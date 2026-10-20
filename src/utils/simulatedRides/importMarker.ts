import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

/**
 * Whether the rides a document is computed from are simulated.
 *
 * The rule is the trips', not a company flag: a document whose source trips
 * include a simulated one carries the marker, because the trips are what its
 * figures come from. A trip takes its marker from its import (trigger,
 * migration 20261020110000), and an import is all one or the other, so asking
 * the imports a document was built from is asking its trips.
 *
 * A lookup that FAILS is not "no". It throws, and the caller refuses to build
 * the document: an unknown source must never print as a real one.
 */
export async function importsAreSimulated(importIds: readonly (string | null | undefined)[]): Promise<boolean> {
  const ids = [...new Set(importIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return false;
  const { data, error } = await supabase.from('fahrtenbuch_imports').select('id, is_simulated').in('id', ids);
  if (error) throw new Error(error.message);
  return (data ?? []).some(row => (row as { is_simulated?: boolean }).is_simulated === true);
}

/** The import a planning run was made from, then whether that import is simulated. */
export async function runsAreSimulated(runIds: readonly (string | null | undefined)[]): Promise<boolean> {
  const ids = [...new Set(runIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return false;
  const { data, error } = await supabase.from('company_planning_runs').select('import_id').in('id', ids);
  if (error) throw new Error(error.message);
  return importsAreSimulated((data ?? []).map(row => (row as { import_id: string | null }).import_id));
}

export interface SimulatedState {
  /** null while unknown. A screen treats unknown as "do not offer a document". */
  simulated: boolean | null;
  failed: boolean;
}

/** For a screen: the answer for one import, `simulated: null` until it is known. */
export function useImportSimulated(importId: string | null | undefined): SimulatedState {
  const [state, setState] = useState<SimulatedState>({ simulated: importId ? null : false, failed: false });
  useEffect(() => {
    if (!importId) { setState({ simulated: false, failed: false }); return; }
    let live = true;
    setState({ simulated: null, failed: false });
    importsAreSimulated([importId])
      .then(simulated => { if (live) setState({ simulated, failed: false }); })
      .catch(() => { if (live) setState({ simulated: null, failed: true }); });
    return () => { live = false; };
  }, [importId]);
  return state;
}
