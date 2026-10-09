/**
 * Ask the partner what is waiting and ingest it.
 *
 * This exists because there is no scheduler in this stack. A submission reaches
 * us when the partner RINGS (owner's decision, 08.10.2026: Reidey cannot replay
 * the token it issued, so it rings and we fetch with the token we hold sealed).
 * A ring that never arrives — their queue died, we were down, the gateway
 * dropped it — is a submission that silently never came, and nothing can retry
 * it on its own. So the retry is a person.
 *
 * It is one hook and not two copies because **the catch-up ingests both kinds
 * at once**: it asks for everything waiting for the fleet, notes and Belege
 * together, and the partner's list names each one's subject. So the same press
 * on either screen does the same thing, and a reviewer on the Notizen tab is
 * not left without the recovery because the receipt reviewer has it.
 *
 * Safe to press twice: every submission is idempotent on the partner's own id.
 */
import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

/** The catch-up's reasons. Most of these send the operator to the Connect
 *  card rather than back to a row, which is why they are their own map. */
const REASON_KEYS: Record<string, TranslationKey> = {
  rate_limited: 'partner.catchup.error.rateLimited',
  not_connected: 'partner.inbox.error.notConnected',
  seal_unreadable: 'partner.inbox.error.sealUnreadable',
  token_rejected: 'partner.inbox.error.tokenRejected',
  partner_unavailable: 'partner.inbox.error.partnerUnavailable',
  seal_key_missing: 'partner.inbox.error.notConfigured',
  endpoint_missing: 'partner.inbox.error.notConfigured',
  endpoint_unparsable: 'partner.inbox.error.notConfigured',
  endpoint_not_https: 'partner.inbox.error.notConfigured',
  endpoint_has_credentials: 'partner.inbox.error.notConfigured',
  endpoint_private_host: 'partner.inbox.error.notConfigured',
  endpoint_unexpected_port: 'partner.inbox.error.notConfigured',
  endpoint_has_path: 'partner.inbox.error.notConfigured',
};

export interface PartnerConnectionRef {
  partner: string;
  fleet: string;
}

export function usePartnerCatchUp(connection: PartnerConnectionRef | null | undefined) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [fetching, setFetching] = useState(false);

  /** Returns whether anything was ingested, so a caller can reload. */
  const catchUp = async (): Promise<boolean> => {
    if (!connection) return false;
    setFetching(true);
    try {
      const { data, error } = await supabase.functions.invoke('partner-intake', {
        body: { kind: 'catchup', partner: connection.partner, fleet: connection.fleet },
      });
      if (error) throw error;
      const answer = data as {
        ok?: boolean; reason?: string; waiting?: number;
        ingested?: number; failed?: number; more?: boolean;
      };
      if (!answer?.ok) {
        const key = answer?.reason ? REASON_KEYS[answer.reason] : undefined;
        showToast('error', key ? t(key) : t('partner.catchup.failed'));
        return false;
      }
      // Four outcomes, and they must not look alike: nothing was waiting,
      // everything came, some came, and none of what was waiting could be
      // ingested. "Fetched 0" beside "0 waiting" is the only one that is good
      // news, and the only one a single success message would say in all four.
      const ingested = answer.ingested ?? 0;
      const failed = answer.failed ?? 0;
      if (ingested === 0 && failed === 0) {
        showToast('success', t('partner.catchup.nothing'));
      } else if (failed === 0) {
        showToast('success', t('partner.catchup.done', { count: String(ingested) }));
      } else {
        showToast('error', t('partner.catchup.partial', {
          count: String(ingested), failed: String(failed),
        }));
      }
      return ingested > 0;
    } catch {
      showToast('error', t('partner.catchup.failed'));
      return false;
    } finally {
      setFetching(false);
    }
  };

  return { catchUp, fetching, available: Boolean(connection) };
}
