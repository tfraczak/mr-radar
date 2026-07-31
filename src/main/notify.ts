import { Notification } from 'electron';
import { toNotifications } from '../core/events';
import { openExternalSafe } from './open';
import { resolveMethod, systemNotify, type ResolvedMethod } from './sys-notify';
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
    // Straight to the item: open its page, and flash its row in the popover
    // so the user has app-side context when they come back.
    if (n.mrKey) onHighlight?.(n.mrKey);
    if (n.url) openExternalSafe(n.url);
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
): void => {
  if (method === 'native') showNative(n, sound, onOpenPopover, onHighlight);
  else systemNotify(method, { title: n.title, body: n.body, url: n.url, sound });
};

export const notify = (events: AppEvent[], opts: NotifyOptions): number => {
  if (!opts.enabled || events.length === 0) return 0;
  const method = resolveMethod(opts.method);
  if (method === 'native' && !Notification.isSupported()) return 0;

  const notifications = toNotifications(events);
  for (const n of notifications) {
    const mrKey = n.events.length === 1 ? n.events[0]?.mrKey : undefined;
    deliver(
      method,
      { title: n.title, body: n.body, url: n.url, mrKey },
      opts.sound,
      opts.onOpenPopover,
      opts.onHighlight,
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
