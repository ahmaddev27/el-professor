import React, { useState, useEffect } from 'react';
import { DollarSign, Plus, CreditCard as Edit2, Trash2, Save, X, Download } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import ConfirmationModal from './ConfirmationModal';
import { handleDatabaseError } from '../utils/errorHandler';
import { exportTableToExcel } from '../utils/excelExport';

interface FixedCost {
  id: string;
  description: string;
  amount: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const FixedCostsManagement: React.FC = () => {
  const [fixedCosts, setFixedCosts] = useState<FixedCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [formData, setFormData] = useState({ description: '', amount: '' });
  const [error, setError] = useState<string | null>(null);
  const { canEdit, canDelete, canCreate, profile, user, companyId } = useAuth();
  const { success, error: showError, warning } = useToast();
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; id: string | null }>({ isOpen: false, id: null });
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  useEffect(() => {
    loadFixedCosts();
  }, []);

  const loadFixedCosts = async () => {
    try {
      setLoading(true);
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('fixed_costs')
        .select('*')
        .eq('company_id', companyId)
        .order('description');

      if (fetchError) {
        if (fetchError.code === 'PGRST204' || fetchError.message.includes('does not exist')) {
          setError('Die Fixkosten-Tabelle existiert noch nicht. Bitte führen Sie die Migration in der Supabase-Konsole aus.');
        } else {
          throw fetchError;
        }
      } else {
        setFixedCosts(data || []);
      }
    } catch (err: any) {
      console.error('Error loading fixed costs:', err);
      setError(err.message || 'Fehler beim Laden der Fixkosten');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!formData.description.trim() || !formData.amount) {
      warning('Fehlende Angaben', 'Bitte füllen Sie alle Felder aus');
      return;
    }

    if (!canCreate) {
      showError('Keine Berechtigung', 'Nur Administratoren und Ersteller können Fixkosten hinzufügen');
      return;
    }

    try {
      const { error } = await supabase
        .from('fixed_costs')
        .insert({
          description: formData.description.trim(),
          amount: parseFloat(formData.amount),
          company_id: companyId
        });

      if (error) {
        console.error('Error adding fixed cost:', error);
        if (error.code === 'PGRST204' || error.message.includes('does not exist')) {
          setError('Die Fixkosten-Tabelle existiert noch nicht. Bitte führen Sie die Migration in der Supabase-Konsole aus.');
          showError('Tabelle fehlt', 'Die Fixkosten-Tabelle existiert noch nicht');
        } else {
          showError('Fehler beim Erstellen', handleDatabaseError(error));
        }
        return;
      }

      success('Fixkosten erstellt', 'Die Fixkosten wurden erfolgreich hinzugefügt');

      setFormData({ description: '', amount: '' });
      setIsAdding(false);
      await loadFixedCosts();
    } catch (err: any) {
      console.error('Error adding fixed cost:', err);
      showError('Fehler beim Erstellen', handleDatabaseError(err));
    }
  };

  const handleUpdate = async (id: string) => {
    if (!formData.description.trim() || !formData.amount) {
      warning('Fehlende Angaben', 'Bitte füllen Sie alle Felder aus');
      return;
    }

    try {
      const { error } = await supabase
        .from('fixed_costs')
        .update({
          description: formData.description.trim(),
          amount: parseFloat(formData.amount),
        })
        .eq('id', id);

      if (error) {
        console.error('Error updating fixed cost:', error);
        showError('Fehler beim Aktualisieren', handleDatabaseError(error));
        return;
      }

      setEditingId(null);
      setFormData({ description: '', amount: '' });
      await loadFixedCosts();
      success('Fixkosten aktualisiert', 'Die Fixkosten wurden erfolgreich geändert');
    } catch (err: any) {
      console.error('Error updating fixed cost:', err);
      showError('Fehler beim Aktualisieren', handleDatabaseError(err));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase
        .from('fixed_costs')
        .delete()
        .eq('id', id);

      if (error) {
        console.error('Error deleting fixed cost:', error);
        showError('Fehler beim Löschen', handleDatabaseError(error));
        return;
      }
      await loadFixedCosts();
      success('Fixkosten gelöscht', 'Die Fixkosten wurden erfolgreich entfernt');
      setDeleteConfirm({ isOpen: false, id: null });
    } catch (err: any) {
      console.error('Error deleting fixed cost:', err);
      showError('Fehler beim Löschen', handleDatabaseError(err));
    }
  };

  const confirmDelete = (id: string) => {
    setDeleteConfirm({ isOpen: true, id });
  };

  const startEdit = (cost: FixedCost) => {
    setEditingId(cost.id);
    setFormData({
      description: cost.description,
      amount: cost.amount.toString(),
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setIsAdding(false);
    setFormData({ description: '', amount: '' });
  };

  const totalFixedCosts = fixedCosts.reduce((sum, cost) => sum + Number(cost.amount), 0);

  const handleExport = () => {
    exportTableToExcel({
      filename: `fixkosten_${new Date().toISOString().split('T')[0]}`,
      sheetTitle: 'Fixkosten',
      moduleName: 'Fixkosten',
      columns: [
        { key: 'description', label: 'Beschreibung',    width: 40 },
        { key: 'amount',      label: 'Betrag (€/Monat)', width: 20, align: 'right', format: v => Number(v).toFixed(2) },
        { key: 'created_at',  label: 'Erstellt am',     width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '' },
      ],
      rows: fixedCosts as unknown as Record<string, unknown>[],
      totals: { amount: totalFixedCosts.toFixed(2) },
    });
  };

  const inputStyle = {
    background: 'var(--bg-subtle)',
    border: '1px solid var(--border)',
    borderRadius: '0.5rem',
    color: 'var(--text-primary)',
    fontSize: '0.875rem',
    padding: '0.5rem 0.75rem',
    outline: 'none'
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-green-600 to-green-800 rounded-xl shadow-lg p-6 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-white bg-opacity-20 rounded-lg p-2">
              <DollarSign className="text-white" size={32} />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Fixkosten</h1>
              <p className="text-green-100 mt-1">Monatliche Fixkosten verwalten</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm text-green-100">Gesamt pro Monat</p>
              <p className="text-3xl font-bold">{totalFixedCosts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</p>
            </div>
            <button
              onClick={handleExport}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-white bg-opacity-20 hover:bg-opacity-30 text-white transition-all"
              title="Als Excel exportieren"
            >
              <Download size={15} />
              Excel
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div
          className="rounded-lg p-4"
          style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}
        >
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            <strong>Fehler:</strong> {error}
          </p>
          {error.includes('Migration') && (
            <div className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
              <p>Bitte führen Sie folgende Schritte aus:</p>
              <ol className="list-decimal ml-5 mt-2 space-y-1">
                <li>Öffnen Sie Ihr Supabase Dashboard</li>
                <li>Gehen Sie zum SQL Editor</li>
                <li>Kopieren Sie die SQL aus der Datei: supabase/migrations/20251008000000_add_fixed_costs_table.sql</li>
                <li>Führen Sie die SQL aus</li>
              </ol>
            </div>
          )}
        </div>
      )}

      {profile && (
        <div
          className="rounded-lg p-4"
          style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)' }}
        >
          <p className="text-sm" style={{ color: 'var(--accent-text)' }}>
            <strong>Benutzerinfo:</strong> {user?.email} | Rolle: {profile?.role || 'Nicht festgelegt'} |
            Kann bearbeiten: {canEdit ? 'Ja' : 'Nein'} | Kann löschen: {canDelete ? 'Ja' : 'Nein'}
          </p>
        </div>
      )}

      {!canEdit && (
        <div
          className="rounded-lg p-4"
          style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}
        >
          <p className="text-sm" style={{ color: 'var(--warning)' }}>
            <strong>Keine Berechtigung:</strong> Sie benötigen mindestens die Rolle "Editor", um Fixkosten zu verwalten.
            Ihre aktuelle Rolle: <strong>{profile?.role || 'Nicht festgelegt'}</strong>
          </p>
        </div>
      )}

      {canEdit && (
        <div
          className="rounded-xl p-6"
          style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)' }}
        >
          {!isAdding ? (
            <button
              onClick={() => setIsAdding(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-white rounded-lg transition-colors"
              style={{ background: 'var(--success)' }}
            >
              <Plus size={20} />
              Neue Fixkosten hinzufügen
            </button>
          ) : (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Neue Fixkosten</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Beschreibung
                  </label>
                  <input
                    type="text"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    placeholder="z.B. Miete, Versicherung..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Betrag (€)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.amount}
                    onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleAdd}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-white rounded-lg"
                  style={{ background: 'var(--success)' }}
                >
                  <Save size={16} />
                  Speichern
                </button>
                <button
                  onClick={cancelEdit}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg"
                  style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                >
                  <X size={16} />
                  Abbrechen
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div
        className="rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)' }}
      >
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead style={{ background: 'var(--bg-subtle)' }}>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Beschreibung
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Betrag
                </th>
                {(canEdit || canDelete) && (
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                    Aktionen
                  </th>
                )}
              </tr>
            </thead>
            <tbody style={{ background: 'var(--bg-surface)' }}>
              {fixedCosts.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-6 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                    Keine Fixkosten vorhanden
                  </td>
                </tr>
              ) : (
                fixedCosts.map((cost) => (
                  <tr
                    key={cost.id}
                    style={{
                      background: hoveredRow === cost.id ? 'var(--bg-subtle)' : 'transparent',
                      borderBottom: '1px solid var(--border)',
                      transition: 'background 0.15s'
                    }}
                    onMouseEnter={() => setHoveredRow(cost.id)}
                    onMouseLeave={() => setHoveredRow(null)}
                  >
                    {editingId === cost.id ? (
                      <>
                        <td className="px-6 py-4">
                          <input
                            type="text"
                            value={formData.description}
                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                            className="w-full"
                            style={inputStyle}
                          />
                        </td>
                        <td className="px-6 py-4">
                          <input
                            type="number"
                            step="0.01"
                            value={formData.amount}
                            onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                            className="w-full"
                            style={inputStyle}
                          />
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => handleUpdate(cost.id)}
                            className="mr-3"
                            style={{ color: 'var(--success)' }}
                            title="Speichern"
                          >
                            <Save size={18} />
                          </button>
                          <button
                            onClick={cancelEdit}
                            style={{ color: 'var(--text-secondary)' }}
                            title="Abbrechen"
                          >
                            <X size={18} />
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-6 py-4 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {cost.description}
                        </td>
                        <td className="px-6 py-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                          {Number(cost.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                        </td>
                        {(canEdit || canDelete) && (
                          <td className="px-6 py-4 text-right text-sm font-medium">
                            {canEdit && (
                              <button
                                onClick={() => startEdit(cost)}
                                className="mr-3"
                                style={{ color: 'var(--accent)' }}
                                title="Bearbeiten"
                              >
                                <Edit2 size={18} />
                              </button>
                            )}
                            {canDelete && (
                              <button
                                onClick={() => confirmDelete(cost.id)}
                                style={{ color: 'var(--danger)' }}
                                title="Löschen"
                              >
                                <Trash2 size={18} />
                              </button>
                            )}
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                ))
              )}
            </tbody>
            {fixedCosts.length > 0 && (
              <tfoot style={{ background: 'var(--bg-subtle)' }}>
                <tr>
                  <td className="px-6 py-4 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Gesamt</td>
                  <td className="px-6 py-4 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                    {totalFixedCosts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                  </td>
                  {(canEdit || canDelete) && <td></td>}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div
        className="rounded-lg p-4"
        style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)' }}
      >
        <p className="text-sm" style={{ color: 'var(--accent-text)' }}>
          <strong>Hinweis:</strong> Fixkosten werden automatisch in den Statistiken für jeden Monat berücksichtigt.
          Sie müssen nur einmal hinzugefügt werden und gelten dann für alle Monate.
        </p>
      </div>

      <ConfirmationModal
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm({ isOpen: false, id: null })}
        onConfirm={() => deleteConfirm.id && handleDelete(deleteConfirm.id)}
        title="Fixkosten löschen"
        message="Möchten Sie diese Fixkosten wirklich löschen?"
        type="warning"
      />
    </div>
  );
};

export default FixedCostsManagement;
