import { describe, expect, it, vi } from 'vitest';
import { overallStatus, runFleetImport, type ImportDeps } from './partnerFleetImport';

const okRpc = { ok: true, created: 2, linked: 1, skipped: [] };

function deps(over: Partial<ImportDeps> = {}): ImportDeps & { rpcs: string[] } {
  const rpcs: string[] = [];
  return {
    rpcs,
    pull: vi.fn(async (scope: string) => scope === 'vehicles'
      ? { data: { ok: false, reason: 'vehicles_unavailable' }, error: null }
      : { data: { ok: true, seen: 3 }, error: null }),
    importRpc: vi.fn(async (rpc: string) => { rpcs.push(rpc); return { data: okRpc, error: null }; }),
    ...over,
  };
}

describe('runFleetImport', () => {
  it('imports drivers while vehicles are unavailable, names the refusal, and is not success', async () => {
    const d = deps();
    const out = await runFleetImport(d);
    expect(out[0]).toMatchObject({ scope: 'drivers', status: 'done', seen: 3 });
    expect(out[1]).toEqual({ scope: 'vehicles', status: 'unavailable', reason: 'import.error.vehiclesUnavailable' });
    expect(d.rpcs).toEqual(['partner_drivers_import']);
    expect(overallStatus(out)).toBe('partial');
  });

  it('keeps going when the drivers leg throws', async () => {
    const d = deps({
      pull: vi.fn(async (scope: string) => {
        if (scope === 'drivers') throw new Error('network');
        return { data: { ok: true, seen: 1 }, error: null };
      }),
    });
    const out = await runFleetImport(d);
    expect(out[0]).toMatchObject({ scope: 'drivers', status: 'failed', reason: 'import.error.pullGeneric' });
    expect(out[1]).toMatchObject({ status: 'done' });
    expect(overallStatus(out)).toBe('partial');
  });

  it('reports a database refusal by its hint and an unreadable answer as a failure', async () => {
    const d = deps({
      pull: vi.fn(async () => ({ data: { ok: true, seen: 0 }, error: null })),
      importRpc: vi.fn(async (rpc: string) => rpc === 'partner_drivers_import'
        ? { data: null, error: { hint: 'not_authorized' } }
        : { data: { ok: true }, error: null }),
    });
    const out = await runFleetImport(d);
    expect(out[0]).toMatchObject({ status: 'failed', reason: 'import.error.notAuthorized' });
    expect(out[1]).toMatchObject({ status: 'failed', reason: 'import.error.importGeneric' });
    expect(overallStatus(out)).toBe('failed');
  });

  it('is success only when every leg imported', async () => {
    const d = deps({ pull: vi.fn(async () => ({ data: { ok: true, seen: 2 }, error: null })) });
    expect(overallStatus(await runFleetImport(d))).toBe('success');
  });
});
