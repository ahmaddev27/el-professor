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
  /** The link row of each linked driver, which the unlink button names. */
  linkIdByDriver: Map<string, string>;
  pending: number;
}

export function summariseLinks(rows: readonly LinkRow[]): LinkSummary {
  const byDriver = new Map<string, DriverLinkState>();
  const linkIdByDriver = new Map<string, string>();
  let pending = 0;
  for (const row of rows) {
    if (row.status === 'pending') pending += 1;
    if (row.status === 'linked' && row.driver_id) {
      byDriver.set(row.driver_id, row.partner_removed_at ? 'departed' : 'linked');
      linkIdByDriver.set(row.driver_id, row.id);
    }
  }
  return { byDriver, linkIdByDriver, pending };
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
  // A person took the link apart (partner_driver_link_unlink, 28.11.2026); no
  // automatic path links the row again, so it waits here for a person.
  unlinked: 'partner.links.reason.unlinked',
};

/** Why a proposal was not linked on its own, in words; null for an older row with no reason. */
export function decisionReasonKey(reason: string | null | undefined): TranslationKey | null {
  return (reason ? REASON_KEYS[reason] : undefined) ?? null;
}

/** The client surface the unlink needs; the real client and the fake both fit. */
interface RpcClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * What came of `partner_driver_link_unlink` (28.11.2026):
 * - `done`: the link is taken apart;
 * - `refused`: a definitive answer, with whether the page's list is stale;
 * - `failed`: anything else, so the dialog stays open for another try.
 */
export type UnlinkOutcome =
  | { kind: 'done' }
  | { kind: 'refused'; messageKey: TranslationKey; reload: boolean }
  | { kind: 'failed' };

const UNLINK_REFUSALS: Record<string, { messageKey: TranslationKey; reload: boolean }> = {
  // Both mean the list showed a link that is not there any more.
  not_linked: { messageKey: 'partner.links.unlink.notLinked', reload: true },
  link_not_found: { messageKey: 'partner.links.unlink.notLinked', reload: true },
  not_authorized: { messageKey: 'partner.links.error.notAuthorized', reload: false },
};

export async function unlinkPartnerDriver(client: RpcClient, linkId: string): Promise<UnlinkOutcome> {
  const { data, error } = await client.rpc('partner_driver_link_unlink', { p_link_id: linkId });
  if (error) {
    const hint = (error as { hint?: unknown }).hint;
    const refusal = typeof hint === 'string' ? UNLINK_REFUSALS[hint] : undefined;
    return refusal ? { kind: 'refused', ...refusal } : { kind: 'failed' };
  }
  return (data as { ok?: unknown } | null)?.ok === true ? { kind: 'done' } : { kind: 'failed' };
}
