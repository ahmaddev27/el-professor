import React, { useState, useEffect } from 'react';
import { DollarSign, Plus, CreditCard as Edit2, Trash2, Save, X, Download } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import ConfirmationModal from './ConfirmationModal';
import { handleDatabaseError } from '../utils/errorHandler';
import { exportTableToExcel } from '../utils/excelExport';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';

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
  // `error` also carries raw database messages, so the migration hint is driven
  // by its own flag rather than by matching a word inside the translated text.
  const [showMigrationSteps, setShowMigrationSteps] = useState(false);
  const { can, profile, user } = useAuth();
  // The context exposes canEdit/canDelete as FUNCTIONS. Used bare in JSX a
  // function object is always truthy, so the "Keine Berechtigung" warning never
  // rendered and Edit/Delete showed for every role — including viewer, whose
  // write the database would then also have allowed. One boolean, asked once.
  const mayEdit = can('fixed-costs', 'edit');
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { success, error: showError, warning } = useToast();
  const { t } = useTranslation();
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; id: string | null }>({ isOpen: false, id: null });
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  useEffect(() => {
    loadFixedCosts();
  }, []);

  const loadFixedCosts = async () => {
    try {
      setLoading(true);
      setError(null);
      setShowMigrationSteps(false);
      const { data, error: fetchError } = await supabase
        .from('fixed_costs')
        .select('*')
        .eq('company_id', companyId)
        .order('description');

      if (fetchError) {
        if (fetchError.code === 'PGRST204' || fetchError.message.includes('does not exist')) {
          setError(t('fleet.fixedCostsTableMissing'));
          setShowMigrationSteps(true);
        } else {
          throw fetchError;
        }
      } else {
        setFixedCosts(data || []);
      }
    } catch (err: any) {
      console.error('Error loading fixed costs:', err);
      setError(err.message || t('fleet.fixedCostsLoadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!formData.description.trim() || !formData.amount) {
      warning(t('fleet.missingFields'), t('fleet.fillAllFields'));
      return;
    }

    if (!mayEdit) {
      showError(t('common.noPermission'), t('fleet.fixedCostsNoAddPermission'));
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
          setError(t('fleet.fixedCostsTableMissing'));
          setShowMigrationSteps(true);
          showError(t('fleet.tableMissingTitle'), t('fleet.fixedCostsTableMissingShort'));
        } else {
          showError(t('common.errorCreate'), handleDatabaseError(error));
        }
        return;
      }

      success(t('fleet.fixedCostsCreated'), t('fleet.fixedCostsCreatedBody'));

      setFormData({ description: '', amount: '' });
      setIsAdding(false);
      await loadFixedCosts();
    } catch (err: any) {
      console.error('Error adding fixed cost:', err);
      showError(t('common.errorCreate'), handleDatabaseError(err));
    }
  };

  const handleUpdate = async (id: string) => {
    if (!formData.description.trim() || !formData.amount) {
      warning(t('fleet.missingFields'), t('fleet.fillAllFields'));
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
        showError(t('common.errorUpdate'), handleDatabaseError(error));
        return;
      }

      setEditingId(null);
      setFormData({ description: '', amount: '' });
      await loadFixedCosts();
      success(t('fleet.fixedCostsUpdated'), t('fleet.fixedCostsUpdatedBody'));
    } catch (err: any) {
      console.error('Error updating fixed cost:', err);
      showError(t('common.errorUpdate'), handleDatabaseError(err));
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
        showError(t('common.errorDelete'), handleDatabaseError(error));
        return;
      }
      await loadFixedCosts();
      success(t('fleet.fixedCostsDeleted'), t('fleet.fixedCostsDeletedBody'));
      setDeleteConfirm({ isOpen: false, id: null });
    } catch (err: any) {
      console.error('Error deleting fixed cost:', err);
      showError(t('common.errorDelete'), handleDatabaseError(err));
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
      sheetTitle: t('nav.fixkosten'),
      moduleName: t('nav.fixkosten'),
      columns: [
        { key: 'description', label: t('common.description'),    width: 40 },
        { key: 'amount',      label: t('fleet.amountPerMonth'),  width: 20, align: 'right', format: v => Number(v).toFixed(2) },
        { key: 'created_at',  label: t('fleet.createdAt'),       width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '' },
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
              <h1 className="text-3xl font-bold">{t('nav.fixkosten')}</h1>
              <p className="text-green-100 mt-1">{t('fleet.fixedCostsSubtitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm text-green-100">{t('fleet.totalPerMonth')}</p>
              <p className="text-3xl font-bold">{totalFixedCosts.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</p>
            </div>
            <button
              onClick={handleExport}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-white bg-opacity-20 hover:bg-opacity-30 text-white transition-all"
              title={t('common.exportExcelShort')}
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
            <strong>{t('common.error')}:</strong> {error}
          </p>
          {showMigrationSteps && (
            <div className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
              <p>{t('fleet.migrationSteps')}</p>
              <ol className="list-decimal ml-5 mt-2 space-y-1">
                <li>{t('fleet.migrationStep1')}</li>
                <li>{t('fleet.migrationStep2')}</li>
                <li>{t('fleet.migrationStep3')}</li>
                <li>{t('fleet.migrationStep4')}</li>
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
            <strong>{t('fleet.userInfo')}</strong> {user?.email} | {t('fleet.roleLabel')}: {profile?.role || t('fleet.notSet')} |
            {' '}{t('fleet.canEditLabel')}: {mayEdit ? t('common.yes') : t('common.no')}
          </p>
        </div>
      )}

      {!mayEdit && (
        <div
          className="rounded-lg p-4"
          style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}
        >
          <p className="text-sm" style={{ color: 'var(--warning)' }}>
            <strong>{t('common.noPermission')}:</strong> {t('fleet.fixedCostsNeedEditorRole')}
            {' '}{t('fleet.currentRole')} <strong>{profile?.role || t('fleet.notSet')}</strong>
          </p>
        </div>
      )}

      {mayEdit && (
        <div
          className="rounded-xl p-6"
          style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)' }}
        >
          {!isAdding ? (
            <button
              onClick={() => setIsAdding(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-white rounded-lg transition-colors"
              style={{ background: 'var(--success-solid)' }}
            >
              <Plus size={20} />
              {t('fleet.addFixedCost')}
            </button>
          ) : (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('fleet.newFixedCost')}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    {t('common.description')}
                  </label>
                  <input
                    type="text"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    placeholder={t('fleet.fixedCostDescriptionPlaceholder')}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    {t('fleet.amountEuro')}
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
                  style={{ background: 'var(--success-solid)' }}
                >
                  <Save size={16} />
                  {t('common.save')}
                </button>
                <button
                  onClick={cancelEdit}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg"
                  style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                >
                  <X size={16} />
                  {t('common.cancel')}
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
                  {t('common.description')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  {t('common.amount')}
                </th>
                {mayEdit && (
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                    {t('fleet.actions')}
                  </th>
                )}
              </tr>
            </thead>
            <tbody style={{ background: 'var(--bg-surface)' }}>
              {fixedCosts.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-6 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                    {t('fleet.noFixedCosts')}
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
                            title={t('common.save')}
                          >
                            <Save size={18} />
                          </button>
                          <button
                            onClick={cancelEdit}
                            style={{ color: 'var(--text-secondary)' }}
                            title={t('common.cancel')}
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
                          {Number(cost.amount).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                        </td>
                        {mayEdit && (
                          <td className="px-6 py-4 text-right text-sm font-medium">
                            {mayEdit && (
                              <button
                                onClick={() => startEdit(cost)}
                                className="mr-3"
                                style={{ color: 'var(--accent)' }}
                                title={t('common.edit')}
                              >
                                <Edit2 size={18} />
                              </button>
                            )}
                            {mayEdit && (
                              <button
                                onClick={() => confirmDelete(cost.id)}
                                style={{ color: 'var(--danger)' }}
                                title={t('common.delete')}
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
                  <td className="px-6 py-4 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('overview.common.gesamt')}</td>
                  <td className="px-6 py-4 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                    {totalFixedCosts.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                  </td>
                  {mayEdit && <td></td>}
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
          <strong>{t('fleet.hint')}</strong> {t('fleet.fixedCostsNote')}
        </p>
      </div>

      <ConfirmationModal
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm({ isOpen: false, id: null })}
        onConfirm={() => deleteConfirm.id && handleDelete(deleteConfirm.id)}
        title={t('fleet.deleteFixedCostTitle')}
        message={t('fleet.deleteFixedCostMessage')}
        type="confirm"
      />
    </div>
  );
};

export default FixedCostsManagement;
