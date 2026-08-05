import { describe, expect, it } from 'vitest';
import { focusClickCommand, resolveSystemMethod, terminalNotifierArgs } from '../src/main/sys-notify';

describe('resolveSystemMethod (headless runtime — native impossible)', () => {
  it('auto and native both mean osascript — terminal-notifier is opt-in ONLY', () => {
    // Merely executing terminal-notifier under app control pops a system
    // "Application Blocked" banner, so nothing may select it automatically.
    expect(resolveSystemMethod('auto')).toBe('osascript');
    expect(resolveSystemMethod('native')).toBe('osascript');
    expect(resolveSystemMethod('osascript')).toBe('osascript');
  });
  it('honors the explicit terminal-notifier opt-in', () => {
    expect(resolveSystemMethod('terminal-notifier')).toBe('terminal-notifier');
  });
});

describe('terminalNotifierArgs', () => {
  const base = { title: 'MR Radar', body: '2 new comments', sound: 'default' };

  it('carries the bundle id only when there is NO click target', () => {
    // macOS handles a -sender banner's click by launching that bundle and
    // silently ignores -open/-execute — so the two are mutually exclusive.
    const args = terminalNotifierArgs(base);
    const at = args.indexOf('-sender');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('com.mr-radar.app');
    expect(terminalNotifierArgs({ ...base, url: 'https://x' })).not.toContain('-sender');
    expect(terminalNotifierArgs({ ...base, execute: 'curl …' })).not.toContain('-sender');
  });

  it('adds -contentImage only when an icon path is given', () => {
    expect(terminalNotifierArgs(base)).not.toContain('-contentImage');
    const args = terminalNotifierArgs({ ...base, icon: '/repo/assets/app-icon.png' });
    expect(args[args.indexOf('-contentImage') + 1]).toBe('/repo/assets/app-icon.png');
  });

  it('adds -open only when a URL is given, so clicks go to the MR', () => {
    expect(terminalNotifierArgs(base)).not.toContain('-open');
    const args = terminalNotifierArgs({ ...base, url: 'https://gitlab.com/x/-/merge_requests/1' });
    expect(args[args.indexOf('-open') + 1]).toBe('https://gitlab.com/x/-/merge_requests/1');
  });

  it('prefers -execute (click-to-item in the app) over -open', () => {
    const args = terminalNotifierArgs({ ...base, url: 'https://x', execute: 'curl focus' });
    expect(args[args.indexOf('-execute') + 1]).toBe('curl focus');
    expect(args).not.toContain('-open');
  });

  it('maps the sound setting: silent omits, default stays default, names pass through', () => {
    expect(terminalNotifierArgs({ ...base, sound: 'silent' })).not.toContain('-sound');
    const dflt = terminalNotifierArgs(base);
    expect(dflt[dflt.indexOf('-sound') + 1]).toBe('default');
    const named = terminalNotifierArgs({ ...base, sound: 'Glass' });
    expect(named[named.indexOf('-sound') + 1]).toBe('Glass');
  });

  it('passes title/body verbatim as argv (no shell, no quoting to break out of)', () => {
    const hostile = { ...base, title: '"; rm -rf ~; "', body: '$(whoami) `id` \\n' };
    const args = terminalNotifierArgs(hostile);
    expect(args[args.indexOf('-title') + 1]).toBe(hostile.title);
    expect(args[args.indexOf('-message') + 1]).toBe(hostile.body);
  });
});

describe('focusClickCommand (the -execute payload — this one IS run by a shell)', () => {
  it('posts the key to /api/focus on the given port', () => {
    const cmd = focusClickCommand(8942, 'acme/rocket!7576');
    expect(cmd).toContain(`--data '{"mrKey":"acme/rocket!7576"}'`);
    expect(cmd).toContain("'http://127.0.0.1:8942/api/focus'");
  });

  it('strips shell-hostile characters from the key instead of trusting quoting', () => {
    const cmd = focusClickCommand(8942, `a'; rm -rf ~; echo '`);
    expect(cmd).not.toContain("'; rm");
    expect(cmd).not.toContain('$');
    // Only the sanitized residue of the key remains inside the JSON body.
    expect(cmd).toContain('{"mrKey":"arm-rfecho"}');
  });

  it('omits the key for digest banners — the click still opens the UI', () => {
    expect(focusClickCommand(8942)).toContain(`--data '{}'`);
  });
});
