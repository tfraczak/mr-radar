#!/usr/bin/env node
/**
 * Install the MENU BAR app as a launchd agent — no bundle of our own to sign.
 *
 *   node scripts/install-tray.mjs            build first: yarn build
 *   node scripts/install-tray.mjs --uninstall
 *
 * What this does and does not buy you, measured rather than assumed:
 *  - it runs ONE unsigned-ish binary instead of shipping a second one. Both the
 *    node_modules Electron and electron-builder's output are ad-hoc signed
 *    (`codesign -dvv`: `Signature=adhoc`, `TeamIdentifier=not set`), so neither
 *    carries a certificate an app-control policy could trust;
 *  - it needs no bundle rebuild, so an approval keyed to this path or hash keeps
 *    working, while every `yarn package` mints a fresh thing to approve.
 * It does NOT dodge application control, and the permission is PATH-scoped, not
 * hash-scoped — measured, not assumed: the same Electron bytes copied to
 * /private/tmp were blocked as "Unrecognized" on a machine where the
 * node_modules copy runs fine, and a teammate's identical file at her own path
 * was blocked too. Plain CLI Mach-O binaries were not caught at all in the same
 * test, so the policy is aimed at .app bundles.
 *
 * Practical consequence for a rollout: ask for a path rule (a wildcard over
 * any user's node_modules/electron/dist/Electron.app/Contents/MacOS/Electron)
 * rather than a hash approval — a hash dies at the next Electron bump, a path survives it.
 * Until then the way in is the headless poller: its agent runs plain node, and
 * nothing in its import graph touches electron.
 *
 * Where Electron is blocked outright, the headless poller is the way in: its
 * agent runs plain node and nothing in its import graph touches electron.
 *
 * Running `electron dist/main/index.js` IS the full tray app — icon, popover,
 * notifications — just not wrapped in our own bundle.
 *
 * Mutually exclusive with the headless poller agent: both poll and notify, so
 * running both would double every banner. Installing one removes the other.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const LABEL = 'com.mr-radar.tray';

// `launchctl kickstart -k` can return success while the old process survives
// (single-instance handoff); installs here always bootout + bootstrap and then
// verify launchd is tracking a live pid.
const verifyRunning = () => {
  try {
    const out = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { encoding: 'utf8' });
    const m = out.match(/pid = (\d+)/);
    if (!m) throw new Error('no pid');
    process.kill(Number(m[1]), 0); // liveness probe, no signal delivered
    return Number(m[1]);
  } catch {
    return undefined;
  }
};
const POLLER_LABEL = 'com.mr-radar.poller';
const repo = resolve(join(import.meta.dirname, '..'));
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logDir = join(homedir(), '.local', 'state', 'mr-radar');
const logPath = join(logDir, 'tray.log');
const entry = join(repo, 'dist', 'main', 'index.js');
const webloc = join(homedir(), 'Applications', 'MR Radar.webloc');

// The path to the signed Electron binary, resolved the same way `yarn dev` does.
const require = createRequire(import.meta.url);
const electron = require('electron');
if (typeof electron !== 'string' || !existsSync(electron)) {
  console.error('  ✗ could not resolve the electron binary — is node_modules installed?');
  process.exit(1);
}

const uid = userInfo().uid;
const domain = `gui/${uid}`;
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const bootout = (label) => {
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
    console.log(`  • stopped ${label}`);
  } catch {
    // Not loaded — fine.
  }
};


/** launchd tears services down asynchronously after bootout — bootstrapping
 * the same label too soon fails with EIO (5). Wait for the teardown, and give
 * bootstrap a few tries for good measure. */
const waitUntilGone = (label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      execFileSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' });
    } catch {
      return; // not loaded — safe to bootstrap
    }
    execFileSync('sleep', ['0.2']);
  }
};

const bootstrap = (path) => {
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('launchctl', ['bootstrap', domain, path], { stdio: 'inherit' });
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
      console.log(`  • bootstrap busy (attempt ${attempt}), retrying…`);
      execFileSync('sleep', ['0.5']);
    }
  }
};

if (process.argv.includes('--uninstall')) {
  bootout(LABEL);
  rmSync(plistPath, { force: true });
  console.log(`  ✓ uninstalled (${plistPath} removed)`);
  process.exit(0);
}

if (!existsSync(entry)) {
  console.error(`  ✗ ${entry} not found — run \`yarn build\` first.`);
  process.exit(1);
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(electron)}</string>
    <string>${xml(entry)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(PATH)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <!-- Restart on crash; respect a clean exit (e.g. Quit from the tray menu
         sticks until the next login rather than fighting the user). -->
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;

mkdirSync(dirname(plistPath), { recursive: true });
mkdirSync(logDir, { recursive: true });

// One radar at a time: the poller agent and its web-UI shortcut step aside.
bootout(POLLER_LABEL);
rmSync(join(homedir(), 'Library', 'LaunchAgents', `${POLLER_LABEL}.plist`), { force: true });
rmSync(webloc, { force: true });

bootout(LABEL);
waitUntilGone(LABEL);
writeFileSync(plistPath, plist);
console.log(`  • wrote ${plistPath}`);
bootstrap(plistPath);
sh('launchctl', ['kickstart', `${domain}/${LABEL}`]);
const pid = verifyRunning();
if (!pid) {
  console.error('  ✗ agent registered but no live process — check the log below');
  process.exit(1);
}
console.log(`  ✓ menu bar app running under launchd (label ${LABEL}, pid ${pid})`);
// Running is not the same as visible: a full menu bar hides new icons (behind
// the notch on laptops) with no indication at all, which reads as a failed
// install. Say so here, where someone is looking, rather than in the README.
console.log("    can't see the radar icon? the menu bar may be full — run `yarn tray:status`");
console.log(`    look for the radar icon in your menu bar · logs: tail -f ${logPath}`);
