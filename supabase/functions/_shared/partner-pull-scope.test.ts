import { describe, expect, it } from 'vitest';
import { endpointIsMissing, pullScopeSpec } from './partner-pull-scope';

describe('pullScopeSpec', () => {
  it('defaults to drivers for an empty body, as every earlier caller sends', () => {
    expect(pullScopeSpec({}).rpc).toBe('partner_roster_apply');
    expect(pullScopeSpec(null).scope).toBe('drivers');
  });

  it('reads vehicles and nothing else as vehicles', () => {
    const spec = pullScopeSpec({ scope: 'vehicles' });
    expect(spec.path).toBe('/api/v1/elprofessor/vehicles');
    expect(spec.rpc).toBe('partner_vehicle_roster_apply');
    expect(spec.page).toBe('cars');
    expect(pullScopeSpec({ scope: 'salaries' }).scope).toBe('drivers');
  });
});

describe('endpointIsMissing', () => {
  it('treats 404, 405 and 501 as absent and an outage as an outage', () => {
    expect([404, 405, 501].every(endpointIsMissing)).toBe(true);
    expect([200, 401, 403, 500, 502].some(endpointIsMissing)).toBe(false);
  });
});
