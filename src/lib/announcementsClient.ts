/**
 * The panel's announcement RPCs (plan 3.11, migration 20260920130010).
 *
 * Each answers `{ok, …}` and refuses with a reason rather than raising, so
 * every outcome comes back as a value; only a broken argument contract raises,
 * and that arrives here as a thrown error. A save or a delete carries the
 * version the screen read, and a stale one is refused and never retried with
 * the newer version — that would overwrite somebody else's change unseen.
 */
import { supabase } from './supabase';
import {
  parseAnnouncementAnswer,
  parsePanelAnnouncement,
  type AnnouncementDocument,
  type AnnouncementResult,
  type PanelAnnouncement,
} from './announcements';

export async function listAnnouncements(): Promise<AnnouncementResult<PanelAnnouncement[]>> {
  const { data, error } = await supabase.rpc('platform_announcements_list');
  if (error) throw new Error(error.message);
  return parseAnnouncementAnswer(data, body => {
    if (!Array.isArray(body.items)) return null;
    return body.items
      .map(parsePanelAnnouncement)
      .filter((a): a is PanelAnnouncement => a !== null);
  });
}

/** Create (no id) or update (id and the version the screen read). */
export async function saveAnnouncement(
  id: string | null,
  document: AnnouncementDocument,
  expectedVersion: number | null,
): Promise<AnnouncementResult<PanelAnnouncement>> {
  const { data, error } = await supabase.rpc('platform_announcement_save', {
    p_id: id,
    p_value: document,
    p_expected_version: expectedVersion,
  });
  if (error) throw new Error(error.message);
  return parseAnnouncementAnswer(data, body => parsePanelAnnouncement(body.item));
}

export async function deleteAnnouncement(
  id: string,
  expectedVersion: number,
): Promise<AnnouncementResult<true>> {
  const { data, error } = await supabase.rpc('platform_announcement_delete', {
    p_id: id,
    p_expected_version: expectedVersion,
  });
  if (error) throw new Error(error.message);
  return parseAnnouncementAnswer(data, () => true as const);
}
