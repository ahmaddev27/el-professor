import { useState } from 'react';
import { Download, RefreshCw, Database, AlertCircle } from 'lucide-react';
import { BACKUP_CHILD_TABLES, BACKUP_TABLES, createAndDownloadBackup } from '../utils/backup';
import { useToast } from '../contexts/ToastContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { Alert, Button, Card } from './ui';

// Holds TranslationKeys: this list is module-level and t() is a hook value.
//
// One row per group rather than one per table: the backup now carries 43 tables
// and naming each would be 43 dictionary entries that drift the moment a table
// is added. The count below comes from the list itself, so the screen and the
// file cannot disagree about how much is in it — which is exactly what went
// wrong when this list said seven and meant seven while the text above it
// promised every table in the system.
const BACKED_UP_GROUP_KEYS: TranslationKey[] = [
  'bill.backup.group.masterData',
  'bill.backup.group.money',
  'bill.backup.group.payroll',
  'bill.backup.group.fahrtenbuch',
  'bill.backup.group.planning',
  'bill.backup.group.documents',
  'bill.backup.group.operations',
];

const BACKED_UP_TABLE_COUNT = BACKUP_TABLES.length + BACKUP_CHILD_TABLES.length;

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
      const backup = await createAndDownloadBackup(companyId);
      // German locale in both languages — see the formatting note in src/i18n/index.ts.
      setLastBackupTime(new Date().toLocaleString('de-DE'));
      // A backup that could not read a table must be impossible to mistake for
      // a complete one. The file says so (`complete: false`, `incompleteTables`)
      // and so does its name (UNVOLLSTAENDIG); this is the third signal, and the
      // only one the operator sees without opening anything. Reporting a success
      // here was half of the defect — the other half was writing `[]` for a
      // table whose read had failed.
      if (backup.complete) {
        showToast('success', t('bill.backup.success'));
      } else {
        showToast(
          'warning',
          t('bill.backup.partialTitle'),
          t('bill.backup.partialBody', {
            failed: backup.incompleteTables.length,
            total: backup.tableReports.length,
          }),
        );
      }
    } catch (error) {
      console.error('Backup error:', error);
      showToast('error', t('bill.backup.failed'));
    } finally {
      setIsLoading(false);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // One button, the company the session is in, the time it last ran in this tab.
  // Drawn with the design system. Two things changed with the backup itself: the
  // contents list is per group with the table count read from `backup.ts`, and
  // the format note now says what an empty table in the file means.

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
          {BACKED_UP_GROUP_KEYS.map(key => (
            <li key={key} className="flex items-start gap-2">
              <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />
              {t(key)}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm tabular-nums text-fg-subtle">
          {t('bill.backup.tableCount', { count: BACKED_UP_TABLE_COUNT })}
        </p>
      </div>
    </Card>
  );
}
