#!/usr/bin/env node
/**
 * Turn raw API captures (scripts/capture-fixtures.sh → tests/fixtures/raw/,
 * gitignored) into committable, ANONYMIZED test fixtures.
 *
 * Two layers of cleaning, both mandatory before anything is committed:
 *  1. Shape reduction — keep only the fields the logic branches on (shas,
 *     statuses, job names, ancestry order). Comment bodies and titles are
 *     replaced outright.
 *  2. Anonymization — real org names, project paths, usernames, numeric ids,
 *     and ticket-key prefixes are mapped to the fixture cast: org `acme`,
 *     RWX-gated repo `acme/rocket`, GitLab-CI repo `acme/gadget`, tickets
 *     `ENG-*`, users `mira.dev` / `alex.harper` / …
 *
 * Fill in ANON below for your org before running; the committed fixtures in
 * tests/fixtures/ are the reference output shape.
 *
 * Usage: node scripts/sanitize-fixtures.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(root, 'tests', 'fixtures', 'raw');
const OUT = join(root, 'tests', 'fixtures');

/**
 * Anonymization map applied to every string field that survives shape
 * reduction. Order matters: longest keys first. Extend for your org — every
 * real project path, username, and Jira project prefix in your captures must
 * have an entry, and `yarn test` plus a manual grep are the safety net.
 */
const ANON = [
  // ['your-org/your-rwx-repo', 'acme/rocket'],
  // ['your-org/your-ci-repo', 'acme/gadget'],
  // ['your-org', 'acme'],
  // ['real.username', 'mira.dev'],
  // ['REALPREFIX-', 'ENG-'],
];

const anon = (value) => {
  if (typeof value !== 'string') return value;
  let s = value;
  for (const [from, to] of ANON) s = s.replaceAll(from, to);
  return s;
};

/** Numeric ids (users, projects) are remapped to a deterministic sequence. */
const idMap = new Map();
const anonId = (id) => {
  if (typeof id !== 'number' || id < 100000) return id;
  if (!idMap.has(id)) idMap.set(id, 1000001 + idMap.size);
  return idMap.get(id);
};

/**
 * Provenance scrub: real SHAs, run ids, discussion ids, and note/pipeline ids
 * are opaque, but they still originate from the real org's systems. Hex tokens
 * map via salted hash (prefix-consistent, so short SHAs quoted in system-note
 * bodies keep matching their long forms); embedded long digit runs map through
 * the same path since digits are valid hex.
 */
const SALT = 'mr-radar-fixture-scrub-v1';
const hexMap = new Map();
const anonHex = (tok) => {
  if (!hexMap.has(tok)) {
    let h = createHash('sha256').update(SALT + tok).digest('hex');
    while (h.length < tok.length) h += createHash('sha256').update(h).digest('hex');
    hexMap.set(tok, h.slice(0, tok.length));
  }
  return hexMap.get(tok);
};
/** Scrub hex tokens and long digit runs embedded in free text (bodies, urls). */
const anonText = (v) =>
  typeof v === 'string' ? anon(v).replace(/\b[0-9a-f]{8,64}\b/g, (m) => anonHex(m)) : v;

const read = (name) => {
  const p = join(RAW, `${name}.json`);
  if (!existsSync(p)) {
    console.error(`  missing ${p} — run yarn verify:fixtures first`);
    return undefined;
  }
  return JSON.parse(readFileSync(p, 'utf8'));
};

const write = (name, data) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  const n = Array.isArray(data) ? data.length : Object.keys(data).length;
  console.log(`  ${name}.json (${n} entries)`);
};

console.log('Sanitizing fixtures:');

// RWX runs carry no prose beyond the run title, which mirrors the commit
// subject. Keep only what the coverage logic reads.
const rwx = read('rwx-runs-branch');
if (rwx) {
  write(
    'rwx-eng118',
    (rwx.Runs ?? []).map((r) => ({
      ID: anonHex(r.ID),
      Branch: anon(r.Branch),
      CommitSha: r.CommitSha ? anonHex(r.CommitSha) : r.CommitSha,
      DefinitionPath: r.DefinitionPath,
      RepositoryName: anon(r.RepositoryName),
      RunUrl: anonText(r.RunUrl),
      Title: 'redacted',
      Trigger: r.Trigger,
      CreatedAt: r.CreatedAt,
      StartedAt: r.StartedAt,
      CompletedAt: r.CompletedAt,
      Status: r.Status,
    })),
  );
}

// Pipelines: ids, statuses, shas, refs and sources. `source` matters because a
// single push yields both a `push` and a `merge_request_event` pipeline.
for (const [src, dest] of [
  ['pipelines-ci-repo', 'pipelines-gadget'],
  ['pipelines-rwx-repo', 'pipelines-rocket'],
]) {
  const pipes = read(src);
  if (!pipes) continue;
  write(
    dest,
    pipes.map((p) => ({
      id: anonId(p.id),
      status: p.status,
      source: p.source,
      ref: anon(p.ref),
      sha: anonHex(p.sha),
      web_url: anonText(p.web_url),
      created_at: p.created_at,
      updated_at: p.updated_at,
    })),
  );
}

// Commit list: shas and ancestry order only. Titles are redacted but the
// duplicate timestamps are preserved deliberately — they are what proves the
// counting logic must not sort by date.
const commits = read('mr-rwx-commits');
if (commits) {
  write(
    'commits-eng118',
    commits.map((c, i) => ({
      id: anonHex(c.id),
      title: `commit ${i + 1}`,
      committed_date: c.committed_date,
    })),
  );
}

// Discussions: structure, authorship and resolution state, bodies replaced.
for (const [src, dest] of [
  ['mr-ci-discussions', 'discussions-gadget320'],
  ['mr-rwx-discussions', 'discussions-rocket7576'],
]) {
  const discussions = read(src);
  if (!discussions) continue;
  write(
    dest,
    discussions.map((d) => ({
      id: anonHex(d.id),
      individual_note: d.individual_note,
      notes: d.notes.map((n, noteIdx) => ({
        id: anonId(n.id),
        author: { id: anonId(n.author.id), username: anon(n.author.username), name: anon(n.author.username) },
        body: n.system ? anonText(n.body.slice(0, 40)) : `redacted comment ${noteIdx + 1}`,
        created_at: n.created_at,
        updated_at: n.updated_at,
        system: n.system,
        resolvable: n.resolvable ?? false,
        ...(n.resolved !== undefined ? { resolved: n.resolved } : {}),
        ...(n.position ? { position: { new_path: anon(n.position.new_path), new_line: n.position.new_line } } : {}),
      })),
    })),
  );
}

// Job names are the whole point of role detection, so they are kept verbatim.
console.log('\nNote: pipeline job fixtures are hand-written in tests/ci.test.ts');
console.log('      (rocket = ruby::lint only, gadget = ruby::rspec::*) so the');
console.log('      classification contract is readable in the test itself.');
console.log('\nBefore committing: grep the output for your real org/user names.\n');
