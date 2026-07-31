#!/usr/bin/env node
/**
 * Install (or remove) the headless poller as a per-user LaunchAgent.
 *
 *   node scripts/install-poller.mjs            build + install + start
 *   node scripts/install-poller.mjs --uninstall
 *
 * Why launchd rather than a terminal window: it starts at login, restarts on
 * crash, and survives closed terminals. The plist pins the exact `node` binary
 * that ran this script (nvm-managed paths aren't on launchd's PATH), sets the
 * working directory to the repo, and routes stdout/stderr to a logfile.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const LABEL = 'com.mr-radar.poller';
const TRAY_LABEL = 'com.mr-radar.tray';
const repo = resolve(join(import.meta.dirname, '..'));
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logDir = join(homedir(), '.local', 'state', 'mr-radar');
const logPath = join(logDir, 'poller.log');
const node = process.execPath;
const entry = join(repo, 'dist', 'poller.js');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const uid = userInfo().uid;
const domain = `gui/${uid}`;

const bootout = (label = LABEL) => {
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
  bootout();
  rmSync(plistPath, { force: true });
  console.log(`  ✓ uninstalled (${plistPath} removed)`);
  process.exit(0);
}

if (!existsSync(entry)) {
  console.error(`  ✗ ${entry} not found — run \`yarn build\` first.`);
  process.exit(1);
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// PATH: launchd gives agents a bare PATH; the poller's fixPath() also repairs it
// at runtime, but baking the Homebrew dirs in makes the first cycle reliable.
const PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>--no-warnings</string>
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
    <!-- Restart on crash, but respect a clean exit (e.g. second-instance guard). -->
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;

mkdirSync(dirname(plistPath), { recursive: true });
mkdirSync(logDir, { recursive: true });

// One radar at a time: the tray agent polls and notifies too, so it steps aside.
bootout(TRAY_LABEL);
rmSync(join(homedir(), 'Library', 'LaunchAgents', `${TRAY_LABEL}.plist`), { force: true });

bootout();
waitUntilGone(LABEL);
writeFileSync(plistPath, plist);
console.log(`  • wrote ${plistPath}`);
bootstrap(plistPath);
sh('launchctl', ['kickstart', `${domain}/${LABEL}`]);
console.log(`  ✓ poller running under launchd (label ${LABEL})`);
console.log(`    logs: tail -f ${logPath}`);
