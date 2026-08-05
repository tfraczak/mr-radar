import { Notification } from 'electron';
import { toNotifications } from '../core/events';
import { openExternalSafe } from './open';
import { focusClickCommand, resolveMethod, systemNotify, type ResolvedMethod } from './sys-notify';
import type { AppEvent } from '../core/types';

/**
 * Deliver notifications by the configured method. On an ad-hoc-signed build the
 * `native` Electron path often won't register with macOS, so `auto` means
 * osascript — always allowed, always delivers. terminal-notifier (icon +
 * click-to-open) is explicit opt-in; see sys-notify.ts for why it can't be
 * automatic under app control.
 */
export interface NotifyOptions {
  enabled: boolean;
  /** 'default' (system sound), 'silent', or a macOS sound name (Glass, Ping…). */
  sound: string;
  method: 'auto' | 'native' | 'terminal-notifier' | 'osascript';
  /** Opens the popover for digests, which have no single URL to visit. */
  onOpenPopover: () => void;
  /** Flash this MR's row in the popover (native click-through only). */
  onHighlight?: (mrKey: string) => void;
  /**
   * The web API port when it's serving — enables terminal-notifier
   * click-to-item via `-execute curl /api/focus` (the `-sender` icon path
   * eats clicks entirely; see sys-notify.ts).
   */
  webPort?: number | undefined;
  /** Radar PNG for terminal-notifier's thumbnail — the visual identity that
   *  survives dropping `-sender` on click-through banners. */
  iconPath?: string | undefined;
}


/** Map our sound setting onto Electron's native Notification options. */
const nativeSoundOpts = (sound: string): { silent: boolean; sound?: string } => {
  if (sound === 'silent') return { silent: true };
  if (sound === 'default' || !sound) return { silent: false };
  return { silent: false, sound }; // named macOS system sound (macOS only)
};

interface Banner {
  title: string;
  body: string;
  url?: string | undefined;
  /** Set when the banner is about exactly one MR — enables click-to-item. */
  mrKey?: string | undefined;
}

const showNative = (
  n: Banner,
  sound: string,
  onOpenPopover: () => void,
  onHighlight?: (mrKey: string) => void,
): void => {
  const { silent, sound: named } = nativeSoundOpts(sound);
  const banner = new Notification({ title: n.title, body: n.body, silent, ...(named ? { sound: named } : {}) });
  banner.on('click', () => {
    // Straight to the item IN THE APP: open the popover and flash the row so
    // it's obvious what the banner was about. The row is one more click if
    // the user wants the MR page — jumping straight to the browser would
    // lose that context.
    if (n.mrKey) onHighlight?.(n.mrKey);
    else if (n.url) openExternalSafe(n.url);
    else onOpenPopover();
  });
  banner.show();
};

const deliver = (
  method: ResolvedMethod,
  n: Banner,
  sound: string,
  onOpenPopover: () => void,
  onHighlight?: (mrKey: string) => void,
  webPort?: number,
  iconPath?: string,
): void => {
  if (method === 'native') {
    showNative(n, sound, onOpenPopover, onHighlight);
    return;
  }
  // Mirror the native click precedence: item-in-app > MR page > popover.
  const execute =
    webPort !== undefined && n.mrKey
      ? focusClickCommand(webPort, n.mrKey)
      : webPort !== undefined && !n.url
        ? focusClickCommand(webPort)
        : undefined;
  systemNotify(method, { title: n.title, body: n.body, url: n.url, execute, sound, icon: iconPath });
};

export const notify = (events: AppEvent[], opts: NotifyOptions): number => {
  if (!opts.enabled || events.length === 0) return 0;
  const method = resolveMethod(opts.method);
  if (method === 'native' && !Notification.isSupported()) return 0;

  const notifications = toNotifications(events);
  for (const n of notifications) {
    // Any banner about exactly one MR is click-to-item — including coalesced
    // ones ("3 new comments"), which are the common case.
    const keys = new Set(n.events.map((e) => e.mrKey).filter(Boolean));
    const mrKey = keys.size === 1 ? [...keys][0] : undefined;
    deliver(
      method,
      { title: n.title, body: n.body, url: n.url, mrKey },
      opts.sound,
      opts.onOpenPopover,
      opts.onHighlight,
      opts.webPort,
      opts.iconPath,
    );
  }
  return notifications.length;
};

/**
 * Fire a single sample notification on demand — verifies delivery and, for the
 * native path, registers the app under System Settings → Notifications. Returns
 * the method actually used so the caller can explain what to expect.
 */
export const sendTestNotification = (
  sound: string,
  method: 'auto' | 'native' | 'terminal-notifier' | 'osascript',
): ResolvedMethod | null => {
  const resolved = resolveMethod(method);
  if (resolved === 'native' && !Notification.isSupported()) return null;
  deliver(
    resolved,
    { title: 'MR Radar', body: "Test notification — you're all set." },
    sound,
    () => {},
  );
  return resolved;
};
