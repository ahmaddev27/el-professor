/**
 * The sentence a user reads when an export did not produce a file.
 *
 * Pure, with `t` passed in, so every kind of failure can be asserted without a
 * renderer. Every message says that no file was created, because that is the
 * thing the person at the button needs to know and cannot see.
 */
import type { TranslationKey, TranslationVars } from '../i18n';
import { ExportServiceError, type ExportFailureKind } from './exportService';

type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

const REJECTION_REASONS: ReadonlySet<string> = new Set([
  'illegal_character',
  'cell_too_long',
  'invalid_sheet_name',
  'too_many_cells',
  'too_many_rows',
  'too_many_columns',
]);

const SIMPLE_MESSAGES: Partial<Record<ExportFailureKind, TranslationKey>> = {
  unreachable: 'export.error.unreachable',
  timeout: 'export.error.timeout',
  busy: 'export.error.busy',
  unauthorized: 'export.error.unauthorized',
  too_large: 'export.error.tooLarge',
};

function rejectionMessage(error: ExportServiceError, t: Translate): string {
  const { code, sheet, row, column } = error.detail;
  // Every code in REJECTION_REASONS has a key of this shape in both dictionaries;
  // exportFailureMessage.test.ts asserts it for each one.
  const reason = t(`export.reason.${code && REJECTION_REASONS.has(code) ? code : 'other'}` as TranslationKey);
  if (sheet === undefined || row === undefined || column === undefined) {
    return t('export.error.rejected', { reason });
  }
  return t('export.error.rejectedAt', { reason, sheet, row, column });
}

function rateLimitMessage(error: ExportServiceError, t: Translate): string {
  const seconds = error.detail.retryAfterSeconds;
  return seconds === undefined
    ? t('export.error.rateLimitedNoWait')
    : t('export.error.rateLimited', { seconds });
}

function serverMessage(error: ExportServiceError, t: Translate): string {
  const requestId = error.detail.requestId;
  return requestId ? t('export.error.server', { requestId }) : t('export.error.serverNoRef');
}

export function exportFailureMessage(error: Error, t: Translate): string {
  if (!(error instanceof ExportServiceError)) return t('export.error.local');
  const simple = SIMPLE_MESSAGES[error.kind];
  if (simple) return t(simple);
  if (error.kind === 'rejected') return rejectionMessage(error, t);
  if (error.kind === 'rate_limited') return rateLimitMessage(error, t);
  return serverMessage(error, t);
}
