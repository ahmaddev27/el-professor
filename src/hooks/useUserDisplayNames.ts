import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Who a `created_by` id is: the account's name, or its address when it has none.
 *
 * The rows come back through `user_profiles`' own policies, so an account from
 * another company or a platform account is simply absent, and the caller shows
 * "unknown" rather than an id. A failed read is the same empty map: an id is
 * never the fallback, because nobody can do anything with one.
 *
 * Null until the read has answered, because "unknown" is a claim: on a slow line
 * the table drew it over a name that was on its way.
 */
export function useUserDisplayNames(): Map<string, string> | null {
  const [names, setNames] = useState<Map<string, string> | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error } = await supabase.from('user_profiles').select('user_id, full_name, email');
      if (!alive) return;
      const next = new Map<string, string>();
      for (const row of (error ? null : data) ?? []) {
        const display = (row.full_name as string | null)?.trim() || (row.email as string | null)?.trim() || '';
        if (row.user_id && display) next.set(row.user_id as string, display);
      }
      setNames(next);
    })();
    return () => { alive = false; };
  }, []);

  return names;
}
