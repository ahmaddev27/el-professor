import { useState } from 'react';
import { Download, RefreshCw, Database, AlertCircle } from 'lucide-react';
import { createAndDownloadBackup } from '../utils/backup';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';

export default function BackupManagement() {
  const [isLoading, setIsLoading] = useState(false);
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const { showToast } = useToast();
  const { companyId } = useAuth();

  const handleCreateBackup = async () => {
    if (!companyId) {
      showToast('Kein Unternehmen zugeordnet', 'error');
      return;
    }
    try {
      setIsLoading(true);
      await createAndDownloadBackup(companyId);
      setLastBackupTime(new Date().toLocaleString('de-DE'));
      showToast('Backup erfolgreich erstellt und heruntergeladen', 'success');
    } catch (error) {
      console.error('Backup error:', error);
      showToast('Fehler beim Erstellen des Backups', 'error');
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
          <h3 style={{ color: 'var(--text-primary)' }} className="text-lg font-semibold">Datensicherung</h3>
          <p style={{ color: 'var(--text-secondary)' }} className="text-sm">Alle Daten exportieren und herunterladen</p>
        </div>
      </div>

      <div className="space-y-4">
        <div style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)', borderRadius: '0.5rem', padding: '1rem', display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
          <AlertCircle style={{ color: 'var(--accent)', flexShrink: 0, marginTop: '0.125rem' }} className="w-5 h-5" />
          <div style={{ color: 'var(--text-primary)', fontSize: '0.875rem' }}>
            <p className="font-medium mb-1">Backup-Format</p>
            <p>Das Backup wird als JSON-Datei heruntergeladen und enthält alle Tabellen des Systems.</p>
          </div>
        </div>

        <div style={{ background: 'var(--bg-subtle)', borderRadius: '0.5rem', padding: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 500 }}>Letztes Backup:</p>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {lastBackupTime ? lastBackupTime : 'Noch kein Backup erstellt'}
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
              Backup wird erstellt...
            </>
          ) : (
            <>
              <Download className="w-5 h-5" />
              Backup jetzt erstellen
            </>
          )}
        </button>

        <div style={{ borderTop: '1px solid var(--border)', marginTop: '1.5rem', paddingTop: '1.5rem' }}>
          <h4 style={{ color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.75rem' }}>Enthaltene Tabellen:</h4>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-2" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            <li className="flex items-center gap-2">
              <span style={{ width: '0.375rem', height: '0.375rem', background: 'var(--accent)', borderRadius: '9999px', display: 'inline-block', flexShrink: 0 }}></span>
              Fahrer
            </li>
            <li className="flex items-center gap-2">
              <span style={{ width: '0.375rem', height: '0.375rem', background: 'var(--accent)', borderRadius: '9999px', display: 'inline-block', flexShrink: 0 }}></span>
              Belege
            </li>
            <li className="flex items-center gap-2">
              <span style={{ width: '0.375rem', height: '0.375rem', background: 'var(--accent)', borderRadius: '9999px', display: 'inline-block', flexShrink: 0 }}></span>
              Benutzerprofile
            </li>
            <li className="flex items-center gap-2">
              <span style={{ width: '0.375rem', height: '0.375rem', background: 'var(--accent)', borderRadius: '9999px', display: 'inline-block', flexShrink: 0 }}></span>
              Fixkosten
            </li>
            <li className="flex items-center gap-2">
              <span style={{ width: '0.375rem', height: '0.375rem', background: 'var(--accent)', borderRadius: '9999px', display: 'inline-block', flexShrink: 0 }}></span>
              Einnahmen
            </li>
            <li className="flex items-center gap-2">
              <span style={{ width: '0.375rem', height: '0.375rem', background: 'var(--accent)', borderRadius: '9999px', display: 'inline-block', flexShrink: 0 }}></span>
              Gehälter
            </li>
            <li className="flex items-center gap-2">
              <span style={{ width: '0.375rem', height: '0.375rem', background: 'var(--accent)', borderRadius: '9999px', display: 'inline-block', flexShrink: 0 }}></span>
              Bargeldtransaktionen
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
