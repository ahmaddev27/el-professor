/**
 * The Overview's way into the fleet import for a company that has nothing yet.
 *
 * It asks for its own two counts instead of reading the Overview's state: the
 * Overview's driver list comes through a hook that falls back to local storage,
 * and its vehicle read drops its error, so neither can tell "none" from "could
 * not read". Head requests return no rows; a failure of either shows nothing.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { useCompanyScope } from '../../hooks/useCompanyScope';
import { shouldShowImportPrompt, type CountRead } from '../../utils/fleetImportPrompt';
import { FleetImportShortcut } from './FleetImportShortcut';

async function countRows(table: 'drivers' | 'cars', companyId: string): Promise<CountRead> {
  try {
    const { count, error } = await supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId);
    if (error || count === null) return { status: 'failed' };
    return { status: 'ok', count };
  } catch {
    return { status: 'failed' };
  }
}

export function FleetImportPrompt() {
  const { isAdmin } = useAuth();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { canEdit } = useCompanyScope();
  const [drivers, setDrivers] = useState<CountRead>({ status: 'loading' });
  const [vehicles, setVehicles] = useState<CountRead>({ status: 'loading' });
  const mayImport = isAdmin && canEdit(undefined, 'drivers');

  useEffect(() => {
    if (!companyId || !mayImport) return;
    let current = true;
    setDrivers({ status: 'loading' });
    setVehicles({ status: 'loading' });
    void countRows('drivers', companyId).then(r => { if (current) setDrivers(r); });
    void countRows('cars', companyId).then(r => { if (current) setVehicles(r); });
    return () => { current = false; };
  }, [companyId, mayImport]);

  if (!shouldShowImportPrompt({ mayImport, drivers, vehicles })) return null;
  return <FleetImportShortcut empty />;
}
