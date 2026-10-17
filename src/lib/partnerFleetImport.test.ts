import { describe, expect, it } from 'vitest';
import { importErrorKey, parseImportResult, pullReasonKey, skipReasonKey } from './partnerFleetImport';

describe('parseImportResult', () => {
  it('reads the counts and the per-row reasons', () => {
    const result = parseImportResult({
      ok: true, created: 2, linked: 1, skipped_count: 1,
      skipped: [{ link_id: 'a', name: 'Unbekannter Fahrer', reason: 'name_missing' }],
    }, 'drivers');
    expect(result).toEqual({
      created: 2, linked: 1,
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
