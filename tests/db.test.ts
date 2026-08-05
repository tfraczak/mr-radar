import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Db, openReadOnlyDb } from '../src/core/db';
import type { AppEvent } from '../src/core/types';

const tmp = mkdtempSync(join(tmpdir(), 'radar-db-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('read-only Db', () => {
  it('reads alongside the writer without migrating or writing', () => {
    const path = join(tmp, 'live.db');
    const writer = new Db(path);
    writer.setMeta('last_poll_at', '2026-08-05T12:00:00Z');
    writer.recordEvents(
      [{ type: 'comment', mrKey: 'acme/rocket!1', branch: 'ENG-1' } as unknown as AppEvent],
      '2026-08-05T12:00:00Z',
      false,
    );

    // Second handle while the writer is still open — the WAL scenario.
    const reader = openReadOnlyDb(path);
    expect(reader).toBeDefined();
    expect(reader!.getMeta('last_poll_at')).toBe('2026-08-05T12:00:00Z');
    expect(reader!.recentEvents(10)).toHaveLength(1);
    expect(reader!.eventStats()).toEqual([{ type: 'comment', n: 1 }]);

    // The type strips the write surface; the handle rejects writes at runtime
    // too, which is what protects the writer from a buggy caller.
    expect(() => (reader as Db).setMeta('k', 'v')).toThrow();

    reader!.close();
    writer.close();
  });

  it('returns undefined when the app has never run (no DB file)', () => {
    expect(openReadOnlyDb(join(tmp, 'never-ran.db'))).toBeUndefined();
  });

  it('returns undefined for an existing but never-migrated file', () => {
    // e.g. a zero-byte file left by a crashed first run, or a foreign file.
    const path = join(tmp, 'empty.db');
    writeFileSync(path, '');
    expect(openReadOnlyDb(path)).toBeUndefined();
  });

  it('filters recentEvents by MR key in SQL', () => {
    const db = new Db(':memory:');
    db.recordEvents(
      [
        { type: 'comment', mrKey: 'acme/rocket!1', branch: 'a' },
        { type: 'approval', mrKey: 'acme/gadget!2', branch: 'b' },
      ] as unknown as AppEvent[],
      '2026-08-05T12:00:00Z',
      false,
    );
    expect(db.recentEvents(10, 'acme/gadget!2').map((e) => e.type)).toEqual(['approval']);
    expect(db.recentEvents(10)).toHaveLength(2);
  });
});

describe('ignore override', () => {
  it('survives the per-cycle upsert and dies with the pruned row', () => {
    const db = new Db(':memory:');
    const row = {
      key: 'acme/rocket!1',
      project_path: 'acme/rocket',
      project_id: 1,
      iid: 1,
      branch: 'ENG-1',
      title: 't',
      head_sha: 's',
      web_url: '#',
      updated_at: 'u',
      user_notes_count: 0,
      unresolved: 0,
      approvals_left: null,
      approvals_required: null,
      approvals_by: null,
      has_conflicts: 0,
      in_scope: 1,
      reason: 'authored',
      ticket_key: null,
      ticket_status: null,
      unverified_count: null,
      unverified_sha: null,
    };
    db.upsertMr(row, 't1');
    expect(db.setIgnoreOverride('acme/rocket!1', 'ignored')).toBe(true);
    db.upsertMr(row, 't2'); // the every-cycle write must not clobber it
    expect(db.getMr('acme/rocket!1')?.ignore_override).toBe('ignored');
    db.setIgnoreOverride('acme/rocket!1', null);
    expect(db.getMr('acme/rocket!1')?.ignore_override).toBeNull();
    expect(db.setIgnoreOverride('acme/rocket!404', 'ignored')).toBe(false); // no row
    db.pruneMrsNotIn([]);
    expect(db.getMr('acme/rocket!1')).toBeUndefined(); // override gone with the MR
    db.close();
  });
});
