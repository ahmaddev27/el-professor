import { useTranslation } from '../contexts/LanguageContext';
import type { ExportChromeText } from '../utils/tableExportRows';

/**
 * The chrome `exportTableToExcel` writes around a caller's own columns — the
 * empty-state cell, the filter line's prefix, the totals row's label and the
 * footer — in the UI language.
 *
 * It exists because **no existing caller passes `labels`**: #112 made the chrome
 * overridable and translated it nowhere, so all six older exports write German
 * chrome whatever the language is. These strings are not a statutory form (see
 * the header of src/i18n/index.ts for the closed list that is), so they follow
 * the language like any other label, and the four exports added with this hook
 * do not ship that defect. The German values are byte-identical to
 * `DEFAULT_EXPORT_CHROME`, so a German file is unchanged.
 *
 * `{count}` must survive translation: `interpolate` returns the template
 * unchanged when no vars are passed, and the exporter substitutes the row count
 * itself. Adopting this in the six older callers is one line each and belongs
 * with whoever owns `excelExport.ts`.
 */
export function useExportChrome(): ExportChromeText {
  const { t } = useTranslation();
  return {
    empty: t('ui.export.chrome.empty'),
    filters: t('ui.export.chrome.filters'),
    totals: t('ui.export.chrome.totals'),
    footer: t('ui.export.chrome.footer'),
  };
}
