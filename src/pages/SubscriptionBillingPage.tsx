import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { callPlatformRpc, PlatformRpcError } from '../lib/platformRpc';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import {
  CreditCard, Receipt, CheckCircle, AlertTriangle, Clock,
  XCircle, Download, Eye, Trash2,
  Plus, RefreshCw, Banknote, CalendarDays, ChevronLeft, ChevronRight,
  TrendingUp, FileText, Search, MoreHorizontal, ShieldAlert,
} from 'lucide-react';
import { format } from 'date-fns';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import MarkPaidModal from '../components/MarkPaidModal';
import GenerateInvoicesModal from '../components/GenerateInvoicesModal';
import AssignSubscriptionModal from '../components/AssignSubscriptionModal';
import InvoiceDetailModal from '../components/InvoiceDetailModal';
import { generateSubscriptionPdf, InvoicePdfData } from '../utils/subscriptionPdf';
import { getInvoiceSeller } from '../lib/platformSettingsClient';
import { listPlans, type PlanCatalogue } from '../lib/platformPlansClient';
import { Link } from 'react-router-dom';
import { invoiceSellerFields } from '../lib/platformSettings';
import {
  Alert, Badge, Button, ConfirmDialog, EmptyState, Input, KpiCard, NativeSelect, cn, formatEuroCents,
  type BadgeProps,
} from '../components/ui';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import {
  buildInvoicesExport,
  buildSubscriptionsExport,
  type FilterEntry,
} from '../lib/panelExports';
import { useExportChrome } from '../hooks/useExportChrome';
import { berlinToday } from '../utils/salaryCashReceiptFlow';
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
/** Reason codes of platform_invoice_delete's refusals, mapped to a dictionary key. */
const DELETE_REFUSAL_KEYS: Record<string, TranslationKey> = {
  invoice_paid: 'sa.subs.deleteRefused.paid',
  invoice_was_paid: 'sa.subs.deleteRefused.wasPaid',
};

/** The words of the confirmation dialog, per action. */
const CONFIRM_KEYS: Record<'unpaid' | 'cancel' | 'delete', { title: TranslationKey; description: TranslationKey }> = {
  unpaid: { title: 'sa.subs.actionMarkUnpaid', description: 'sa.subs.confirmUnpaid.description' },
  cancel: { title: 'sa.subs.actionCancel', description: 'sa.subs.confirmCancel.description' },
  delete: { title: 'sa.subs.actionDelete', description: 'sa.subs.confirmDelete.description' },
};

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
 * would raise 22023 is never offered.
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
        <ChevronLeft size={14} className="rtl:-scale-x-100" />{t('admin.common.prev')}
      </Button>
      <span className="text-xs text-fg-muted tabular-nums">
        {t('admin.common.pageOf', { page: page + 1, pages })}
      </span>
      <Button variant="secondary" size="sm" disabled={!hasNext} onClick={() => onPage(page + 1)}>
        {t('admin.common.next')}<ChevronRight size={14} className="rtl:-scale-x-100" />
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
  const exportPicker = useColumnPickerExport();
  const exportChrome = useExportChrome();

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
  /**
   * The third read has a failure of its own, separate from `problem`.
   *
   * `subscription_plans_select` is `USING (true)` (20260917130000), so an error
   * here is never an RLS refusal — it is a transport failure, a gateway 502
   * during a release or a schema-cache miss. It was not inspected at all, and
   * the Tarife tab then said "Noch keine Tarife angelegt", inviting an owner to
   * create plans that already exist.
   *
   * It is deliberately not folded into `problem`, which hides the KPI cards: the
   * invoice and subscription figures may have been read perfectly well, and
   * withholding facts that *were* read is the mirror image of the defect.
   */
  const [plansFailed, setPlansFailed] = useState(false);
  /**
   * The plan catalogue (`public.plans`), which is what prices and gates. The
   * Tarife tab shows it; `plans` above is the older `subscription_plans` table,
   * kept only because AssignSubscriptionModal still picks a row from it.
   */
  const [catalogue, setCatalogue] = useState<PlanCatalogue | null>(null);
  const [catalogueFailed, setCatalogueFailed] = useState(false);

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
  const [invoiceConfirm, setInvoiceConfirm] = useState<{ kind: 'unpaid' | 'cancel' | 'delete'; invoice: PlatformInvoiceRow } | null>(null);
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
    setPlansFailed(false);
    setCatalogueFailed(false);
    listPlans().then(setCatalogue).catch(err => {
      console.error(err);
      setCatalogue(null);
      setCatalogueFailed(true);
    });
    try {
      const [plansRes, invRes, subsRes] = await Promise.all([
        supabase.from('subscription_plans').select('*').order('monthly_price'),
        fetchInvoices(query),
        fetchSubscriptions({ companyId: null, status: null, pageIndex: subscriptionPage }),
      ]);

      // A catalogue that could not be read is not an empty catalogue.
      if (plansRes.error) {
        console.error(plansRes.error);
        setPlans([]);
        setPlansFailed(true);
      } else {
        setPlans(plansRes.data ?? []);
      }

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
      setPlans([]);
      setPlansFailed(true);
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
  //
  // It is **one page**, the first 100 companies by name, and that is a bounded
  // list rather than a complete one — `platform_companies_list` caps a page at
  // 100. Paging it here would be several audit rows per screen open for a
  // convenience, and a company past the hundredth is still reachable: the search
  // box filters on the company name in SQL. Give the picker a search of its own
  // before this grows past a hundred customers.
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

  // ── Excel exports ──
  //
  // **The rule being preserved: a file says what it holds.** Both read models
  // cap a page at 100 rows and write one audited `read` row per call, so an
  // export writes the page on screen and the workbook says so — in its filter
  // band and in its filename (decision D-C). Re-reading every page here would
  // fill the append-only audit log for a convenience and produce a file whose
  // own row count nobody could check.
  //
  // Both are withheld while `problem` is set or the read is still running: an
  // invoice list of nought and a total of 0,00 € are claims, and a file makes
  // them with more authority than a screen.
  //
  // `billing.manage` is not re-checked here because it cannot be false — the
  // component returns the refusal Alert above before this renders — and the
  // database refuses each read regardless.

  const statusNames: Readonly<Record<string, string>> = {
    open: t('sa.subs.invoiceStatus.open'),
    paid: t('sa.subs.invoiceStatus.paid'),
    overdue: t('sa.subs.invoiceStatus.overdue'),
    canceled: t('sa.subs.invoiceStatus.canceled'),
  };

  /** What the operator filtered the invoice list by, for the band. */
  const invoiceFilterEntries = (): FilterEntry[] => [
    {
      label: t('sa.subs.export.filterMonth'),
      value: query.month >= 1 && query.month <= 12 ? monthLabel(t, query.month) : t('sa.subs.filterAllMonths'),
    },
    { label: t('sa.subs.export.filterYear'), value: String(query.year) },
    {
      label: t('common.status'),
      value: query.status === 'all' ? t('sa.subs.filterAllStatuses') : statusNames[query.status] ?? query.status,
    },
    {
      label: t('sa.subs.col.company'),
      value: query.companyId
        ? companies.find(company => company.id === query.companyId)?.name ?? query.companyId
        : t('sa.subs.filterAllCompanies'),
    },
    { label: t('sa.subs.export.filterSearch'), value: query.search || null },
  ];

  const handleExportInvoices = () => {
    try {
      exportPicker.table('platformInvoices', buildInvoicesExport({
        rows: invoices,
        // The summary is the database's own sum over the whole filtered set.
        // The builder puts it in the totals row only where the file holds that
        // whole set, and in the band — labelled as the whole filter — otherwise.
        summary: invoiceSummary,
        scope: { pageIndex: query.pageIndex, total: invoiceTotal, rowCount: invoices.length, pageSize: BILLING_PAGE_SIZE },
        filters: invoiceFilterEntries(),
        filterLineTemplate: t('ui.export.filterLine'),
        // The period the operator asked for: a month where one is picked, else
        // the year alone, so two files of one year do not overwrite each other.
        periodSlug: query.month >= 1 && query.month <= 12
          ? `${query.year}-${String(query.month).padStart(2, '0')}`
          : String(query.year),
        labels: {
          sheetTitle: t('sa.subs.export.invoicesTitle'),
          company: t('sa.subs.col.company'),
          plan: t('sa.subs.col.plan'),
          period: t('sa.subs.col.monthYear'),
          number: t('sa.subs.col.number'),
          amount: t('common.amount'),
          collected: t('sa.subs.export.collected'),
          status: t('common.status'),
          due: t('sa.subs.col.due'),
          paidOn: t('sa.subs.col.paidOn'),
          note: t('sa.subs.export.note'),
          created: t('sa.subs.export.created'),
          statusNames,
          monthNames: MONTH_KEYS.map(key => t(key)),
          expected: t('sa.subs.export.expected'),
          totalsCollected: t('sa.subs.export.collectedTotal'),
          scope: { whole: t('admin.export.scope.whole'), page: t('admin.export.scope.page') },
          chrome: exportChrome,
        },
      }));
    } catch (error: any) {
      showToast('error', t('ui.export.failed'), error?.message);
    }
  };

  const handleExportSubscriptions = () => {
    try {
      exportPicker.table('platformSubscriptions', buildSubscriptionsExport({
        rows: subscriptions,
        activeCount: activeSubCount,
        scope: { pageIndex: subscriptionPage, total: subscriptionTotal, rowCount: subscriptions.length, pageSize: BILLING_PAGE_SIZE },
        // The tab has no filter controls, so there is nothing to list.
        filters: [],
        filterLineTemplate: t('ui.export.filterLine'),
        today: berlinToday(),
        labels: {
          sheetTitle: t('sa.subs.export.subscriptionsTitle'),
          company: t('sa.subs.col.company'),
          plan: t('sa.subs.col.plan'),
          pricePerMonth: t('sa.subs.col.pricePerMonth'),
          status: t('common.status'),
          start: t('sa.subs.col.start'),
          billingDay: t('sa.subs.col.billingDay'),
          statusNames,
          activeCount: t('sa.subs.export.activeCount'),
          scope: { whole: t('admin.export.scope.whole'), page: t('admin.export.scope.page') },
          chrome: exportChrome,
        },
      }));
    } catch (error: any) {
      showToast('error', t('ui.export.failed'), error?.message);
    }
  };

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

  // ── Delete invoice ──
  // Only an invoice nobody paid. The database refuses the rest with a reason
  // code; the sentence shown comes from the dictionaries, so it follows the
  // operator's language, and the function's own German is the fallback.
  const handleDelete = async (inv: PlatformInvoiceRow) => {
    try {
      await callPlatformRpc('platform_invoice_delete', { p_invoice_id: inv.id });
    } catch (err: any) {
      const key = err instanceof PlatformRpcError ? DELETE_REFUSAL_KEYS[err.reason] : undefined;
      showToast('error', t('sa.subs.errorWithMessage', { message: key ? t(key) : err.message }));
      return;
    }
    showToast('success', t('sa.subs.invoiceDeleted'));
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged. Everything below
  // only draws.

  // ── Status badge ──
  const StatusBadge = ({ status, dueDate }: { status: string; dueDate?: string }) => {
    const isOverdue = status === 'open' && dueDate && new Date(dueDate) < now;
    const displayStatus = isOverdue ? 'overdue' : status;

    // Open is informational, overdue critical, paid positive, cancelled neutral.
    const config: Record<string, { tone: NonNullable<BadgeProps['tone']>; label: string; icon: React.ElementType }> = {
      open:     { tone: 'info',     label: t('sa.subs.invoiceStatus.open'),     icon: Clock },
      paid:     { tone: 'positive', label: t('sa.subs.invoiceStatus.paid'),     icon: CheckCircle },
      overdue:  { tone: 'critical', label: t('sa.subs.invoiceStatus.overdue'),  icon: AlertTriangle },
      canceled: { tone: 'neutral',  label: t('sa.subs.invoiceStatus.canceled'), icon: XCircle },
    };
    const c = config[displayStatus] || config.open;
    const Icon = c.icon;

    return (
      <Badge tone={c.tone}>
        <Icon aria-hidden />
        {c.label}
      </Badge>
    );
  };

  const menuItemClass =
    'flex w-full items-center gap-2 px-3 py-2 text-start text-sm transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:bg-sunken [@media(pointer:coarse)]:min-h-11';

  // ── Actions dropdown ──
  const InvoiceActions = ({ inv }: { inv: PlatformInvoiceRow }) => {
    const [open, setOpen] = useState(false);

    return (
      <div className="relative">
        <button
          type="button"
          aria-label={t('sa.subs.actionsMenu')}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="inline-flex items-center justify-center rounded-tight p-1.5 text-fg-subtle transition-colors hover:bg-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10"
        >
          <MoreHorizontal aria-hidden size={16} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="glass-strong absolute end-0 top-8 z-50 w-52 rounded-tile py-1.5 font-ui">
              <button className={cn(menuItemClass, 'text-fg')}
                onClick={() => { setOpen(false); setDetailInvoice(inv); }}
              >
                <Eye aria-hidden size={14} /> {t('sa.subs.actionView')}
              </button>
              {canBilling && inv.status !== 'paid' && inv.status !== 'canceled' && (
                <button className={cn(menuItemClass, 'text-positive')}
                  onClick={() => { setOpen(false); setMarkPaidInvoice(inv); }}
                >
                  <Banknote aria-hidden size={14} /> {t('sa.subs.actionMarkPaidCash')}
                </button>
              )}
              {canBilling && inv.status === 'paid' && (
                <button className={cn(menuItemClass, 'text-caution')}
                  onClick={() => { setOpen(false); setInvoiceConfirm({ kind: 'unpaid', invoice: inv }); }}
                >
                  <XCircle aria-hidden size={14} /> {t('sa.subs.actionMarkUnpaid')}
                </button>
              )}
              {canBilling && inv.status !== 'canceled' && (
                <button className={cn(menuItemClass, 'text-critical')}
                  onClick={() => { setOpen(false); setInvoiceConfirm({ kind: 'cancel', invoice: inv }); }}
                >
                  <XCircle aria-hidden size={14} /> {t('sa.subs.actionCancel')}
                </button>
              )}
              {canBilling && inv.status !== 'paid' && (
                <button className={cn(menuItemClass, 'text-critical')}
                  onClick={() => { setOpen(false); setInvoiceConfirm({ kind: 'delete', invoice: inv }); }}
                >
                  <Trash2 aria-hidden size={14} /> {t('sa.subs.actionDelete')}
                </button>
              )}
              <button className={cn(menuItemClass, 'text-fg')}
                onClick={() => { setOpen(false); void handleDownloadPdf(inv); }}
              >
                <Download aria-hidden size={14} /> {t(inv.status === 'paid' ? 'sa.subs.actionReceiptPdf' : 'sa.subs.actionInvoicePdf')}
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  if (!isSuperAdmin) {
    return <div className="p-8 font-ui text-fg-muted">{t('sa.subs.accessDenied')}</div>;
  }

  // Since decision D14 the money is billing.manage's. A support or read_only
  // account keeps the company list and every company's own subscription state;
  // it is told so here rather than shown an empty table, which would read as
  // "this customer has no invoices".
  if (!canBilling) {
    return (
      <Alert tone="caution" icon={ShieldAlert} title={t('admin.read.denied')} className="font-ui">
        {t('sa.subs.noAccessBody')}
      </Alert>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <RefreshCw aria-hidden size={24} className="text-brand-text motion-safe:animate-spin" />
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

  const thClass = 'px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider text-fg-subtle';
  const tableFrameClass = 'glass-card relative overflow-x-auto rounded-surface';
  const rowClass = 'border-b border-line transition-colors last:border-b-0 hover:bg-sunken';
  const filterSelectClass = 'h-10';
  const filterSelectFrame = 'w-auto';

  return (
    <div className="space-y-6 font-ui">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold leading-[1.2] tracking-[-0.025em] text-fg">{t('sa.subs.title')}</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {t('sa.subs.subtitle')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => setShowGenerateModal(true)}
            className={canBilling ? undefined : 'hidden'}
          >
            <FileText aria-hidden size={16} /> {t('sa.subs.generateInvoices')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowAssignModal(true)}
            className={canBilling ? undefined : 'hidden'}
          >
            <Plus aria-hidden size={16} /> {t('sa.subs.assignSubscription')}
          </Button>
          <Link
            to="/admin/plaene"
            className={cn(
              canPricing ? 'inline-flex' : 'hidden',
              'h-10 items-center gap-2 rounded-control border border-line-strong bg-raised px-4 text-sm font-semibold text-fg transition-colors hover:bg-sunken',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [@media(pointer:coarse)]:h-11',
            )}
          >
            <CreditCard aria-hidden size={16} /> {t('sa.subs.managePlans')}
          </Link>
        </div>
      </div>

      {/* A read that did not happen: no figure below is shown as a zero. */}
      {problem && <Alert tone="critical" className="font-ui">{t(problem)}</Alert>}

      {/* KPI Cards */}
      {!problem && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
          {[
            { label: t('sa.subs.kpi.activeSubs'), value: activeSubCount, icon: CreditCard },
            { label: t('sa.subs.kpi.openInvoices'), value: invoiceSummary.openCount, icon: Clock },
            { label: t('sa.subs.kpi.paidThisMonth'), value: invoiceSummary.paidThisMonthCount, icon: CheckCircle },
            { label: t('sa.subs.invoiceStatus.overdue'), value: invoiceSummary.overdueCount, icon: AlertTriangle },
            { label: t('sa.subs.kpi.expected'), value: fmtEur(invoiceSummary.filteredAmount), icon: TrendingUp },
            { label: t('sa.subs.kpi.collected'), value: fmtEur(invoiceSummary.filteredCollected), icon: Banknote },
          ].map((kpi, i) => (
            <KpiCard key={i} label={kpi.label} value={kpi.value} icon={kpi.icon} />
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-0.5 rounded-control border border-edge bg-sunken p-[3px]">
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
              type="button"
              aria-pressed={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-tight px-4 py-2 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [@media(pointer:coarse)]:min-h-10',
                activeTab === tab ? 'bg-raised text-fg shadow-segment' : 'text-fg-subtle hover:text-fg',
              )}
            >
              <Icon aria-hidden size={15} />
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
          <div className="flex flex-wrap items-center gap-3">
            <form onSubmit={submitSearch} className="relative flex min-w-[220px] max-w-md flex-1 gap-2">
              <div className="relative flex-1">
                <Search aria-hidden size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
                <Input
                  type="text"
                  placeholder={t('sa.subs.searchPlaceholder')}
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  maxLength={100}
                  className="ps-9"
                />
              </div>
              {/* `type="submit"` is explicit: the primitive defaults to "button",
                  and this one submits the form. */}
              <Button type="submit" size="md" className="font-semibold">
                {t('admin.common.search')}
              </Button>
            </form>
            {/* The page on screen as a workbook. Withheld while the read failed
                or is running: a file of nought invoices is a claim. */}
            <Button
              variant="secondary"
              size="md"
              disabled={loading || problem !== null || invoices.length === 0}
              onClick={handleExportInvoices}
              title={t('common.exportExcel')}
            >
              <Download aria-hidden size={14} />{t('admin.export.download')}
            </Button>
            <NativeSelect
              containerClassName={filterSelectFrame}
              className={filterSelectClass}
              value={query.month}
              onChange={e => change({ month: +e.target.value })}
            >
              <option value={0}>{t('sa.subs.filterAllMonths')}</option>
              {MONTH_KEYS.map((monthKey, i) => <option key={i} value={i + 1}>{t(monthKey)}</option>)}
            </NativeSelect>
            <NativeSelect
              containerClassName={filterSelectFrame}
              className={filterSelectClass}
              value={query.year}
              onChange={e => change({ year: +e.target.value })}
            >
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </NativeSelect>
            <NativeSelect
              containerClassName={filterSelectFrame}
              className={filterSelectClass}
              value={query.status}
              onChange={e => change({ status: e.target.value })}
            >
              <option value="all">{t('sa.subs.filterAllStatuses')}</option>
              <option value="open">{t('sa.subs.invoiceStatus.open')}</option>
              <option value="paid">{t('sa.subs.invoiceStatus.paid')}</option>
              <option value="canceled">{t('sa.subs.invoiceStatus.canceled')}</option>
            </NativeSelect>
            <NativeSelect
              containerClassName={filterSelectFrame}
              className={filterSelectClass}
              value={query.companyId ?? 'all'}
              onChange={e => change({ companyId: e.target.value === 'all' ? null : e.target.value })}
            >
              <option value="all">{t('sa.subs.filterAllCompanies')}</option>
              {companies.map(company => (
                <option key={company.id} value={company.id}>{company.name}</option>
              ))}
            </NativeSelect>
          </div>

          {/* Invoice Table. The frame scrolls sideways, so the action column
              stays reachable on a phone. */}
          <div className={tableFrameClass}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-wash">
                  {([
                    'sa.subs.col.company', 'sa.subs.col.plan', 'sa.subs.col.monthYear',
                    'sa.subs.col.number', 'common.amount', 'common.status',
                    'sa.subs.col.due', 'sa.subs.col.paidOn', null,
                  ] as const).map((h, i) => (
                    <th key={i} className={thClass}>{h ? t(h) : ''}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 ? (
                  <tr>
                    <td colSpan={9}>
                      <EmptyState icon={Receipt} size="sm" title={problem ? t(problem) : t('sa.subs.noInvoices')} />
                    </td>
                  </tr>
                ) : invoices.map(inv => (
                  <tr key={inv.id} className={rowClass}>
                    <td className="px-4 py-3 font-medium text-fg">
                      {inv.company_name || inv.company_id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {inv.plan_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {monthLabel(t, inv.invoice_month)} {inv.invoice_year}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-fg-subtle">
                      {inv.invoice_number}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-semibold tabular-nums text-fg">
                      {fmtEur(inv.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={inv.status} dueDate={inv.due_date} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-fg-muted">
                      {(() => { try { return format(new Date(inv.due_date), 'dd.MM.yy'); } catch { return '-'; } })()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-fg-muted">
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
          {/* Same rule as the invoice tab's: the page on screen, said so in the
              file, and nothing while the read did not succeed. */}
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="md"
              disabled={loading || problem !== null || subscriptions.length === 0}
              onClick={handleExportSubscriptions}
              title={t('common.exportExcel')}
            >
              <Download aria-hidden size={14} />{t('admin.export.download')}
            </Button>
          </div>
          <div className={tableFrameClass}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-wash">
                  {([
                    'sa.subs.col.company', 'sa.subs.col.plan', 'sa.subs.col.pricePerMonth',
                    'common.status', 'sa.subs.col.start', 'sa.subs.col.payment',
                    'sa.subs.col.billingDay',
                  ] as const).map((h, i) => (
                    <th key={i} className={thClass}>{t(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {subscriptions.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <EmptyState icon={CalendarDays} size="sm" title={problem ? t(problem) : t('sa.subs.noSubscriptions')} />
                    </td>
                  </tr>
                ) : subscriptions.map(sub => (
                  <tr key={sub.id} className={rowClass}>
                    <td className="px-4 py-3 font-medium text-fg">
                      {sub.company_name || sub.company_id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {sub.plan_name || '-'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-semibold tabular-nums text-fg">
                      {fmtEur(sub.monthly_price)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={sub.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-fg-muted">
                      {(() => { try { return format(new Date(sub.starts_at), 'dd.MM.yyyy'); } catch { return sub.starts_at; } })()}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {t('sa.subs.paymentCash')}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {t('sa.subs.dayOfMonth', { day: sub.billing_day })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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

      {/* Plans Tab: the catalogue that prices and gates, read-only. It is
          edited on its own page. */}
      {activeTab === 'plans' && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {catalogueFailed || !catalogue ? (
            /* Not "no plans exist": the catalogue was not read (or is still
               being read), and a price of 0,00 EUR would be a claim. */
            <div className="col-span-full">
              {catalogueFailed && (
                <Alert tone="critical" className="font-ui" title={t('admin.read.failedTitle')}>
                  {t('admin.read.failed')}
                </Alert>
              )}
            </div>
          ) : catalogue.plans.map(plan => (
            <div
              key={plan.slug}
              className={cn(
                'glass-card space-y-3 rounded-surface p-5',
                plan.is_active ? '' : 'border-critical opacity-60',
              )}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-fg">{plan.name}</h3>
                {!plan.is_active && (
                  <Badge tone="critical">{t('sa.status.inactive')}</Badge>
                )}
              </div>
              <p className="whitespace-nowrap text-2xl font-bold tabular-nums text-brand-text">{formatEuroCents(plan.price_per_car_cents)}<span className="text-sm font-normal text-fg-subtle">{t('admin.plans.perCarSuffix')}</span></p>
              <p className="text-sm text-fg-muted">
                {t('admin.plans.field.features', { count: plan.features.length, total: catalogue.featureKeys.length })}
              </p>
            </div>
          ))}
          {catalogue && canPricing && (
            <p className="col-span-full text-sm text-fg-subtle">
              <Link to="/admin/plaene" className="text-brand-text hover:underline">{t('sa.subs.managePlans')}</Link>
            </p>
          )}
        </div>
      )}

      {/* Modals */}
      <ConfirmDialog
        open={invoiceConfirm !== null}
        onClose={() => setInvoiceConfirm(null)}
        onConfirm={() => {
          if (!invoiceConfirm) return;
          if (invoiceConfirm.kind === 'cancel') void handleCancel(invoiceConfirm.invoice);
          else if (invoiceConfirm.kind === 'delete') void handleDelete(invoiceConfirm.invoice);
          else void handleMarkUnpaid(invoiceConfirm.invoice);
        }}
        title={t(CONFIRM_KEYS[invoiceConfirm?.kind ?? 'unpaid'].title)}
        description={t(CONFIRM_KEYS[invoiceConfirm?.kind ?? 'unpaid'].description)}
        confirmLabel={t(CONFIRM_KEYS[invoiceConfirm?.kind ?? 'unpaid'].title)}
      />
      {markPaidInvoice && (
        <MarkPaidModal
          invoice={markPaidInvoice}
          onClose={() => setMarkPaidInvoice(null)}
          onConfirm={loadData}
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
