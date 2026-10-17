/**
 * What a pull is for: the roster of drivers, or the vehicles. Pure, so Node
 * runs it; the Deno function only asks it questions.
 *
 * The scope names the partner's path, the RPC that stores the page and the
 * page of ours the caller must hold. A body that names anything else is read
 * as the default, so a caller sending `{}` (every screen before the fleet
 * import) keeps pulling drivers.
 */
export type PullScope = 'drivers' | 'vehicles';

export interface PullScopeSpec {
  scope: PullScope;
  path: string;
  rpc: string;
  rpcArgument: string;
  page: string;
}

const SPECS: Record<PullScope, PullScopeSpec> = {
  drivers: {
    scope: 'drivers',
    path: '/api/v1/elprofessor/fleet/drivers',
    rpc: 'partner_roster_apply',
    rpcArgument: 'p_drivers',
    page: 'drivers',
  },
  vehicles: {
    scope: 'vehicles',
    path: '/api/v1/elprofessor/vehicles',
    rpc: 'partner_vehicle_roster_apply',
    rpcArgument: 'p_vehicles',
    page: 'cars',
  },
};

export function pullScopeSpec(body: unknown): PullScopeSpec {
  const raw = (body as { scope?: unknown } | null)?.scope;
  return raw === 'vehicles' ? SPECS.vehicles : SPECS.drivers;
}

/**
 * The partner has no such endpoint (yet). Reported as `vehicles_unavailable`
 * and NOT stamped as a failure on the connection: a missing route says nothing
 * about the token, and marking the connection failed would break the roster
 * pull that works.
 */
export function endpointIsMissing(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}
