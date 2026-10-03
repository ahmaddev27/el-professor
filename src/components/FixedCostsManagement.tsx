import React, { useState, useEffect, useMemo } from 'react';
import { CalendarClock, ChevronDown, Download, Info, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { useToast } from '../contexts/ToastContext';
import { handleDatabaseError } from '../utils/errorHandler';
import { exportTableToExcel } from '../utils/excelExport';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  copyForMonth,
  currentMonth,
  listMonths,
  monthStart,
  resolveMonth,
  type CostCopy,
  type MonthlyCostRow,
  type ResolvedMonth,
} from '../utils/fixedCostMonths';
import {
  Alert,
  Badge,
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

type FixedCost = MonthlyCostRow & {
  created_by: string | null;
  updated_at: string;
};

const MONTH_KEYS: TranslationKey[] = [
  'bill.month.january', 'bill.month.february', 'bill.month.march', 'bill.month.april',
  'bill.month.may', 'bill.month.june', 'bill.month.july', 'bill.month.august',
  'bill.month.september', 'bill.month.october', 'bill.month.november', 'bill.month.december',
];

// Supabase answers at most 1000 rows a request, silently; a company with a few
// years of months would reach that, so the load is paged.
const PAGE_SIZE = 1000;

const FixedCostsManagement: React.FC = () => {
  const [fixedCosts, setFixedCosts] = useState<FixedCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingMonth, setAddingMonth] = useState<string | null>(null);
  const [formData, setFormData] = useState({ description: '', amount: '' });
  const [error, setError] = useState<string | null>(null);
  // `error` also carries raw database messages, so the migration hint is driven
  // by its own flag rather than by matching a word inside the translated text.
  const [showMigrationSteps, setShowMigrationSteps] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const { profile, user } = useAuth();
  // `can` through the scope: in a read context `can(page, 'edit')` is false,
  // which is what current_role_permits(page, true) answers there (plan 3.4b).
  const { can } = useCompanyScope();
  // One boolean, asked once; the context's canEdit is a function and truthy bare.
  const mayEdit = can('fixed-costs', 'edit');
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { success, error: showError, warning } = useToast();
  const { t } = useTranslation();
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; id: string | null; month: string | null }>({
    isOpen: false, id: null, month: null,
  });

  useEffect(() => {
    loadFixedCosts();
  }, []);

  const loadFixedCosts = async () => {
    try {
      setLoading(true);
      setError(null);
      setShowMigrationSteps(false);
      const all: FixedCost[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error: fetchError } = await supabase
          .from('fixed_costs')
          .select('*')
          .eq('company_id', companyId)
          .order('id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (fetchError) {
          if (fetchError.code === 'PGRST204' || fetchError.message.includes('does not exist')) {
            setError(t('fleet.fixedCostsTableMissing'));
            setShowMigrationSteps(true);
            return;
          }
          throw fetchError;
        }
        all.push(...((data || []) as FixedCost[]));
        if (!data || data.length < PAGE_SIZE) break;
      }
      setFixedCosts(all);
    } catch (err: any) {
      console.error('Error loading fixed costs:', err);
      setError(err.message || t('fleet.fixedCostsLoadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const months = useMemo(() => listMonths(fixedCosts), [fixedCosts]);
  const resolvedMonths = useMemo(() => months.map(m => resolveMonth(fixedCosts, m)), [months, fixedCosts]);
  const monthLabel = (month: string) => {
    const [year, mm] = month.split('-');
    return `${t(MONTH_KEYS[Number(mm) - 1])} ${year}`;
  };

  const parsedForm = (): CostCopy | null => {
    if (!formData.description.trim() || !formData.amount) {
      warning(t('fleet.missingFields'), t('fleet.fillAllFields'));
      return null;
    }
    return { description: formData.description.trim(), amount: parseFloat(formData.amount) };
  };

  // Writing into a month that only inherits: its rows are copied in ONE insert
  // with the change applied, so the month is never half copied and an earlier
  // month is never touched. A month with rows of its own is edited in place.
  const insertCopies = (month: string, copies: CostCopy[]) =>
    supabase.from('fixed_costs').insert(
      copies.map(c => ({ description: c.description, amount: c.amount, company_id: companyId, period_month: monthStart(month) })),
    );

  const reportWrite = (err: any, title: string) => {
    console.error('Error writing fixed cost:', err);
    if (err?.code === 'PGRST204' || err?.message?.includes('does not exist')) {
      setError(t('fleet.fixedCostsTableMissing'));
      setShowMigrationSteps(true);
      showError(t('fleet.tableMissingTitle'), t('fleet.fixedCostsTableMissingShort'));
    } else {
      showError(title, handleDatabaseError(err));
    }
  };

  const handleAdd = async (resolved: ResolvedMonth) => {
    const cost = parsedForm();
    if (!cost) return;
    if (!mayEdit) {
      showError(t('common.noPermission'), t('fleet.fixedCostsNoAddPermission'));
      return;
    }
    try {
      const copies = resolved.source === 'own' ? [cost] : copyForMonth(resolved, { add: cost });
      const { error: writeError } = await insertCopies(resolved.month, copies);
      if (writeError) return reportWrite(writeError, t('common.errorCreate'));
      success(t('fleet.fixedCostsCreated'), t('fleet.fixedCostsCreatedBody'));
      setFormData({ description: '', amount: '' });
      setAddingMonth(null);
      await loadFixedCosts();
    } catch (err: any) {
      reportWrite(err, t('common.errorCreate'));
    }
  };

  const handleUpdate = async (resolved: ResolvedMonth, id: string) => {
    const cost = parsedForm();
    if (!cost) return;
    try {
      const { error: writeError } =
        resolved.source === 'own'
          ? await supabase.from('fixed_costs').update(cost).eq('id', id)
          : await insertCopies(resolved.month, copyForMonth(resolved, { replaceId: id, replaceWith: cost }));
      if (writeError) return reportWrite(writeError, t('common.errorUpdate'));
      setEditingId(null);
      setFormData({ description: '', amount: '' });
      await loadFixedCosts();
      success(t('fleet.fixedCostsUpdated'), t('fleet.fixedCostsUpdatedBody'));
    } catch (err: any) {
      reportWrite(err, t('common.errorUpdate'));
    }
  };

  const handleDelete = async (month: string, id: string) => {
    const resolved = resolveMonth(fixedCosts, month);
    try {
      const { error: writeError } =
        resolved.source === 'own'
          ? await supabase.from('fixed_costs').delete().eq('id', id)
          : await insertCopies(month, copyForMonth(resolved, { removeId: id }));
      if (writeError) return reportWrite(writeError, t('common.errorDelete'));
      await loadFixedCosts();
      success(t('fleet.fixedCostsDeleted'), t('fleet.fixedCostsDeletedBody'));
      setDeleteConfirm({ isOpen: false, id: null, month: null });
    } catch (err: any) {
      reportWrite(err, t('common.errorDelete'));
    }
  };

  // A month with no rows of its own reads as inherited, so emptying a month
  // would silently bring the previous month's costs back. Say so instead.
  const confirmDelete = (resolved: ResolvedMonth, id: string) => {
    const wouldEmpty = resolved.rows.length === 1;
    if (wouldEmpty && hasEarlierRows(resolved.month)) {
      warning(t('fleet.fcm.lastRowTitle'), t('fleet.fcm.lastRowBody'));
      return;
    }
    setDeleteConfirm({ isOpen: true, id, month: resolved.month });
  };

  const hasEarlierRows = (month: string) =>
    fixedCosts.some(c => c.period_month === null || c.period_month.slice(0, 7) < month);

  const startEdit = (cost: FixedCost) => {
    setEditingId(cost.id);
    setFormData({ description: cost.description, amount: cost.amount.toString() });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setAddingMonth(null);
    setFormData({ description: '', amount: '' });
  };

  const toggle = (month: string, isOpen: boolean) => setExpanded({ ...expanded, [month]: !isOpen });

  const handleExport = () => {
    // What the screen shows, month by month, inherited rows included.
    const rows = resolvedMonths.flatMap(r =>
      r.rows.map(cost => ({ month: monthLabel(r.month), description: cost.description, amount: cost.amount })),
    );
    exportTableToExcel({
      filename: `fixkosten_${new Date().toISOString().split('T')[0]}`,
      sheetTitle: t('nav.fixkosten'),
      moduleName: t('nav.fixkosten'),
      columns: [
        { key: 'month',       label: t('common.month'),          width: 20 },
        { key: 'description', label: t('common.description'),    width: 40 },
        // fixed_costs.amount is numeric(10,2) — euros, not cents.
        { key: 'amount',      label: t('fleet.amountPerMonth'),  width: 20, align: 'right', type: 'money' },
      ],
      rows,
    });
  };

  // ── Presentation ──────────────────────────────────────────────────────────

  // formatEuro refuses a value that is not a finite amount; show it as it is.
  const euro = (amount: number) => (Number.isFinite(amount) ? formatEuro(amount) : String(amount));

  // A read that failed with nothing loaded yet: "no fixed costs" and a total of
  // 0,00 € would both be claims the screen cannot make.
  const loadFailed = Boolean(error) && fixedCosts.length === 0;

  const columns: DataTableColumn<FixedCost>[] = [
    {
      id: 'description',
      header: t('common.description'),
      value: cost => cost.description,
      className: 'pr-2 sm:pr-4 md:min-w-[12rem]',
      cell: cost =>
        editingId === cost.id ? (
          <Input
            type="text"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            aria-label={t('common.description')}
            // size 1 lets the field take the cell's width, so the row's save and
            // cancel buttons stay on a phone's screen.
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

  const rowActions = (resolved: ResolvedMonth) => (cost: FixedCost) =>
    editingId === cost.id ? (
      <>
        <Tooltip content={t('common.save')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('fleet.saveFixedCostAria', { description: cost.description })}
            onClick={() => handleUpdate(resolved, cost.id)}
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
            onClick={() => confirmDelete(resolved, cost.id)}
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

  const sourceBadge = (r: ResolvedMonth) => {
    if (r.source === 'own') return <Badge tone="brand">{t('fleet.fcm.own')}</Badge>;
    if (r.source === 'none') return <Badge>{t('fleet.fcm.none')}</Badge>;
    return (
      <Badge tone="caution">
        {r.inheritedFrom ? t('fleet.fcm.inheritedFrom', { month: monthLabel(r.inheritedFrom) }) : t('fleet.fcm.inheritedBaseline')}
      </Badge>
    );
  };

  const addForm = (r: ResolvedMonth) => (
    <div className="grid grid-cols-1 gap-4 rounded-surface border border-line p-4">
      <h3 className="text-[14px] font-semibold">{t('fleet.newFixedCost')}</h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={t('common.description')}>
          <Input
            type="text"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder={t('fleet.fixedCostDescriptionPlaceholder')}
            // The form opens from a button; focus follows it.
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
        <Button onClick={() => handleAdd(r)}>
          <Save aria-hidden />
          {t('common.save')}
        </Button>
      </div>
    </div>
  );

  const addButton = (month: string) => (
    <Button size="sm" onClick={() => { setEditingId(null); setFormData({ description: '', amount: '' }); setAddingMonth(month); }}>
      <Plus aria-hidden />
      {t('fleet.addFixedCost')}
    </Button>
  );

  const monthCard = (r: ResolvedMonth) => {
    const isOpen = expanded[r.month] ?? r.month === currentMonth();
    const panelId = `fixed-costs-${r.month}`;
    return (
      <Card key={r.month}>
        <CardHeader className="pb-0">
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls={panelId}
            onClick={() => toggle(r.month, isOpen)}
            className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [@media(pointer:coarse)]:min-h-11"
          >
            <span className="flex flex-wrap items-center gap-2">
              <ChevronDown aria-hidden className={`size-4 shrink-0 text-fg-subtle transition-transform ${isOpen ? '' : '-rotate-90'}`} />
              <CardTitle as="h2">{monthLabel(r.month)}</CardTitle>
              {sourceBadge(r)}
            </span>
            <span className="font-semibold tabular-nums">{euro(r.total)}</span>
          </button>
        </CardHeader>
        {isOpen && (
          <CardContent id={panelId} className="grid grid-cols-1 gap-4 pt-0">
            {r.source === 'inherited' && mayEdit && (
              <Alert tone="brand">{t('fleet.fcm.inheritedHint')}</Alert>
            )}
            {mayEdit && addingMonth === r.month && addForm(r)}
            <DataTable
              caption={t('fleet.fcm.monthCaption', { month: monthLabel(r.month) })}
              columns={columns}
              rows={r.rows as FixedCost[]}
              getRowId={cost => `${r.month}-${cost.id}`}
              error={loadFailed}
              rowActions={mayEdit ? rowActions(r) : undefined}
              rowActionsLabel={t('fleet.actions')}
              totals={{ description: t('overview.common.gesamt'), amount: euro(r.total) }}
              emptyState={<EmptyState size="sm" icon={CalendarClock} title={t('fleet.noFixedCosts')} />}
            />
            {mayEdit && addingMonth !== r.month && <div>{addButton(r.month)}</div>}
          </CardContent>
        )}
      </Card>
    );
  };

  const current = resolvedMonths.find(r => r.month === currentMonth());

  return (
    <div className="font-ui">
      {header(
        // An empty list and a total of 0,00 € are claims about the company's
        // data; after a failed read the screen has made no such observation,
        // and a workbook cannot take the claim back.
        <Button variant="secondary" onClick={handleExport} disabled={loadFailed}>
          <Download aria-hidden />
          {t('common.exportExcelShort')}
        </Button>,
      )}

      <div className="grid grid-cols-1 gap-4">
        {!loadFailed && (
          current && <KpiCard
            label={`${t('fleet.totalPerMonth')} · ${monthLabel(current.month)}`}
            value={euro(current.total)}
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

        {!loadFailed && resolvedMonths.map(monthCard)}

        <p className="flex items-start gap-2 text-[13px] text-fg-muted">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
          <span>
            <span className="font-semibold text-fg">{t('fleet.hint')}</span> {t('fleet.fcm.note')}
          </span>
        </p>

        {profile && (
          <p className="text-xs text-fg-subtle">
            <span className="font-semibold">{t('fleet.userInfo')}</span> {user?.email} | {t('fleet.roleLabel')}:{' '}
            {profile?.role || t('fleet.notSet')} | {t('fleet.canEditLabel')}: {mayEdit ? t('common.yes') : t('common.no')}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm({ isOpen: false, id: null, month: null })}
        onConfirm={() => deleteConfirm.id && deleteConfirm.month && handleDelete(deleteConfirm.month, deleteConfirm.id)}
        title={t('fleet.deleteFixedCostTitle')}
        description={t('fleet.deleteFixedCostMessage')}
        confirmLabel={t('common.delete')}
        icon={Trash2}
      />
    </div>
  );
};

export default FixedCostsManagement;
