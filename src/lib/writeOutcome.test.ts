import { describe, expect, it } from 'vitest';
import { createFakeSupabase, callsOf, type FakeCall } from '../test-utils/fakeSupabase';
import { classifyWrite, deleteChecked, updateChecked } from './writeOutcome';

/**
 * A DELETE or UPDATE that a policy's USING clause hides answers 200 with an
 * empty array. These cases pin what the helpers make of that, with the answer
 * scripted the way PostgREST gives it.
 */

const idRow = [{ id: 'r1' }];

describe('deleteChecked', () => {
  it('reports done when the row came back from the DELETE', async () => {
    const { client, calls } = createFakeSupabase(() => ({ data: idRow, error: null }));
    expect(await deleteChecked(client, 'cars', q => q.eq('id', 'r1'))).toBe('done');
    expect(callsOf(calls, 'cars', 'select')).toHaveLength(0); // no probe needed
  });

  it('reports refused when nothing was deleted and the row is still there', async () => {
    const { client } = createFakeSupabase((c: FakeCall) =>
      ({ data: c.op === 'delete' ? [] : idRow, error: null }));
    expect(await deleteChecked(client, 'cars', q => q.eq('id', 'r1'))).toBe('refused');
  });

  it('reports gone when nothing was deleted because nothing was left', async () => {
    const { client } = createFakeSupabase(() => ({ data: [], error: null }));
    expect(await deleteChecked(client, 'cars', q => q.eq('id', 'r1'))).toBe('gone');
  });

  it('throws the database error instead of classifying it', async () => {
    const { client } = createFakeSupabase(() => ({ data: null, error: new Error('boom') }));
    await expect(deleteChecked(client, 'cars', q => q.eq('id', 'r1'))).rejects.toThrow('boom');
  });

  it('throws when the probe itself fails, not guessing a refusal', async () => {
    const { client } = createFakeSupabase((c: FakeCall) =>
      c.op === 'delete' ? { data: [], error: null } : { data: null, error: new Error('probe') });
    await expect(deleteChecked(client, 'cars', q => q.eq('id', 'r1'))).rejects.toThrow('probe');
  });

  it('counts a partly deleted batch as refused while rows remain', async () => {
    const { client } = createFakeSupabase((c: FakeCall) =>
      ({ data: c.op === 'delete' ? [{ id: 'a' }] : [{ id: 'b' }], error: null }));
    expect(await deleteChecked(client, 'saved', q => q.in('id', ['a', 'b']), 2)).toBe('refused');
  });
});

describe('updateChecked', () => {
  it('reports refused for a hidden row and done for a changed one', async () => {
    const hidden = createFakeSupabase((c: FakeCall) => ({ data: c.op === 'update' ? [] : idRow, error: null }));
    expect(await updateChecked(hidden.client, 'cars', { a: 1 }, q => q.eq('id', 'r1'))).toBe('refused');
    const changed = createFakeSupabase(() => ({ data: idRow, error: null }));
    expect(await updateChecked(changed.client, 'cars', { a: 1 }, q => q.eq('id', 'r1'))).toBe('done');
  });
});

describe('classifyWrite', () => {
  it('does not probe when everything asked for was touched', async () => {
    let probed = false;
    await classifyWrite(2, 2, async () => { probed = true; return 0; });
    expect(probed).toBe(false);
  });
});
