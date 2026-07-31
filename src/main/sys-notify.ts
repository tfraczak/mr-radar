import { execFile, execFileSync } from 'node:child_process';

/**
 * Deliver notifications through a pre-signed macOS helper instead of Electron's
 * native `Notification`.
 *
 * Why: this app ships ad-hoc-signed (no Apple Developer ID), and an ad-hoc
 * Electron app frequently fails to register with macOS's UserNotifications — it
 * never appears under System Settings → Notifications and banners silently
 * no-op. `osascript` is Apple-signed and always delivers.
 *
 *   osascript         — the default: always present, always allowed.
 *   terminal-notifier — click-to-open (`-open`) and the MR Radar icon
 *                        (`-sender`), but EXPLICIT OPT-IN only. On this machine
 *                        ThreatLocker SIGKILLs it, and every blocked execution
 *                        pops a scary "Application Blocked" banner — so `auto`
 *                        must never touch it, not even to probe. Set
 *                        notifications.method to "terminal-notifier" once
 *                        security approves it; a killed send falls back to
 *                        osascript silently and stops retrying for the process.
 */

export type ResolvedMethod = 'native' | 'terminal-notifier' | 'osascript';

const BUNDLE_ID = 'com.mr-radar.app';

let terminalNotifierPath: string | null | undefined;

/** Absolute path to terminal-notifier if installed, else null. Never executes it. */
const findTerminalNotifier = (): string | null => {
  if (terminalNotifierPath !== undefined) return terminalNotifierPath;
  try {
    terminalNotifierPath =
      execFileSync('/usr/bin/which', ['terminal-notifier'], { encoding: 'utf8' }).trim() || null;
  } catch {
    terminalNotifierPath = null;
  }
  return terminalNotifierPath;
};

/**
 * Set when a terminal-notifier send dies (ThreatLocker SIGKILL): the rest of
 * the process falls back to osascript without re-triggering block banners.
 */
let terminalNotifierBroken = false;

/** Turn the configured method into the concrete one to use right now. */
export const resolveMethod = (
  configured: 'auto' | 'native' | 'terminal-notifier' | 'osascript',
): ResolvedMethod => {
  if (configured === 'native' || configured === 'osascript') return configured;
  if (configured === 'terminal-notifier') return 'terminal-notifier';
  // auto: osascript. Deliberately NOT terminal-notifier — merely executing it
  // under app control pops a block banner, so preferring it can't be automatic.
  return 'osascript';
};

/**
 * Like resolveMethod, but for a runtime with no Electron (the headless poller):
 * `native` is impossible there, so `auto`/`native` both become osascript.
 */
export const resolveSystemMethod = (
  configured: 'auto' | 'native' | 'terminal-notifier' | 'osascript',
): 'terminal-notifier' | 'osascript' => {
  return configured === 'terminal-notifier' ? 'terminal-notifier' : 'osascript';
};

export interface SysNotification {
  title: string;
  body: string;
  url?: string | undefined;
  /** 'default' | 'silent' | a macOS sound name. */
  sound: string;
  /** PNG path shown as the notification's thumbnail (terminal-notifier only). */
  icon?: string | undefined;
}

/**
 * Build the terminal-notifier argv for a notification. Exported for testing so
 * the icon/sender/open wiring is verifiable without spawning anything.
 *
 * `-sender ${BUNDLE_ID}` makes the banner adopt the installed (even if
 * unrunnable) MR Radar bundle's identity and icon; `-contentImage` adds the
 * radar as a thumbnail so it's recognizable even where `-sender`'s icon doesn't
 * render. `-open <url>` opens the MR on click.
 */
export const terminalNotifierArgs = (n: SysNotification): string[] => {
  const args = ['-title', n.title, '-message', n.body, '-sender', BUNDLE_ID];
  if (n.icon) args.push('-contentImage', n.icon);
  if (n.url) args.push('-open', n.url);
  if (n.sound !== 'silent') args.push('-sound', n.sound === 'default' ? 'default' : n.sound);
  return args;
};

const osascriptNotify = (n: SysNotification): void => {
  // Build an AppleScript literal, escaping \ and " so titles/bodies from
  // GitLab can't break out of the string.
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let script = `display notification "${esc(n.body)}" with title "${esc(n.title)}"`;
  if (n.sound !== 'silent') script += ` sound name "${esc(n.sound === 'default' ? 'Glass' : n.sound)}"`;
  execFile('osascript', ['-e', script], () => {});
};

/** Fire one notification via terminal-notifier or osascript. */
export const systemNotify = (method: 'terminal-notifier' | 'osascript', n: SysNotification): void => {
  if (method === 'terminal-notifier' && !terminalNotifierBroken) {
    const tn = findTerminalNotifier();
    if (!tn) {
      osascriptNotify(n);
      return;
    }
    execFile(tn, terminalNotifierArgs(n), (err) => {
      const killed =
        (err as (Error & { signal?: string; code?: number }) | null)?.signal === 'SIGKILL' ||
        (err as (Error & { code?: number }) | null)?.code === 137;
      if (killed) {
        // Blocked by app control. Deliver this one via osascript and stop
        // trying terminal-notifier for the rest of the process, so each
        // notification can't pop another "Application Blocked" banner.
        terminalNotifierBroken = true;
        osascriptNotify(n);
      }
    });
    return;
  }
  osascriptNotify(n);
};
