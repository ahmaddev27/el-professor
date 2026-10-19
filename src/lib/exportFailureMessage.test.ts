import { describe, expect, it } from 'vitest';
import { de } from '../i18n/de';
import { en } from '../i18n/en';
import { translate } from '../i18n';
import { exportFailureMessage } from './exportFailureMessage';
import { ExportServiceError, type ExportFailureKind } from './exportService';

const german = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('de', key, vars);
const english = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);

const KINDS: ExportFailureKind[] = ['unreachable', 'timeout', 'busy', 'rate_limited', 'unauthorized', 'too_large', 'rejected', 'server'];

describe('exportFailureMessage', () => {
  it('every kind of failure has a sentence, and every sentence says that no file was created', () => {
    for (const kind of KINDS) {
      const error = new ExportServiceError(kind, { code: 'illegal_character', sheet: 'S', row: 2, column: 3, requestId: 'r', retryAfterSeconds: 9 });
      for (const t of [german, english]) {
        const message = exportFailureMessage(error, t);
        expect(message, kind).not.toMatch(/^export\./);
        expect(message, kind).toMatch(/keine Datei|No file/);
      }
    }
  });

  it('names the sheet, row and column of a rejected cell', () => {
    const error = new ExportServiceError('rejected', { code: 'illegal_character', sheet: 'Belege', row: 12, column: 4 });
    const message = exportFailureMessage(error, german);
    expect(message).toContain('Belege');
    expect(message).toContain('Zeile 12');
    expect(message).toContain('Spalte 4');
    expect(message).toContain('Steuerzeichen');
  });

  it('falls back to a general reason for a code it does not know', () => {
    const error = new ExportServiceError('rejected', { code: 'something_new' });
    expect(exportFailureMessage(error, german)).toContain('ungültiger Inhalt');
  });

  it('puts the request id in a server error so support can find it', () => {
    expect(exportFailureMessage(new ExportServiceError('server', { requestId: 'deadbeef' }), german)).toContain('deadbeef');
    expect(exportFailureMessage(new ExportServiceError('server'), german)).not.toContain('{');
  });

  it('tells a rate-limited user how long to wait when it knows', () => {
    expect(exportFailureMessage(new ExportServiceError('rate_limited', { retryAfterSeconds: 14 }), german)).toContain('14 Sekunden');
    expect(exportFailureMessage(new ExportServiceError('rate_limited'), german)).not.toContain('{');
  });

  it('a failure that is not the service (a payload bug) still says no file was created', () => {
    expect(exportFailureMessage(new Error('boom'), german)).toContain('keine Datei');
  });

  it('every dynamic rejection reason exists in both dictionaries', () => {
    for (const code of ['illegal_character', 'cell_too_long', 'invalid_sheet_name', 'too_many_cells', 'too_many_rows', 'too_many_columns', 'other']) {
      expect(de, code).toHaveProperty(`export.reason.${code}`);
      expect(en, code).toHaveProperty(`export.reason.${code}`);
    }
  });

  it('carries the placeholders of the German sentence into the English one', () => {
    for (const key of ['export.error.rateLimited', 'export.error.rejectedAt', 'export.error.server', 'export.error.rejected'] as const) {
      const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
      expect(vars(en[key] ?? ''), key).toEqual(vars(de[key]));
    }
  });
});
