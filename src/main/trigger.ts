import { dialog } from 'electron';
import { executeTrigger, inFlightRun, planTrigger, type TriggerDeps, type TriggerResult } from '../core/trigger';
import type { WatchItem } from '../core/types';

export type { TriggerDeps, TriggerResult } from '../core/trigger';

/**
 * The Electron shell around ../core/trigger: a native confirm dialog, then the
 * shared execute path. See core/trigger.ts for why the split exists (the web
 * UI confirms in the browser instead).
 *
 * Two things worth knowing about the mechanics:
 *
 * 1. It passes the **MR's head sha**, not local `git rev-parse HEAD`.
 *    `.rwx/ci.yml`'s `git/clone` task clones `ref: ${{ init.commit-sha }}`
 *    straight from GitLab and has no local-files task, so the run tests exactly
 *    the commit the MR proposes — independent of what's checked out or
 *    uncommitted locally. A branch can be started without switching to it.
 *
 * 2. RWX has no API to start an *existing* `waiting` run, so this creates a new
 *    run pinned to the same commit. Equivalent in effect; the original waiting
 *    run stays waiting. Said plainly in the dialog so it isn't a surprise.
 */
export const startRunFor = async (
  deps: TriggerDeps,
  item: WatchItem,
): Promise<TriggerResult> => {
  const plan = planTrigger(deps.config, item);
  if (typeof plan === 'string') return { started: false, message: plan };

  const inFlight = inFlightRun(deps.db, item);
  if (inFlight) {
    // `started: true` so the button flips to "Current run" with the link.
    return {
      started: true,
      message: 'A run for this commit is already in flight.',
      ...(inFlight.url ? { url: inFlight.url } : {}),
    };
  }

  const short = item.headSha.slice(0, 8);
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Cancel', 'Start run'],
    defaultId: 1,
    // Escape and the red X both cancel — an accidental dismissal must not spend
    // CI minutes.
    cancelId: 0,
    title: 'Start RWX run',
    message: `Start ${plan.definition} for ${item.branch}?`,
    detail:
      `${item.key}\n${item.title}\n\n` +
      `Commit:  ${short} (the MR's head)\n` +
      `Repo:    ${plan.checkout}\n\n` +
      'This creates a new run for that commit and consumes CI minutes. ' +
      'Any run already waiting for this commit stays waiting — RWX has no API ' +
      'to start an existing one.',
  });

  if (response !== 1) return { started: false, message: 'Cancelled.' };
  return executeTrigger(deps, item, plan);
}
