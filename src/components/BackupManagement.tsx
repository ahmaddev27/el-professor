import { useState } from 'react';
import { Download, RefreshCw, Database, AlertCircle } from 'lucide-react';
import { createAndDownloadBackup } from '../utils/backup';
import { useToast } from '../contexts/ToastContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

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

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '0.5rem', boxShadow: 'var(--shadow-sm)', padding: '1.5rem' }}>
      <div className="flex items-center gap-3 mb-6">
        <div style={{ background: 'var(--accent-subtle)', borderRadius: '0.5rem', padding: '0.75rem' }}>
          <Database style={{ color: 'var(--accent)' }} className="w-6 h-6" />
        </div>
        <div>
          <h3 style={{ color: 'var(--text-primary)' }} className="text-lg font-semibold">{t('bill.backup.title')}</h3>
          <p style={{ color: 'var(--text-secondary)' }} className="text-sm">{t('bill.backup.subtitle')}</p>
        </div>
      </div>

      <div className="space-y-4">
        <div style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)', borderRadius: '0.5rem', padding: '1rem', display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
          <AlertCircle style={{ color: 'var(--accent)', flexShrink: 0, marginTop: '0.125rem' }} className="w-5 h-5" />
          <div style={{ color: 'var(--text-primary)', fontSize: '0.875rem' }}>
            <p className="font-medium mb-1">{t('bill.backup.formatTitle')}</p>
            <p>{t('bill.backup.formatBody')}</p>
          </div>
        </div>

        <div style={{ background: 'var(--bg-subtle)', borderRadius: '0.5rem', padding: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 500 }}>{t('bill.backup.last')}</p>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {lastBackupTime ? lastBackupTime : t('bill.backup.never')}
            </p>
          </div>
        </div>

        <button
          onClick={handleCreateBackup}
          disabled={isLoading}
          style={{
            width: '100%',
            background: isLoading ? 'var(--bg-muted)' : 'var(--accent)',
            color: isLoading ? 'var(--text-tertiary)' : 'var(--accent-text)',
            borderRadius: '0.5rem',
            padding: '0.5rem 1rem',
            border: 'none',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            cursor: isLoading ? 'not-allowed' : 'pointer',
          }}
          onMouseEnter={e => { if (!isLoading) e.currentTarget.style.background = 'var(--accent-hover)'; }}
          onMouseLeave={e => (e.currentTarget.style.background = isLoading ? 'var(--bg-muted)' : 'var(--accent)')}
        >
          {isLoading ? (
            <>
              <RefreshCw className="w-5 h-5 animate-spin" />
              {t('bill.backup.creating')}
            </>
          ) : (
            <>
              <Download className="w-5 h-5" />
              {t('bill.backup.createNow')}
            </>
          )}
        </button>

        <div style={{ borderTop: '1px solid var(--border)', marginTop: '1.5rem', paddingTop: '1.5rem' }}>
          <h4 style={{ color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.75rem' }}>{t('bill.backup.tablesTitle')}</h4>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-2" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            {BACKED_UP_TABLE_KEYS.map(key => (
              <li key={key} className="flex items-center gap-2">
                <span style={{ width: '0.375rem', height: '0.375rem', background: 'var(--accent)', borderRadius: '9999px', display: 'inline-block', flexShrink: 0 }}></span>
                {t(key)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
