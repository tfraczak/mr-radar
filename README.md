# MR Radar

[![CI](https://github.com/tfraczak/mr-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/tfraczak/mr-radar/actions/workflows/ci.yml)

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

## Install

```bash
git clone https://github.com/tfraczak/mr-radar.git && cd mr-radar
./install.sh
```

That's the whole install. The script checks prerequisites, installs
dependencies, builds, and registers the menu bar app under launchd — it starts
at login, restarts on crash, and the script is safe to re-run any time
(including after `git pull`, to update).

It installs anything that's missing along the way: Homebrew (asks first),
nvm + the pinned Node, and [`glab`](https://gitlab.com/gitlab-org/cli) via
brew — and it walks you through `glab auth login` if you aren't authenticated
yet. The optional [`rwx`](https://rwx.com) CLI is offered during install
(answer no unless some of your repos gate their specs on RWX).

A **radar icon** appears in your menu bar when it's done. Click it → **Open**
for the popover, then walk through the first-run setup below.

## Manual installation

If the script trips on something, the steps it automates are each one command:

```bash
corepack enable   # provides the pinned Yarn, no global install
                  # (if corepack itself is missing: npm install -g corepack)
yarn install
yarn build
yarn tray:install # register + start the launchd agent
```

`yarn tray:status` reports whether the agent is running, whether `dist/` exists,
and whether the app answers on its own port — the first thing to run if no icon
appears. `yarn tray:uninstall` removes the agent again. For a one-off run without
installing anything: `yarn install && yarn dev` (dies with the terminal).
If Electron can't run on your machine at all, there's a headless poller with a
web UI instead — see its section below (`yarn poller:install`). A normal
packaged `.app` also builds with `yarn package`, a drag-to-Applications disk
image with `yarn package:dmg`, and a `.pkg` installer with `yarn package:pkg`
— see "Signing for distribution" below before sharing any of them.

## First-run setup

### Step 1 — connect Jira

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

**If your org designates the developer via a custom field** (a user-picker like a
"Dev Resource" field), add it under Settings → Jira → **My-ticket fields**: the picker
lists your site's real user-valued fields, and any you select count a ticket as yours
(`field = currentUser()`), alongside the default Assignee + Watcher.

### Step 2 — tell it how your statuses map (optional)

Settings → **Jira** also holds the status→section mapping. Every status the app has ever
seen on your tickets is offered as a chip in four multi-selects:

- **Active (watch list)** — tickets in these statuses drive MR scope (defaults:
  In Development, Code Review, Dev Complete);
- **Verification** — out of dev's hands, collapsed section;
- **Done** — collapsed at the bottom; long-closed tickets disappear;
- **Hide** — never shown at all (Backlog noise). Not to be confused with *ignoring*:
  hidden statuses vanish entirely, while ignored MRs (below) stay one click away.

Anything unassigned lands in a collapsed "Other" section, so nothing is silently lost.
**Advanced: conditional rules** routes by ticket fields — the shipped example sends a
Dev Complete ticket with *no fix version* to its own "needs a fix version" section (with an
in-app picker) and versioned ones to Verification. Rules support per-repo scoping, issue-type
regexes, due dates, clone/remove, and fall-through.

**Tickets with no MR.** (On a GitHub install every label below reads *PR* — the wording
follows the resolved forge; only the app's own name stays MR Radar.) The radar is MR-shaped, so the one state it can't show from the
GitLab side is *you haven't started*: a ticket assigned to you, in flight, with no branch
pushed. Those tickets get a collapsed **No MR yet** section of their own, above Verification: one
dashed placeholder row each, carrying the Jira summary and a **No MR yet** line — muted by
default, and a warning at the statuses where an MR really is expected (Settings → **Jira** → *Tickets without an MR*,
default `Code Review`). **Advanced: which tickets need an MR** decides case by case with the
same rule builder: `(any status)` when *issueType* matches `spike|research` → **exempt**
drops the row entirely, **expect** promotes it to a warning. Statuses mapped to
Verification/Done/Hide are skipped — a ticket gets there *after* its MR merged, and merged
MRs leave the radar. The rows still count toward **My work** so nothing goes missing, and
the **No MR yet** filter narrows to just them (which opens the section).

**Ignoring MRs.** Two paths, one destination: a status rule with the `ignore` target
(e.g. the `(no ticket)` sentinel), or the eye control on any ticket header/row. Either way
the MR moves to a collapsed **Ignored** section at the very bottom and goes fully silent —
no notifications, no unread badge, no counts — until the MR closes. The closed eye on an
ignored row restores it (pinning that one MR visible if a rule ignores it).

**Copy for Slack.** Rows that look ready to announce for code review — ticket in a
ready status (Settings → **Slack**, default `Code Review`), every check
green for the current head commit (repos without CI — a scripts repo, say — are exempt
via their `none` test gate; repos with RWX *and* a pipeline need both), no open review
threads, not a draft, no conflicts — grow a **Copy for Slack** button. Clicking it
re-fetches that one MR fresh (MR state, ticket status, discussions, CI) and either copies
the announcement to the clipboard or tells you exactly what still blocks it. The message
template lives in Settings → **Slack** with a variable legend and a live preview —
`{ticketKey}`, `{ticketUrl}` (Jira link), `{title}` (MR subject line, leading ticket key stripped), `{mrUrl}` — so the
announcement speaks in your voice. Named links use `[text](url)` (the **Insert link**
button writes one for you): the copy carries both clipboard flavors, so Slack's composer
pastes `[{ticketKey}]({ticketUrl})` as a real hyperlink while plain targets (pbcopy,
terminals) see `ENG-123 (https://…)`.

### Step 3 — repos and CI (only for RWX users)

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

### Step 4 — notifications

Settings → **Notifications**: pick a sound and a delivery method, then verify with the menu
bar icon → **Send test notification**.

- `auto` — delivers via `osascript`. Always works, generic icon, no click action.
- `native` — Electron's banners: app icon, and **clicking jumps straight to the MR** and
  flashes its row in the popover. Requires macOS to accept the binary's notification
  registration (check System Settings → Notifications for an "Electron" entry after a test).
- `terminal-notifier` — icon + click-to-open for the headless poller
  (`brew install terminal-notifier`). Some application-control software blocks it.

### Step 5 — verify

```bash
yarn status       # one live read-only cycle: source health, in-scope MRs, would-be events
yarn tray:logs    # follow the running agent's log ("cycle ok · N api calls" is healthy)
```

### If something's off

| Symptom | Fix |
|---|---|
| No radar icon | `yarn tray:status` — it separates the two causes. If it reports the app running and serving, the icon exists and your **menu bar is full**: macOS hides the overflow (behind the notch on laptops) with no indication — ⌘-drag to reorder, use an overflow manager (Ice/Bartender), or just open `http://127.0.0.1:8942`. Otherwise the startup crashed: `yarn tray:logs`, fix, `yarn tray:install`. |
| Footer shows GitLab red | `glab auth status`, then `glab auth login`. |
| "Set the Atlassian URL…" | Settings → Jira needs the URL *saved* before a token can be connected. |
| Token rejected | It's verified against `/rest/api/3/myself` — check the email matches the token's account. |
| No banners | Send a test notification; on `native`, check System Settings → Notifications → Electron. Fall back to `auto`. |
| Stale UI after `yarn build` | The running agent keeps old code: `yarn tray:restart`. |
| Start run refuses | The repo row in Settings → General needs a valid local checkout path. |
| `yarn install` dies with `SIGKILL` / a temp `xfs-*/build.log` | Application-control software (ThreatLocker et al) killed a dependency's native postinstall — not a broken package. Ask for that binary to be approved, or: `YARN_ENABLE_SCRIPTS=false yarn install && yarn rebuild electron`. esbuild's postinstall is already disabled in `package.json` for exactly this reason. |
| Watching the wrong forge | `./install.sh` seeds `forge: gitlab`; switch it in Settings → Git (`auto` detects from whichever CLI is authenticated). |

### Updating

```bash
git pull && ./install.sh
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

A ticket with no merge request at all gets one dashed row in the collapsed **No MR yet**
section instead (see *Tickets without an MR* above), so work you haven't pushed can't hide
behind the absence of an MR.

Clicking a row opens the MR; clicking a CI chip opens the run or pipeline; clicking a ticket
opens Jira (a no-MR row opens its ticket — there's nothing else to open). The footer shows per-source health and the last poll time.

## Scope: why it's not just "all my MRs"

Only MRs whose branch maps to a Jira ticket in an **active** status are watched — plus
review requests, which are always in scope. That's the whole point of querying Jira: it
turns a wall of stale MRs into the few that are actually in flight. Which statuses count as
active, and where every other status lands (Verification / Done / Hide / Other), is
configurable in Settings → Jira, including conditional routing rules
("*Dev Complete* in *any repo* when *fixVersions* *empty* → *needs a fix version*").

## Notifications

Banners on new comments (human and bot alike), reviews, approvals, conflicts, and CI
results. Volume is kept sane:

- comments on one MR in a cycle collapse into a single banner;
- an unverified-tests nudge fires **once per push**, never repeatedly;
- the very first run (or any run after the database is cleared) seeds silently.

**Which events notify is a grid, not a switch.** Settings → **Notifications** lists every
event type down the side and the three buckets across the top — *My work*, *My reviews*,
*Participating* — so you can say "everything on my own MRs, but only comments and
new-commits on the ones I'm reviewing". Unchecked events are never announced; the row
still shows them when you look. Suppression happens at the banner, never at the
recording, so switching a type back on reports what happens next instead of replaying the
backlog. The shipped default: everything on your own MRs, and on other people's, the human
traffic (comments, approvals, reviews, conflicts) but not their CI.

**MRs you review get one signal of their own:** the author pushed since you last spoke.
The row grows an **updated** badge, the attention line reads "New commits since your
comment", and the banner fires once per push. It compares the head commit's date against
your newest comment — the real question, rather than "the MR changed somehow" — and the
commit list is fetched once per push, not per cycle.

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

**The web UI is the popover** — both the tray and the poller serve the exact same renderer
at `http://127.0.0.1:8942` (configurable via `web.port`). It binds to 127.0.0.1 only, rejects
non-localhost Host headers (DNS rebinding), and requires a per-process token on every API
call, which cross-origin pages can neither read nor send.

## CLI / agent access

`radar-cli` is an app client: it reads and drives the *running* radar (tray or poller)
instead of running its own poll cycle. It's built for agents as much as for humans —
Claude Code can shell out to it directly.

```bash
yarn radar status                 # build + run; humans
node --no-warnings dist/radar-cli.js status --json    # agents (no rebuild per call)
```

```bash
radar-cli status                          # app health, polling state, section counts
radar-cli list --section active           # watched MRs (also: --ticket ENG-123)
radar-cli show 'acme/rocket!7576'         # full detail: test gate, checks, approvals
radar-cli discussions 'acme/rocket!7576'  # review threads with comment bodies (live only)
radar-cli events --limit 20               # notification history
radar-cli tickets                         # cached Jira tickets
radar-cli run 'acme/rocket!7576'          # start an RWX run (safe to retry)
radar-cli ignore 'acme/rocket!7576'       # mute until it closes (unignore restores)
radar-cli slack 'acme/rocket!7576'        # fresh ready-for-review check → message (| pbcopy)
radar-cli pause / resume / poll           # polling controls
```

**The hybrid model:** read commands work even when the app is closed — they fall back to a
read-only open of the local database and flag the result `stale` with the last-poll
timestamp. Action commands need the live app and exit `2` with recovery guidance otherwise.
`--json` emits stable machine shapes: `{source: "live"|"db", dataAsOf, stale?, staleNote?,
...payload}`.

**Discovery and security:** the running app writes `~/.local/state/mr-radar/web-token.json`
(mode 0600) with its API token and port; the CLI reads that file. The posture is unchanged
from the web UI — localhost only, same-user file, no new listener, and no secrets in
`config.json`.

To give an agent standing access from another repo, add a line like this to that repo's
`CLAUDE.md`:

> MR/CI status for this machine is available via
> `node --no-warnings ~/code/personal/mr-radar/dist/radar-cli.js <cmd> --json`
> (try `status`, `list`, `show <mr-key>`, `discussions <mr-key>`).

### MCP server

The same nine capabilities are also exposed as an MCP stdio server (hand-rolled protocol
core — still zero runtime dependencies) for agent clients that speak MCP instead of
shelling out:

```bash
yarn build
claude mcp add mr-radar -- node --no-warnings "$PWD/dist/mcp.js"
```

or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "mr-radar": { "command": "node", "args": ["--no-warnings", "/path/to/mr-radar/dist/mcp.js"] }
  }
}
```

Tools: `radar_status`, `radar_mrs`, `radar_mr`, `radar_discussions`, `radar_events`,
`radar_tickets` (reads — the first three and last two work app-down, flagged stale), plus
`radar_review_message`, `radar_set_ignored`, `radar_start_run`, `radar_set_polling`,
`radar_poll_now` (actions — need the live app; your
MCP client's tool-permission prompt is the confirmation for `radar_start_run`). CLI and MCP
share the same client module, so their hybrid semantics are identical. Smoke-test with
`npx @modelcontextprotocol/inspector node dist/mcp.js`.

## Signing for distribution

Artifacts built on your own machine open fine locally, but a DMG someone
*downloads* is quarantined: unsigned apps hit Gatekeeper's wall (on current
macOS, System Settings → Privacy & Security → "Open Anyway" is the only
bypass — right-click → Open no longer works for unsigned apps). Opening
cleanly on other people's Macs takes two things, both automated here:

1. **A Developer ID certificate.** Join the Apple Developer Program
   ($99/year, individual is fine), then in Xcode → Settings → Accounts →
   Manage Certificates create a **Developer ID Application** certificate
   (and **Developer ID Installer** if you'll ship signed .pkg). It lands in
   your login keychain, where electron-builder finds it by name.
2. **Notarization.** Since macOS 10.15 signing alone isn't enough — Apple
   must scan and notarize the build. Generate an app-specific password at
   appleid.apple.com, note your Team ID (developer.apple.com → Membership),
   and export:

   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="XXXXXXXXXX"
   yarn package:signed
   ```

`yarn package:signed` signs with the hardened runtime (entitlements in
assets/entitlements.mac.plist cover Electron's JIT), uploads to Apple's
notary service, waits for the verdict, and staples the ticket — the
resulting DMG opens on any Mac with only the standard "downloaded from the
internet" prompt. Regular `yarn package*` builds stay unsigned for local
use.

A signed, notarized app also carries your stable Team ID — exactly the
identity app-control software (ThreatLocker and similar) can allowlist
permanently, instead of chasing ad-hoc hashes that change every build.

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
GitHub Actions (`.github/workflows/ci.yml`) runs typecheck + lint + test +
build on every push and PR, on Linux and macOS. A GitLab CI config
(`.gitlab-ci.yml`) with the same gate is included too, so a mirror on a GitLab
instance gets pipelines for free.

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
