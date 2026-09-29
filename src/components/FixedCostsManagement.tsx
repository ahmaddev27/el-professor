import React, { useState, useEffect } from 'react';
import { CalendarClock, Download, Info, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { useToast } from '../contexts/ToastContext';
import { handleDatabaseError } from '../utils/errorHandler';
import { exportTableToExcel } from '../utils/excelExport';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  formatEuro,
  Input,
  KpiCard,
  PageHeader,
  Tooltip,
  type DataTableColumn,
} from './ui';

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
  const { profile, user } = useAuth();
  // `can` through the scope: in a read context `can(page, 'edit')` is false,
  // which is what current_role_permits(page, true) answers there (plan 3.4b).
  const { can } = useCompanyScope();
  // The context exposes canEdit/canDelete as FUNCTIONS. Used bare in JSX a
  // function object is always truthy, so the "Keine Berechtigung" warning never
  // rendered and Edit/Delete showed for every role — including viewer, whose
  // write the database would then also have allowed. One boolean, asked once.
  const mayEdit = can('fixed-costs', 'edit');
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { success, error: showError, warning } = useToast();
  const { t } = useTranslation();
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; id: string | null }>({ isOpen: false, id: null });

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
        // fixed_costs.amount is numeric(10,2) — euros, not cents.
        { key: 'amount',      label: t('fleet.amountPerMonth'),  width: 20, align: 'right', type: 'money' },
        { key: 'created_at',  label: t('fleet.createdAt'),       width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '' },
      ],
      rows: fixedCosts as unknown as Record<string, unknown>[],
      totals: { amount: totalFixedCosts },
    });
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged; everything below
  // only draws it. The total is the float sum above, formatted through
  // utils/money.ts; this block adds no arithmetic.

  // formatEuro refuses a value that is not a finite amount. A figure shows such
  // a value as it is rather than taking the screen down, as DataTable does for
  // its own currency cells.
  const euro = (amount: number) => (Number.isFinite(amount) ? formatEuro(amount) : String(amount));

  // A read that failed with nothing loaded yet: "no fixed costs" and a total of
  // 0,00 € would both be claims the screen cannot make.
  const loadFailed = Boolean(error) && fixedCosts.length === 0;

  const columns: DataTableColumn<FixedCost>[] = [
    {
      id: 'description',
      header: t('common.description'),
      value: cost => cost.description,
      sortable: true,
      // On a phone the description wraps and the paddings tighten, so the amount
      // and both row actions stay on screen, also while a row is being edited.
      className: 'pr-2 sm:pr-4 md:min-w-[12rem]',
      cell: cost =>
        editingId === cost.id ? (
          <Input
            type="text"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            aria-label={t('common.description')}
            // A field's natural width is 20 characters, which a table cell
            // cannot shrink below; size 1 lets it take the cell's width instead,
            // so the row's save and cancel buttons stay on a phone's screen.
            size={1}
          />
        ) : (
          <span className="font-medium">{cost.description}</span>
        ),
    },
    {
      id: 'amount',
      header: t('common.amount'),
      kind: 'currency',
      className: 'pl-2 pr-3 sm:px-4',
      value: cost => Number(cost.amount),
      sortable: true,
      cell: cost =>
        editingId === cost.id ? (
          <Input
            type="number"
            step="0.01"
            value={formData.amount}
            onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
            aria-label={t('fleet.amountEuro')}
            className="ml-auto w-[5.5rem] text-right sm:w-32"
          />
        ) : (
          euro(Number(cost.amount))
        ),
    },
  ];

  const rowActions = (cost: FixedCost) =>
    editingId === cost.id ? (
      <>
        <Tooltip content={t('common.save')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('fleet.saveFixedCostAria', { description: cost.description })}
            onClick={() => handleUpdate(cost.id)}
          >
            <Save aria-hidden />
          </Button>
        </Tooltip>
        <Tooltip content={t('common.cancel')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('fleet.cancelFixedCostEditAria', { description: cost.description })}
            onClick={cancelEdit}
          >
            <X aria-hidden />
          </Button>
        </Tooltip>
      </>
    ) : (
      <>
        <Tooltip content={t('common.edit')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('fleet.editFixedCostAria', { description: cost.description })}
            onClick={() => startEdit(cost)}
          >
            <Pencil aria-hidden />
          </Button>
        </Tooltip>
        <Tooltip content={t('common.delete')}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="hover:text-critical"
            aria-label={t('fleet.deleteFixedCostAria', { description: cost.description })}
            onClick={() => confirmDelete(cost.id)}
          >
            <Trash2 aria-hidden />
          </Button>
        </Tooltip>
      </>
    );

  const header = (actions?: React.ReactNode) => (
    <PageHeader title={t('nav.fixkosten')} description={t('fleet.fixedCostsSubtitle')} actions={actions} />
  );

  if (loading) {
    return (
      <div className="font-ui">
        {header()}
        <div className="grid grid-cols-1 gap-4">
          <KpiCard label={t('fleet.totalPerMonth')} value="" loading className="sm:max-w-xs" />
          <DataTable caption={t('fleet.fixedCostsCaption')} columns={columns} rows={[]} getRowId={cost => cost.id} loading />
        </div>
      </div>
    );
  }

  const addButton = (size?: 'sm') => (
    <Button size={size} onClick={() => setIsAdding(true)}>
      <Plus aria-hidden />
      {t('fleet.addFixedCost')}
    </Button>
  );

  return (
    <div className="font-ui">
      {header(
        <>
          {/* The rule: an empty table and a total of 0,00 € are claims about the
              company's data, and after a read that failed the screen has made no
              such observation. `loadFailed` already withholds the KpiCard and
              blanks the table; the same claim inside a workbook is one the screen
              cannot take back once the file has left the browser. */}
          <Button variant="secondary" onClick={handleExport} disabled={loadFailed}>
            <Download aria-hidden />
            {t('common.exportExcelShort')}
          </Button>
          {mayEdit && !isAdding ? addButton() : null}
        </>,
      )}

      <div className="grid grid-cols-1 gap-4">
        {!loadFailed && (
          <KpiCard
            label={t('fleet.totalPerMonth')}
            value={euro(totalFixedCosts)}
            icon={CalendarClock}
            className="sm:max-w-xs"
          />
        )}

        {error && (
          <Alert tone="critical" title={t('common.error')}>
            <p>{error}</p>
            {showMigrationSteps && (
              <div className="mt-2">
                <p>{t('fleet.migrationSteps')}</p>
                <ol className="ml-5 mt-2 list-decimal space-y-1">
                  <li>{t('fleet.migrationStep1')}</li>
                  <li>{t('fleet.migrationStep2')}</li>
                  <li>{t('fleet.migrationStep3')}</li>
                  <li>{t('fleet.migrationStep4')}</li>
                </ol>
              </div>
            )}
          </Alert>
        )}

        {!mayEdit && (
          <Alert tone="caution" title={t('common.noPermission')}>
            {t('fleet.fixedCostsNeedEditorRole')}{' '}
            {t('fleet.currentRole')} <strong className="font-semibold text-fg">{profile?.role || t('fleet.notSet')}</strong>
          </Alert>
        )}

        {mayEdit && isAdding && (
          <Card>
            <CardHeader>
              <CardTitle as="h2">{t('fleet.newFixedCost')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t('common.description')}>
                  <Input
                    type="text"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder={t('fleet.fixedCostDescriptionPlaceholder')}
                    // The form opens from a button in the page header; focus
                    // follows it, or a keyboard user is left at the header.
                    autoFocus
                  />
                </Field>
                <Field label={t('fleet.amountEuro')}>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.amount}
                    onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                    placeholder={t('fleet.amountPlaceholder')}
                  />
                </Field>
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" onClick={cancelEdit}>
                  <X aria-hidden />
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleAdd}>
                  <Save aria-hidden />
                  {t('common.save')}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <DataTable
          caption={t('fleet.fixedCostsCaption')}
          columns={columns}
          rows={fixedCosts}
          getRowId={cost => cost.id}
          error={loadFailed}
          rowActions={mayEdit ? rowActions : undefined}
          rowActionsLabel={t('fleet.actions')}
          totals={{ description: t('overview.common.gesamt'), amount: euro(totalFixedCosts) }}
          emptyState={
            <EmptyState
              size="sm"
              icon={CalendarClock}
              title={t('fleet.noFixedCosts')}
              action={mayEdit && !isAdding ? addButton('sm') : undefined}
            />
          }
        />

        <p className="flex items-start gap-2 text-[13px] text-fg-muted">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
          <span>
            <span className="font-semibold text-fg">{t('fleet.hint')}</span> {t('fleet.fixedCostsNote')}
          </span>
        </p>

        {/* Audit finding 6 calls this developer output and the design README
            leaves removing it to the owner, so it stays, moved below the
            list and set as small print until he decides. */}
        {profile && (
          <p className="text-xs text-fg-subtle">
            <span className="font-semibold">{t('fleet.userInfo')}</span> {user?.email} | {t('fleet.roleLabel')}:{' '}
            {profile?.role || t('fleet.notSet')} | {t('fleet.canEditLabel')}: {mayEdit ? t('common.yes') : t('common.no')}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm({ isOpen: false, id: null })}
        onConfirm={() => deleteConfirm.id && handleDelete(deleteConfirm.id)}
        title={t('fleet.deleteFixedCostTitle')}
        description={t('fleet.deleteFixedCostMessage')}
        confirmLabel={t('common.delete')}
        icon={Trash2}
      />
    </div>
  );
};

export default FixedCostsManagement;
