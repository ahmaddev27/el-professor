/**
 * Announcements (plan 3.11): a short notice the platform shows the companies it
 * is meant for, for as long as it is meant to show.
 *
 * Two shapes, because two readers see two different things:
 *
 * - **What a tenant receives** through `get_app_config()`: the text, the tone
 *   and the window, and never the audience — a list of company ids is who the
 *   platform's other customers are. The database has already decided that this
 *   company is in the audience and that the window is open now.
 * - **What the panel edits** through `platform_announcements_list()` and
 *   `platform_announcement_save()`: everything, audience included.
 *
 * ## The window is two instants, never two dates
 *
 * An announcement shows while `starts_at <= now < ends_at`. The owner types a
 * wall-clock time in the browser, which is in Berlin; `toIsoInstant` turns it
 * into an ISO string **with its offset** (UTC, `Z`) before it leaves the
 * browser, and the database refuses a time without one — because a bare date
 * compared with `current_date` would mean midnight in the database's zone (UTC)
 * where the owner meant midnight in Berlin.
 *
 * The form rules mirror `app_private.platform_announcement_problem` (migration
 * 20260920130010) and name the same paths, so a typo is named on its field.
 * They decide nothing: the database validates every document it stores.
 */
import type { Language } from '../i18n';
import type { Plan } from '../contexts/PlanContext';
import type { TranslationKey } from '../i18n';

export type AnnouncementTone = 'info' | 'warning';
export type AnnouncementAudience = 'all' | 'plans' | 'companies';

/** One announcement as a tenant receives it. */
export interface Announcement {
  readonly id: string;
  readonly version: number;
  readonly tone: AnnouncementTone;
  readonly titleDe: string;
  readonly bodyDe: string;
  /** '' when there is no English text: the German shows instead. */
  readonly titleEn: string;
  readonly bodyEn: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
}

/** One announcement as the panel edits it. */
export interface PanelAnnouncement extends Announcement {
  readonly audience: AnnouncementAudience;
  readonly plans: readonly Plan[];
  readonly companyIds: readonly string[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

// The database's bounds (20260920130010); tests/rls/announcements.sql pins them.
export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 1000;
export const ANNOUNCEMENT_MAX_COMPANIES = 200;
export const ANNOUNCEMENT_PLANS: readonly Plan[] = ['basic', 'advanced', 'premium'];

const TONES: readonly AnnouncementTone[] = ['info', 'warning'];
const AUDIENCES: readonly AnnouncementAudience[] = ['all', 'plans', 'companies'];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const isInstant = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

function parseAnnouncement(value: unknown): Announcement | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const tone = str(value.tone);
  const titleDe = str(value.title_de);
  const bodyDe = str(value.body_de);
  const version = value.version;
  if (!id || !tone || !(TONES as readonly string[]).includes(tone) || !titleDe || !bodyDe) return null;
  if (typeof version !== 'number' || !Number.isInteger(version)) return null;
  if (!isInstant(value.starts_at)) return null;
  const endsAt = value.ends_at === null || value.ends_at === undefined ? null : value.ends_at;
  if (endsAt !== null && !isInstant(endsAt)) return null;
  return {
    id,
    version,
    tone: tone as AnnouncementTone,
    titleDe,
    bodyDe,
    titleEn: str(value.title_en) ?? '',
    bodyEn: str(value.body_en) ?? '',
    startsAt: value.starts_at,
    endsAt: endsAt as string | null,
  };
}

/**
 * The announcements a `get_app_config()` answer carries, or null for anything
 * that is not a list. An entry this build cannot read is dropped on its own.
 */
export function parseAnnouncements(value: unknown): readonly Announcement[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(parseAnnouncement).filter((a): a is Announcement => a !== null);
}

/** The panel's list, audience included. */
export function parsePanelAnnouncement(value: unknown): PanelAnnouncement | null {
  const base = parseAnnouncement(value);
  if (!base || !isRecord(value)) return null;
  const audience = str(value.audience);
  if (!audience || !(AUDIENCES as readonly string[]).includes(audience)) return null;
  const plans = Array.isArray(value.plans)
    ? value.plans.filter((p): p is Plan => typeof p === 'string' && (ANNOUNCEMENT_PLANS as readonly string[]).includes(p))
    : [];
  const companyIds = Array.isArray(value.company_ids)
    ? value.company_ids.filter((c): c is string => typeof c === 'string')
    : [];
  return {
    ...base,
    audience: audience as AnnouncementAudience,
    plans,
    companyIds,
    createdAt: str(value.created_at),
    updatedAt: str(value.updated_at),
  };
}

// ─── Showing one ─────────────────────────────────────────────────────────────

/**
 * The text for the reader's language. English only when both of its fields are
 * filled — the database refuses half a translation, and this does not trust it
 * to — otherwise the German, which every announcement carries.
 */
export function announcementText(a: Announcement, language: Language): { title: string; body: string } {
  if (language === 'en' && a.titleEn.trim() !== '' && a.bodyEn.trim() !== '') {
    return { title: a.titleEn, body: a.bodyEn };
  }
  return { title: a.titleDe, body: a.bodyDe };
}

/**
 * Whether the window is open at `now` (milliseconds). The database only hands
 * out open announcements, but a tab stays open for hours: this is what takes a
 * banner down at its end without waiting for the next configuration read.
 */
export function isShowing(a: Announcement, now: number): boolean {
  const start = Date.parse(a.startsAt);
  if (Number.isNaN(start) || start > now) return false;
  if (a.endsAt === null) return true;
  const end = Date.parse(a.endsAt);
  return !Number.isNaN(end) && now < end;
}

/**
 * Where a dismissal is remembered, in the viewer's own browser. The version is
 * part of it: an announcement the owner corrects comes back for a reader who
 * dismissed the old wording.
 */
export function dismissalKey(a: Pick<Announcement, 'id' | 'version'>): string {
  return `announcement-dismissed:${a.id}:${a.version}`;
}

export type AnnouncementState = 'scheduled' | 'showing' | 'ended';

export function announcementState(a: Announcement, now: number): AnnouncementState {
  if (Date.parse(a.startsAt) > now) return 'scheduled';
  return isShowing(a, now) ? 'showing' : 'ended';
}

// ─── The editor ──────────────────────────────────────────────────────────────

export interface AnnouncementForm {
  tone: AnnouncementTone;
  titleDe: string;
  bodyDe: string;
  titleEn: string;
  bodyEn: string;
  audience: AnnouncementAudience;
  plans: Plan[];
  companyIds: string[];
  /** `YYYY-MM-DDTHH:MM`, as a datetime-local field holds it: the browser's wall clock. */
  startsLocal: string;
  /** '' for an announcement that does not end. */
  endsLocal: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An instant as a datetime-local value in the browser's own zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * A datetime-local value — the browser's wall clock, no zone — as the instant it
 * names, in ISO with `Z`. Null for anything that is not a real time, including
 * a date that rolls over (the 31st of June) rather than exist.
 */
export function toIsoInstant(local: string): string | null {
  const m = LOCAL_INPUT.exec(local.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
      || d.getHours() !== hour || d.getMinutes() !== minute) {
    return null;
  }
  return d.toISOString();
}

export function emptyAnnouncementForm(now: Date = new Date()): AnnouncementForm {
  return {
    tone: 'info',
    titleDe: '',
    bodyDe: '',
    titleEn: '',
    bodyEn: '',
    audience: 'all',
    plans: [],
    companyIds: [],
    startsLocal: toLocalInput(now.toISOString()),
    endsLocal: '',
  };
}

export function announcementToForm(a: PanelAnnouncement): AnnouncementForm {
  return {
    tone: a.tone,
    titleDe: a.titleDe,
    bodyDe: a.bodyDe,
    titleEn: a.titleEn,
    bodyEn: a.bodyEn,
    audience: a.audience,
    plans: [...a.plans],
    companyIds: [...a.companyIds],
    startsLocal: toLocalInput(a.startsAt),
    endsLocal: a.endsAt ? toLocalInput(a.endsAt) : '',
  };
}

/** The document `platform_announcement_save` takes. */
export interface AnnouncementDocument {
  tone: AnnouncementTone;
  title_de: string;
  body_de: string;
  title_en: string;
  body_en: string;
  audience: AnnouncementAudience;
  plans: Plan[];
  company_ids: string[];
  starts_at: string;
  ends_at: string | null;
}

const textProblem = (text: string, max: number, required: boolean): boolean =>
  (required && text.trim() === '') || text.length > max || CONTROL_CHARACTERS.test(text);

/**
 * A form back into the document a save sends, or the first field the database
 * would refuse, by the path it would name.
 */
export function announcementFromForm(form: AnnouncementForm): { value: AnnouncementDocument } | { error: string } {
  const titleDe = form.titleDe.trim();
  const bodyDe = form.bodyDe.trim();
  const titleEn = form.titleEn.trim();
  const bodyEn = form.bodyEn.trim();

  if (!TONES.includes(form.tone)) return { error: 'announcement.tone' };
  if (textProblem(titleDe, ANNOUNCEMENT_TITLE_MAX, true)) return { error: 'announcement.title_de' };
  if (textProblem(bodyDe, ANNOUNCEMENT_BODY_MAX, true)) return { error: 'announcement.body_de' };
  if (textProblem(titleEn, ANNOUNCEMENT_TITLE_MAX, false)) return { error: 'announcement.title_en' };
  if (textProblem(bodyEn, ANNOUNCEMENT_BODY_MAX, false)) return { error: 'announcement.body_en' };
  // Half a translation would put an English title over a German body.
  if ((titleEn === '') !== (bodyEn === '')) return { error: 'announcement.english' };

  if (!AUDIENCES.includes(form.audience)) return { error: 'announcement.audience' };
  const plans = form.audience === 'plans'
    ? ANNOUNCEMENT_PLANS.filter(plan => form.plans.includes(plan))
    : [];
  if (form.audience === 'plans' && plans.length === 0) return { error: 'announcement.plans' };

  const companyIds = form.audience === 'companies' ? [...new Set(form.companyIds.map(id => id.toLowerCase()))] : [];
  if (form.audience === 'companies'
      && (companyIds.length === 0 || companyIds.length > ANNOUNCEMENT_MAX_COMPANIES)) {
    return { error: 'announcement.company_ids' };
  }
  const badId = companyIds.findIndex(id => !UUID.test(id));
  if (badId >= 0) return { error: `announcement.company_ids.${badId}` };

  const startsAt = toIsoInstant(form.startsLocal);
  if (!startsAt) return { error: 'announcement.starts_at' };
  let endsAt: string | null = null;
  if (form.endsLocal.trim() !== '') {
    endsAt = toIsoInstant(form.endsLocal);
    if (!endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) return { error: 'announcement.ends_at' };
  }

  return {
    value: {
      tone: form.tone,
      title_de: titleDe,
      body_de: bodyDe,
      title_en: titleEn,
      body_en: bodyEn,
      audience: form.audience,
      plans,
      company_ids: companyIds,
      starts_at: startsAt,
      ends_at: endsAt,
    },
  };
}

// ─── Answers ─────────────────────────────────────────────────────────────────

export type AnnouncementResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; problem?: string; currentVersion?: number };

/** A `{ok, …}` answer of the three panel RPCs. */
export function parseAnnouncementAnswer<T>(
  data: unknown,
  read: (body: Record<string, unknown>) => T | null,
): AnnouncementResult<T> {
  if (!isRecord(data)) return { ok: false, reason: 'malformed' };
  if (data.ok === true) {
    const value = read(data);
    return value === null ? { ok: false, reason: 'malformed' } : { ok: true, value };
  }
  const refusal: AnnouncementResult<T> = {
    ok: false,
    reason: typeof data.reason === 'string' ? data.reason : 'malformed',
  };
  if (typeof data.problem === 'string') refusal.problem = data.problem;
  if (typeof data.current_version === 'number') refusal.currentVersion = data.current_version;
  return refusal;
}

/** The message a refusal reads as; the settings screen's own sentences. */
export function announcementRefusalKey(reason: string): TranslationKey {
  switch (reason) {
    case 'forbidden':        return 'admin.settings.refusal.forbidden';
    case 'rate_limited':     return 'admin.settings.refusal.rateLimited';
    case 'version_conflict': return 'admin.settings.refusal.versionConflict';
    case 'invalid_value':    return 'admin.settings.refusal.invalidValue';
    case 'not_found':        return 'admin.announcements.notFound';
    default:                 return 'admin.settings.refusal.failed';
  }
}
