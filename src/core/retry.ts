import { ExecError } from './exec';

/**
 * Bounded backoff for HTTP calls: retry only what plausibly heals on its own
 * (429/502/503/504 and transport errors), on a short fixed ladder.
 *
 * The one non-obvious rule is the Retry-After clamp: a server (or something
 * pretending to be one) can send `Retry-After: 86400` and stall the poll loop
 * for a day. Honor the header only when it asks for 1..5s; otherwise fall back
 * to our own ladder.
 */

export const BACKOFF_SECONDS = [0.2, 0.5, 1.0] as const;
export const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_AFTER_MIN = 1;
const RETRY_AFTER_MAX = 5;

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

/**
 * Transient failure signatures in CLI output (P6).
 *
 * glab/rwx failures surface as ExecError — an exit status plus stderr — and an
 * exit status alone can't separate "GitLab had a blip" from "this MR is gone",
 * so without text classification the retry wrapper never retried a subprocess
 * at all. Whitelist-only: auth failures (401, invalid_grant) and 404s must NOT
 * retry, and a hung call that hit our own timeout must not stack more 45s
 * waits — the next poll cycle is the retry for those.
 */
const TRANSIENT_CLI_OUTPUT =
  /\b(?:429|502|503|504)\b|too many requests|bad gateway|service unavailable|gateway timeout|connection (?:refused|reset)|context deadline exceeded|tls handshake|unexpected eof|temporary failure|i\/o timeout/i;

export const isRetryableError = (err: unknown): boolean => {
  if (err instanceof HttpError) return RETRYABLE_STATUSES.has(err.status);
  if (err instanceof ExecError) return TRANSIENT_CLI_OUTPUT.test(`${err.message}\n${err.stderr}`);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  if (cause && cause !== err) return isRetryableError(cause);
  return false;
}

/** Seconds to wait, honoring Retry-After only inside the safe window. */
export const delayFor = (attempt: number, retryAfterHeader?: string | null): number => {
  const parsed = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(parsed) && parsed >= RETRY_AFTER_MIN && parsed <= RETRY_AFTER_MAX) {
    return parsed;
  }
  return BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] ?? 1;
}

const sleep = (seconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.round(seconds * 1000)));

export interface RetryOptions {
  attempts?: number;
  onRetry?: (attempt: number, delaySeconds: number, err: unknown) => void;
}

export const withRetries = async <T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> => {
  const attempts = opts.attempts ?? BACKOFF_SECONDS.length;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isRetryableError(err)) throw err;
      // No response headers here — this path wraps subprocesses, not fetch.
      const wait = delayFor(attempt);
      opts.onRetry?.(attempt + 1, wait, err);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** fetch + retry + Retry-After handling, for Jira (the only direct HTTP source). */
export const fetchJsonWithRetries = async <T>(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<T> => {
  const attempts = opts.attempts ?? BACKOFF_SECONDS.length;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new HttpError(res.status, body, url);
        if (attempt < attempts && RETRYABLE_STATUSES.has(res.status)) {
          const wait = delayFor(attempt, res.headers.get('retry-after'));
          opts.onRetry?.(attempt + 1, wait, err);
          await sleep(wait);
          continue;
        }
        throw err;
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError) throw err;
      if (attempt === attempts || !isRetryableError(err)) throw err;
      const wait = delayFor(attempt);
      opts.onRetry?.(attempt + 1, wait, err);
      await sleep(wait);
    }
  }
  throw lastErr;
}
