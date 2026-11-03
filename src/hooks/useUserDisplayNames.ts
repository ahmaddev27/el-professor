import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Who a `created_by` id is: the account's name, or its address when it has none.
 *
 * The rows come back through `user_profiles`' own policies, so an account from
 * another company or a platform account is simply absent, and the caller shows
 * "unknown" rather than an id. A failed read is the same empty map: an id is
 * never the fallback, because nobody can do anything with one.
 */
export function useUserDisplayNames(): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error } = await supabase.from('user_profiles').select('user_id, full_name, email');
      if (!alive || error) return;
      const next = new Map<string, string>();
      for (const row of data ?? []) {
        const display = (row.full_name as string | null)?.trim() || (row.email as string | null)?.trim() || '';
        if (row.user_id && display) next.set(row.user_id as string, display);
      }
      setNames(next);
    })();
    return () => { alive = false; };
  }, []);

  return names;
}
