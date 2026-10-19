import { useEffect } from 'react';
import { useToast } from '../../contexts/ToastContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { setExportFailureSink } from '../../lib/exportFeedback';
import { exportFailureMessage } from '../../lib/exportFailureMessage';

/**
 * Registers the toast as the place a failed export is reported.
 *
 * Mounted once, inside the toast and language providers, so the export
 * functions, which are plain functions called from many screens, can say what
 * happened in the user's language without any of those screens handling it.
 * Renders nothing.
 */
export function ExportFailureBridge() {
  const { showToast } = useToast();
  const { t } = useTranslation();

  useEffect(() => {
    return setExportFailureSink(({ error, retry }) => {
      const action = retry ? { label: t('export.error.retry'), onClick: retry } : undefined;
      showToast('error', t('export.error.title'), exportFailureMessage(error, t), action ? 12000 : 8000, action);
    });
  }, [showToast, t]);

  return null;
}
