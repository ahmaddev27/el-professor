import { describe, expect, it } from 'vitest';
import { shouldShowImportPrompt, type CountRead } from './fleetImportPrompt';

const ok = (count: number): CountRead => ({ status: 'ok', count });
const failed: CountRead = { status: 'failed' };
const loading: CountRead = { status: 'loading' };

describe('shouldShowImportPrompt', () => {
  it('shows for an administrator of a company with no drivers and no vehicles', () => {
    expect(shouldShowImportPrompt({ mayImport: true, drivers: ok(0), vehicles: ok(0) })).toBe(true);
  });

  it('stays away once the company has drivers', () => {
    expect(shouldShowImportPrompt({ mayImport: true, drivers: ok(3), vehicles: ok(0) })).toBe(false);
  });

  it('stays away once the company has vehicles', () => {
    expect(shouldShowImportPrompt({ mayImport: true, drivers: ok(0), vehicles: ok(2) })).toBe(false);
  });

  it('shows nothing when a read failed, whichever one', () => {
    expect(shouldShowImportPrompt({ mayImport: true, drivers: failed, vehicles: ok(0) })).toBe(false);
    expect(shouldShowImportPrompt({ mayImport: true, drivers: ok(0), vehicles: failed })).toBe(false);
  });

  it('shows nothing while a count is still loading', () => {
    expect(shouldShowImportPrompt({ mayImport: true, drivers: loading, vehicles: ok(0) })).toBe(false);
  });

  it('does not invite a user the import would refuse', () => {
    expect(shouldShowImportPrompt({ mayImport: false, drivers: ok(0), vehicles: ok(0) })).toBe(false);
  });
});
