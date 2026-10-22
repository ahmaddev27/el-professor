import { describe, expect, it } from 'vitest';
import { callsOf, createFakeSupabase, type FakeCall } from '../test-utils/fakeSupabase';
import {
  SIGNED_URL_SECONDS,
  attachEvidence,
  decideNote,
  detachEvidence,
  evidenceUrl,
  type EvidenceClient,
} from './driverNoteProvenance';
import { isEvidenceKey } from '../utils/noteProvenance';

/**
 * The writes about a note's provenance: the order of the steps, what each sends,
 * and what is left behind when one is refused.
 */

const CO = 'c0000000-0000-4000-8000-00000000000a';
const NOTE = 'a8100000-0000-4000-8000-000000000001';
const FILE_ID = 'f8100000-0000-4000-8000-000000000001';

interface World {
  /** Rows an UPDATE touches (a role without the right touches none: 200, no rows). */
  touches: boolean;
  /** Rows still there when the probe asks after an UPDATE that touched none. */
  remains: boolean;
  /** An UPDATE that raises, the way a CHECK would. */
  updateThrows: boolean;
  uploadError: boolean;
  signedError: boolean;
}

function setup(patch: Partial<World> = {}) {
  const world: World = { touches: true, remains: true, updateThrows: false, uploadError: false, signedError: false, ...patch };
  const order: string[] = [];
  const fake = createFakeSupabase((call: FakeCall) => {
    if (call.op === 'update') {
      order.push(`update:${JSON.stringify(call.payload)}`);
      if (world.updateThrows) return { data: null, error: { message: 'violates check constraint "driver_notes_evidence_path_shape"' } };
      return { data: world.touches ? [{ id: NOTE }] : [], error: null };
    }
    return { data: world.remains ? [{ id: NOTE }] : [], error: null };
  });
  const storage = {
    from: (bucket: string) => ({
      upload: async (path: string, _body: unknown, options: { contentType: string; upsert: boolean }) => {
        order.push(`upload:${bucket}:${path}:${options.contentType}:${options.upsert}`);
        return { error: world.uploadError ? { message: 'no' } : null };
      },
      remove: async (paths: string[]) => {
        order.push(`remove:${bucket}:${paths.join(',')}`);
        return { error: null };
      },
      createSignedUrl: async (path: string, seconds: number) => {
        order.push(`sign:${bucket}:${path}:${seconds}`);
        return world.signedError
          ? { data: null, error: { message: 'no' } }
          : { data: { signedUrl: `https://files.invalid/${path}?t=1` }, error: null };
      },
    }),
  };
  const client = { ...fake.client, storage } as unknown as EvidenceClient;
  return { client, order, calls: fake.calls };
}

const file = (name = 'Bescheid.pdf', type = 'application/pdf', size = 2048) =>
  ({ name, type, size }) as { name: string; type: string; size: number } & Blob;

describe('deciding a note', () => {
  it('sends the status and nothing about who or when: the database stamps those', async () => {
    const { client, calls } = setup();
    expect(await decideNote(client, CO, NOTE, { status: 'verified' })).toBe('done');
    const [update] = callsOf(calls, 'driver_notes', 'update');
    expect(update.payload).toEqual({ verification_status: 'verified' });
    // The fake records the column of each filter, not its value: the note, then the company.
    expect(update.filters).toEqual(['eq:id', 'eq:company_id']);
  });

  it('sends a rejection with its reason, trimmed', async () => {
    const { client, calls } = setup();
    await decideNote(client, CO, NOTE, { status: 'rejected', reason: '  Datum stimmt nicht  ' });
    expect(callsOf(calls, 'driver_notes', 'update')[0].payload).toEqual({
      verification_status: 'rejected', rejected_reason: 'Datum stimmt nicht',
    });
  });

  it('does not send a rejection with no reason, and says so', async () => {
    const { client, calls } = setup();
    expect(await decideNote(client, CO, NOTE, { status: 'rejected', reason: '   ' })).toBe('reason_missing');
    expect(calls).toHaveLength(0);
  });

  it('takes a decision back by sending unverified alone', async () => {
    const { client, calls } = setup();
    await decideNote(client, CO, NOTE, { status: 'unverified' });
    expect(callsOf(calls, 'driver_notes', 'update')[0].payload).toEqual({ verification_status: 'unverified' });
  });

  it('reports a refusal, not a success, when a role without the right touches nothing', async () => {
    const { client } = setup({ touches: false, remains: true });
    expect(await decideNote(client, CO, NOTE, { status: 'verified' })).toBe('refused');
  });

  it('reports a note somebody else deleted first as gone, not as refused', async () => {
    const { client } = setup({ touches: false, remains: false });
    expect(await decideNote(client, CO, NOTE, { status: 'verified' })).toBe('gone');
  });
});

describe('attaching a document', () => {
  it('stores the file first and the key second, under a generated name, never replacing', async () => {
    const { client, order } = setup();
    const result = await attachEvidence(client, { companyId: CO, noteId: NOTE, file: file(), newFileId: () => FILE_ID });

    const path = `${CO}/driver-notes/${NOTE}/${FILE_ID}.pdf`;
    expect(result).toEqual({ ok: true, path });
    expect(order).toEqual([
      `upload:documents:${path}:application/pdf:false`,
      `update:${JSON.stringify({ evidence_path: path })}`,
    ]);
    expect(isEvidenceKey(path, CO, NOTE)).toBe(true);
  });

  it('sends the content type of the extension, not what the browser said', async () => {
    const { client, order } = setup();
    await attachEvidence(client, { companyId: CO, noteId: NOTE, file: file('IMG.JPG', ''), newFileId: () => FILE_ID });
    expect(order[0]).toContain(':image/jpeg:false');
    expect(order[0]).toContain('.jpg:');
  });

  it('takes the file back when the key is refused, so a refused attachment leaves nothing behind', async () => {
    const { client, order } = setup({ touches: false, remains: true });
    const result = await attachEvidence(client, { companyId: CO, noteId: NOTE, file: file(), newFileId: () => FILE_ID });
    expect(result).toEqual({ ok: false, problem: 'refused' });
    expect(order[order.length - 1]).toBe(`remove:documents:${CO}/driver-notes/${NOTE}/${FILE_ID}.pdf`);
  });

  it('takes the file back when the note is gone', async () => {
    const { client, order } = setup({ touches: false, remains: false });
    const result = await attachEvidence(client, { companyId: CO, noteId: NOTE, file: file(), newFileId: () => FILE_ID });
    expect(result).toEqual({ ok: false, problem: 'gone' });
    expect(order[order.length - 1]).toMatch(/^remove:documents:/);
  });

  it('takes the file back when the write raises, and lets the error through', async () => {
    const { client, order } = setup({ updateThrows: true });
    await expect(attachEvidence(client, { companyId: CO, noteId: NOTE, file: file(), newFileId: () => FILE_ID }))
      .rejects.toMatchObject({ message: expect.stringContaining('driver_notes_evidence_path_shape') });
    expect(order[order.length - 1]).toMatch(/^remove:documents:/);
  });

  it('writes no key when the file could not be stored', async () => {
    const { client, order, calls } = setup({ uploadError: true });
    const result = await attachEvidence(client, { companyId: CO, noteId: NOTE, file: file(), newFileId: () => FILE_ID });
    expect(result).toEqual({ ok: false, problem: 'upload' });
    expect(order).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['an svg', file('x.svg', 'image/svg+xml'), 'type'],
    ['a file that says it is another type', file('x.png', 'image/svg+xml'), 'type'],
    ['an empty file', file('x.pdf', 'application/pdf', 0), 'empty'],
    ['an enormous one', file('x.pdf', 'application/pdf', 50 * 1024 * 1024), 'size'],
  ])('touches neither storage nor the table for %s', async (_what, picked, problem) => {
    const { client, order, calls } = setup();
    expect(await attachEvidence(client, { companyId: CO, noteId: NOTE, file: picked })).toEqual({ ok: false, problem });
    expect(order).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('taking a document off a note', () => {
  it('clears the key first and the file only once that is done', async () => {
    const { client, order } = setup();
    const path = `${CO}/driver-notes/${NOTE}/${FILE_ID}.pdf`;
    expect(await detachEvidence(client, CO, NOTE, path)).toBe('done');
    expect(order).toEqual([`update:${JSON.stringify({ evidence_path: null })}`, `remove:documents:${path}`]);
  });

  it('leaves the file where the note can still reach it when the key could not be cleared', async () => {
    const { client, order } = setup({ touches: false, remains: true });
    expect(await detachEvidence(client, CO, NOTE, 'k')).toBe('refused');
    expect(order.some(step => step.startsWith('remove:'))).toBe(false);
  });
});

describe('a link to a document', () => {
  it('is short-lived', async () => {
    const { client, order } = setup();
    expect(await evidenceUrl(client, 'k')).toBe('https://files.invalid/k?t=1');
    expect(order).toEqual([`sign:documents:k:${SIGNED_URL_SECONDS}`]);
    expect(SIGNED_URL_SECONDS).toBeLessThanOrEqual(300);
  });

  it('is null when storage refuses, never a guess', async () => {
    const { client } = setup({ signedError: true });
    expect(await evidenceUrl(client, 'k')).toBeNull();
  });
});
