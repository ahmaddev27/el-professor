/**
 * Where an export that failed is reported.
 *
 * The export functions (`exportTableToExcel` and friends) are plain functions
 * with a `void` signature, called from more than forty places that have no
 * toast of their own. A screen cannot be asked to handle a failure it never
 * sees, so the failure goes to one sink that `ExportFailureBridge` registers
 * inside the providers, where it can use the toast and the language.
 *
 * `retry` runs the same delivery again with the workbook already built.
 * Without a sink (a test, the design harness) the failure is logged, which is
 * what the old fire-and-forget writer did.
 */
import type { ExportServiceError } from './exportService';

export interface ExportFailureReport {
  error: ExportServiceError | Error;
  filename: string;
  /** Absent when pressing the button again cannot help. */
  retry?: () => void;
}

type Sink = (report: ExportFailureReport) => void;

let sink: Sink | null = null;

/** Registers the sink and answers the function that removes it again. */
export function setExportFailureSink(next: Sink | null): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

export function reportExportFailure(report: ExportFailureReport): void {
  if (sink) {
    sink(report);
    return;
  }
  console.error(`export of ${report.filename} failed`, report.error);
}
