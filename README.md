# MR Radar

A local macOS tool that watches your GitLab merge requests and tells you when
something needs you — a comment, a review, an approval, a merge conflict, or a CI result —
scoped to the tickets you're actually working on in Jira.

It exists to close three gaps that make MR activity easy to miss:

- **Test results can live in different systems per repo.** Repos that run specs in GitLab CI
  show status on the MR. Repos that run them in [RWX](https://rwx.com) with `start: manually`
  do not — the run is created on every push, waits for a human, and never reports back to
  GitLab, so an MR can look green while its spec suite has *never run*. MR Radar reads
  whichever system actually gates each repo and says so plainly.
- **Nothing joins the three systems.** If your branch name *is* the Jira ticket key
  (`ENG-126`), that key is also the RWX run branch — so one key ties "what I'm working on"
  to "what needs my attention" to "did it actually pass".
- **Reviews are invisible until you go looking.** This brings them to the menu bar.

## Getting set up, step by step

The app shells out to the `glab` and `rwx` CLIs, so it never holds those credentials and
never asks you for them. Total setup time is about ten minutes.

### Step 0 — prerequisites

1. **Node ≥ 22.5** (an `.nvmrc` pins the version used for development):

   ```bash
   nvm install && nvm use
   ```

2. **Yarn 4** comes via corepack — no global install:

   ```bash
   corepack enable
   ```

3. **The GitLab CLI**, authenticated against your GitLab host:

   ```bash
   brew install glab
   glab auth login
   ```

   Sanity check: `glab api user --jq .username` should print your username.

4. **The RWX CLI** — only if any of your repos run their specs on
   [RWX](https://rwx.com); skip otherwise:

   ```bash
   brew install rwx-cloud/tap/rwx
   rwx login
   ```

### Step 1 — install and launch

```bash
git clone <this repo> && cd mr-radar
yarn install
yarn dev      # builds, then launches the menu bar app
```

A **radar icon** appears in your menu bar. On this first launch the app already works in a
degraded mode: it lists your open MRs and review requests scoped by *recent activity*,
because it doesn't know your Jira tickets yet. The footer of the popover shows per-source
health, so you can see at a glance what's connected.

Click the icon → **Open** for the popover.

### Step 2 — connect Jira

This is what turns the wall of MRs into "the handful actually in flight". Ticket scoping,
the fix-version picker, and status sections all need it.

1. Menu bar icon → **Settings…** → **Jira** tab.
2. Set **Atlassian URL** to your site, e.g. `https://your-org.atlassian.net` (bare https
   origin — no path), and **Jira email** to the address you log in with. **Save.**
3. Create an API token at
   <https://id.atlassian.com/manage-profile/security/api-tokens> (Create API token → copy).
4. The popover now shows a **Connect Jira** field: paste the token and hit **Connect**. The
   app verifies it against Jira before storing it in the macOS Keychain (service
   `mr-radar`) — a bad paste is rejected on the spot, and the token never touches a file.

Within a poll cycle the popover regroups by Jira ticket, and the footer's Jira source goes
green.

### Step 3 — tell it how your statuses map (optional)

Settings → **Jira** also holds the status→section mapping. Every status the app has ever
seen on your tickets is offered as a chip in four multi-selects:

- **Active (watch list)** — tickets in these statuses drive MR scope (defaults:
  In Development, Code Review, Dev Complete);
- **Verification** — out of dev's hands, collapsed section;
- **Done** — collapsed at the bottom; long-closed tickets disappear;
- **Ignore** — never shown (Backlog noise).

Anything unassigned lands in a collapsed "Other" section, so nothing is silently lost.
**Advanced: conditional rules** routes by ticket fields — the shipped example sends a
Dev Complete ticket with *no fix version* to its own "needs a fix version" section (with an
in-app picker) and versioned ones to Verification. Rules support per-repo scoping, issue-type
regexes, due dates, clone/remove, and fall-through.

### Step 4 — repos and CI (only for RWX users)

Settings → **General** grows one row per repo the app has seen you working in:

- **checkout** — set this to your local clone (e.g. `/Users/you/code/rocket`) for any repo
  whose specs run on RWX with `start: manually`. It enables the **Start run** button on MRs
  whose specs haven't run (the `rwx` CLI needs a working tree to resolve `.rwx/` from).
  Repos on plain GitLab CI need nothing here.
- **Test gate** — leave on `auto`; the app detects per repo whether specs live in RWX or
  GitLab pipelines (or nowhere). Pin `rwx` / `gitlab` / `none` only if detection gets a
  repo wrong.
- **Use RWX for CI status** — the global switch. With it off (or with no `rwx` CLI
  installed), the app is GitLab-pipelines-only and never invokes `rwx`.

### Step 5 — notifications

Settings → **Notifications**: pick a sound and a delivery method, then verify with the menu
bar icon → **Send test notification**.

- `auto` — delivers via `osascript`. Always works, generic icon, no click action.
- `native` — Electron's banners: app icon, and **clicking jumps straight to the MR** and
  flashes its row in the popover. Requires macOS to accept the binary's notification
  registration (check System Settings → Notifications for an "Electron" entry after a test).
- `terminal-notifier` — icon + click-to-open for the headless poller
  (`brew install terminal-notifier`). Some application-control software blocks it.

### Step 6 — make it permanent

`yarn dev` dies with your terminal. Install it under launchd instead — starts at login,
restarts on crash:

```bash
yarn tray:install
```

This runs the app via the distributor-signed Electron binary in node_modules — a launch
path that also tends to survive application-control software (ThreatLocker and similar),
which often blocks ad-hoc-signed packaged apps but allows the signed Electron binary.

**Alternative — the headless poller.** If Electron can't run on your machine at all,
`yarn poller:install` registers a plain Node process instead, which notifies via
`osascript`/`terminal-notifier` and serves the *identical* popover UI as a web page at
<http://127.0.0.1:8942> (`yarn ui` opens it). Both forms share the same core, config,
database, and Keychain token; each installer removes the other agent, so you can flip
between them with one command.

You can also build a normal `.app` (`yarn package`, then drag
`release/mac-arm64/MR Radar.app` to Applications). It's ad-hoc signed, not notarized, so the
first launch may need **right-click → Open**; on app-control-managed machines it may be
blocked outright — use `yarn tray:install` instead.

### Step 7 — verify

```bash
yarn status       # one live read-only cycle: source health, in-scope MRs, would-be events
yarn tray:logs    # follow the running agent's log ("cycle ok · N api calls" is healthy)
```

### If something's off

| Symptom | Fix |
|---|---|
| No radar icon | `yarn tray:logs` — a crash on startup logs there; `yarn tray:install` again after fixing. |
| Footer shows GitLab red | `glab auth status`, then `glab auth login`. |
| "Set the Atlassian URL…" | Settings → Jira needs the URL *saved* before a token can be connected. |
| Token rejected | It's verified against `/rest/api/3/myself` — check the email matches the token's account. |
| No banners | Send a test notification; on `native`, check System Settings → Notifications → Electron. Fall back to `auto`. |
| Stale UI after `yarn build` | The running agent keeps old code: `yarn tray:restart`. |
| Start run refuses | The repo row in Settings → General needs a valid local checkout path. |

### Updating

```bash
git pull && yarn install && yarn build && yarn tray:restart
```

## API tokens — where they live

Only **one** token is app-specific, and it never lives in this repo or in a config file.

| Service | Where the token lives | How to set it |
|---|---|---|
| **Jira** | macOS Keychain — service `mr-radar`, account `jira` | Connect field in the popover, or `yarn jira:token` |
| **GitLab** | `glab`'s own credential store | `glab auth login` |
| **RWX** | `~/.config/rwx/accesstoken` | `rwx login` |

`yarn jira:token` accepts the token by interactive prompt, a pipe, or `MR_RADAR_JIRA_TOKEN`
in the environment — but **never as a command-line argument**, which would leak it to `ps`
and shell history. Either path verifies against `/rest/api/3/myself` before storing.

Only Jira gets an app-managed token, on purpose: GitLab and RWX already keep their own
credentials in their CLIs, and duplicating them would just widen the attack surface.

Everything else — Atlassian URL, email, repo checkouts, poll cadence, themes — is non-secret
and lives in `~/.config/mr-radar/config.json`, created on first run and editable from the
in-app Settings.

## What it shows

The popover has three tabs:

- **My work** — MRs you authored.
- **My reviews** — you're a requested reviewer **or** you already approved it.
- **Participating** — MRs you're neither authoring nor reviewing but are engaged with: you
  **commented** on them in the last 30 days, or you were **mentioned** (pending todos — so
  this tab shows mentions you haven't looked at yet). Rows carry a "you commented" /
  "mentioned" badge and a one-click **Become reviewer** action.

Within each tab, MRs are grouped by Jira ticket. Each row carries:

- the MR title and `project!iid`, with badges for draft, **conflict**, unresolved threads,
  approval count, and a non-default target branch;
- a **CI chip** labeled by provider so lint is never mistaken for specs — `RWX passed`,
  `CI failed` (with the failing job name), `RWX running`, `RWX never run` (checked against
  the branch's full history, not just the recent window), or `RWX stale` (it ran, but on an
  older commit);
- a **Start run** button on RWX-gated MRs whose specs haven't run, which triggers a run for
  the MR's head commit after a confirmation, then becomes **Current run** linking to the run
  page. Runs you start are watched to completion and notify their result even if they scroll
  out of RWX's recent-runs window.

Clicking a row opens the MR; clicking a CI chip opens the run or pipeline; clicking a ticket
opens Jira. The footer shows per-source health and the last poll time.

## Scope: why it's not just "all my MRs"

Only MRs whose branch maps to a Jira ticket in an **active** status are watched — plus
review requests, which are always in scope. That's the whole point of querying Jira: it
turns a wall of stale MRs into the few that are actually in flight. Which statuses count as
active, and where every other status lands (Verification / Done / Ignore / Other), is
configurable in Settings → Jira, including conditional routing rules
("*Dev Complete* in *any repo* when *fixVersions* *empty* → *needs a fix version*").

## Notifications

Banners on new comments (human and bot alike), reviews, approvals, conflicts, and CI
results. Volume is kept sane:

- comments on one MR in a cycle collapse into a single banner;
- an unverified-tests nudge fires **once per push**, never repeatedly;
- the very first run (or any run after the database is cleared) seeds silently.

Delivery `method` in Settings: `auto` uses `osascript` (always delivers, generic icon);
`native` uses Electron's notifications (app icon + **click jumps straight to the item** and
highlights it in the popover) where macOS accepts the binary's registration;
`terminal-notifier` adds icon + click-to-open for the headless poller (`brew install
terminal-notifier`) — note some application-control software blocks it.

## Battery and quiet hours

- **pauses** on sleep and lock, and while outside configured active hours;
- **backs off** from 60 s toward 15 min after quiet cycles, snapping back on any activity;
- can be **paused** outright from the menu (the icon goes hollow so it's never ambiguous).

## The menu bar app under launchd

```bash
yarn tray:install      # build + run the tray app via the signed Electron binary
yarn tray:logs         # follow its log
yarn tray:restart      # restart after a rebuild (yarn build first)
yarn tray:uninstall    # stop and remove the agent
```

Starts at login, restarts on crash. Quit from the tray menu sticks until the next login.

## The headless poller (fallback: web UI instead of a tray)

```bash
yarn poller:install    # build + register the launchd agent + start it
yarn ui                # open the UI at http://127.0.0.1:8942
yarn poller:logs       # follow the poller log
yarn poller:status     # launchctl state of the agent
yarn poller:restart    # restart after a rebuild
yarn poller:uninstall  # stop and remove the agent
yarn status            # one live read-only cycle: sources, in-scope MRs, what would notify
```

**The web UI is the popover** — the poller serves the exact same renderer at
`http://127.0.0.1:8942` (configurable via `web.port`). It binds to 127.0.0.1 only, rejects
non-localhost Host headers (DNS rebinding), and requires a per-process token on every API
call, which cross-origin pages can neither read nor send.

## Development

```bash
yarn cli --dry-run   # one real poll cycle, prints what WOULD notify, persists nothing
yarn cli --stats     # event history from the DB
yarn test            # unit tests
yarn typecheck
yarn lint
```

Everything in `src/core/` is Electron-free and unit-tested; `src/main/` is the menu bar
shell and `src/renderer/` the popover (design system in `src/renderer/ui.ts`).
`.gitlab-ci.yml` runs typecheck + lint + test on every push/MR.

Data lives in SQLite at `~/.local/state/mr-radar/mr-radar.db`. Delete it to reset; the next
run reseeds silently.

Test fixtures under `tests/fixtures/` are sanitized, anonymized derivatives of real API
responses (`scripts/capture-fixtures.sh` + `scripts/sanitize-fixtures.mjs`); raw captures
are gitignored and must never be committed.

## Tech stack

- **Electron + TypeScript** — the one Node/TS path that gives a tray icon, a popover, and
  clickable native notifications together.
- **`node:sqlite`** — SQLite from the standard library, so there's no native module to compile.
- **`glab` / `rwx` CLIs** — for GitLab and RWX, so the app holds no credentials for either.
- **No bundler** — the renderer is a browser ES module compiled by `tsc`; the build is just
  `tsc` plus a file copy.

## License

MIT — see [LICENSE](LICENSE).
