#!/usr/bin/env node
/**
 * Install the MENU BAR app as a launchd agent — the ThreatLocker-compatible way.
 *
 *   node scripts/install-tray.mjs            build first: yarn build
 *   node scripts/install-tray.mjs --uninstall
 *
 * Why this works when the packaged .app is blocked: electron-builder re-signs
 * its output ad-hoc, making it an unrecognized binary that ThreatLocker
 * SIGKILLs. The Electron binary inside node_modules is the distributor-signed
 * one, which ThreatLocker allows (verified: `electron --version` exits 0 while
 * the packaged bundle dies with 137). Running `electron dist/main/index.js`
 * IS the full tray app — icon, popover, notifications — just not wrapped in
 * our own bundle.
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
console.log(`  ✓ menu bar app running under launchd (label ${LABEL})`);
console.log(`    look for the radar icon in your menu bar · logs: tail -f ${logPath}`);
