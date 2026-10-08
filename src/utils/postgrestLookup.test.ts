import { describe, expect, it } from 'vitest';
import { KEY_LOOKUP_CHUNK, UUID_LOOKUP_CHUNK, inGroups, sourceRowKeyChunks } from './postgrestLookup';
import { BACKUP_PARENT_ID_CHUNK } from './backup';

/** A 64-character hex key, as `source_row_key` stores it. */
const key = (n: number) => n.toString(16).padStart(64, '0');

describe('the importer’s duplicate-ride lookup', () => {
  it('keeps every query well below the size the gateway refuses (≈ 52 keys, measured 08.10.2026)', () => {
    // The query supabase-js writes for one chunk, with the longest optional filter.
    const chunk = sourceRowKeyChunks(Array.from({ length: 1000 }, (_, i) => key(i)))[0];
    const query =
      `select=source_row_key&company_id=eq.${'0'.repeat(36)}&source_row_key=in.(${chunk.join(',')})&import_id=neq.${'0'.repeat(36)}`;
    expect(chunk).toHaveLength(KEY_LOOKUP_CHUNK);
    // Half the ~3.5 KB that nginx's 4 KB header buffer leaves for the echoed query.
    expect(query.length).toBeLessThan(1800);
    expect(KEY_LOOKUP_CHUNK).toBeLessThanOrEqual(26);
  });

  it('keeps every uuid list well below the size the gateway refuses (≈ 95 uuids, measured 08.10.2026)', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    const ids = Array.from({ length: UUID_LOOKUP_CHUNK }, (_, i) => uuid(i));
    const query = `select=id,driver_id&company_id=eq.${uuid(0)}&id=in.(${ids.join(',')})`;
    expect(query.length).toBeLessThan(1800);
    // The backup's child tables ask the same way and take the same bound.
    expect(BACKUP_PARENT_ID_CHUNK).toBeLessThanOrEqual(UUID_LOOKUP_CHUNK);
  });

  it('asks each key once, in chunks, and loses none', () => {
    const keys = [...Array.from({ length: 60 }, (_, i) => key(i)), key(3), key(7)];
    const chunks = sourceRowKeyChunks(keys);
    expect(chunks.map(c => c.length)).toEqual([25, 25, 10]);
    expect(new Set(chunks.flat())).toEqual(new Set(keys));
  });

  it('keeps at most four lookups in flight and returns the answers in order', async () => {
    let inFlight = 0;
    let peak = 0;
    const answers = await inGroups([1, 2, 3, 4, 5, 6, 7, 8, 9], async n => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return n * 10;
    });
    expect(answers).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
