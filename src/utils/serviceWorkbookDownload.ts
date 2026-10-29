/**
 * Writes a workbook through the export service and hands the file to the
 * browser. The only writer of operational Excel files.
 *
 * The file is offered to the user only after the service has answered with the
 * complete workbook, so a failure never leaves a partial download. On failure
 * nothing is downloaded and nothing is written by any other library: see
 * `src/lib/exportService.ts` for why there is no fallback.
 */
import type * as XLSX from 'xlsx';
import { ExportServiceError, fetchWorkbook, type ExportServiceDeps } from '../lib/exportService';
import { reportExportFailure } from '../lib/exportFeedback';
import { triggerDownload } from './browserDownload';
import type { WorkbookPayload } from '../lib/workbookContract';
import { workbookToPayload, type PayloadOptions } from './workbookPayload';

/** Rejects with an ExportServiceError when the service cannot deliver the file. */
export async function downloadServiceWorkbook(
  source: XLSX.WorkBook,
  filename: string,
  deps?: ExportServiceDeps,
  options?: PayloadOptions,
): Promise<void> {
  const blob = await fetchWorkbook(workbookToPayload(source, options), deps);
  triggerDownload(blob, filename);
}

/**
 * The fire-and-forget shape every export button is written against. A failure
 * goes to the sink with a retry that reuses the already-built workbook.
 */
export function deliverWorkbook(source: XLSX.WorkBook, filename: string, options?: PayloadOptions): void {
  void downloadServiceWorkbook(source, filename, undefined, options).catch((error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    const retryable = failure instanceof ExportServiceError && failure.retryable;
    reportExportFailure({
      error: failure,
      filename,
      retry: retryable ? () => deliverWorkbook(source, filename, options) : undefined,
    });
  });
}

/**
 * `deliverWorkbook` for a caller that already holds the payload (the simulated
 * month's report is built as one, with no SheetJS workbook in between). Same
 * rules: the file is offered only after the service answered, a failure goes to
 * the sink, and a retry reuses the payload already built.
 */
export function deliverWorkbookPayload(payload: WorkbookPayload, filename: string): void {
  void fetchWorkbook(payload)
    .then(blob => triggerDownload(blob, filename))
    .catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      const retryable = failure instanceof ExportServiceError && failure.retryable;
      reportExportFailure({
        error: failure,
        filename,
        retry: retryable ? () => deliverWorkbookPayload(payload, filename) : undefined,
      });
    });
}
