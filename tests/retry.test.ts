import { describe, expect, it } from 'vitest';
import { ExecError } from '../src/core/exec';
import { HttpError, delayFor, isRetryableError } from '../src/core/retry';

describe('isRetryableError on subprocess failures (P6)', () => {
  const execErr = (stderr: string): ExecError => new ExecError('glab api: failed', 'glab', 1, stderr);

  it('retries transient server and network blips reported by the CLI', () => {
    expect(isRetryableError(execErr('HTTP 502 Bad Gateway'))).toBe(true);
    expect(isRetryableError(execErr('429 Too Many Requests'))).toBe(true);
    expect(isRetryableError(execErr('dial tcp 172.65.1.1:443: connect: connection refused'))).toBe(true);
    expect(isRetryableError(execErr('Get "https://gitlab.com": context deadline exceeded'))).toBe(true);
    expect(isRetryableError(execErr('net/http: TLS handshake timeout'))).toBe(true);
  });

  it('never retries auth or not-found failures — they will not get better', () => {
    expect(isRetryableError(execErr('401 Unauthorized'))).toBe(false);
    expect(isRetryableError(execErr('Oauth2: "invalid_grant" ...'))).toBe(false);
    expect(isRetryableError(execErr('404 Not Found'))).toBe(false);
  });

  it('does not retry our own subprocess timeout — the next cycle is the retry', () => {
    expect(isRetryableError(new ExecError('glab api: timed out after 45000ms', 'glab', null, ''))).toBe(false);
  });
});

describe('delayFor', () => {
  it('honors a Retry-After only inside the safe 1..5s window', () => {
    expect(delayFor(0, '3')).toBe(3);
    expect(delayFor(0, '1')).toBe(1);
    expect(delayFor(0, '5')).toBe(5);
  });
  it('ignores a hostile or out-of-range Retry-After and falls back to the ladder', () => {
    expect(delayFor(0, '86400')).toBe(0.2); // way too long → ignored
    expect(delayFor(0, '0')).toBe(0.2); // below floor → ignored
    expect(delayFor(0, 'garbage')).toBe(0.2);
  });
  it('walks the backoff ladder and caps at the last step', () => {
    expect(delayFor(0)).toBe(0.2);
    expect(delayFor(1)).toBe(0.5);
    expect(delayFor(2)).toBe(1.0);
    expect(delayFor(9)).toBe(1.0); // capped
  });
});

describe('isRetryableError', () => {
  it('retries only the transient HTTP statuses', () => {
    for (const s of [429, 502, 503, 504]) {
      expect(isRetryableError(new HttpError(s, '', 'u'))).toBe(true);
    }
    for (const s of [400, 401, 403, 404, 500]) {
      expect(isRetryableError(new HttpError(s, '', 'u'))).toBe(false);
    }
  });
  it('retries transient network error codes', () => {
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
  });
  it('follows a wrapped cause chain', () => {
    const inner = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(isRetryableError(new Error('wrapper', { cause: inner }))).toBe(true);
  });
  it('treats a plain error as non-retryable', () => {
    expect(isRetryableError(new Error('nope'))).toBe(false);
  });
});
