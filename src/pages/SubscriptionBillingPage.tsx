import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { callPlatformRpc } from '../lib/platformRpc';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import {
  CreditCard, Receipt, CheckCircle, AlertTriangle, Clock,
  XCircle, DollarSign, Building2, Filter, Download, Eye,
  Plus, RefreshCw, Banknote, CalendarDays, ChevronDown,
  TrendingUp, FileText, Search, MoreHorizontal, X,
} from 'lucide-react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import MarkPaidModal from '../components/MarkPaidModal';
import PlanManagementModal from '../components/PlanManagementModal';
import GenerateInvoicesModal from '../components/GenerateInvoicesModal';
import AssignSubscriptionModal from '../components/AssignSubscriptionModal';
import InvoiceDetailModal from '../components/InvoiceDetailModal';
import { generateSubscriptionPdf, InvoicePdfData } from '../utils/subscriptionPdf';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SubscriptionPlan {
  id: string;
  name: string;
  monthly_price: number;
  included_cars: number;
  drivers_per_car_limit: number;
  features_json: Record<string, any>;
  is_active: boolean;
}

interface CompanySub {
  id: string;
  company_id: string;
  plan_id: string;
  status: string;
  starts_at: string;
  ends_at: string | null;
  billing_day: number;
  monthly_price: number;
  payment_method: string;
  notes: string | null;
  companies: { name: string; email: string | null; city: string | null } | null;
  subscription_plans: { name: string } | null;
}

interface Invoice {
  id: string;
  company_id: string;
  subscription_id: string;
  invoice_month: number;
  invoice_year: number;
  invoice_number: string;
  amount: number;
  status: string;
  payment_method: string;
  due_date: string;
  paid_at: string | null;
  paid_by: string | null;
  collected_by: string | null;
  cash_received_amount: number | null;
  receipt_note: string | null;
  created_at: string;
  companies: { name: string; email: string | null; street: string | null; house_number: string | null; postal_code: string | null; city: string | null } | null;
  company_subscriptions: { plan_id: string; subscription_plans: { name: string } | null } | null;
}

interface CompanySettings {
  company_name: string;
  street: string | null;
  house_number: string | null;
  postal_code: string | null;
  city: string | null;
  vat_id: string | null;
  tax_number: string | null;
  bank_name: string | null;
  iban: string | null;
  bic: string | null;
  account_holder: string | null;
}

// Screen-only month names, for the filter dropdown and the period column. The
// Rechnung/Quittung PDF keeps its own German copy in utils/subscriptionPdf.ts,
// so nothing here reaches a generated document. Values are TranslationKeys
// because this array is module-level and t() is a hook value.
const MONTH_KEYS: readonly TranslationKey[] = [
  'sa.month.january', 'sa.month.february', 'sa.month.march', 'sa.month.april',
  'sa.month.may', 'sa.month.june', 'sa.month.july', 'sa.month.august',
  'sa.month.september', 'sa.month.october', 'sa.month.november', 'sa.month.december',
];

/** Resolve a 1-based month number, tolerating a value outside 1\u201312. */
function monthLabel(t: (key: TranslationKey) => string, month: number): string {
  const key = MONTH_KEYS[month - 1];
  return key ? t(key) : '';
}

function fmtEur(v: number) {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' \u20AC';
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SubscriptionBillingPage() {
  // The platform write RPCs take the acting account from the caller's own token,
  // so nothing here sends a user id any more.
  const { isSuperAdmin, profile } = useAuth();
  // Hidden for a role without the capability; the database refuses regardless.
  const { platformCan } = useSuperAdmin();
  const canBilling = platformCan('billing.manage');
  const canPricing = platformCan('pricing.manage');
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<CompanySub[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [sellerSettings, setSellerSettings] = useState<CompanySettings | null>(null);

  // Filters
  const now = new Date();
  const [filterMonth, setFilterMonth] = useState(now.getMonth() + 1);
  const [filterYear, setFilterYear] = useState(now.getFullYear());
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterCompany, setFilterCompany] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // Modals
  const [markPaidInvoice, setMarkPaidInvoice] = useState<Invoice | null>(null);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [detailInvoice, setDetailInvoice] = useState<Invoice | null>(null);

  const [activeTab, setActiveTab] = useState<'invoices' | 'subscriptions' | 'plans'>('invoices');

  // ── Load data ──

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [plansRes, subsRes, invRes] = await Promise.all([
        supabase.from('subscription_plans').select('*').order('monthly_price'),
        supabase.from('company_subscriptions').select('*, companies(name, email, city), subscription_plans(name)').order('created_at', { ascending: false }),
        supabase.from('subscription_invoices').select('*, companies(name, email, street, house_number, postal_code, city), company_subscriptions(plan_id, subscription_plans(name))').order('invoice_year', { ascending: false }).order('invoice_month', { ascending: false }).order('created_at', { ascending: false }),
      ]);

      if (plansRes.data) setPlans(plansRes.data);
      if (subsRes.data) setSubscriptions(subsRes.data as any);
      if (invRes.data) setInvoices(invRes.data as any);

      // Load seller settings (platform owner company settings)
      if (isSuperAdmin && profile?.company_id) {
        const { data: cs } = await supabase
          .from('company_settings')
          .select('company_name, street, house_number, postal_code, city, vat_id, tax_number, bank_name, iban, bic, account_holder')
          .eq('company_id', profile.company_id)
          .maybeSingle();
        if (cs) setSellerSettings(cs);
      }
    } catch (err) {
      console.error(err);
      showToast('error', t('sa.subs.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, profile?.company_id, showToast, t]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Filtered invoices ──

  const filteredInvoices = invoices.filter(inv => {
    if (filterMonth > 0 && inv.invoice_month !== filterMonth) return false;
    if (filterYear > 0 && inv.invoice_year !== filterYear) return false;
    if (filterStatus !== 'all' && inv.status !== filterStatus) return false;
    if (filterCompany !== 'all' && inv.company_id !== filterCompany) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const name = inv.companies?.name?.toLowerCase() || '';
      const num = inv.invoice_number.toLowerCase();
      if (!name.includes(q) && !num.includes(q)) return false;
    }
    return true;
  });

  // ── KPIs ──

  const activeSubCount = subscriptions.filter(s => s.status === 'active').length;
  const openInvoices = invoices.filter(i => i.status === 'open');
  const overdueInvoices = invoices.filter(i => i.status === 'open' && new Date(i.due_date) < now);
  const paidThisMonth = invoices.filter(i => i.status === 'paid' && i.invoice_month === now.getMonth() + 1 && i.invoice_year === now.getFullYear());
  const totalExpected = filteredInvoices.reduce((s, i) => s + i.amount, 0);
  const totalCollected = filteredInvoices.filter(i => i.status === 'paid').reduce((s, i) => s + (i.cash_received_amount || i.amount), 0);

  // ── Companies list for filter ──
  const companyMap = new Map<string, string>();
  invoices.forEach(inv => {
    if (inv.companies?.name) companyMap.set(inv.company_id, inv.companies.name);
  });
  subscriptions.forEach(sub => {
    if (sub.companies?.name) companyMap.set(sub.company_id, (sub.companies as any).name);
  });

  // ── Mark unpaid ──
  const handleMarkUnpaid = async (inv: Invoice) => {
    try {
      // The invoice and its payment-trail row in one transaction. The trail keeps
      // the German wording it was always written with, whatever language the
      // operator's UI is in.
      await callPlatformRpc('platform_invoice_mark_unpaid', { p_invoice_id: inv.id });
    } catch (err: any) {
      showToast('error', t('sa.subs.errorWithMessage', { message: err.message }));
      return;
    }
    showToast('success', t('sa.subs.markedOpen'));
    loadData();
  };

  // ── Cancel invoice ──
  const handleCancel = async (inv: Invoice) => {
    try {
      await callPlatformRpc('platform_invoice_cancel', { p_invoice_id: inv.id });
    } catch (err: any) {
      showToast('error', t('sa.subs.errorWithMessage', { message: err.message }));
      return;
    }
    showToast('success', t('sa.subs.invoiceCanceled'));
    loadData();
  };

  // ── PDF download ──
  // Every literal below feeds generateSubscriptionPdf and is therefore German
  // in both languages: the PDF is a German payment record.
  const handleDownloadPdf = (inv: Invoice) => {
    const planName = inv.company_subscriptions?.subscription_plans?.name || 'Abonnement';
    const co = inv.companies;
    const addr = co ? [co.street, co.house_number].filter(Boolean).join(' ') + (co.postal_code ? `\n${co.postal_code} ${co.city || ''}` : '') : null;
    const s = sellerSettings;
    const sellerAddr = s ? [s.street, s.house_number].filter(Boolean).join(' ') + `\n${s.postal_code || ''} ${s.city || ''}` : '';
    const sellerTax = [s?.vat_id ? `USt-IdNr: ${s.vat_id}` : '', s?.tax_number ? `Steuernr: ${s.tax_number}` : ''].filter(Boolean).join(' | ');
    const sellerBank = s ? [s.bank_name, s.iban ? `IBAN: ${s.iban}` : '', s.bic ? `BIC: ${s.bic}` : ''].filter(Boolean).join(' | ') : '';

    const pdfData: InvoicePdfData = {
      invoiceNumber: inv.invoice_number,
      invoiceMonth: inv.invoice_month,
      invoiceYear: inv.invoice_year,
      amount: inv.amount,
      status: inv.status,
      dueDate: inv.due_date,
      paidAt: inv.paid_at,
      collectedByName: null,
      receiptNote: inv.receipt_note,
      companyName: co?.name || 'Unbekannt',
      companyAddress: addr,
      planName,
      sellerName: s?.company_name || 'El-Professor',
      sellerAddress: sellerAddr,
      sellerTaxInfo: sellerTax,
      sellerBank,
    };

    const doc = generateSubscriptionPdf(pdfData);
    // German in both languages: this word is the export filename and also
    // appears inside the generated PDF, which is a German payment record.
    const label = inv.status === 'paid' ? 'Quittung' : 'Rechnung';
    doc.save(`${label}_${inv.invoice_number}.pdf`);
    showToast('success', t('sa.subs.pdfDownloaded', { label }));
  };

  // ── Status badge ──
  const StatusBadge = ({ status, dueDate }: { status: string; dueDate?: string }) => {
    const isOverdue = status === 'open' && dueDate && new Date(dueDate) < now;
    const displayStatus = isOverdue ? 'overdue' : status;

    const config: Record<string, { bg: string; text: string; label: string; icon: React.ElementType }> = {
      open:     { bg: 'rgba(59,130,246,0.12)', text: 'var(--accent)',  label: t('sa.subs.invoiceStatus.open'),     icon: Clock },
      paid:     { bg: 'rgba(34,197,94,0.12)',   text: 'var(--success)', label: t('sa.subs.invoiceStatus.paid'),     icon: CheckCircle },
      overdue:  { bg: 'rgba(239,68,68,0.12)',   text: 'var(--danger)',  label: t('sa.subs.invoiceStatus.overdue'),  icon: AlertTriangle },
      canceled: { bg: 'rgba(148,163,184,0.15)', text: 'var(--text-tertiary)', label: t('sa.subs.invoiceStatus.canceled'), icon: XCircle },
    };
    const c = config[displayStatus] || config.open;
    const Icon = c.icon;

    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold" style={{ background: c.bg, color: c.text }}>
        <Icon size={12} />
        {c.label}
      </span>
    );
  };

  // ── Actions dropdown ──
  const InvoiceActions = ({ inv }: { inv: Invoice }) => {
    const [open, setOpen] = useState(false);

    return (
      <div className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="p-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--text-tertiary)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <MoreHorizontal size={16} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              className="absolute right-0 top-8 z-50 w-52 rounded-xl py-1.5 shadow-xl"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
            >
              <button className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors"
                style={{ color: 'var(--text-primary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                onClick={() => { setOpen(false); setDetailInvoice(inv); }}
              >
                <Eye size={14} /> {t('sa.subs.actionView')}
              </button>
              {canBilling && inv.status !== 'paid' && inv.status !== 'canceled' && (
                <button className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors"
                  style={{ color: 'var(--success)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => { setOpen(false); setMarkPaidInvoice(inv); }}
                >
                  <Banknote size={14} /> {t('sa.subs.actionMarkPaidCash')}
                </button>
              )}
              {canBilling && inv.status === 'paid' && (
                <button className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors"
                  style={{ color: 'var(--warning)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => { setOpen(false); handleMarkUnpaid(inv); }}
                >
                  <XCircle size={14} /> {t('sa.subs.actionMarkUnpaid')}
                </button>
              )}
              {canBilling && inv.status !== 'canceled' && (
                <button className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors"
                  style={{ color: 'var(--danger)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => { setOpen(false); handleCancel(inv); }}
                >
                  <XCircle size={14} /> {t('sa.subs.actionCancel')}
                </button>
              )}
              <button className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors"
                style={{ color: 'var(--text-primary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                onClick={() => { setOpen(false); handleDownloadPdf(inv); }}
              >
                <Download size={14} /> {t(inv.status === 'paid' ? 'sa.subs.actionReceiptPdf' : 'sa.subs.actionInvoicePdf')}
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  if (!isSuperAdmin) {
    return <div className="p-8" style={{ color: 'var(--text-secondary)' }}>{t('sa.subs.accessDenied')}</div>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <RefreshCw size={24} className="animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  const years = [...new Set(invoices.map(i => i.invoice_year))];
  if (!years.includes(now.getFullYear())) years.push(now.getFullYear());
  years.sort((a, b) => b - a);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('sa.subs.title')}</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            {t('sa.subs.subtitle')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowGenerateModal(true)}
            className={`${canBilling ? 'flex' : 'hidden'} items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all`}
            style={{ background: 'var(--accent)', color: 'white' }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <FileText size={16} /> {t('sa.subs.generateInvoices')}
          </button>
          <button
            onClick={() => setShowAssignModal(true)}
            className={`${canBilling ? 'flex' : 'hidden'} items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all`}
            style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
          >
            <Plus size={16} /> {t('sa.subs.assignSubscription')}
          </button>
          <button
            onClick={() => setShowPlanModal(true)}
            className={`${canPricing ? 'flex' : 'hidden'} items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all`}
            style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
          >
            <CreditCard size={16} /> {t('sa.subs.managePlans')}
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: t('sa.subs.kpi.activeSubs'), value: activeSubCount, icon: CreditCard, color: 'var(--accent)' },
          { label: t('sa.subs.kpi.openInvoices'), value: openInvoices.length, icon: Clock, color: 'var(--warning)' },
          { label: t('sa.subs.kpi.paidThisMonth'), value: paidThisMonth.length, icon: CheckCircle, color: 'var(--success)' },
          { label: t('sa.subs.invoiceStatus.overdue'), value: overdueInvoices.length, icon: AlertTriangle, color: 'var(--danger)' },
          { label: t('sa.subs.kpi.expected'), value: fmtEur(totalExpected), icon: TrendingUp, color: 'var(--accent)' },
          { label: t('sa.subs.kpi.collected'), value: fmtEur(totalCollected), icon: Banknote, color: 'var(--success)' },
        ].map((kpi, i) => {
          const Icon = kpi.icon;
          return (
            <div key={i} className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `color-mix(in srgb, ${kpi.color} 12%, transparent)` }}>
                  <Icon size={16} style={{ color: kpi.color }} />
                </div>
              </div>
              <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{kpi.value}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{kpi.label}</p>
            </div>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--bg-subtle)' }}>
        {(['invoices', 'subscriptions', 'plans'] as const).map(tab => {
          const labels = {
            invoices: t('sa.subs.tab.invoices'),
            subscriptions: t('sa.subs.tab.subscriptions'),
            plans: t('sa.subs.tab.plans'),
          };
          const icons = { invoices: Receipt, subscriptions: CalendarDays, plans: CreditCard };
          const Icon = icons[tab];
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all"
              style={{
                background: activeTab === tab ? 'var(--bg-surface)' : 'transparent',
                color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)',
                boxShadow: activeTab === tab ? 'var(--shadow-sm)' : 'none',
              }}
            >
              <Icon size={15} />
              {labels[tab]}
            </button>
          );
        })}
      </div>

      {/* Invoices Tab */}
      {activeTab === 'invoices' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
              <input
                type="text"
                placeholder={t('sa.subs.searchPlaceholder')}
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm"
                style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              />
            </div>
            <select
              value={filterMonth}
              onChange={e => setFilterMonth(+e.target.value)}
              className="px-3 py-2.5 rounded-xl text-sm"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value={0}>{t('sa.subs.filterAllMonths')}</option>
              {MONTH_KEYS.map((monthKey, i) => <option key={i} value={i + 1}>{t(monthKey)}</option>)}
            </select>
            <select
              value={filterYear}
              onChange={e => setFilterYear(+e.target.value)}
              className="px-3 py-2.5 rounded-xl text-sm"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="px-3 py-2.5 rounded-xl text-sm"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value="all">{t('sa.subs.filterAllStatuses')}</option>
              <option value="open">{t('sa.subs.invoiceStatus.open')}</option>
              <option value="paid">{t('sa.subs.invoiceStatus.paid')}</option>
              <option value="canceled">{t('sa.subs.invoiceStatus.canceled')}</option>
            </select>
            <select
              value={filterCompany}
              onChange={e => setFilterCompany(e.target.value)}
              className="px-3 py-2.5 rounded-xl text-sm"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value="all">{t('sa.subs.filterAllCompanies')}</option>
              {[...companyMap.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          </div>

          {/* Invoice Table */}
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {([
                      'sa.subs.col.company', 'sa.subs.col.plan', 'sa.subs.col.monthYear',
                      'sa.subs.col.number', 'common.amount', 'common.status',
                      'sa.subs.col.due', 'sa.subs.col.paidOn', null,
                    ] as const).map((h, i) => (
                      <th key={i} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{h ? t(h) : ''}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredInvoices.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-center py-12" style={{ color: 'var(--text-tertiary)' }}>
                        <Receipt size={32} className="mx-auto mb-2 opacity-40" />
                        <p>{t('sa.subs.noInvoices')}</p>
                      </td>
                    </tr>
                  ) : filteredInvoices.map(inv => (
                    <tr
                      key={inv.id}
                      className="transition-colors"
                      style={{ borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>
                        {inv.companies?.name || inv.company_id.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                        {inv.company_subscriptions?.subscription_plans?.name || '-'}
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                        {monthLabel(t, inv.invoice_month)} {inv.invoice_year}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {inv.invoice_number}
                      </td>
                      <td className="px-4 py-3 font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {fmtEur(inv.amount)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={inv.status} dueDate={inv.due_date} />
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                        {(() => { try { return format(new Date(inv.due_date), 'dd.MM.yy'); } catch { return '-'; } })()}
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                        {inv.paid_at ? (() => { try { return format(new Date(inv.paid_at), 'dd.MM.yy HH:mm'); } catch { return '-'; } })() : '-'}
                      </td>
                      <td className="px-4 py-3">
                        <InvoiceActions inv={inv} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Subscriptions Tab */}
      {activeTab === 'subscriptions' && (
        <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {([
                    'sa.subs.col.company', 'sa.subs.col.plan', 'sa.subs.col.pricePerMonth',
                    'common.status', 'sa.subs.col.start', 'sa.subs.col.payment',
                    'sa.subs.col.billingDay',
                  ] as const).map((h, i) => (
                    <th key={i} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {subscriptions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12" style={{ color: 'var(--text-tertiary)' }}>
                      <CalendarDays size={32} className="mx-auto mb-2 opacity-40" />
                      <p>{t('sa.subs.noSubscriptions')}</p>
                    </td>
                  </tr>
                ) : subscriptions.map(sub => (
                  <tr
                    key={sub.id}
                    style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>
                      {(sub.companies as any)?.name || sub.company_id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                      {sub.subscription_plans?.name || '-'}
                    </td>
                    <td className="px-4 py-3 font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {fmtEur(sub.monthly_price)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={sub.status} />
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                      {(() => { try { return format(new Date(sub.starts_at), 'dd.MM.yyyy'); } catch { return sub.starts_at; } })()}
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                      {t('sa.subs.paymentCash')}
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                      {t('sa.subs.dayOfMonth', { day: sub.billing_day })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Plans Tab */}
      {activeTab === 'plans' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {plans.length === 0 ? (
            <div className="col-span-full text-center py-16" style={{ color: 'var(--text-tertiary)' }}>
              <CreditCard size={40} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t('sa.subs.noPlans')}</p>
              <button
                hidden={!canPricing}
                onClick={() => setShowPlanModal(true)}
                className="mt-4 px-4 py-2 rounded-xl text-sm font-medium"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {t('sa.subs.createPlan')}
              </button>
            </div>
          ) : plans.map(plan => {
            const subCount = subscriptions.filter(s => s.plan_id === plan.id && s.status === 'active').length;
            return (
              <div key={plan.id} className="rounded-xl p-5 space-y-3" style={{
                background: 'var(--bg-surface)',
                border: `1px solid ${plan.is_active ? 'var(--border)' : 'var(--danger)'}`,
                opacity: plan.is_active ? 1 : 0.6,
              }}>
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>{plan.name}</h3>
                  {!plan.is_active && (
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger)' }}>{t('sa.status.inactive')}</span>
                  )}
                </div>
                <p className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>{fmtEur(plan.monthly_price)}<span className="text-sm font-normal" style={{ color: 'var(--text-tertiary)' }}>{t('sa.subs.perMonthSuffix')}</span></p>
                <div className="space-y-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <p>{t('sa.subs.plan.carsIncluded', { count: plan.included_cars })}</p>
                  <p>{t('sa.subs.plan.driversPerCar', { count: plan.drivers_per_car_limit })}</p>
                  <p>{t('sa.subs.plan.activeSubscriptions', { count: subCount })}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {markPaidInvoice && (
        <MarkPaidModal
          invoice={markPaidInvoice}
          onClose={() => setMarkPaidInvoice(null)}
          onConfirm={loadData}
        />
      )}
      {showPlanModal && (
        <PlanManagementModal
          plans={plans}
          onClose={() => setShowPlanModal(false)}
          onSaved={loadData}
        />
      )}
      {showGenerateModal && (
        <GenerateInvoicesModal
          subscriptions={subscriptions}
          onClose={() => setShowGenerateModal(false)}
          onGenerated={loadData}
        />
      )}
      {showAssignModal && (
        <AssignSubscriptionModal
          plans={plans}
          onClose={() => setShowAssignModal(false)}
          onAssigned={loadData}
        />
      )}
      {detailInvoice && (
        <InvoiceDetailModal
          invoice={detailInvoice}
          onClose={() => setDetailInvoice(null)}
          onDownloadPdf={() => handleDownloadPdf(detailInvoice)}
          sellerSettings={sellerSettings}
        />
      )}
    </div>
  );
}
