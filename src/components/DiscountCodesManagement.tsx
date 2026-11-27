import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil as Edit2, Trash2, ToggleLeft, ToggleRight, Tag, ChevronDown, ChevronUp, Users, Building2, Calendar, Hash, Percent, Euro, Check, AlertTriangle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { callPlatformRpc } from '../lib/platformRpc';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { fmt as fmtPrice } from '../utils/pricing';
import {
  Alert, Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  EmptyState, Field, Input, NativeSelect, PageHeader, cn,
} from './ui';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface DiscountCode {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  usage_mode: 'once' | 'monthly';
  audience_type: 'single' | 'multiple';
  max_redemptions: number | null;
  used_count: number;
  valid_from: string | null;
  valid_until: string | null;
  active: boolean;
  applies_to_plan: 'basic' | 'advanced' | 'premium' | 'all';
  applies_to_billing_cycle: 'monthly' | 'yearly' | 'all';
  min_cars: number | null;
  max_cars: number | null;
  assigned_company_id: string | null;
  created_at: string;
  updated_at: string;
}

interface Redemption {
  id: string;
  company_id: string;
  plan: string;
  billing_cycle: string;
  car_limit: number;
  original_price: number;
  discount_amount: number;
  final_price: number;
  usage_mode: string;
  redeemed_at: string;
  company_name?: string;
}

interface Company { id: string; name: string; }

const emptyForm = (): Omit<DiscountCode, 'id' | 'used_count' | 'created_at' | 'updated_at'> => ({
  code: '',
  description: null,
  discount_type: 'percentage',
  discount_value: 10,
  usage_mode: 'once',
  audience_type: 'multiple',
  max_redemptions: null,
  valid_from: null,
  valid_until: null,
  active: true,
  applies_to_plan: 'all',
  applies_to_billing_cycle: 'all',
  min_cars: null,
  max_cars: null,
  assigned_company_id: null,
});

// ─── Modal ─────────────────────────────────────────────────────────────────────

interface ModalProps {
  dc: DiscountCode | null;
  companies: Company[];
  onClose: () => void;
  onSaved: () => void;
}

const DiscountCodeModal: React.FC<ModalProps> = ({ dc, companies, onClose, onSaved }) => {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [form, setForm] = useState(dc ? {
    code: dc.code,
    description: dc.description ?? '',
    discount_type: dc.discount_type,
    discount_value: dc.discount_value,
    usage_mode: dc.usage_mode,
    audience_type: dc.audience_type,
    max_redemptions: dc.max_redemptions ?? '',
    valid_from: dc.valid_from ? dc.valid_from.slice(0, 10) : '',
    valid_until: dc.valid_until ? dc.valid_until.slice(0, 10) : '',
    active: dc.active,
    applies_to_plan: dc.applies_to_plan,
    applies_to_billing_cycle: dc.applies_to_billing_cycle,
    min_cars: dc.min_cars ?? '',
    max_cars: dc.max_cars ?? '',
    assigned_company_id: dc.assigned_company_id ?? '',
  } : {
    code: '',
    description: '',
    discount_type: 'percentage' as const,
    discount_value: 10,
    usage_mode: 'once' as const,
    audience_type: 'multiple' as const,
    max_redemptions: '' as string | number,
    valid_from: '',
    valid_until: '',
    active: true,
    applies_to_plan: 'all' as const,
    applies_to_billing_cycle: 'all' as const,
    min_cars: '' as string | number,
    max_cars: '' as string | number,
    assigned_company_id: '',
  });
  const [saving, setSaving] = useState(false);

  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.code.trim()) { showToast('error', t('codes.discount.enterCode')); return; }
    if (form.discount_value <= 0) { showToast('error', t('codes.discount.valuePositive')); return; }
    if (form.discount_type === 'percentage' && form.discount_value > 100) {
      showToast('error', t('codes.discount.percentMax')); return;
    }
    setSaving(true);
    const payload = {
      code: form.code.trim().toUpperCase(),
      description: form.description || null,
      discount_type: form.discount_type,
      discount_value: Number(form.discount_value),
      usage_mode: form.usage_mode,
      audience_type: form.audience_type,
      max_redemptions: form.max_redemptions !== '' ? Number(form.max_redemptions) : null,
      valid_from: form.valid_from || null,
      valid_until: form.valid_until || null,
      active: form.active,
      applies_to_plan: form.applies_to_plan,
      applies_to_billing_cycle: form.applies_to_billing_cycle,
      min_cars: form.min_cars !== '' ? Number(form.min_cars) : null,
      max_cars: form.max_cars !== '' ? Number(form.max_cars) : null,
      assigned_company_id: form.assigned_company_id || null,
    };
    try {
      // p_fields carries exactly the columns of this form; the database refuses
      // any other key, and checks the same rules again before it writes.
      await callPlatformRpc('platform_discount_code_save', { p_id: dc ? dc.id : null, p_fields: payload });
    } catch (err: any) {
      setSaving(false);
      showToast('error', err.message);
      return;
    }
    setSaving(false);
    showToast('success', dc ? t('codes.discount.updated') : t('codes.discount.created'));
    onSaved();
    onClose();
  };

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent
        className="max-w-xl max-h-[90dvh] overflow-y-auto"
        onPointerDownOutside={e => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{dc ? t('codes.discount.edit') : t('codes.discount.new')}</DialogTitle>
          <DialogDescription className="sr-only">{dc ? t('codes.discount.edit') : t('codes.discount.new')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* Code + Description */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('codes.discount.codeRequired')}>
              <Input value={form.code} onChange={e => set('code', e.target.value.toUpperCase())} placeholder="WELCOME10" />
            </Field>
            <Field label={t('common.description')}>
              <Input value={form.description ?? ''} onChange={e => set('description', e.target.value)} placeholder={t('codes.discount.descPlaceholder')} />
            </Field>
          </div>

          {/* Discount type + value */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('codes.discount.type')}>
              <NativeSelect value={form.discount_type} onChange={e => set('discount_type', e.target.value)}>
                <option value="percentage">{t('codes.discount.percentOption')}</option>
                <option value="fixed">{t('codes.discount.fixedOption')}</option>
              </NativeSelect>
            </Field>
            <Field label={<>{t('codes.discount.value')} {form.discount_type === 'percentage' ? '(%)' : '(€)'}</>}>
              <Input type="number" min={0} max={form.discount_type === 'percentage' ? 100 : undefined} step="0.01"
                value={form.discount_value}
                onChange={e => set('discount_value', parseFloat(e.target.value) || 0)} />
            </Field>
          </div>

          {/* Usage mode + Audience type */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('codes.discount.usage')}>
              <NativeSelect value={form.usage_mode} onChange={e => set('usage_mode', e.target.value)}>
                <option value="once">{t('codes.discount.once')}</option>
                <option value="monthly">{t('codes.discount.monthlyRecurring')}</option>
              </NativeSelect>
            </Field>
            <Field label={t('codes.discount.audience')}>
              <NativeSelect value={form.audience_type} onChange={e => set('audience_type', e.target.value)}>
                <option value="multiple">{t('codes.discount.multipleCompanies')}</option>
                <option value="single">{t('codes.discount.singleCompany')}</option>
              </NativeSelect>
            </Field>
          </div>

          {/* Assigned company (single) + max redemptions (multiple) */}
          {form.audience_type === 'single' && (
            <Field label={t('codes.discount.assignedCompany')}>
              <NativeSelect value={form.assigned_company_id ?? ''} onChange={e => set('assigned_company_id', e.target.value)}>
                <option value="">{t('codes.discount.firstRedeemer')}</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </NativeSelect>
            </Field>
          )}
          {form.audience_type === 'multiple' && (
            <Field label={t('codes.discount.maxRedemptions')}>
              <Input type="number" min={1}
                value={form.max_redemptions} onChange={e => set('max_redemptions', e.target.value)} placeholder={t('codes.discount.maxPlaceholder')} />
            </Field>
          )}

          {/* Validity dates */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('codes.discount.validFrom')}>
              <Input type="date" value={form.valid_from ?? ''} onChange={e => set('valid_from', e.target.value)} />
            </Field>
            <Field label={t('codes.col.validUntil')}>
              <Input type="date" value={form.valid_until ?? ''} onChange={e => set('valid_until', e.target.value)} />
            </Field>
          </div>

          {/* Plan + billing cycle filters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('codes.discount.validForPlan')}>
              <NativeSelect value={form.applies_to_plan} onChange={e => set('applies_to_plan', e.target.value)}>
                <option value="all">{t('codes.discount.allPlans')}</option>
                {/* Plan tier names are product names, identical in both languages. */}
                <option value="basic">Basic</option>
                <option value="advanced">Advanced</option>
                <option value="premium">Premium</option>
              </NativeSelect>
            </Field>
            <Field label={t('codes.discount.validForCycle')}>
              <NativeSelect value={form.applies_to_billing_cycle} onChange={e => set('applies_to_billing_cycle', e.target.value)}>
                <option value="all">{t('codes.discount.monthlyAndYearly')}</option>
                <option value="monthly">{t('codes.discount.monthlyOnly')}</option>
                <option value="yearly">{t('codes.discount.yearlyOnly')}</option>
              </NativeSelect>
            </Field>
          </div>

          {/* Car limits */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('codes.discount.minCars')}>
              <Input type="number" min={1}
                value={form.min_cars} onChange={e => set('min_cars', e.target.value)} placeholder="—" />
            </Field>
            <Field label={t('codes.discount.maxCars')}>
              <Input type="number" min={1}
                value={form.max_cars} onChange={e => set('max_cars', e.target.value)} placeholder="—" />
            </Field>
          </div>

          {/* Active toggle */}
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <div
              className={cn('relative h-6 w-11 rounded-full transition-colors', form.active ? 'bg-positive-dot' : 'bg-sunken')}
              onClick={() => set('active', !form.active)}
            >
              <div className={cn('absolute left-0.5 top-0.5 size-5 rounded-full bg-solid shadow-elev-xs motion-safe:transition-transform', form.active ? 'translate-x-5' : 'translate-x-0')} />
            </div>
            <span className="text-sm font-medium text-fg">{t('codes.status.active')}</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ─── Redemptions popover ──────────────────────────────────────────────────────

const REDEMPTIONS_PAGE_SIZE = 50;

const RedemptionsPanel: React.FC<{ codeId: string }> = ({ codeId }) => {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Redemption[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // This panel is the only place a discount's euro effect per company is shown,
  // so "Noch keine Einlösungen." must not stand in for a read that failed.
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    (async () => {
      setLoadFailed(false);
      const { data, error, count } = await supabase
        .from('discount_code_redemptions')
        .select('*, companies(name)', { count: 'exact' })
        .eq('discount_code_id', codeId)
        .order('redeemed_at', { ascending: false })
        .limit(REDEMPTIONS_PAGE_SIZE);
      if (error) {
        console.error(error);
        setRows([]);
        setTotal(null);
        setLoadFailed(true);
      } else {
        setRows((data ?? []).map((r: any) => ({ ...r, company_name: r.companies?.name })));
        setTotal(typeof count === 'number' ? count : null);
      }
      setLoading(false);
    })();
  }, [codeId]);

  if (loading) return <p className="text-xs text-center py-3 text-fg-subtle">{t('common.loading')}</p>;
  /*
    One paragraph, two sentences, and the sentence is the signal — not the
    colour: the wording already says which of the two happened, so a failed
    read keeps the panel's muted tone rather than painting itself red.
  */
  if (loadFailed || !rows.length) return (
    <p className="text-xs text-center py-3 text-fg-subtle">
      {loadFailed ? t('admin.read.failed') : t('codes.discount.noRedemptions')}
    </p>
  );

  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-fg-subtle">
            <th className="text-left py-1.5 pr-3 font-semibold">{t('codes.col.firm')}</th>
            <th className="text-left py-1.5 pr-3 font-semibold">{t('codes.col.plan')}</th>
            <th className="text-right py-1.5 pr-3 font-semibold">{t('codes.col.original')}</th>
            <th className="text-right py-1.5 pr-3 font-semibold">{t('codes.col.discount')}</th>
            <th className="text-right py-1.5 font-semibold">{t('codes.col.finalPrice')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-line">
              <td className="py-1.5 pr-3 text-fg">{r.company_name ?? r.company_id.slice(0, 8)}</td>
              <td className="py-1.5 pr-3 capitalize text-fg-muted">{r.plan}</td>
              <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums text-fg-muted">{fmtPrice(r.original_price)} €</td>
              <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums text-positive">-{fmtPrice(r.discount_amount)} €</td>
              <td className="py-1.5 text-right whitespace-nowrap tabular-nums font-semibold text-fg">{fmtPrice(r.final_price)} €</td>
            </tr>
          ))}
          {/*
            This is one page of at most 50, not the code's whole redemption
            history: say so rather than let the rows read as all of them. The
            line carries no colour of its own — it inherits the ambient legacy
            text colour, so it adds neither an inline style nor a Phase-2 token
            pair on a legacy background that nothing measures yet.
          */}
          {total !== null && total > rows.length && (
            <tr>
              <td colSpan={5} className="pt-2 text-[11px] text-fg-subtle">
                {t('admin.read.partial', { shown: rows.length, total })}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

// Holds TranslationKeys: this list is module-level and t() is a hook value.
const TABLE_HEADER_KEYS: TranslationKey[] = [
  'codes.col.code',
  'codes.discount.type',
  'common.value',
  'codes.discount.usage',
  'codes.discount.audience',
  'codes.col.validity',
  'codes.col.usages',
  'codes.status.active',
  'codes.col.actions',
];

const DiscountCodesManagement: React.FC = () => {
  const { showToast } = useToast();
  const { t, tPlural } = useTranslation();
  const [codes, setCodes] = useState<DiscountCode[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalDc, setModalDc] = useState<DiscountCode | 'new' | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; dc: DiscountCode | null }>({ open: false, dc: null });
  /**
   * A read that did not succeed. Neither the table's "Noch keine Rabattcodes
   * erstellt." nor the header's "N Codes · M aktiv" is shown while it is set:
   * both are claims about what exists on the platform, and a read that failed
   * makes neither.
   */
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      // Both errors are bound. Neither was, so a refusal or a transport failure
      // emptied the table in silence — and because nothing caught a rejected
      // Promise.all either, `loading` stayed true and the panel span for ever.
      const [codesRes, companiesRes] = await Promise.all([
        supabase.from('discount_codes').select('*').order('created_at', { ascending: false }),
        supabase.from('companies').select('id, name').order('name'),
      ]);
      if (codesRes.error) throw codesRes.error;
      if (companiesRes.error) throw companiesRes.error;
      setCodes(codesRes.data ?? []);
      setCompanies(companiesRes.data ?? []);
    } catch (err: any) {
      console.error(err);
      setCodes([]);
      setCompanies([]);
      setLoadFailed(true);
      showToast('error', err?.message || t('common.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [showToast, t]);

  useEffect(() => { load(); }, [load]);

  // Revoking a discount code is switching it off, and the same switch turns it
  // back on.
  const toggleActive = async (dc: DiscountCode) => {
    try {
      await callPlatformRpc('platform_discount_code_set_active', { p_id: dc.id, p_active: !dc.active });
    } catch (err: any) {
      showToast('error', err.message);
      return;
    }
    setCodes(prev => prev.map(c => c.id === dc.id ? { ...c, active: !c.active } : c));
  };

  const handleDelete = (dc: DiscountCode) => {
    setDeleteConfirm({ open: true, dc });
  };

  const confirmDelete = async () => {
    const dc = deleteConfirm.dc;
    setDeleteConfirm({ open: false, dc: null });
    if (!dc) return;
    try {
      await callPlatformRpc('platform_discount_code_delete', { p_id: dc.id });
    } catch (err: any) {
      showToast('error', err.message);
      return;
    }
    setCodes(prev => prev.filter(c => c.id !== dc.id));
    showToast('success', t('codes.discount.deleted'));
  };

  const formatDate = (iso: string | null) => iso ? format(new Date(iso), 'dd.MM.yy', { locale: de }) : '—';

  const discountLabel = (dc: DiscountCode) =>
    dc.discount_type === 'percentage'
      ? `${dc.discount_value}%`
      : `${fmtPrice(dc.discount_value)} €`;

  const usageModeLabel = (mode: string) =>
    mode === 'once' ? t('codes.discount.once') : t('codes.discount.monthly');
  const audienceLabel = (type: string) =>
    type === 'single' ? t('codes.discount.singleCompany') : t('codes.discount.multipleCompanies');

  // The keys of these maps are the stored plan / billing-cycle values — only the
  // label is translated, never the value compared against the database.
  const planLabel = (v: string) => {
    const labels: Record<string, string> = { all: t('common.all'), basic: 'Basic', advanced: 'Advanced', premium: 'Premium' };
    return labels[v] ?? v;
  };
  const cycleLabel = (v: string) => {
    const labels: Record<string, string> = { all: t('common.all'), monthly: t('codes.discount.monthly'), yearly: t('codes.discount.yearly') };
    return labels[v] ?? v;
  };


  // ── Presentation (phase 5) ────────────────────────────────────────────────
  return (
    <div className="space-y-6 font-ui">
      {/* Header */}
      <PageHeader
        className="pb-0"
        title={
          <span className="inline-flex items-center gap-3">
            <Tag className="text-brand-text" size={26} />
            {t('codes.discount.title')}
          </span>
        }
        description={
          /* Two counts over a list that was not read are not counts of zero. */
          loadFailed ? t('admin.read.failedTitle') : (<>
            {tPlural({ one: 'codes.countCode.one', other: 'codes.countCode.other' }, codes.length)}
            {' · '}
            {t('codes.activeCount', { count: codes.filter(c => c.active).length })}
          </>)
        }
        actions={
          <Button onClick={() => setModalDc('new')}>
            <Plus size={16} />
            {t('codes.discount.new')}
          </Button>
        }
      />

      {/* Table */}
      <div className="glass-card rounded-surface relative overflow-x-auto">
        {loading ? (
          <div className="py-16 text-center text-fg-subtle">{t('common.loading')}</div>
        ) : loadFailed ? (
          /* Not "no discount codes exist" — the list was not read. */
          <div className="p-4">
            <Alert tone="critical" className="font-ui" title={t('admin.read.failedTitle')}>
              {t('admin.read.failed')}
            </Alert>
          </div>
        ) : codes.length === 0 ? (
          <EmptyState icon={Tag} title={t('codes.discount.none')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-wash">
                <tr>
                  {TABLE_HEADER_KEYS.map(key => (
                    <th key={key} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap text-fg-muted">{t(key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {codes.map(dc => (
                  <React.Fragment key={dc.id}>
                    <tr className="border-b border-line transition-colors hover:bg-sunken">
                      <td className="px-4 py-3">
                        <div className="font-mono font-bold text-sm text-fg">{dc.code}</div>
                        {dc.description && <div className="text-xs mt-0.5 text-fg-subtle">{dc.description}</div>}
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {dc.applies_to_plan !== 'all' && (
                            <Badge tone="brand">{planLabel(dc.applies_to_plan)}</Badge>
                          )}
                          {dc.applies_to_billing_cycle !== 'all' && (
                            <Badge tone="caution">{cycleLabel(dc.applies_to_billing_cycle)}</Badge>
                          )}
                          {(dc.min_cars || dc.max_cars) && (
                            <Badge tone="neutral">
                              {t('codes.discount.carsRange', { min: dc.min_cars ?? '1', max: dc.max_cars ?? '∞' })}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={dc.discount_type === 'percentage' ? 'info' : 'caution'}>
                          {dc.discount_type === 'percentage' ? <Percent size={12} /> : <Euro size={12} />}
                          {dc.discount_type === 'percentage' ? t('codes.discount.percent') : t('codes.discount.fixed')}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-bold text-sm whitespace-nowrap tabular-nums text-fg">{discountLabel(dc)}</td>
                      <td className="px-4 py-3 text-xs text-fg-muted">{usageModeLabel(dc.usage_mode)}</td>
                      <td className="px-4 py-3 text-xs text-fg-muted">
                        <div>{audienceLabel(dc.audience_type)}</div>
                        {dc.max_redemptions && <div className="text-[11px] text-fg-subtle">{t('codes.discount.maxShort', { count: dc.max_redemptions })}</div>}
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap tabular-nums text-fg-muted">
                        <div>{formatDate(dc.valid_from)} – {formatDate(dc.valid_until)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setExpanded(expanded === dc.id ? null : dc.id)}
                          className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2 py-1 text-xs font-semibold tabular-nums text-brand-text transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [@media(pointer:coarse)]:min-h-10"
                        >
                          <Hash size={10} />
                          {dc.used_count}
                          {expanded === dc.id ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => toggleActive(dc)}
                          className="inline-flex items-center justify-center rounded-tight transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10"
                        >
                          {dc.active
                            ? <ToggleRight size={24} className="text-positive" />
                            : <ToggleLeft size={24} className="text-fg-subtle" />}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setModalDc(dc)}
                            className="text-brand-text"
                            title={t('common.edit')}
                          >
                            <Edit2 size={15} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleDelete(dc)}
                            className="text-critical hover:text-critical"
                            title={t('common.delete')}
                          >
                            <Trash2 size={15} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {expanded === dc.id && (
                      <tr>
                        <td colSpan={9} className="px-6 py-4 bg-sunken">
                          <p className="text-xs font-semibold uppercase tracking-wider mb-3 text-fg-muted">{t('codes.discount.redemptions')}</p>
                          <RedemptionsPanel codeId={dc.id} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal */}
      {modalDc && (
        <DiscountCodeModal
          dc={modalDc === 'new' ? null : modalDc}
          companies={companies}
          onClose={() => setModalDc(null)}
          onSaved={load}
        />
      )}
      <ConfirmDialog
        open={deleteConfirm.open}
        onClose={() => setDeleteConfirm({ open: false, dc: null })}
        onConfirm={confirmDelete}
        title={t('codes.discount.deleteTitle')}
        description={t('codes.discount.deleteConfirm', { code: deleteConfirm.dc?.code ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
      />
    </div>
  );
};

export default DiscountCodesManagement;
