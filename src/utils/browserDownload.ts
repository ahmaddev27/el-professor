/**
 * The repo's Blob-download shape, with the anchor attached to the document.
 * `backup.ts`, `AbrechnungPage` and `DocumentsPage` all append, click and
 * remove; `historicalWorkingHoursFahrtenbuchExport.ts`'s `triggerDownload` is
 * the one that does not, and a detached anchor's click is ignored by Firefox.
 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
