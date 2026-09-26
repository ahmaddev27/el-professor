import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { callPlatformRpc } from '../lib/platformRpc';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import {
  CreditCard, Receipt, CheckCircle, AlertTriangle, Clock,
  XCircle, Download, Eye,
  Plus, RefreshCw, Banknote, CalendarDays, ChevronLeft, ChevronRight,
  TrendingUp, FileText, Search, MoreHorizontal, ShieldAlert,
} from 'lucide-react';
import { format } from 'date-fns';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import MarkPaidModal from '../components/MarkPaidModal';
import PlanManagementModal from '../components/PlanManagementModal';
import GenerateInvoicesModal from '../components/GenerateInvoicesModal';
import AssignSubscriptionModal from '../components/AssignSubscriptionModal';
import InvoiceDetailModal from '../components/InvoiceDetailModal';
import { generateSubscriptionPdf, InvoicePdfData } from '../utils/subscriptionPdf';
import { getInvoiceSeller } from '../lib/platformSettingsClient';
import { invoiceSellerFields } from '../lib/platformSettings';
import { Alert, Button } from '../components/ui';
import { fetchInvoices, fetchSubscriptions } from '../lib/platformBillingClient';
import { fetchCompanies } from '../lib/platformDirectoryClient';
import {
  BILLING_PAGE_SIZE,
  EMPTY_INVOICE_SUMMARY,
  EMPTY_SUBSCRIPTION_SUMMARY,
  invoiceCompanyAddress,
  type InvoiceQuery,
  type PlatformInvoiceRow,
  type PlatformInvoiceSummary,
  type PlatformSubscriptionRow,
  type PlatformSubscriptionSummary,
} from '../lib/platformBilling';
import {
  directoryHasNextPage,
  directoryReachablePageCount,
  platformReadRefusalKey,
  type PlatformCompanyRow,
} from '../lib/platformReadModels';

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

// Screen-only month names, for the filter dropdown and the period column. The
// Rechnung/Quittung PDF keeps its own German copy in utils/subscriptionPdf.ts,
// so nothing here reaches a generated document. Values are TranslationKeys
// because this array is module-level and t() is a hook value.
const MONTH_KEYS: readonly TranslationKey[] = [
  'sa.month.january', 'sa.month.february', 'sa.month.march', 'sa.month.april',
  'sa.month.may', 'sa.month.june', 'sa.month.july', 'sa.month.august',
  'sa.month.september', 'sa.month.october', 'sa.month.november', 'sa.month.december',
];

/** Resolve a 1-based month number, tolerating a value outside 1–12. */
function monthLabel(t: (key: TranslationKey) => string, month: number): string {
  const key = MONTH_KEYS[month - 1];
  return key ? t(key) : '';
}

function fmtEur(v: number) {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/**
 * Server-side paging for the two tables below (decision D14): the invoices and
 * the subscriptions are read one page at a time now, so both tabs need one of
 * these and it is written once.
 *
 * `hasNext` is `directoryHasNextPage`, which is false past `platform_read_offset`'s
 * ceiling — rows beyond it exist and no page can reach them, so a button that
 * would raise 22023 is never offered. Drawn with the design system rather than
 * with this screen's inline styles: the style ratchet holds every legacy file at
 * its count, and AdminLayout already renders `Button` on --bg-base for the Team
 * and Protokoll screens, so no new colour pair is introduced.
 */
function Pager({
  page, pages, hasNext, onPage, t,
}: {
  page: number;
  pages: number;
  hasNext: boolean;
  onPage: (pageIndex: number) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="flex items-center justify-end gap-3 font-ui">
      <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => onPage(Math.max(0, page - 1))}>
        <ChevronLeft size={14} />{t('admin.common.prev')}
      </Button>
      <span className="text-xs text-fg-muted tabular-nums">
        {t('admin.common.pageOf', { page: page + 1, pages })}
      </span>
      <Button variant="secondary" size="sm" disabled={!hasNext} onClick={() => onPage(page + 1)}>
        {t('admin.common.next')}<ChevronRight size={14} />
      </Button>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SubscriptionBillingPage() {
  // The platform write RPCs take the acting account from the caller's own token,
  // so nothing here sends a user id any more.
  const { isSuperAdmin } = useAuth();
  // Hidden for a role without the capability; the database refuses regardless.
  const { platformCan } = useSuperAdmin();
  const canBilling = platformCan('billing.manage');
  const canPricing = platformCan('pricing.manage');
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<PlatformSubscriptionRow[]>([]);
  const [subscriptionSummary, setSubscriptionSummary] = useState<PlatformSubscriptionSummary>(EMPTY_SUBSCRIPTION_SUMMARY);
  const [subscriptionTotal, setSubscriptionTotal] = useState(0);
  const [subscriptionPage, setSubscriptionPage] = useState(0);

  const [invoices, setInvoices] = useState<PlatformInvoiceRow[]>([]);
  const [invoiceSummary, setInvoiceSummary] = useState<PlatformInvoiceSummary>(EMPTY_INVOICE_SUMMARY);
  const [invoiceTotal, setInvoiceTotal] = useState(0);

  const [companies, setCompanies] = useState<PlatformCompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * A refusal the database decided, or a failure. Either way the figures below
   * are not shown as zeroes: an empty invoice list and a total of 0,00 € are
   * claims, and a read that did not happen must not make them.
   */
  const [problem, setProblem] = useState<TranslationKey | null>(null);

  // Filters. The search box is submitted rather than applied per keystroke:
  // every call to a read model writes one row into an append-only audit log.
  const now = new Date();
  const [query, setQuery] = useState<InvoiceQuery>({
    companyId: null,
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    status: 'all',
    search: '',
    pageIndex: 0,
  });
  const [searchInput, setSearchInput] = useState('');

  // Modals
  const [markPaidInvoice, setMarkPaidInvoice] = useState<PlatformInvoiceRow | null>(null);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [detailInvoice, setDetailInvoice] = useState<PlatformInvoiceRow | null>(null);

  const [activeTab, setActiveTab] = useState<'invoices' | 'subscriptions' | 'plans'>('invoices');

  // ── Load data ──
  //
  // The three billing tables are no longer readable across companies (decision
  // D14): the invoices and the subscriptions come from the two audited read
  // models, which page on the server and bring the figures with them.
  // subscription_plans is a platform catalogue, not a customer's money, and is
  // still read directly.

  const loadData = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const [plansRes, invRes, subsRes] = await Promise.all([
        supabase.from('subscription_plans').select('*').order('monthly_price'),
        fetchInvoices(query),
        fetchSubscriptions({ companyId: null, status: null, pageIndex: subscriptionPage }),
      ]);

      if (plansRes.data) setPlans(plansRes.data);

      if (!invRes.ok || !subsRes.ok) {
        setInvoices([]);
        setInvoiceTotal(0);
        setInvoiceSummary(EMPTY_INVOICE_SUMMARY);
        setSubscriptions([]);
        setSubscriptionTotal(0);
        setSubscriptionSummary(EMPTY_SUBSCRIPTION_SUMMARY);
        setProblem(platformReadRefusalKey(invRes.ok ? (subsRes as { reason: string }).reason : invRes.reason));
        return;
      }

      setInvoices(invRes.items);
      setInvoiceTotal(invRes.total);
      setInvoiceSummary(invRes.summary);
      setSubscriptions(subsRes.items);
      setSubscriptionTotal(subsRes.total);
      setSubscriptionSummary(subsRes.summary);
    } catch (err) {
      console.error(err);
      setInvoices([]);
      setInvoiceTotal(0);
      setInvoiceSummary(EMPTY_INVOICE_SUMMARY);
      setSubscriptions([]);
      setSubscriptionTotal(0);
      setSubscriptionSummary(EMPTY_SUBSCRIPTION_SUMMARY);
      setProblem('admin.read.failed');
      showToast('error', t('sa.subs.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [query, subscriptionPage, showToast, t]);

  useEffect(() => {
    if (!canBilling) return;
    void loadData();
  }, [canBilling, loadData]);

  // The company picker is read once per screen: every call writes an audit row,
  // so it is not reloaded per filter change.
  useEffect(() => {
    if (!canBilling) return;
    let cancelled = false;
    fetchCompanies().then(
      result => { if (!cancelled && result.ok) setCompanies(result.items); },
      () => { /* The picker stays empty; the lists still work. */ },
    );
    return () => { cancelled = true; };
  }, [canBilling]);

  // Every filter change starts again at page one: page 4 of a different filter
  // is a different set of rows.
  const change = (patch: Partial<InvoiceQuery>) =>
    setQuery(previous => ({ ...previous, ...patch, pageIndex: 0 }));

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    change({ search: searchInput });
  };

  // ── KPIs ──
  // Computed in SQL over the same sets the browser used to sum after loading
  // every invoice of every customer.

  const activeSubCount = subscriptionSummary.activeCount;

  // ── Mark unpaid ──
  const handleMarkUnpaid = async (inv: PlatformInvoiceRow) => {
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
  const handleCancel = async (inv: PlatformInvoiceRow) => {
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
  //
  // The sender is the `seller` setting (plan 3.10), read when the PDF is built
  // through platform_invoice_seller(): one audited read per document, and one
  // every staff role that may open this page may make. It used to be the
  // company_settings row of whichever company the signed-in platform account
  // sat in — none, on both real databases — which is why the invoices said
  // 'El-Professor' and nothing else. When the sender cannot be read, no PDF is
  // built: an invoice without its sender is not a document to hand a customer.
  //
  // The buyer's address comes from the read model, which carries it for exactly
  // this reason (decision D14): a document that cannot name its recipient is
  // not one to send. It is `companies.address` over `postal_code city`, the two
  // lines CompaniesPage prints; the `street` + `house_number` this used to
  // compose are columns of company_settings, so the query behind it was refused
  // and no invoice ever reached this function (migration 20260924110000).
  const handleDownloadPdf = async (inv: PlatformInvoiceRow) => {
    const seller = await getInvoiceSeller().catch(() => null);
    if (!seller) {
      showToast('error', t('sa.subs.sellerUnavailable'));
      return;
    }

    const planName = inv.plan_name || 'Abonnement';
    const addr = invoiceCompanyAddress(inv);
    const { sellerName, sellerAddress, sellerTaxInfo, sellerBank } = invoiceSellerFields(seller);

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
      companyName: inv.company_name || 'Unbekannt',
      companyAddress: addr,
      planName,
      sellerName,
      sellerAddress,
      sellerTaxInfo,
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
  const InvoiceActions = ({ inv }: { inv: PlatformInvoiceRow }) => {
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
                onClick={() => { setOpen(false); void handleDownloadPdf(inv); }}
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

  // Since decision D14 the money is billing.manage's. A support or read_only
  // account keeps the company list and every company's own subscription state;
  // it is told so here rather than shown an empty table, which would read as
  // "this customer has no invoices".
  if (!canBilling) {
    // Drawn with the design system rather than with this screen's inline styles:
    // the style ratchet holds every legacy file at its count, and new markup that
    // spells a colour out again is what it exists to stop. AdminLayout already
    // renders these primitives on --bg-base for the Team and Protokoll screens,
    // so the pair is one tokens.contrast.test.ts already measures.
    return (
      <Alert tone="caution" icon={ShieldAlert} title={t('admin.read.denied')} className="font-ui">
        {t('sa.subs.noAccessBody')}
      </Alert>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <RefreshCw size={24} className="animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  const years = [...invoiceSummary.years];
  if (!years.includes(now.getFullYear())) years.push(now.getFullYear());
  years.sort((a, b) => b - a);

  const invoicePages = directoryReachablePageCount(invoiceTotal, BILLING_PAGE_SIZE);
  const invoiceHasNext = directoryHasNextPage(query.pageIndex, invoiceTotal, BILLING_PAGE_SIZE);
  const subscriptionPages = directoryReachablePageCount(subscriptionTotal, BILLING_PAGE_SIZE);
  const subscriptionHasNext = directoryHasNextPage(subscriptionPage, subscriptionTotal, BILLING_PAGE_SIZE);

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
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
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

      {/* A read that did not happen: no figure below is shown as a zero. */}
      {problem && <Alert tone="critical" className="font-ui">{t(problem)}</Alert>}

      {/* KPI Cards */}
      {!problem && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: t('sa.subs.kpi.activeSubs'), value: activeSubCount, icon: CreditCard, color: 'var(--accent)' },
            { label: t('sa.subs.kpi.openInvoices'), value: invoiceSummary.openCount, icon: Clock, color: 'var(--warning)' },
            { label: t('sa.subs.kpi.paidThisMonth'), value: invoiceSummary.paidThisMonthCount, icon: CheckCircle, color: 'var(--success)' },
            { label: t('sa.subs.invoiceStatus.overdue'), value: invoiceSummary.overdueCount, icon: AlertTriangle, color: 'var(--danger)' },
            { label: t('sa.subs.kpi.expected'), value: fmtEur(invoiceSummary.filteredAmount), icon: TrendingUp, color: 'var(--accent)' },
            { label: t('sa.subs.kpi.collected'), value: fmtEur(invoiceSummary.filteredCollected), icon: Banknote, color: 'var(--success)' },
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
      )}

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
          {/* Filters. They are applied by the database now, so the search is
              submitted: one read, one audit row, per search rather than per key. */}
          <div className="flex flex-wrap gap-3 items-center">
            <form onSubmit={submitSearch} className="relative flex-1 min-w-[220px] max-w-md flex gap-2">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
                <input
                  type="text"
                  placeholder={t('sa.subs.searchPlaceholder')}
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  maxLength={100}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm"
                  style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                />
              </div>
              {/* The design system's Button, for the reason Pager gives: a new
                  inline style in a legacy file is what the style ratchet stops.
                  `type="submit"` is explicit — the primitive defaults to
                  "button", and this one submits the form. */}
              <Button type="submit" size="md" className="font-semibold">
                {t('admin.common.search')}
              </Button>
            </form>
            <select
              value={query.month}
              onChange={e => change({ month: +e.target.value })}
              className="px-3 py-2.5 rounded-xl text-sm"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value={0}>{t('sa.subs.filterAllMonths')}</option>
              {MONTH_KEYS.map((monthKey, i) => <option key={i} value={i + 1}>{t(monthKey)}</option>)}
            </select>
            <select
              value={query.year}
              onChange={e => change({ year: +e.target.value })}
              className="px-3 py-2.5 rounded-xl text-sm"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <select
              value={query.status}
              onChange={e => change({ status: e.target.value })}
              className="px-3 py-2.5 rounded-xl text-sm"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value="all">{t('sa.subs.filterAllStatuses')}</option>
              <option value="open">{t('sa.subs.invoiceStatus.open')}</option>
              <option value="paid">{t('sa.subs.invoiceStatus.paid')}</option>
              <option value="canceled">{t('sa.subs.invoiceStatus.canceled')}</option>
            </select>
            <select
              value={query.companyId ?? 'all'}
              onChange={e => change({ companyId: e.target.value === 'all' ? null : e.target.value })}
              className="px-3 py-2.5 rounded-xl text-sm"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value="all">{t('sa.subs.filterAllCompanies')}</option>
              {companies.map(company => (
                <option key={company.id} value={company.id}>{company.name}</option>
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
                  {invoices.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-center py-12" style={{ color: 'var(--text-tertiary)' }}>
                        <Receipt size={32} className="mx-auto mb-2 opacity-40" />
                        <p>{problem ? t(problem) : t('sa.subs.noInvoices')}</p>
                      </td>
                    </tr>
                  ) : invoices.map(inv => (
                    <tr
                      key={inv.id}
                      className="transition-colors"
                      style={{ borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>
                        {inv.company_name || inv.company_id.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                        {inv.plan_name || '-'}
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

          {invoicePages > 1 && (
            <Pager
              page={query.pageIndex}
              pages={invoicePages}
              hasNext={invoiceHasNext}
              onPage={pageIndex => setQuery(q => ({ ...q, pageIndex }))}
              t={t}
            />
          )}
        </div>
      )}

      {/* Subscriptions Tab */}
      {activeTab === 'subscriptions' && (
        <div className="space-y-4">
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
                        <p>{problem ? t(problem) : t('sa.subs.noSubscriptions')}</p>
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
                        {sub.company_name || sub.company_id.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                        {sub.plan_name || '-'}
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

          {subscriptionPages > 1 && (
            <Pager
              page={subscriptionPage}
              pages={subscriptionPages}
              hasNext={subscriptionHasNext}
              onPage={setSubscriptionPage}
              t={t}
            />
          )}
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
                style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
              >
                {t('sa.subs.createPlan')}
              </button>
            </div>
          ) : plans.map(plan => {
            // The count is every active subscription of that plan, not the
            // page's: it comes back with the subscriptions read model.
            const subCount = subscriptionSummary.activeByPlan[plan.id] ?? 0;
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
          onDownloadPdf={() => void handleDownloadPdf(detailInvoice)}
        />
      )}
    </div>
  );
}
