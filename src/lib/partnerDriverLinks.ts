/**
 * What the Fahrer screen knows about the company's Reidey links, read once per
 * load: which drivers are linked (and whether the partner dropped them since),
 * and how many proposals wait for a person.
 *
 * It reads `partner_driver_links` itself and not through `PartnerLinkProposals`,
 * because the list, the badge column and the notice above it must agree, and
 * the dialog's own table is a different, 200-row view of the same rows.
 */
import type { TranslationKey } from '../i18n';

export const PARTNER = 'reidey';
const PAGE = 1000;

export interface LinkRow {
  id: string;
  driver_id: string | null;
  status: 'pending' | 'linked' | 'rejected';
  partner_removed_at: string | null;
  decision_reason: string | null;
}

export type DriverLinkState = 'linked' | 'departed';

export interface LinkSummary {
  byDriver: Map<string, DriverLinkState>;
  pending: number;
}

export function summariseLinks(rows: readonly LinkRow[]): LinkSummary {
  const byDriver = new Map<string, DriverLinkState>();
  let pending = 0;
  for (const row of rows) {
    if (row.status === 'pending') pending += 1;
    if (row.status === 'linked' && row.driver_id) {
      byDriver.set(row.driver_id, row.partner_removed_at ? 'departed' : 'linked');
    }
  }
  return { byDriver, pending };
}

/** The client surface this read needs; the real client and the fake both fit. */
interface LinkClient {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Every link of the company, paged: PostgREST stops at 1000 rows without an
 * error, and a short list would read as "nobody is linked".
 */
export async function fetchLinkRows(client: LinkClient, companyId: string): Promise<LinkRow[]> {
  const rows: LinkRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('partner_driver_links')
      .select('id, driver_id, status, partner_removed_at, decision_reason')
      .eq('company_id', companyId)
      .eq('partner', PARTNER)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as LinkRow[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

const REASON_KEYS: Record<string, TranslationKey> = {
  name_missing: 'partner.links.reason.nameMissing',
  name_ambiguous: 'partner.links.reason.nameAmbiguous',
  name_inactive: 'partner.links.reason.nameInactive',
  name_taken: 'partner.links.reason.nameTaken',
};

/** Why a proposal was not linked on its own, in words; null for an older row with no reason. */
export function decisionReasonKey(reason: string | null | undefined): TranslationKey | null {
  return (reason ? REASON_KEYS[reason] : undefined) ?? null;
}
