import { describe, expect, it } from 'vitest';
import { ExecError, run } from '../src/core/exec';

/**
 * `node -e` stands in for the real CLIs: it can exit any status with any
 * combination of stdout/stderr, so the contract is testable without rwx or glab
 * installed and without touching the network.
 */
const node = (script: string, opts: Parameters<typeof run>[2] = {}): Promise<string> =>
  run(process.execPath, ['-e', script], opts);

describe('run', () => {
  it('resolves stdout on success', async () => {
    await expect(node('process.stdout.write("hello")')).resolves.toBe('hello');
  });

  it('rejects a non-zero exit by default, keeping stderr for the diagnosis', async () => {
    const err = await node('process.stderr.write("boom"); process.exit(3)').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).code).toBe(3);
    expect((err as ExecError).stderr).toBe('boom');
  });
});

describe('run with allowNonZeroExit', () => {
  it('resolves a payload printed alongside a non-zero exit', async () => {
    // The `rwx runs show` case: the exit status mirrors the RUN's verdict, so a
    // failed run exits 1 with a complete, valid payload on stdout. Rejecting on
    // the status alone is what made every FAILED run invisible to the app.
    await expect(
      node('process.stdout.write(JSON.stringify({Status:{Result:"failed"}})); process.exit(1)', {
        allowNonZeroExit: true,
      }),
    ).resolves.toBe('{"Status":{"Result":"failed"}}');
  });

  it('still rejects when there is no payload to salvage', async () => {
    // A bogus run id: exit 1, nothing on stdout. That IS a failed lookup, and
    // must stay one — otherwise a missing run would parse as an empty result.
    const err = await node('process.stderr.write("no such run"); process.exit(1)', {
      allowNonZeroExit: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).stderr).toContain('no such run');
  });

  it('treats whitespace-only stdout as no payload', async () => {
    await expect(
      node('process.stdout.write("  \\n "); process.exit(1)', { allowNonZeroExit: true }),
    ).rejects.toBeInstanceOf(ExecError);
  });

  it('still rejects a timeout, however much was printed first', async () => {
    const err = await node(
      'process.stdout.write("partial"); setTimeout(() => {}, 5000)',
      { allowNonZeroExit: true, timeoutMs: 150 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).message).toMatch(/timed out/);
  });

  it('still rejects a missing binary', async () => {
    const err = await run('definitely-not-a-real-binary-xyz', ['--json'], {
      allowNonZeroExit: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).code).toBeNull(); // ENOENT, not an exit status
  });
});
