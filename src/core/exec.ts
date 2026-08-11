import { execFile } from 'node:child_process';

export class ExecError extends Error {
  constructor(
    message: string,
    readonly cmd: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Output cap. `glab api` on a busy MR returns ~150KB; 32MB is plenty. */
  maxBuffer?: number;
  env?: Record<string, string>;
  /**
   * Accept a non-zero exit when the command still printed a payload.
   *
   * `rwx runs show` mirrors the RUN's verdict in its own exit status: a failed
   * run exits 1 while writing a perfectly good 1.7MB of JSON to stdout. Judging
   * by the status alone therefore makes exactly the results you most need — the
   * failures — indistinguishable from a broken lookup, and they vanish.
   *
   * Empty stdout, a timeout, a signal, or a missing binary still reject: those
   * produce no payload to work with, so there is nothing to salvage.
   */
  allowNonZeroExit?: boolean;
}

/**
 * Run a command and return stdout. Rejects with ExecError carrying stderr,
 * which is the only useful diagnostic when `glab`/`rwx` fail.
 */
export const run = (cmd: string, args: string[], opts: RunOptions = {}): Promise<string> => {
  const { cwd, timeoutMs = 60_000, maxBuffer = 32 * 1024 * 1024, env } = opts;
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        env: env ? { ...process.env, ...env } : process.env,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          const why = killed ? `timed out after ${timeoutMs}ms` : err.message;
          // execFile's `code` is the exit status when numeric, but an errno
          // string (ENOENT) when the binary is missing.
          const code = typeof err.code === 'number' ? err.code : null;
          // A real exit status plus a real payload = a result, not a failure.
          if (opts.allowNonZeroExit && !killed && code !== null && stdout.trim() !== '') {
            resolve(stdout);
            return;
          }
          reject(new ExecError(`${cmd} ${args[0] ?? ''}: ${why}`, cmd, code, stderr));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Parse JSON from a CLI that may prepend chatter to stdout.
 *
 * `rwx` writes update notices ("A new release of rwx is available…") to stdout
 * ahead of the JSON payload, so a bare JSON.parse of its output fails. Skip to
 * the first `{`/`[` rather than trying to suppress the notice.
 */
export const parseJsonLoose = <T>(out: string, context: string): T => {
  const start = out.search(/[[{]/);
  if (start === -1) {
    throw new Error(`${context}: no JSON found in output (${out.slice(0, 200).trim()})`);
  }
  const body = out.slice(start);
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    // The classic `glab api --paginate` failure: page arrays concatenated as
    // `][`, which is not valid JSON. We page manually to avoid it, so seeing
    // this means someone reintroduced --paginate.
    const hint = body.includes('][')
      ? ' (output contains "][" — looks like `glab api --paginate`, which emits concatenated arrays; page manually instead)'
      : '';
    throw new Error(`${context}: invalid JSON${hint}: ${(err as Error).message}`, { cause: err });
  }
}

export const runJson = async <T>(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<T> => {
  const out = await run(cmd, args, opts);
  return parseJsonLoose<T>(out, `${cmd} ${args.join(' ')}`);
}
