/**
 * German dates and counts for the platform panel.
 *
 * `DD.MM.YYYY` in both languages — on-screen figures map one-to-one onto German
 * documents, and switching the format with the UI language invites
 * transcription errors (src/i18n/index.ts). Never `MM/DD/YYYY`.
 *
 * A missing timestamp reads as an em dash rather than "Invalid Date" or a blank
 * cell that could be mistaken for a value.
 */

export const EMPTY_CELL = '—';

const parse = (iso: string | null | undefined): Date | null => {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** `DD.MM.YYYY`, in the reader's own timezone. */
export function deDate(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return EMPTY_CELL;
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** `DD.MM.YYYY HH:MM:SS` — the audit log needs the second to order two rows. */
export function deDateTime(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return EMPTY_CELL;
  return `${deDate(iso)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `DD.MM.YYYY HH:MM`, for a time a person chose to the minute (an announcement's window). */
export function deDateTimeMinute(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return EMPTY_CELL;
  return `${deDate(iso)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A whole number with German thousands separators: 1234 → "1.234". */
export function deCount(value: number): string {
  if (!Number.isFinite(value)) return EMPTY_CELL;
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * The head of a uuid, for a column that identifies a row without filling it.
 * The whole id stays in the cell's title so it can still be copied.
 */
export function shortId(id: string | null | undefined): string {
  if (typeof id !== 'string' || id.length === 0) return EMPTY_CELL;
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}
