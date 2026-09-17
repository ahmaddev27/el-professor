/**
 * The directory read models, called (plan 3.6c).
 *
 * Every function here is one `supabase.rpc` — a POST, because the read models
 * are VOLATILE and record their own read — handed straight to the pure parser
 * in `platformReadModels.ts`. A transport or privilege failure throws; a
 * refusal the function decided (`not_authorized`) comes back as a value, so the
 * `denied` audit row it wrote is kept and the screen can say why.
 */
import { supabase } from './supabase';
import {
  DIRECTORY_PAGE_SIZE,
  directoryOffset,
  directoryRpcArgs,
  parsePlatformReadPage,
  parseCompanyRow,
  parseDriverRow,
  parseUserRow,
  parseVehicleRow,
  type DirectoryQuery,
  type PlatformCompanyRow,
  type PlatformDriverRow,
  type PlatformReadResult,
  type PlatformUserRow,
  type PlatformVehicleRow,
} from './platformReadModels';

async function callReadModel<T>(
  fn: string,
  args: Record<string, unknown>,
  parseItem: (raw: Record<string, unknown>) => T,
): Promise<PlatformReadResult<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return parsePlatformReadPage(data, parseItem);
}

export function fetchVehicles(query: DirectoryQuery): Promise<PlatformReadResult<PlatformVehicleRow>> {
  return callReadModel('platform_vehicles_list', directoryRpcArgs(query), parseVehicleRow);
}

export function fetchDrivers(query: DirectoryQuery): Promise<PlatformReadResult<PlatformDriverRow>> {
  return callReadModel('platform_drivers_list', directoryRpcArgs(query), parseDriverRow);
}

export function fetchUsers(query: DirectoryQuery): Promise<PlatformReadResult<PlatformUserRow>> {
  return callReadModel('platform_users_list', directoryRpcArgs(query), parseUserRow);
}

/**
 * The companies a filter offers, by name. One page: the picker is a
 * convenience, every call writes an audit row, and it is read once per screen
 * rather than per keystroke. A platform with more companies than one page holds
 * is told so, and filters by typing instead.
 */
export function fetchCompanies(pageIndex = 0): Promise<PlatformReadResult<PlatformCompanyRow>> {
  return callReadModel('platform_companies_list', {
    p_sort: 'name_asc',
    p_limit: DIRECTORY_PAGE_SIZE,
    p_offset: directoryOffset(pageIndex),
  }, parseCompanyRow);
}
