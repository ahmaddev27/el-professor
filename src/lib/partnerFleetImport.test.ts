import { describe, expect, it } from 'vitest';
import {
  importErrorKey, parseImportResult, parsePullCounts, pullFailureReason, pullReasonKey, runImportLeg, skipReasonKey,
} from './partnerFleetImport';

describe('parseImportResult', () => {
  it('reads the counts and the per-row reasons', () => {
    const result = parseImportResult({
      ok: true, created: 2, linked: 1, skipped_count: 1,
      skipped: [{ link_id: 'a', name: 'Unbekannter Fahrer', reason: 'name_missing' }],
    }, 'drivers');
    expect(result).toEqual({
      created: 2, linked: 1, pending: 1,
      skipped: [{ linkId: 'a', label: 'Unbekannter Fahrer', reason: 'name_missing' }],
    });
  });

  it('reads a vehicle row by its plate', () => {
    const result = parseImportResult({
      ok: true, created: 0, linked: 0,
      skipped: [{ link_id: 'b', plate: 'M-AB 1', reason: 'plate_unavailable' }],
    }, 'vehicles');
    expect(result?.skipped[0]).toMatchObject({ label: 'M-AB 1', reason: 'plate_unavailable' });
  });

  it('refuses an answer without counts instead of reporting zero', () => {
    expect(parseImportResult(null, 'drivers')).toBeNull();
    expect(parseImportResult({ ok: true }, 'drivers')).toBeNull();
    expect(parseImportResult({ ok: false, created: 0, linked: 0, skipped: [] }, 'drivers')).toBeNull();
    expect(parseImportResult({ ok: true, created: '3', linked: 0, skipped: [] }, 'drivers')).toBeNull();
  });

  it('keeps a reason it does not know visible as unknown', () => {
    const result = parseImportResult({
      ok: true, created: 0, linked: 0, skipped: [{ link_id: 'c', name: 'X', reason: 'new_code' }],
    }, 'drivers');
    expect(result?.skipped[0].reason).toBe('unknown');
    expect(skipReasonKey('unknown', 'drivers')).toBe('import.skip.unknownDriver');
  });
});

describe('reason keys', () => {
  it('maps the pull and import refusals', () => {
    expect(pullReasonKey('vehicles_unavailable')).toBe('import.error.vehiclesUnavailable');
    expect(pullReasonKey('token_rejected')).toBe('partner.pull.error.tokenRejected');
    expect(pullReasonKey('something_new')).toBe('import.error.pullGeneric');
    expect(importErrorKey('platform_session_not_allowed')).toBe('import.error.platformSession');
    expect(importErrorKey(undefined)).toBe('import.error.importGeneric');
  });
});

describe('the real reason of a refused pull', () => {
  const httpError = (body: unknown) => ({ context: { clone: () => ({ json: async () => body }) } });

  it('reads the reason out of the response the error carries', async () => {
    expect(await pullFailureReason(httpError({ ok: false, reason: 'partner_unreachable' }))).toBe('partner_unreachable');
  });

  it('answers nothing for a body that is not readable', async () => {
    expect(await pullFailureReason({ context: { clone: () => ({ json: async () => { throw new Error('x'); } }) } })).toBeUndefined();
    expect(await pullFailureReason(new Error('network'))).toBeUndefined();
    expect(await pullFailureReason(null)).toBeUndefined();
  });

  it('does not end in the generic sentence when the pull said why', async () => {
    const outcome = await runImportLeg('drivers', {
      pull: async () => ({ data: null, error: httpError({ ok: false, reason: 'not_connected' }) }),
      importRpc: async () => ({ data: null, error: null }),
    });
    expect(outcome).toEqual({ scope: 'drivers', status: 'failed', reason: pullReasonKey('not_connected') });
    expect(pullReasonKey('not_connected')).not.toBe('import.error.pullGeneric');
  });

  it('never says "nothing was changed" once the import itself has thrown', async () => {
    const importThrew = await runImportLeg('drivers', {
      pull: async () => ({ data: { ok: true, seen: 7 }, error: null }),
      importRpc: async () => { throw new Error('connection lost'); },
    });
    expect(importThrew).toEqual({ scope: 'drivers', status: 'failed', reason: 'import.error.importGeneric' });
    const pullThrew = await runImportLeg('drivers', {
      pull: async () => { throw new Error('connection lost'); },
      importRpc: async () => ({ data: null, error: null }),
    });
    expect(pullThrew).toEqual({ scope: 'drivers', status: 'failed', reason: 'import.error.pullGeneric' });
  });

  it('carries the pull counts into a finished leg', async () => {
    const outcome = await runImportLeg('drivers', {
      pull: async () => ({ data: { ok: true, seen: 7, new: 2, departed: 1 }, error: null }),
      importRpc: async () => ({ data: { ok: true, created: 1, linked: 1, pending: 0, skipped: [] }, error: null }),
    });
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.pull).toMatchObject({ seen: 7, new: 2, departed: 1, returned: null });
      expect(outcome.result.pending).toBe(0);
    }
  });
});

describe('parsePullCounts and the new skip reasons', () => {
  it('never invents a count', () => {
    expect(parsePullCounts({ seen: 3 })).toEqual({ seen: 3, new: null, departed: null, returned: null, truncated: false });
    expect(parsePullCounts(null).seen).toBeNull();
  });
  it('names the two new reasons', () => {
    expect(skipReasonKey('name_ambiguous', 'drivers')).toBe('import.skip.nameAmbiguous');
    expect(skipReasonKey('name_inactive', 'drivers')).toBe('import.skip.nameInactive');
  });
});
