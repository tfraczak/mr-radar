import { describe, expect, it } from 'vitest';
import { resolveSystemMethod, terminalNotifierArgs } from '../src/main/sys-notify';

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

  it('always carries the bundle id so the banner shows the app identity', () => {
    const args = terminalNotifierArgs(base);
    const at = args.indexOf('-sender');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('com.mr-radar.app');
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
