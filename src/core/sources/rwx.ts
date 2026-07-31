import { execFile } from 'node:child_process';
import { runJson } from '../exec';
import { withRetries } from '../retry';
import type { RwxRun, RwxRunsResponse } from '../types';

const RWX = process.env.MR_RADAR_RWX ?? 'rwx';

/**
 * RWX access via the `rwx` CLI, which reads its own token from
 * ~/.config/rwx/accesstoken — so, as with `glab`, this app holds no credential.
 *
 * Note the CLI prints an update notice to stdout ahead of the JSON payload;
 * `parseJsonLoose` in exec.ts skips to the first brace rather than fighting it.
 */
export class RwxSource {
  constructor(private readonly rwx: string = RWX) {}

  private availability: Promise<boolean> | undefined;

  /**
   * Whether the CLI exists at all, so installs without RWX skip the
   * integration instead of erroring every cycle. Only ENOENT means missing —
   * a nonzero exit or timeout still proves the binary exists. Success is
   * cached for the process; failure is NOT, so a transient startup problem
   * (PATH still being fixed up, slow first exec) can't disable RWX forever.
   */
  available(): Promise<boolean> {
    this.availability ??= new Promise((resolve) => {
      execFile(this.rwx, ['--version'], { timeout: 10_000 }, (err) => {
        const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
        if (missing || (err && !err.killed)) {
          // Missing or odd failure: report accordingly but let the next
          // cycle re-probe rather than caching a possibly-transient answer.
          this.availability = undefined;
        }
        resolve(!missing);
      });
    });
    return this.availability;
  }

  /** Newest 100 runs across the org — covers every active branch in one call. */
  async recentRuns(limit = 100): Promise<RwxRun[]> {
    const res = await withRetries(() =>
      runJson<RwxRunsResponse>(this.rwx, ['runs', 'list', '--limit', String(limit), '--json'], {
        timeoutMs: 45_000,
      }),
    );
    return res.Runs ?? [];
  }

  async runsForBranch(branch: string, limit = 100): Promise<RwxRun[]> {
    const res = await withRetries(() =>
      runJson<RwxRunsResponse>(
        this.rwx,
        ['runs', 'list', '--branch', branch, '--limit', String(limit), '--json'],
        { timeoutMs: 45_000 },
      ),
    );
    return res.Runs ?? [];
  }

  private readonly historyCache = new Map<string, { at: number; runs: RwxRun[] }>();
  private myRunsCache: { at: number; runs: RwxRun[] } | undefined;
  /** Terminal runs are immutable, so `showRun` results cache forever. */
  private readonly showCache = new Map<string, RwxRun>();

  /**
   * Runs *I* triggered (`--mine`), TTL-cached.
   *
   * This is how manually-started runs are found at all: a CLI-triggered run has
   * EMPTY Branch/CommitSha metadata (verified live — `Trigger: "cli"` runs carry
   * `Branch: ""`), so `--branch` filters can never return them. The user's own
   * runs are exactly the ones "did I run the specs?" is about.
   */
  async myRuns(ttlMs = 10 * 60_000): Promise<{ runs: RwxRun[]; fetched: boolean }> {
    if (this.myRunsCache && Date.now() - this.myRunsCache.at < ttlMs) {
      return { runs: this.myRunsCache.runs, fetched: false };
    }
    const res = await withRetries(() =>
      runJson<RwxRunsResponse>(this.rwx, ['runs', 'list', '--mine', '--limit', '100', '--json'], {
        timeoutMs: 45_000,
      }),
    );
    const runs = res.Runs ?? [];
    this.myRunsCache = { at: Date.now(), runs };
    return { runs, fetched: true };
  }

  /**
   * One run by id — authoritative regardless of the list windows, and the only
   * place a CLI-triggered run's commit is recorded (`Init["Commit-sha"]`).
   */
  async showRun(id: string): Promise<RwxRun & { fetched?: boolean }> {
    const hit = this.showCache.get(id);
    if (hit) return hit;
    const d = await withRetries(() =>
      runJson<RwxShowResponse>(this.rwx, ['runs', 'show', id, '--json'], { timeoutMs: 45_000 }),
    );
    const org = (d.RepositorySlug ?? '').split('/')[0];
    const run: RwxRun = {
      ID: d.ID ?? id,
      Branch: d.Branch ?? '',
      // The list payload leaves CommitSha empty for cli runs; Init has the truth.
      CommitSha: d.CommitSha ?? d.Init?.['Commit-sha'] ?? '',
      DefinitionPath: d.DefinitionPath ?? '',
      RepositoryName: d.RepositoryName ?? '',
      RunUrl: org ? `https://cloud.rwx.com/mint/${org}/runs/${id}` : '',
      Title: d.Title ?? '',
      Trigger: d.Trigger ?? '',
      CreatedAt: d.StartedAt ?? d.CompletedAt ?? '',
      StartedAt: d.StartedAt ?? null,
      CompletedAt: d.CompletedAt ?? null,
      Status: d.Status ?? { Execution: 'waiting', Result: 'no_result' },
    };
    if (isTerminal(run)) this.showCache.set(id, run);
    return { ...run, fetched: true };
  }

  /**
   * `runsForBranch`, cached for `ttlMs` per branch.
   *
   * Used to answer "has this branch EVER produced a test result?" when the
   * global recent-runs window has no completed run for it — which on rocket is
   * the steady state for most branches, so asking fresh every cycle would add
   * one `rwx` call per MR per cycle. Staleness is safe here: a run that
   * completes *now* is by definition inside the global recent window, so the
   * cached history only ever misses results the live path already sees.
   */
  async branchHistory(
    branch: string,
    ttlMs = 10 * 60_000,
  ): Promise<{ runs: RwxRun[]; fetched: boolean }> {
    const hit = this.historyCache.get(branch);
    if (hit && Date.now() - hit.at < ttlMs) return { runs: hit.runs, fetched: false };
    const runs = await this.runsForBranch(branch);
    this.historyCache.set(branch, { at: Date.now(), runs });
    return { runs, fetched: true };
  }

  /**
   * Start a run for a specific commit.
   *
   * Deliberately passes the **MR's head sha** rather than local `git rev-parse
   * HEAD`. `.rwx/ci.yml`'s `git/clone` task clones `ref: ${{ init.commit-sha }}`
   * from GitLab and has no local-files task, so the run tests exactly the commit
   * the MR proposes regardless of what the working tree looks like. That also
   * means a branch can be started without checking it out.
   *
   * `cwd` must be the repo checkout so the CLI can resolve `.rwx/`.
   */
  async startRun(opts: {
    checkout: string;
    definition: string;
    branch: string;
    commitSha: string;
    title: string;
  }): Promise<{ runId?: string; url?: string; raw: unknown }> {
    const args = [
      'run',
      '--file',
      opts.definition,
      '--title',
      opts.title,
      '--init',
      `commit-sha=${opts.commitSha}`,
      '--init',
      `ref=refs/heads/${opts.branch}`,
      '--json',
    ];
    const raw = await runJson<unknown>(this.rwx, args, {
      cwd: opts.checkout,
      timeoutMs: 120_000,
    });
    const found = findRunIdAndUrl(raw);
    return { ...found, raw };
  }

  /** Dispatch a pre-configured workflow (rocket's `.rwx/number_qa.yml`). */
  async dispatch(key: string, ref: string, params: Record<string, string> = {}): Promise<unknown> {
    const args = ['dispatch', key, '--ref', ref, '--json'];
    for (const [k, v] of Object.entries(params)) args.push('--param', `${k}=${v}`);
    return runJson<unknown>(this.rwx, args, { timeoutMs: 60_000 });
  }
}

/**
 * `rwx run --json` output shape isn't contractually documented, so hunt for a
 * run id and URL rather than assuming a key. Falls back to parsing the run id
 * out of a cloud.rwx.com URL.
 */
export const findRunIdAndUrl = (raw: unknown): { runId?: string; url?: string } => {
  let runId: string | undefined;
  let url: string | undefined;

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === 'string') {
        const lower = k.toLowerCase();
        if (!runId && (lower === 'id' || lower === 'runid') && /^[0-9a-f]{16,}$/i.test(v)) runId = v;
        if (!url && /url$/i.test(lower) && v.includes('rwx.com')) url = v;
      } else {
        visit(v);
      }
    }
  };
  visit(raw);

  if (!runId && url) {
    const m = /\/runs\/([0-9a-f]+)/i.exec(url);
    if (m?.[1]) runId = m[1];
  }
  return { ...(runId ? { runId } : {}), ...(url ? { url } : {}) };
}

interface RwxShowResponse {
  ID?: string;
  Branch?: string | null;
  CommitSha?: string | null;
  DefinitionPath?: string;
  RepositoryName?: string;
  RepositorySlug?: string;
  Title?: string;
  Trigger?: string;
  StartedAt?: string | null;
  CompletedAt?: string | null;
  Init?: Record<string, string> | null;
  Status?: RwxRun['Status'];
}

/**
 * The branch a run belongs to, from metadata OR the title convention.
 *
 * Push-created runs carry `Branch`; CLI-triggered runs (script/rwx and our own
 * Start-run button) carry an EMPTY Branch — their only branch signal is the
 * org-wide title convention `"<branch> - <email>"` that script/rwx writes.
 * Without this, every manually-started run is invisible and a branch whose
 * specs just passed still reads "never run".
 */
export const titleBranch = (title: string): string | undefined => {
  return /^([A-Z][A-Z0-9]+-\d+)\s+-\s/.exec(title.trim())?.[1];
}

export const branchOfRun = (run: RwxRun): string | undefined => {
  return run.Branch || titleBranch(run.Title);
}

/**
 * Did this run produce an actual result?
 *
 * This is the crux of the whole CI model. A `waiting` run is **not** coverage:
 * rocket's `.rwx/ci.yml` uses `start: manually`, so a run is created on every push
 * and then sits there. On ENG-118 every single `.rwx/ci.yml` run back to
 * 2026-07-09 is `waiting` — the spec suite has never run. Treating `waiting` as
 * "a run exists, so we're covered" would report that branch as fine.
 */
export const isCompleted = (run: RwxRun): boolean => {
  return (
    run.Status.Execution === 'finished' &&
    (run.Status.Result === 'succeeded' || run.Status.Result === 'failed')
  );
}

export const isTerminal = (run: RwxRun): boolean => {
  return run.Status.Execution === 'finished' || run.Status.Execution === 'aborted';
}
