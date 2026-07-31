import { describe, expect, it } from 'vitest';
import { hostAllowed, injectShim } from '../src/web-server';

describe('hostAllowed (DNS-rebinding guard)', () => {
  it('accepts localhost forms for the bound port', () => {
    expect(hostAllowed('127.0.0.1:8942', 8942)).toBe(true);
    expect(hostAllowed('localhost:8942', 8942)).toBe(true);
    expect(hostAllowed('[::1]:8942', 8942)).toBe(true);
  });
  it('rejects foreign hosts — the DNS-rebinding vector', () => {
    expect(hostAllowed('evil.com:8942', 8942)).toBe(false);
    expect(hostAllowed('radar.attacker.dev', 8942)).toBe(false);
    expect(hostAllowed(undefined, 8942)).toBe(false);
  });
  it('rejects the right host on the wrong port', () => {
    expect(hostAllowed('127.0.0.1:9999', 8942)).toBe(false);
  });
});

describe('injectShim', () => {
  const html = [
    '<head>',
    '    <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:;" />',
    '    <title>MR Radar</title>',
    '</head>',
    '<script type="module" src="renderer.js"></script>',
  ].join('\n');

  it('embeds the token, loads the shim before the renderer, widens CSP', () => {
    const out = injectShim(html, 'tok123', true);
    expect(out).toContain('<meta name="radar-token" content="tok123" />');
    expect(out).toContain("connect-src 'self'"); // fetch() must be allowed
    expect(out).toContain('<link rel="icon" type="image/png" href="app-icon.png" />');
    // Classic script first: it must define window.radar before the module runs.
    const shimAt = out.indexOf('web-radar.js');
    const rendererAt = out.indexOf('renderer.js');
    expect(shimAt).toBeGreaterThan(-1);
    expect(shimAt).toBeLessThan(rendererAt);
  });

  it('omits the icon link when no icon is available', () => {
    expect(injectShim(html, 't', false)).not.toContain('rel="icon"');
  });
});
