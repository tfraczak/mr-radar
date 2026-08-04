import { BrowserWindow, nativeTheme, screen } from 'electron';
import { join } from 'node:path';

const WIDTH = 560;
const HEIGHT = 660;

/**
 * The dropdown panel.
 *
 * Destroyed on close rather than hidden, which reclaims the whole renderer
 * process. That's the largest share of Electron's footprint and the popover is
 * open seconds a day, so the ~100ms to recreate it is a good trade — this is the
 * "release the renderer when hidden" item from the plan.
 */
export class Popover {
  private win: BrowserWindow | undefined;

  constructor(private readonly onReady: () => void) {}

  /**
   * Settings intent for a window that is still booting. 'ready-to-show' fires
   * when the first frame can paint — BEFORE the renderer's module script has
   * necessarily run and registered its IPC listeners — so a message sent then
   * is silently dropped on cold starts. The flag is consumed when the renderer
   * proves it is alive by requesting its first snapshot.
   */
  private pendingShowSettings = false;

  consumePendingShowSettings(): boolean {
    const pending = this.pendingShowSettings;
    this.pendingShowSettings = false;
    return pending;
  }

  get isOpen(): boolean {
    return this.win !== undefined && !this.win.isDestroyed();
  }

  toggle(bounds: Electron.Rectangle | undefined): void {
    if (this.isOpen) {
      this.close();
      return;
    }
    this.open(bounds);
  }

  open(bounds: Electron.Rectangle | undefined, opts: { showSettings?: boolean } = {}): void {
    if (this.isOpen) {
      this.win?.show();
      this.win?.focus();
      if (opts.showSettings) this.send('ui:show-settings', undefined);
      return;
    }

    this.win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Solid, theme-matched background rather than `vibrancy: 'sidebar'`.
      // A vibrant window is dimmed by macOS while unfocused, which rendered the
      // whole popover as near-invisible low-contrast text. An opaque background
      // stays readable regardless of focus, in both themes. Set here to match
      // the CSS so there's no first-paint flash before styles.css loads.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#f6f6f7',
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // The preload only needs contextBridge/ipcRenderer, which work sandboxed
        // — so keep the sandbox on to shrink the blast radius.
        sandbox: true,
      },
    });

    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    void this.win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));

    if (opts.showSettings) this.pendingShowSettings = true;
    this.win.once('ready-to-show', () => {
      this.position(bounds);
      this.win?.show();
      this.onReady();
    });

    // Click-away dismisses, like a real menu bar popover.
    this.win.on('blur', () => this.close());
    this.win.on('closed', () => {
      this.win = undefined;
      this.pendingShowSettings = false;
    });
  }

  close(): void {
    if (!this.win || this.win.isDestroyed()) {
      this.win = undefined;
      return;
    }
    this.win.destroy();
    this.win = undefined;
  }

  send(channel: string, payload: unknown): void {
    if (this.isOpen) this.win?.webContents.send(channel, payload);
  }

  /** Centre under the tray icon, nudged to stay on screen. */
  private position(bounds: Electron.Rectangle | undefined): void {
    if (!this.win) return;
    const display = screen.getDisplayNearestPoint(
      bounds ? { x: Math.round(bounds.x), y: Math.round(bounds.y) } : screen.getCursorScreenPoint(),
    );
    const work = display.workArea;

    let x = bounds ? Math.round(bounds.x + bounds.width / 2 - WIDTH / 2) : work.x + work.width - WIDTH - 8;
    x = Math.max(work.x + 8, Math.min(x, work.x + work.width - WIDTH - 8));
    const y = bounds ? Math.round(bounds.y + bounds.height + 4) : work.y + 8;

    this.win.setPosition(x, Math.max(work.y + 4, y), false);
  }
}
