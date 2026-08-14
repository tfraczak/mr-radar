#!/usr/bin/env node
/**
 * Answer "is the menu bar app actually running?" in one command.
 *
 * "The icon isn't showing up" has two completely different causes and the icon
 * itself can't tell you which: the agent never started, or it started fine and
 * the icon is off-screen — macOS silently hides menu bar overflow behind the
 * notch, and a work Mac's menu bar fills up fast. This prints the four facts
 * that separate those: launchd's opinion, whether the build exists, whether the
 * process answers on its own HTTP port, and the tail of its log.
 *
 * Read-only: it starts nothing and changes nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.mr-radar.tray';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(repo, 'dist', 'main', 'index.js');
const logPath = join(homedir(), '.local', 'state', 'mr-radar', 'tray.log');
const tokenPath = join(homedir(), '.local', 'state', 'mr-radar', 'web-token.json');

const line = (label, value) => console.log(`  ${`${label}:`.padEnd(10)} ${value}`);

console.log('MR Radar — menu bar app status\n');

// 1. launchd. `print` fails outright when the label was never registered, which
//    is a different answer from "registered but not running".
let pid;
try {
  const out = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const found = out.match(/pid = (\d+)/);
  if (found) {
    try {
      process.kill(Number(found[1]), 0); // liveness probe, no signal delivered
      pid = Number(found[1]);
      line('launchd', `running (pid ${pid})`);
    } catch {
      line('launchd', `registered, but pid ${found[1]} is gone`);
    }
  } else {
    const state = out.match(/state = (\S+)/)?.[1] ?? 'unknown';
    line('launchd', `registered but not running (state ${state}) — run: yarn tray:install`);
  }
} catch {
  line('launchd', `no agent registered (${LABEL}) — run: yarn tray:install`);
}

// 2. The build the agent runs. A missing dist is why a fresh clone's agent dies
//    on launch, and `yarn tray:restart` alone never creates it.
line(
  'build',
  existsSync(entry)
    ? `dist present (built ${new Date(statSync(entry).mtimeMs).toLocaleString()})`
    : 'dist MISSING — run: yarn build',
);

// 3. The app's own HTTP port. Answering here proves the process is alive and
//    serving even when nothing is visible in the menu bar.
let health;
try {
  const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
  const res = await fetch(`http://127.0.0.1:${token.port}/api/health`);
  health = await res.json();
  line(
    'web api',
    `responding on 127.0.0.1:${token.port} (mode ${health.mode}, v${health.version}` +
      `${health.lastPollAt ? `, last poll ${new Date(health.lastPollAt).toLocaleTimeString()}` : ', no poll yet'})`,
  );
} catch {
  line('web api', existsSync(tokenPath) ? 'not responding' : 'no token file — the app has not served yet');
}

// 4. Can Electron run at all? The decisive question when nothing started: app
//    control kills it silently, and our code never runs to log anything.
let electronOk;
try {
  const { createRequire } = await import('node:module');
  const bin = createRequire(import.meta.url)('electron');
  if (typeof bin !== 'string' || !existsSync(bin)) throw new Error('unresolved');
  execFileSync(bin, ['--version'], { stdio: 'ignore' });
  electronOk = true;
  line('electron', 'runs (node_modules binary is approved on this machine)');
} catch (err) {
  electronOk = false;
  const why = err?.signal ? `killed with ${err.signal}` : `exit ${err?.status ?? '?'}`;
  line('electron', `WILL NOT RUN (${why}) — application control, not a broken install`);
}

// 5. The log, which is where a startup crash lands.
if (existsSync(logPath)) {
  const tail = readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-5);
  console.log(`\n  last log lines (${logPath}):`);
  for (const l of tail) console.log(`    ${l}`);
} else {
  console.log(`\n  no log yet at ${logPath}`);
}

// Electron blocked: the menu bar app can never start here, and there is a
// fallback that needs no Electron at all.
if (electronOk === false) {
  console.log(`
  The menu bar app cannot run on this machine: something killed Electron before
  our code executed, which is why there is no icon and nothing in the log. Two
  ways forward:
    • ask for this path to be approved, then re-run ./install.sh
    • use the headless poller instead — plain node, no Electron, same polling and
      notifications, and the same UI in a browser:  yarn poller:install`);
}

// The case people actually hit: it IS running, and the icon is off-screen.
if (pid && health) {
  console.log(`
  The app is running and serving. If you still can't see the radar icon, the
  menu bar is out of room — macOS hides the overflow (behind the notch on
  laptops) with no indication. Options:
    • open the UI in a browser instead:  http://127.0.0.1:${JSON.parse(readFileSync(tokenPath, 'utf8')).port}
    • ⌘-drag menu bar icons to reorder, and drop something you don't need
    • use an overflow manager (Ice, Bartender) to reveal hidden items`);
}
