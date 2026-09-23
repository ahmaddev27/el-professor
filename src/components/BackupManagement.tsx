import { useState } from 'react';
import { Download, RefreshCw, Database, AlertCircle } from 'lucide-react';
import { createAndDownloadBackup } from '../utils/backup';
import { useToast } from '../contexts/ToastContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { Alert, Button, Card } from './ui';

// Holds TranslationKeys: this list is module-level and t() is a hook value.
const BACKED_UP_TABLE_KEYS: TranslationKey[] = [
  'bill.backup.table.drivers',
  'bill.backup.table.belege',
  'bill.backup.table.userProfiles',
  'bill.backup.table.fixedCosts',
  'bill.backup.table.income',
  'bill.backup.table.salaries',
  'bill.backup.table.cashTransactions',
];

export default function BackupManagement() {
  const [isLoading, setIsLoading] = useState(false);
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const { showToast } = useToast();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { t } = useTranslation();

  const handleCreateBackup = async () => {
    if (!companyId) {
      showToast('error', t('bill.backup.noCompany'));
      return;
    }
    try {
      setIsLoading(true);
      await createAndDownloadBackup(companyId);
      // German locale in both languages — see the formatting note in src/i18n/index.ts.
      setLastBackupTime(new Date().toLocaleString('de-DE'));
      showToast('success', t('bill.backup.success'));
    } catch (error) {
      console.error('Backup error:', error);
      showToast('error', t('bill.backup.failed'));
    } finally {
      setIsLoading(false);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // The backup itself is unchanged: one button, the company the session is in,
  // the time it last ran in this tab. Drawn with the design system.

  return (
    <Card className="grid gap-5 p-5 font-ui sm:p-6">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-surface bg-brand-soft text-brand-text">
          <Database className="size-5" />
        </span>
        <div>
          <h2 className="text-[15px] font-semibold text-fg">{t('bill.backup.title')}</h2>
          <p className="text-sm text-fg-muted">{t('bill.backup.subtitle')}</p>
        </div>
      </div>

      <Alert tone="brand" role="note" icon={AlertCircle} title={t('bill.backup.formatTitle')}>
        {t('bill.backup.formatBody')}
      </Alert>

      <div className="rounded-control bg-sunken p-4">
        <p className="text-sm font-medium text-fg">{t('bill.backup.last')}</p>
        <p className="text-sm tabular-nums text-fg-muted">
          {lastBackupTime ? lastBackupTime : t('bill.backup.never')}
        </p>
      </div>

      <Button
        size="lg"
        className="w-full"
        onClick={handleCreateBackup}
        disabled={isLoading}
      >
        {isLoading ? (
          <>
            <RefreshCw aria-hidden className="motion-safe:animate-spin" />
            {t('bill.backup.creating')}
          </>
        ) : (
          <>
            <Download aria-hidden />
            {t('bill.backup.createNow')}
          </>
        )}
      </Button>

      <div className="border-t border-line pt-5">
        <h3 className="mb-3 text-sm font-semibold text-fg">{t('bill.backup.tablesTitle')}</h3>
        <ul className="grid grid-cols-1 gap-2 text-sm text-fg-muted md:grid-cols-2">
          {BACKED_UP_TABLE_KEYS.map(key => (
            <li key={key} className="flex items-center gap-2">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
              {t(key)}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
