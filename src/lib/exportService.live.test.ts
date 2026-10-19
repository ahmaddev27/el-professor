/**
 * A smoke test against a RUNNING export service, skipped unless asked for.
 *
 *   EXPORT_LIVE_URL=https://api-staging.elprofessor.eu \
 *   EXPORT_LIVE_TOKEN=<a signed-in user's access token> \
 *   EXPORT_LIVE_OUT=/tmp/live.xlsx \
 *   npx vitest run src/lib/exportService.live.test.ts
 *
 * It builds a real Belege export the way the screen does, sends it through the
 * production client code and writes the answer to EXPORT_LIVE_OUT, so the file
 * can be opened and its signature read. The anon key must be refused, which is
 * the same property deploy.sh probes after every release.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTableWorkbook } from '../utils/excelExport';
import { workbookToPayload } from '../utils/workbookPayload';
import { ExportServiceError, fetchWorkbook } from './exportService';

const url = process.env.EXPORT_LIVE_URL;
const token = process.env.EXPORT_LIVE_TOKEN;
const out = process.env.EXPORT_LIVE_OUT;

const payload = workbookToPayload(buildTableWorkbook({
  filename: 'live', sheetTitle: 'Belege', moduleName: 'Belege',
  columns: [
    { key: 'nr', label: 'Belegnummer' },
    { key: 'preis', label: 'Literpreis', type: 'number3' },
    { key: 'betrag', label: 'Betrag', type: 'money' },
    { key: 'text', label: 'Beschreibung' },
  ],
  rows: [
    { nr: 'BEL-1', preis: 2.049, betrag: 41.47, text: '=HYPERLINK("http://evil.example","x")' },
    { nr: 'BEL-2', preis: 1.989, betrag: 1234.5, text: '+SUM(A1) Müller € 🚕' },
  ],
  totals: { betrag: 1275.97 },
}));

describe.skipIf(!url || !token)('the live export service', () => {
  it('writes the workbook for a signed-in user', { timeout: 30_000 }, async () => {
    const blob = await fetchWorkbook(payload, { baseUrl: url, getAccessToken: async () => token ?? null });
    expect(blob.size).toBeGreaterThan(1000);
    if (out) writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  });

  it('refuses a token that is not an end user\'s', { timeout: 30_000 }, async () => {
    const error = await fetchWorkbook(payload, {
      baseUrl: url,
      getAccessToken: async () => 'not-a-real-token',
      refreshSession: async () => false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExportServiceError);
    expect((error as ExportServiceError).kind).toBe('unauthorized');
  });
});
