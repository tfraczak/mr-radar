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
