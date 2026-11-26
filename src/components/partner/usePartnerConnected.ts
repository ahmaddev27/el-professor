/**
 * Whether the company has a live (not revoked) Reidey connection.
 *
 * 'unknown' covers both loading and a failed read: "not connected" is a claim,
 * and a screen that can only act on a known connection falls back to the plain
 * link to the import page for anything but 'connected'.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export function usePartnerConnected(companyId: string | null | undefined): 'connected' | 'unknown' {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setConnected(false);
    if (!companyId) return;
    let current = true;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('partner_connections')
          .select('id')
          .eq('company_id', companyId)
          .neq('status', 'revoked')
          .limit(1);
        if (!error && current) setConnected((data ?? []).length > 0);
      } catch {
        // Stays 'unknown'.
      }
    })();
    return () => { current = false; };
  }, [companyId]);

  return connected ? 'connected' : 'unknown';
}
