import { Menu, Tray, nativeImage, nativeTheme } from 'electron';
import { join } from 'node:path';
import { describePause } from '../core/schedule';
import type { UiSnapshot, UiTab } from '../renderer/contract';
import type { UiState } from './state';

/**
 * The menu bar presence.
 *
 * Three icon states so the app's status is legible at a glance without opening
 * anything: filled bullseye = active, bullseye with a pip = unread, hollow ring
 * = paused. The plan called for the paused state to be unmistakable, since a
 * silently-paused notifier is worse than no notifier.
 *
 * Clicking the icon opens only the menu (via setContextMenu) — the popover is an
 * explicit "Open" item, so a single click can't fire two things at once.
 */
export interface TrayCallbacks {
  onToggle: () => void;
  onPollNow: () => void;
  /** Open the popover on one bucket — the menu's three main entries. */
  onOpenTab: (tab: UiTab) => void;
  onSettings: () => void;
  onRevealConfig: () => void;
  onMarkAllRead: () => void;
  onTestNotification: () => void;
  onNotificationSettings: () => void;
  onQuit: () => void;
}

const ASSETS = join(__dirname, '..', '..', 'assets');

export class TrayController {
  private tray: Tray | undefined;

  /**
   * `presented` hands back the same snapshot the popover renders, so the menu's
   * bucket counts are the popover's own numbers rather than a second, subtly
   * different tally of the same work.
   */
  constructor(
    private readonly cb: TrayCallbacks,
    private readonly presented: () => UiSnapshot | undefined = () => undefined,
  ) {}

  init(): void {
    this.tray = new Tray(templateIcon('radar-idle'));
    this.tray.setToolTip('MR Radar');
    // A context menu means a left- or right-click both just open the menu. No
    // separate click handler, so clicking the icon never also opens the popover.
    this.tray.setContextMenu(this.menu(undefined));
  }

  update(state: UiState): void {
    if (!this.tray) return;
    const unread = state.unread.length;
    const paused = state.pausedReason !== undefined;

    if (unread > 0 && !paused) {
      // Colored badge icon — pick the polarity that contrasts with the current
      // menu bar (dark radar on a light bar, light radar on a dark bar). Not a
      // template image, so the red badge shows in actual color.
      const variant = nativeTheme.shouldUseDarkColors ? 'radar-alert-light' : 'radar-alert-dark';
      this.tray.setImage(coloredIcon(variant));
    } else {
      this.tray.setImage(templateIcon(paused ? 'radar-idle' : 'radar'));
    }
    // The count sits next to the icon rather than inside it — legible at any
    // size, and macOS has no tray badge API.
    this.tray.setTitle(unread > 0 ? ` ${unread}` : '');
    this.tray.setToolTip(tooltip(state));
    this.tray.setContextMenu(this.menu(state));
  }

  private menu(state: UiState | undefined): Menu {
    const paused = state?.pausedReason;
    const byUser = paused === 'user';
    const items = state?.snapshot?.items.filter((i) => i.inScope) ?? [];
    const failing = items.filter((i) => i.testGate?.kind === 'verified' && i.testGate.result === 'failed');
    const unverified = items.filter((i) => i.testGate?.kind === 'unverified' && i.testGate.startable);

    // One entry per bucket, so the menu can open the app *where you were
    // headed* rather than wherever it happened to be left. Counts come from the
    // presented snapshot — the popover's own numbers.
    const totals = state ? this.presented()?.tabTotals : undefined;
    const term = state ? changeTermFor(this.presented()) : 'MR';
    const buckets: { tab: UiTab; label: string }[] = [
      { tab: 'work', label: 'My work' },
      { tab: 'reviews', label: 'My reviews' },
      { tab: 'participating', label: 'Participating' },
    ];

    return Menu.buildFromTemplate([
      { label: state ? tooltip(state) : 'MR Radar — starting…', enabled: false },
      { type: 'separator' },
      ...buckets.map((b) => ({
        label: totals ? `${b.label} (${totals[b.tab]})` : b.label,
        click: () => this.cb.onOpenTab(b.tab),
      })),
      { type: 'separator' },
      {
        label: byUser ? 'Resume polling' : 'Pause polling',
        click: () => this.cb.onToggle(),
        // Only a user pause is togglable; sleep and off-hours resolve themselves.
        enabled: paused === undefined || byUser,
      },
      { label: 'Poll now', click: () => this.cb.onPollNow(), enabled: !state?.polling },
      {
        label: `Mark all read${state?.unread.length ? ` (${state.unread.length})` : ''}`,
        click: () => this.cb.onMarkAllRead(),
        enabled: Boolean(state?.unread.length),
      },
      { type: 'separator' },
      // "tracked" = the whole polling universe; the buckets above count the
      // narrower slice the popover shows. Two words, so they can't be confused.
      { label: `${items.length} ${term}s tracked`, enabled: false },
      {
        label: failing.length ? `${failing.length} with failing tests` : 'No failing tests',
        enabled: false,
      },
      {
        label: unverified.length ? `${unverified.length} never verified` : 'All verified',
        enabled: false,
      },
      { type: 'separator' },
      { label: 'Settings…', click: () => this.cb.onSettings() },
      { label: 'Send test notification', click: () => this.cb.onTestNotification() },
      { label: 'Notification settings…', click: () => this.cb.onNotificationSettings() },
      // Reveal, never open — opening the .json hands it to Xcode/your editor.
      { label: 'Reveal config file in Finder', click: () => this.cb.onRevealConfig() },
      { type: 'separator' },
      { label: 'Quit MR Radar', click: () => this.cb.onQuit(), accelerator: 'Command+Q' },
    ]);
  }

  /** Icon bounds, so the popover can be centred under it. */
  bounds(): Electron.Rectangle | undefined {
    return this.tray?.getBounds();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }
}

/** MR/PR for the tray's own wording; 'MR' until the first snapshot lands. */
const changeTermFor = (snapshot: UiSnapshot | undefined): 'MR' | 'PR' =>
  snapshot?.forge === 'github' ? 'PR' : 'MR';

const tooltip = (state: UiState): string => {
  if (state.pausedReason) return `MR Radar — ${describePause(state.pausedReason)}`;
  if (state.polling) return 'MR Radar — polling…';
  if (state.lastError) return `MR Radar — last poll failed: ${state.lastError}`;
  if (!state.lastPollAt) return 'MR Radar — waiting for first poll';
  const when = new Date(state.lastPollAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `MR Radar — last checked ${when}`;
}

/**
 * Template image: macOS recolors it (alpha only) for light and dark menu bars.
 * `@2x`/`@3x` files beside the base name are picked up automatically.
 */
const templateIcon = (name: string) => {
  const image = nativeImage.createFromPath(join(ASSETS, `${name}.png`));
  image.setTemplateImage(true);
  return image;
}

/** Colored image: rendered as-is, so the red alert badge keeps its color. */
const coloredIcon = (name: string) => {
  return nativeImage.createFromPath(join(ASSETS, `${name}.png`));
}
