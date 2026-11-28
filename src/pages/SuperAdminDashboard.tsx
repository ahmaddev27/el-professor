import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { fetchCompanies } from '../lib/platformDirectoryClient';
import { fetchInvoiceQuotes } from '../lib/platformBillingClient';
import type { PlatformInvoiceQuote } from '../lib/platformBilling';
import { collectCompanyCounts, UNKNOWN_COMPANY_COUNTS, type CompanyCounts } from '../lib/platformReadModels';
import {
  Building2, Users, Car, FileText, TrendingUp, AlertTriangle,
  CheckCircle, XCircle, PauseCircle, Plus, ExternalLink,
  RefreshCw, BarChart3, AlertCircle, ChevronRight,
  Shield, Activity, Tag, ClipboardCheck, Gift, KeyRound, PencilLine,
} from 'lucide-react';
import { callPlatformRpc } from '../lib/platformRpc';
import DiscountCodesManagement from '../components/DiscountCodesManagement';
import ReferralCodesManagement from '../components/ReferralCodesManagement';
import ActivationCodesManagement from '../components/ActivationCodesManagement';
import ManualSubscriptionModal from '../components/ManualSubscriptionModal';
import { format, isAfter, startOfMonth } from 'date-fns';
import { de } from 'date-fns/locale';
import { calcPricing, fmt as fmtPrice } from '../utils/pricing';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { contextRefusalMessage } from '../lib/supportSession';
import { ADMIN_BASE, TENANT_HOME } from '../lib/adminGate';
import { useTranslation } from '../contexts/LanguageContext';
import {
  Alert, Badge, Button, Card, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, EmptyState, Field, Input, KpiCard, NativeSelect, PageHeader, Tabs,
  TabsList, TabsTrigger, cn,
} from '../components/ui';
import { controlFrameClass } from '../components/ui/Input';
import type { CompanyStatus } from '../contexts/AuthContext';
import type { TranslationKey } from '../i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

type Plan = 'basic' | 'advanced' | 'premium';
// CompanyStatus is imported from AuthContext, which reads the column on every
// load: the six values companies_status_check allows, declared once.

interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  approval_status: 'pending' | 'approved' | 'rejected' | 'suspended';
  rejection_reason: string | null;
  plan: Plan;
  billing_cycle: 'monthly' | 'yearly';
  subscription_car_limit: number;
  created_at: string;
  updated_at: string;
  email: string | null;
  city: string | null;
  referral_code_used: string | null;
  user_count: number;
  driver_count: number;
  active_car_count: number;
  /**
   * Whether the three counts above were read for this company. False when the
   * counts could not be read at all, and for a company created since they were
   * last read — the counts are read on opening and on refresh, not on the
   * minute tick. Where it is false the counts are 0 and mean nothing.
   */
  counts_known: boolean;
  /**
   * The company's `company_settings.drivers_per_car_limit`, and **null where it
   * was not read**.
   *
   * `collectCompanyCounts` records the key only where the read model returned a
   * number, so a company whose settings row is missing — or whose column is null
   * — is absent from the map even on a wholly successful read. This was
   * `dpcMap[c.id] ?? 4`, which made the Fahrer column print a denominator of the
   * screen's own invention (`–/12` where the truth may be `–/6`) and decided the
   * red "limit reached" colour from it. There is no default any more.
   *
   * Since 20261026110000 **this screen prints no denominator at all**: the
   * trigger that multiplied this column by `subscription_car_limit` is dropped,
   * so the product was a cap that could not refuse. The field is kept because
   * `platform_companies_list` returns it and the type describes that answer; it
   * has no reader on this screen.
   */
  drivers_per_car_limit: number | null;
  subscription_status: string | null;
  subscription_expires_at: string | null;
  subscription_started_at: string | null;
  subscription_duration_type: string | null;
}

interface PlatformKPIs {
  totalCompanies: number;
  totalUsers: number;
  totalDrivers: number;
  /**
   * Platform-wide, and null because no read model returns it: a platform
   * account reads no company's receipts directly since 20260917140000, and this
   * screen renders for platform accounts only, so the figure is unknown here
   * rather than zero.
   */
  totalReceipts: number | null;
  /**
   * Whether the per-company counts could be read at all. False means the
   * figures are unknown and must show a dash — never a zero, which on this
   * screen would say that every customer has no users and no drivers.
   */
  countsKnown: boolean;
  activeCompanies: number;
  suspendedCompanies: number;
  inactiveCompanies: number;
  archivedCompanies: number;
  deletedCompanies: number;
  newThisMonth: number;
  basicCount: number;
  advancedCount: number;
  premiumCount: number;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

// Product tier names, not words — untranslated in both dictionaries.
const PLAN_LABEL: Record<Plan, string> = { basic: 'Basic', advanced: 'Advanced', premium: 'Premium' };

// Object keys are the values stored in `companies.status`, which drive RLS and
// the approval gates in App.tsx — never translate the key or a comparison, only
// the label. `label` holds a TranslationKey because this map is module-level
// and t() is a hook value; CompaniesPage.tsx resolves the same key set.
const STATUS_CFG: Record<CompanyStatus, { label: TranslationKey; tone: 'positive' | 'critical' | 'neutral'; Icon: React.ElementType }> = {
  active:    { label: 'sa.status.active',    tone: 'positive', Icon: CheckCircle },
  suspended: { label: 'sa.status.suspended', tone: 'critical', Icon: PauseCircle },
  inactive:  { label: 'sa.status.inactive',  tone: 'neutral',  Icon: XCircle },
  archived:  { label: 'sa.status.archived',  tone: 'neutral',  Icon: XCircle },
  deleted:   { label: 'sa.status.deleted',   tone: 'critical', Icon: XCircle },
};

// ─── Attention Item ───────────────────────────────────────────────────────────

interface AttentionItem {
  id: string;
  companyName: string;
  reason: string;
  severity: 'critical' | 'warning' | 'info';
  company: CompanyRow;
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function SuperAdminDashboard() {
  // The prices this screen shows come from the same price book the database
  // charges from (plan 3.9), so a changed price shows here without a release.
  const { priceBook } = useAppConfig();
  const { openCompany, platformCan } = useSuperAdmin();
  // What the platform role may do, from platform_whoami(). Actions a role lacks
  // are hidden; the database refuses them regardless.
  const canLifecycle = platformCan('companies.lifecycle');
  const canBilling = platformCan('billing.manage');
  const canCodes = platformCan('codes.manage');
  const canOpenCompany = platformCan('business.read');
  const { showToast } = useToast();
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Entering a company opens a **read** context on it (plan 3.4b): since
  // 20260917140000 the database answers a platform account with the context's
  // company and nothing else, so navigating without one renders every tenant
  // screen against rows it cannot read — and PlatformAccountGuard bounces it
  // straight back. Writing needs the support session the bar offers inside the
  // company; opening one here would ask for a justification before anyone knows
  // whether one is needed.
  //
  // Declared *after* navigate and t, deliberately: a useCallback dependency
  // array is evaluated where it is written, so naming either of them above its
  // own const is a use-before-declaration. That was four errors — the exact
  // four the ratchet caught — and a render-time ReferenceError on the panel's
  // landing page, which no type error would have described.
  const enterCompany = useCallback(async (company: any) => {
    try {
      await openCompany(company, 'view');
      navigate(TENANT_HOME);
    } catch (error) {
      showToast('error', contextRefusalMessage(error, t));
    }
  }, [openCompany, navigate, showToast, t]);

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  /**
   * Whether the company list in state above is the platform's, or whatever was
   * left after a read that did not succeed.
   *
   * It describes the list currently held, not the request in flight, so it is
   * **not** cleared where the load starts: a silent reload must not make the
   * list on screen read as unknown while it is still the last good one. A failed
   * attempt does clear it — including a failed minute tick, because a reload
   * that failed means the list on screen may no longer be the platform's, and
   * `ReferralCodesManagement` counts its usage figures over exactly this list.
   */
  const [companiesKnown, setCompaniesKnown] = useState(false);
  const [kpis, setKpis] = useState<PlatformKPIs | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeSection, setActiveSection] = useState<'overview' | 'approvals' | 'discounts' | 'referrals' | 'activation'>('overview');
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<{ company: CompanyRow } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [manualSubModal, setManualSubModal] = useState<CompanyRow | null>(null);
  const [statusConfirm, setStatusConfirm] = useState<{ company: CompanyRow; status: CompanyStatus } | null>(null);
  const [suspendConfirm, setSuspendConfirm] = useState<CompanyRow | null>(null);
  // The per-company counts as last read. Kept between loads so the minute tick
  // and the reload after each action reuse them instead of reading them again.
  const companyCounts = useRef<CompanyCounts>(UNKNOWN_COMPANY_COUNTS);

  /*
    What this month's invoice costs per company, from platform_invoice_quotes —
    the same figure GenerateInvoicesModal inserts (a company's first invoice is
    a flat price, later ones the price book per car). Keyed by company here; the
    RPC keys by subscription. 'unavailable' covers a refusal and a failed read
    alike and prints a dash, never a computed guess. One audited read row per
    call, so it is read on opening and on the refresh button, never on the tick.
  */
  type QuoteState = { status: 'loading' } | { status: 'unavailable' }
    | { status: 'ok'; byCompany: Map<string, PlatformInvoiceQuote> };
  const [quotes, setQuotes] = useState<QuoteState>({ status: 'loading' });
  const loadQuotes = useCallback(async () => {
    const now = new Date();
    const result = await fetchInvoiceQuotes(now.getMonth() + 1, now.getFullYear()).catch(() => null);
    if (!result) { setQuotes({ status: 'unavailable' }); return; }
    const byCompany = new Map<string, PlatformInvoiceQuote>();
    result.forEach(q => byCompany.set(q.companyId, q));
    setQuotes({ status: 'ok', byCompany });
  }, []);

  /**
   * `silent` keeps the page on screen while it reloads. `readCounts` reads the
   * per-company counts again, which writes one audit row per page — so only the
   * page opening and the refresh button pass it. The minute tick and the
   * reloads after an action never do: one tab left open would otherwise write
   * some 1 440 rows a day into an append-only log that keeps them all.
   */
  const load = useCallback(async (silent = false, readCounts = false) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    try {
      // 1. Companies with plan + subscription data
      const { data: companiesRaw, error: cErr } = await supabase
        .from('companies')
        .select('id, name, slug, status, approval_status, rejection_reason, plan, billing_cycle, subscription_car_limit, created_at, updated_at, email, city, referral_code_used, subscription_status, subscription_expires_at, subscription_started_at, subscription_duration_type')
        .order('created_at', { ascending: false });

      if (cErr) throw cErr;
      const raw = companiesRaw ?? [];

      /*
        2-3b. Users, drivers and active vehicles per company, from the audited
        read model rather than counted here by hand.

        The three queries that stood here read user_profiles, drivers and cars
        across every company with the caller's own JWT, and none of them even
        bound `error`. Since 20260917140000 (plan 3.4) a platform account reads
        none of those three without an open context, so each returned `[]` in
        silence and this page — the panel's landing page — rendered 0 users and
        0 drivers as headline figures, `0/3` and `0/12` per company, and an
        attention list naming every customer on the platform as empty.

        platform_companies_list computes all three server-side under
        companies.read and records the read — one row per page, which is why
        they are read only when asked for (see `readCounts`). It is paged, so a
        platform with more companies than one page holds still gets every
        count. A refusal, a transport error or companies past the reachable
        pages leave them unknown, the figures show a dash, and the company table
        and approvals below still render.
      */
      if (readCounts) {
        companyCounts.current = await collectCompanyCounts(fetchCompanies);
      }
      const counts = companyCounts.current;
      const ucMap = counts.users;
      const dcMap = counts.drivers;
      const ccMap = counts.vehicles;

      /*
        4. drivers_per_car_limit, from the same audited read model.

        This was a `company_settings` select across every company. Since
        20260923100000 (plan 3.13b) a platform account reads that table only
        inside an open context — it carries the company's legal name, managing
        director, VAT and tax number, commercial register, bank name, IBAN, BIC
        and account holder, and `companies.read` is held by every staff role,
        so the panel read all of it for every customer with no context and no
        audit row. The one column the panel actually used is now a key of
        platform_companies_list, so the figure arrives with the counts and is
        recorded like them.

        Left unread here, the select returned an empty set in silence and every
        company's allowance fell back to 4 — the same failure shape as the
        counts before this page moved to the read model.

        5. The platform-wide receipt total is gone rather than wrong: a
           platform account reads no company's receipts since 20260917140000,
           so this query could only ever return 0 now, and no read model
           reports the figure. It is unknown here, and the card says so.
      */
      const dpcMap = counts.driversPerCar;

      const enriched: CompanyRow[] = raw.map(c => ({
        ...c,
        billing_cycle: (c.billing_cycle ?? 'monthly') as 'monthly' | 'yearly',
        subscription_car_limit: c.subscription_car_limit ?? 3,
        approval_status: (c.approval_status ?? 'approved') as 'pending' | 'approved' | 'rejected' | 'suspended',
        rejection_reason: c.rejection_reason ?? null,
        referral_code_used: c.referral_code_used ?? null,
        user_count: ucMap[c.id] || 0,
        driver_count: dcMap[c.id] || 0,
        active_car_count: ccMap[c.id] || 0,
        counts_known: counts.known && ucMap[c.id] !== undefined,
        drivers_per_car_limit: dpcMap[c.id] ?? null,
      }));

      setCompanies(enriched);
      setCompaniesKnown(true);

      // Compute KPIs
      const now = new Date();
      const monthStart = startOfMonth(now);

      const totalUsers = Object.values(ucMap).reduce((a, b) => a + b, 0);
      const totalDrivers = Object.values(dcMap).reduce((a, b) => a + b, 0);

      const kpiData: PlatformKPIs = {
        totalCompanies: enriched.filter(c => c.status !== 'archived' && c.status !== 'deleted').length,
        totalUsers,
        totalDrivers,
        totalReceipts: null,
        // The totals are sums over every company, so one company whose counts
        // were not read makes them unknown too.
        countsKnown: counts.known && enriched.every(c => c.counts_known),
        activeCompanies: enriched.filter(c => c.status === 'active').length,
        suspendedCompanies: enriched.filter(c => c.status === 'suspended').length,
        inactiveCompanies: enriched.filter(c => c.status === 'inactive').length,
        archivedCompanies: enriched.filter(c => c.status === 'archived').length,
        deletedCompanies: enriched.filter(c => c.status === 'deleted').length,
        newThisMonth: enriched.filter(c => isAfter(new Date(c.created_at), monthStart)).length,
        basicCount: enriched.filter(c => (c.plan ?? 'basic') === 'basic').length,
        advancedCount: enriched.filter(c => c.plan === 'advanced').length,
        premiumCount: enriched.filter(c => c.plan === 'premium').length,
      };
      setKpis(kpiData);
    } catch (err: any) {
      // The list on screen is no longer vouched for, so nothing counted over it
      // is either. `companies` is deliberately left as it was: a stale list the
      // screen marks as unconfirmed beats an empty one that claims there are no
      // customers.
      console.error(err);
      setCompaniesKnown(false);
      showToast('error', t('sa.dash.errorLoad'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showToast, t]);

  // Opening the page is a deliberate read, so it reads the counts.
  useEffect(() => { load(false, true); }, [load]);

  // Only a role holding billing.manage may read the quotes; the others are
  // never asked (the database would refuse and write a `denied` row).
  useEffect(() => {
    if (canBilling) loadQuotes(); else setQuotes({ status: 'unavailable' });
  }, [canBilling, loadQuotes]);

  // Auto-refresh every 60s — and never the counts, which cost an
  // audit row a page.
  useEffect(() => {
    const id = setInterval(() => load(true), 60_000);
    return () => clearInterval(id);
  }, [load]);

  const handleStatusChange = async (company: CompanyRow, status: CompanyStatus) => {
    try {
      await callPlatformRpc('platform_company_set_status', { p_company_id: company.id, p_status: status });
      const statusKey = STATUS_CFG[status]?.label;
      showToast('success', `${company.name} → ${statusKey ? t(statusKey) : status}`);
      load(true);
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    }
  };

  const handlePlanChange = async (company: CompanyRow, plan: Plan) => {
    try {
      await callPlatformRpc('platform_company_set_plan', { p_company_id: company.id, p_plan: plan });
      showToast('success', t('sa.dash.toast.planChanged', { name: company.name, plan: PLAN_LABEL[plan] }));
      load(true);
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    }
  };

  const handleBillingCycleChange = async (company: CompanyRow, billing_cycle: 'monthly' | 'yearly') => {
    try {
      await callPlatformRpc('platform_company_set_plan', { p_company_id: company.id, p_billing_cycle: billing_cycle });
      showToast('success', `${company.name} → ${t(billing_cycle === 'yearly' ? 'sa.dash.cycle.yearly' : 'sa.dash.cycle.monthly')}`);
      load(true);
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    }
  };

  const handleCarLimitChange = async (company: CompanyRow, limit: number) => {
    if (limit < 1 || limit > 200) return;
    try {
      await callPlatformRpc('platform_company_set_plan', { p_company_id: company.id, p_car_limit: limit });
      showToast('success', t('sa.dash.toast.carLimitChanged', { name: company.name, limit }));
      load(true);
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    }
  };

  const handleApprove = async (company: CompanyRow) => {
    setApprovingId(company.id);
    try {
      // Exactly what this screen wrote before: the approval columns and nothing
      // else. No code and no mail at approval (the owner's decision of
      // 15.09.2026); the approving account comes from the caller's own token.
      await callPlatformRpc('platform_company_set_approval', { p_company_id: company.id, p_decision: 'approve' });
      showToast('success', t('sa.dash.toast.approved', { name: company.name }));
      load(true);
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    } finally {
      setApprovingId(null);
    }
  };

  const handleReject = async () => {
    if (!rejectModal) return;
    const company = rejectModal.company;
    setApprovingId(company.id);
    try {
      await callPlatformRpc('platform_company_set_approval', {
        p_company_id: company.id,
        p_decision: 'reject',
        p_reason: rejectReason.trim() || null,
      });
      showToast('success', t('sa.dash.toast.rejected', { name: company.name }));
      setRejectModal(null);
      setRejectReason('');
      load(true);
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    } finally {
      setApprovingId(null);
    }
  };

  const handleSuspendApproval = async (company: CompanyRow) => {
    try {
      await callPlatformRpc('platform_company_set_approval', { p_company_id: company.id, p_decision: 'suspend' });
      showToast('success', t('sa.dash.toast.approvalSuspended', { name: company.name }));
      load(true);
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    }
  };

  /**
   * The way back from a suspension.
   *
   * Since 20260919150000 `platform_company_set_approval('suspend')` writes
   * `companies.status`, so approval is not what was taken away and re-approving
   * would leave the company suspended behind a green badge. This is the same
   * RPC the lifecycle menu on CompaniesPage calls, which also lifts the
   * `suspended` state from the company's users.
   */
  const handleReactivate = async (company: CompanyRow) => {
    // approvingId is what the button's `disabled` reads; without setting it the
    // busy state is dead and a double click fires two reactivate calls.
    setApprovingId(company.id);
    try {
      await callPlatformRpc('platform_company_lifecycle', { p_company_id: company.id, p_action: 'reactivate' });
      showToast('success', t('sa.companies.toast.reactivated', { name: company.name }));
      load(true);
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    } finally {
      setApprovingId(null);
    }
  };

  // Compute attention items
  const attentionItems: AttentionItem[] = [];
  const pendingCompanies = companies.filter(c => c.approval_status === 'pending');
  if (companies.length > 0) {
    // Pending approvals are first in attention
    for (const c of pendingCompanies) {
      attentionItems.push({ id: `${c.id}-pending`, companyName: c.name, reason: t('sa.dash.attention.pending'), severity: 'warning', company: c });
    }
    for (const c of companies) {
      // Skip archived/deleted companies from attention items
      if (c.status === 'archived' || c.status === 'deleted') continue;
      // Both flags read 0 as "none", so they may only be raised where this
      // company's counts were actually read. Unread, a count is 0 and means
      // "unknown": every company would look empty, and the list would name
      // every customer on the platform.
      if (c.counts_known && c.user_count === 0) {
        attentionItems.push({ id: `${c.id}-nousers`, companyName: c.name, reason: t('sa.dash.attention.noUsers'), severity: 'info', company: c });
      }
      if (c.counts_known && c.driver_count === 0 && c.status !== 'inactive') {
        attentionItems.push({ id: `${c.id}-nodrivers`, companyName: c.name, reason: t('sa.dash.attention.noDrivers'), severity: 'info', company: c });
      }
      if (c.status === 'suspended') {
        attentionItems.push({ id: `${c.id}-suspended`, companyName: c.name, reason: t('sa.dash.attention.suspended'), severity: 'warning', company: c });
      }
    }
    // Sort: critical first
    attentionItems.sort((a, b) => {
      const rank = { critical: 0, warning: 1, info: 2 };
      return rank[a.severity] - rank[b.severity];
    });
  }

  const recentCompanies = [...companies]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 8);

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic. Everything below only draws; the
  // presentation helpers (badges, plan bar, tone maps) are at the end of the file.

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw aria-hidden size={24} className="text-fg-subtle motion-safe:animate-spin" />
      </div>
    );
  }

  return (
    <>
    <div className="space-y-6 pb-10 font-ui">

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-tight bg-caution-soft text-caution">
            <Shield aria-hidden size={16} />
          </span>
          <span className="text-xs font-semibold uppercase tracking-widest text-caution">Super Admin</span>
        </div>
        <PageHeader
          className="pb-0"
          title={t('sa.dash.title')}
          description={t('sa.dash.subtitle')}
          actions={
            <>
              {/* The one reload besides opening the page that reads the counts again. */}
              <Button
                variant="secondary"
                onClick={() => { load(true, true); if (canBilling) loadQuotes(); }}
                disabled={refreshing}
              >
                <RefreshCw aria-hidden className={refreshing ? 'motion-safe:animate-spin' : ''} />
                {t('common.update')}
              </Button>
              <Button asChild>
                <Link to={`${ADMIN_BASE}/companies`}>
                  <Building2 aria-hidden />
                  {t('sa.dash.allCompanies')}
                </Link>
              </Button>
            </>
          }
        />
      </div>

      {/*
        The company list was not read, so nothing counted over it is a fact:
        "0 Unternehmen", an empty customer table and a code with 0 Nutzungen all
        read as statements about the platform, and this says they are not. The
        KPI cards need no guard — `kpis` stays null until a read succeeds, so
        they are absent rather than zero.
      */}
      {!loading && !companiesKnown && (
        <Alert tone="caution" className="font-ui" title={t('admin.read.failedTitle')}>
          {t('admin.read.failed')}
        </Alert>
      )}

      {/* ── Section tabs ───────────────────────────────────────────────────────── */}
      <Tabs value={activeSection} onValueChange={value => setActiveSection(value as typeof activeSection)}>
        <TabsList variant="segmented" className="h-auto flex-wrap">
          {([
            { id: 'overview',    label: t('sa.dash.tab.overview'),   icon: BarChart3,      visible: true },
            { id: 'approvals',   label: t('sa.dash.tab.approvals'),  icon: ClipboardCheck, visible: true, badge: pendingCompanies.length },
            { id: 'discounts',   label: t('sa.dash.tab.discounts'),  icon: Tag,            visible: canCodes },
            { id: 'referrals',   label: t('sa.dash.tab.referrals'),  icon: Gift,           visible: canCodes },
            { id: 'activation',  label: t('sa.dash.tab.activation'), icon: KeyRound,       visible: canCodes },
          ] as const).filter(tab => tab.visible).map(tab => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              onClick={() => setActiveSection(tab.id)}
              className="h-9 gap-2 px-4 [@media(pointer:coarse)]:h-11"
            >
              <tab.icon aria-hidden size={14} />
              {tab.label}
              {tab.badge !== undefined && tab.badge > 0 && (
                <Badge tone="caution" className="h-[18px] px-1.5 text-[10px] font-bold">{tab.badge}</Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* ── Discount Codes section ─────────────────────────────────────────────── */}
      {canCodes && activeSection === 'discounts' && <DiscountCodesManagement />}

      {/* ── Referral Codes section ─────────────────────────────────────────────── */}
      {canCodes && activeSection === 'referrals' && <ReferralCodesManagement companies={companies} companiesKnown={companiesKnown} />}

      {/* ── Activation Codes section ───────────────────────────────────────────── */}
      {canCodes && activeSection === 'activation' && <ActivationCodesManagement companies={companies} />}

      {/* ── Approvals section ────────────────────────────────────────────────── */}
      {activeSection === 'approvals' && (
        <div className="space-y-4">
          <Card>
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <div className="flex items-center gap-2">
                <ClipboardCheck aria-hidden size={16} className="text-caution" />
                <h3 className="text-sm font-semibold text-fg">
                  {t('sa.dash.pendingApprovals')}
                </h3>
                {pendingCompanies.length > 0 && (
                  <Badge tone="caution" className="font-bold">{pendingCompanies.length}</Badge>
                )}
              </div>
            </div>
            {pendingCompanies.length === 0 ? (
              <EmptyState icon={CheckCircle} size="sm" title={t('sa.dash.noPendingRequests')} />
            ) : (
              <div className="divide-y divide-line">
                {pendingCompanies.map(c => (
                  <div key={c.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-caution-soft text-sm font-bold text-caution">
                      {c.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-fg">{c.name}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        <PlanBadge plan={c.plan ?? 'basic'} />
                        <span className="text-[11px] text-fg-subtle">
                          {t('sa.dash.carsCount', { count: c.subscription_car_limit })} · {t(c.billing_cycle === 'yearly' ? 'sa.dash.cycle.yearly' : 'sa.dash.cycle.monthly')}
                        </span>
                        {c.referral_code_used && (
                          <Badge tone="positive" className="font-mono">
                            <Gift aria-hidden /> {c.referral_code_used}
                          </Badge>
                        )}
                        <span className="text-[11px] text-fg-subtle">
                          {t('sa.dash.registeredAt', { date: format(new Date(c.created_at), 'dd. MMM yyyy HH:mm', { locale: de }) })}
                        </span>
                      </div>
                    </div>
                    <div className={`${canLifecycle ? 'flex' : 'hidden'} shrink-0 items-center gap-2`}>
                      <Button
                        size="sm"
                        onClick={() => handleApprove(c)}
                        disabled={approvingId === c.id}
                      >
                        {approvingId === c.id ? <RefreshCw aria-hidden className="motion-safe:animate-spin" /> : <CheckCircle aria-hidden />}
                        {t('sa.dash.approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="text-critical"
                        onClick={() => { setRejectModal({ company: c }); setRejectReason(''); }}
                        disabled={approvingId === c.id}
                      >
                        <XCircle aria-hidden />
                        {t('sa.dash.reject')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Approved / rejected / suspended table */}
          <Card>
            <div className="flex items-center gap-2 border-b border-line px-5 py-4">
              <Activity aria-hidden size={16} className="text-fg-subtle" />
              <h3 className="text-sm font-semibold text-fg">{t('sa.dash.allApprovalStatuses')}</h3>
            </div>
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-wash">
                    {([
                      'sa.dash.col.company', 'sa.dash.col.approval',
                      'sa.dash.col.registered', 'sa.dash.col.referralCode', null,
                    ] as const).map((h, i) => (
                      <th key={i} className="whitespace-nowrap px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{h ? t(h) : ''}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {companies.filter(c => c.status !== 'deleted').map(c => {
                    const ap = c.approval_status;
                    /*
                      Suspension is `companies.status` since 20260919150000
                      (plan 3.F step U1), and this table has no status column —
                      it renders one badge, from the approval status. So the
                      badge asks the suspension first: without this a company
                      suspended from this very table would go on reading green
                      *Genehmigt*, keep offering *Sperren*, and lose its way
                      back, because the reactivate button below was keyed on an
                      `approval_status` value that no longer occurs.
                    */
                    const suspended = c.status === 'suspended';
                    const apTone = suspended || ap === 'rejected' ? 'critical'
                      : ap === 'approved' ? 'positive'
                        : ap === 'pending' ? 'caution' : 'critical';
                    const apLabel = t(
                      suspended ? 'sa.dash.approval.suspended'
                        : ap === 'approved' ? 'sa.dash.approval.approved'
                          : ap === 'pending' ? 'sa.dash.approval.pending'
                            : ap === 'rejected' ? 'sa.dash.approval.rejected'
                              : 'sa.dash.approval.suspended',
                    );
                    return (
                      <tr key={c.id} className="border-b border-line">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="flex size-7 shrink-0 items-center justify-center rounded-tight bg-brand-soft text-xs font-bold text-brand-text">
                              {c.name.charAt(0).toUpperCase()}
                            </div>
                            <span className="text-sm font-medium text-fg">{c.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Badge tone={apTone}>{apLabel}</Badge>
                            {canLifecycle && ap === 'approved' && !suspended && (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="hover:text-critical"
                                onClick={() => setSuspendConfirm(c)}
                              >
                                {t('sa.dash.suspend')}
                              </Button>
                            )}
                            {/*
                              The way back from a suspension is `reactivate`,
                              not `approve`: approval is not what was taken
                              away, and re-approving an already-approved company
                              would leave it suspended with a green badge.
                            */}
                            {canLifecycle && suspended && (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="text-positive"
                                onClick={() => handleReactivate(c)}
                                disabled={approvingId === c.id}
                              >
                                {approvingId === c.id ? '…' : t('sa.lifecycle.reactivate.confirm')}
                              </Button>
                            )}
                            {canLifecycle && !suspended && ap === 'rejected' && (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="text-positive"
                                onClick={() => handleApprove(c)}
                                disabled={approvingId === c.id}
                              >
                                {t('sa.dash.approve')}
                              </Button>
                            )}
                            {canLifecycle && !suspended && ap === 'pending' && (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="text-positive"
                                onClick={() => handleApprove(c)}
                                disabled={approvingId === c.id}
                              >
                                {approvingId === c.id ? '…' : t('sa.dash.approve')}
                              </Button>
                            )}
                          </div>
                          {c.rejection_reason && (
                            <p className="mt-1 max-w-xs truncate text-[11px] text-fg-subtle" title={c.rejection_reason}>
                              {t('sa.dash.reasonPrefix', { reason: c.rejection_reason })}
                            </p>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-fg-subtle">
                          {format(new Date(c.created_at), 'dd.MM.yyyy', { locale: de })}
                        </td>
                        <td className="px-4 py-3">
                          {c.referral_code_used ? (
                            <Badge tone="positive" className="font-mono">{c.referral_code_used}</Badge>
                          ) : (
                            <span className="text-fg-subtle">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="[&[hidden]]:hidden"
                            aria-label={t('sa.dash.openCompany')}
                            hidden={!canOpenCompany} onClick={() => { void enterCompany(c as any); }}
                          >
                            <ExternalLink aria-hidden />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ── Overview section ──────────────────────────────────────────────────── */}
      {activeSection === 'overview' && <>

      {/* ── KPI Grid ──────────────────────────────────────────────────────────── */}
      {kpis && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard
            label={t('sa.dash.kpi.companies')}
            value={kpis.totalCompanies}
            icon={Building2}
            trend={{
              direction: kpis.newThisMonth >= 0 ? 'up' : 'down',
              value: `${kpis.newThisMonth >= 0 ? '+' : ''}${kpis.newThisMonth}`,
              sentiment: kpis.newThisMonth >= 0 ? 'positive' : 'negative',
            }}
            caption={t('sa.dash.kpi.newThisMonth', { count: kpis.newThisMonth })}
          />
          {/* Users and drivers are summed from the audited read model. The
              receipt total has no read model at all, so it is unknown rather
              than zero — a dash, never a number nobody read. */}
          <KpiCard label={t('sa.dash.kpi.users')} value={kpis.countsKnown ? kpis.totalUsers : '–'} icon={Users} />
          <KpiCard label={t('sa.dash.kpi.drivers')} value={kpis.countsKnown ? kpis.totalDrivers : '–'} icon={Car} />
          <KpiCard label={t('sa.dash.kpi.receipts')} value={kpis.totalReceipts ?? '–'} icon={FileText} />
        </div>
      )}

      {/* ── Subscription stats + Plan distribution ───────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">

        {/* Subscription breakdown */}
        {kpis && (
          <Card className="space-y-4 p-5 lg:col-span-1">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-subtle">{t('sa.dash.statusDistribution')}</h3>
            <div className="space-y-2.5">
              {([
                // `alwaysShow` replaces a filter that matched on the German label.
                // Active stays visible at zero; the rest appear only when non-zero.
                { id: 'active',       labelKey: 'sa.status.active',            value: kpis.activeCompanies,    tone: 'text-positive',  Icon: CheckCircle, alwaysShow: true },
                { id: 'suspended',    labelKey: 'sa.status.suspended',         value: kpis.suspendedCompanies, tone: 'text-critical',  Icon: PauseCircle },
                { id: 'inactive',     labelKey: 'sa.status.inactive',          value: kpis.inactiveCompanies,  tone: 'text-fg-subtle', Icon: XCircle },
                { id: 'archived',     labelKey: 'sa.status.archived',          value: kpis.archivedCompanies,  tone: 'text-fg-muted',  Icon: XCircle },
                { id: 'deleted',      labelKey: 'sa.status.deleted',           value: kpis.deletedCompanies,   tone: 'text-critical',  Icon: XCircle },
              ] as const).filter(row => row.value > 0 || 'alwaysShow' in row).map(row => (
                <div key={row.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-fg-muted">
                    <row.Icon aria-hidden size={13} className={row.tone} />
                    {t(row.labelKey)}
                  </div>
                  <span className={`text-sm font-bold tabular-nums ${row.value > 0 ? row.tone : 'text-fg-subtle'}`}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Plan distribution */}
        {kpis && (
          <Card className="space-y-4 p-5 lg:col-span-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-subtle">{t('sa.dash.planDistribution')}</h3>
              <span className="text-xs text-fg-subtle">{t('sa.dash.companiesCount', { count: kpis.totalCompanies })}</span>
            </div>
            <PlanDistributionBar kpis={kpis} total={kpis.totalCompanies} />
            <div className="grid grid-cols-3 gap-3 pt-1">
              {[
                { plan: 'basic' as Plan,    count: kpis.basicCount    },
                { plan: 'advanced' as Plan, count: kpis.advancedCount },
                { plan: 'premium' as Plan,  count: kpis.premiumCount  },
              ].map(({ plan, count }) => (
                <div key={plan} className={`min-w-0 rounded-tile border p-2 text-center sm:p-3 ${PLAN_TILE_CLASS[plan]}`}>
                  <p className="text-xl font-bold tabular-nums">{count}</p>
                  <p className="mt-0.5 text-xs font-semibold">{PLAN_LABEL[plan]}</p>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* ── Needs attention ───────────────────────────────────────────────────── */}
      {attentionItems.length > 0 && (
        <Card className="space-y-3 p-5">
          <div className="flex items-center gap-2">
            <AlertTriangle aria-hidden size={16} className="text-caution" />
            <h3 className="text-sm font-semibold text-fg">
              {t('sa.dash.attentionTitle', { count: attentionItems.length })}
            </h3>
          </div>
          <div className="max-h-64 space-y-2 overflow-y-auto pe-1">
            {attentionItems.map(item => (
              <Alert
                key={item.id}
                tone={item.severity === 'critical' ? 'critical' : item.severity === 'warning' ? 'caution' : 'brand'}
                icon={AlertCircle}
                title={<span className="block truncate">{item.companyName}</span>}
                action={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="[&[hidden]]:hidden"
                    hidden={!canOpenCompany} onClick={() => { void enterCompany(item.company as any); }}
                    title={t('sa.dash.openCompany')}
                    aria-label={t('sa.dash.openCompany')}
                  >
                    <ExternalLink aria-hidden />
                  </Button>
                }
              >
                {item.reason}
              </Alert>
            ))}
          </div>
        </Card>
      )}

      {/* ── Companies table ───────────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Activity aria-hidden size={16} className="text-brand-text" />
            <h3 className="text-sm font-semibold text-fg">
              {t('sa.dash.allCompaniesCount', { count: companies.length })}
            </h3>
          </div>
          <Link
            to={`${ADMIN_BASE}/companies`}
            className="flex items-center gap-1.5 text-xs font-semibold text-brand-text transition-colors hover:underline [@media(pointer:coarse)]:min-h-10"
          >
            {t('sa.dash.manageAll')} <ChevronRight aria-hidden size={13} className="rtl:-scale-x-100" />
          </Link>
        </div>
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-wash">
                {([
                  'sa.dash.col.company', 'sa.dash.col.tariff', 'sa.dash.col.billing',
                  'sa.dash.col.cars', 'sa.dash.col.drivers', 'sa.dash.col.price',
                  'common.status', 'sa.dash.col.created', null,
                ] as const).map((h, i) => (
                  <th key={i} className="whitespace-nowrap px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{h ? t(h) : ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentCompanies.map(c => (
                <tr key={c.id} className="border-b border-line transition-colors hover:bg-wash">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-tight bg-brand-soft text-xs font-bold text-brand-text">
                        {c.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-semibold text-fg">{c.name}</p>
                        <p className="text-[10px] text-fg-subtle">{c.slug}</p>
                      </div>
                    </div>
                  </td>
                  {/* Tarif */}
                  <td className="px-4 py-3">
                    <NativeSelect
                      value={c.plan ?? 'basic'}
                      disabled={!canBilling}
                      onChange={e => handlePlanChange(c, e.target.value as Plan)}
                      containerClassName="w-32"
                      className={`h-8 text-xs font-semibold [@media(pointer:coarse)]:h-10 ${PLAN_SELECT_CLASS[c.plan ?? 'basic']}`}
                      title={t('sa.dash.changeTariff')}
                    >
                      {/* Product tier names — untranslated in both languages. */}
                      <option value="basic">Basic</option>
                      <option value="advanced">Advanced</option>
                      <option value="premium">Premium</option>
                    </NativeSelect>
                  </td>

                  {/* Abrechnung */}
                  <td className="px-4 py-3">
                    <NativeSelect
                      value={c.billing_cycle}
                      disabled={!canBilling}
                      onChange={e => handleBillingCycleChange(c, e.target.value as 'monthly' | 'yearly')}
                      containerClassName="w-32"
                      className="h-8 text-xs [@media(pointer:coarse)]:h-10"
                      title={t('sa.dash.changeBilling')}
                    >
                      <option value="monthly">{t('sa.dash.cycle.monthly')}</option>
                      <option value="yearly">{t('sa.dash.cycle.yearly')}</option>
                    </NativeSelect>
                  </td>

                  {/* Fahrzeuge limit + aktive */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={1}
                        max={200}
                        defaultValue={c.subscription_car_limit}
                        disabled={!canBilling}
                        onBlur={e => {
                          const v = parseInt(e.target.value);
                          if (!isNaN(v) && v !== c.subscription_car_limit) handleCarLimitChange(c, v);
                        }}
                        className="h-8 w-16 shrink-0 px-2 text-center text-xs font-semibold [@media(pointer:coarse)]:h-10"
                        title={t('sa.dash.carLimit')}
                      />
                      {/*
                        Both numbers stay, the red goes. Until 20261026110000
                        `active >= allowance` was a wall — `trg_enforce_car_limit`
                        refused the next car — so painting it `--danger` told the
                        operator something true. The cap is gone (billing, never
                        blocking) and the figure on the left is now what the
                        invoice charges, so red would claim a refusal that
                        cannot happen. The pair is kept because the quote
                        carries both and a stale allowance beside a live fleet
                        is exactly what nobody could see before.
                      */}
                      <span className="whitespace-nowrap text-[10px] tabular-nums text-fg-subtle"
                            title={t('sa.dash.carsBilledHint')}>
                        {c.counts_known ? c.active_car_count : '–'}/{c.subscription_car_limit}
                      </span>
                    </div>
                  </td>

                  {/* Fahrer aktiv / limit */}
                  <td className="px-4 py-3">
                    {/*
                      The driver COUNT, and no denominator.

                      This cell used to read `driver_count / driversAllowance(
                      subscription_car_limit, drivers_per_car_limit)`, in red
                      once the count reached it. That denominator was the
                      product of two numbers, and since 20261026110000 neither
                      one does anything: `trg_enforce_driver_limit`, which was
                      the only thing that multiplied them, is dropped, and the
                      invoice is priced on the fleet rather than on the first of
                      them. So the fraction was a cap that could not refuse and
                      a quantity that bills nothing — the class of figure this
                      codebase has spent two days removing, and worse than a
                      missing number because an operator would act on it.

                      `driversAllowance` is deliberately left in
                      src/lib/panelFigures.ts with its own test: it still
                      describes what the dropped trigger computed, and
                      tests/rls/fleet-caps-removed.sql's negative control uses
                      the same arithmetic. It simply has no caller on a screen.
                    */}
                    <span className="text-xs tabular-nums text-fg-muted">
                      {c.counts_known ? c.driver_count : '–'}
                    </span>
                  </td>

                  {/* Calculated price */}
                  <td className="px-4 py-3">
                    {(() => {
                      // No quote for a company means no active subscription, so
                      // nothing is invoiced and the list price stands. Only once
                      // the quotes are known — otherwise a dash, not a guess.
                      if (quotes.status !== 'ok') {
                        return (
                          <p className="text-xs text-fg-subtle"
                             title={quotes.status === 'loading' ? undefined : t('sa.dash.billedUnavailable')}>
                            –
                          </p>
                        );
                      }
                      const quote = quotes.byCompany.get(c.id);
                      /*
                        The car count the invoice is priced on since
                        20261026110000 — the FLEET, not
                        `companies.subscription_car_limit`.

                        This mattered inside one cell. The monthly figure comes
                        from the quote, which the database priced on the fleet,
                        while `bp` fed the yearly sub-line below and was priced
                        on the stored allowance — so for Customer B (billed
                        10, runs 2) the same cell would have read 80,00 € a
                        month and ten cars' worth a year. Both halves take the
                        same count now.

                        The quote carries the count it used; a company with no
                        active subscription has no quote, and then the read
                        model's own `active_car_count` is the same measurement.
                        If neither is available the price is NOT rendered —
                        this screen's own rule, already written above for the
                        drivers allowance: a dash, never a plausible number.
                      */
                      const cars = quote?.activeCars ?? (c.counts_known ? c.active_car_count : null);
                      if (cars === null) {
                        return (
                          <p className="text-xs text-fg-subtle" title={t('sa.dash.billedUnavailable')}>–</p>
                        );
                      }
                      const bp = calcPricing(priceBook, c.plan ?? 'basic', cars, c.billing_cycle);
                      const monthly = quote ? quote.amountCents / 100 : bp.monthlyEquivalent;
                      return (
                        <div>
                          <p className="whitespace-nowrap text-xs font-semibold tabular-nums text-fg">
                            {fmtPrice(monthly)} €<span className="font-normal text-fg-subtle">{t('sa.dash.perMonthShort')}</span>
                          </p>
                          {quote?.firstInvoice && (
                            <p className="text-[10px] text-fg-subtle">
                              {t('sa.dash.firstInvoice')}
                            </p>
                          )}
                          {c.billing_cycle === 'yearly' && (
                            <p className="whitespace-nowrap text-[10px] tabular-nums text-fg-subtle">
                              {fmtPrice(bp.finalTotal)} €{t('sa.dash.perYearShort')}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                  </td>

                  {/* Status */}
                  <td className="px-4 py-3">
                    {(c.status === 'archived' || c.status === 'deleted') ? (
                      <StatusBadge status={c.status} />
                    ) : (
                      <NativeSelect
                        value={c.status}
                        disabled={!canLifecycle}
                        onChange={e => setStatusConfirm({ company: c, status: e.target.value as CompanyStatus })}
                        containerClassName="w-32"
                        className={`h-8 text-xs font-semibold [@media(pointer:coarse)]:h-10 ${STATUS_SELECT_CLASS[STATUS_CFG[c.status]?.tone ?? 'neutral']}`}
                        title={t('sa.dash.changeStatus')}
                      >
                        {/* `value` is the stored companies.status — only the label is translated. */}
                        <option value="active">{t('sa.status.active')}</option>
                        <option value="suspended">{t('sa.status.suspended')}</option>
                        <option value="inactive">{t('sa.status.inactive')}</option>
                      </NativeSelect>
                    )}
                  </td>

                  <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-fg-subtle">
                    {format(new Date(c.created_at), 'dd.MM.yy', { locale: de })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="[&[hidden]]:hidden"
                        hidden={!canBilling}
                        onClick={() => setManualSubModal(c)}
                        title={t('sa.dash.editSubscriptionManually')}
                        aria-label={t('sa.dash.editSubscriptionManually')}
                      >
                        <PencilLine aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-brand-text [&[hidden]]:hidden"
                        hidden={!canOpenCompany} onClick={() => { void enterCompany(c as any); }}
                        title={t('sa.dash.openAsCompany')}
                        aria-label={t('sa.dash.openAsCompany')}
                      >
                        <ExternalLink aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {companies.length > 8 && (
          <div className="border-t border-line px-5 py-3 text-center">
            <Link to={`${ADMIN_BASE}/companies`} className="text-xs font-semibold text-brand-text hover:underline">
              {t('sa.dash.showAllCompanies', { count: companies.length })}
            </Link>
          </div>
        )}
      </Card>

      {/* ── Recent signups (activity) ─────────────────────────────────────────── */}
      <Card className="space-y-3 p-5">
        <div className="flex items-center gap-2">
          <TrendingUp aria-hidden size={16} className="text-positive" />
          <h3 className="text-sm font-semibold text-fg">{t('sa.dash.recentSignups')}</h3>
        </div>
        {companies.slice(0, 5).map(c => (
          <div key={c.id} className="flex items-center justify-between gap-3 py-1.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-brand-soft text-xs font-bold text-brand-text">
                {c.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-fg">{c.name}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={c.status} />
                  <PlanBadge plan={c.plan ?? 'basic'} />
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs tabular-nums text-fg-subtle">
                {format(new Date(c.created_at), 'dd. MMM', { locale: de })}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="[&[hidden]]:hidden"
                hidden={!canOpenCompany} onClick={() => { void enterCompany(c as any); }}
                aria-label={t('sa.dash.openCompany')}
              >
                <ExternalLink aria-hidden />
              </Button>
            </div>
          </div>
        ))}
      </Card>

      {/* ── Quick actions ─────────────────────────────────────────────────────── */}
      <Card className="space-y-3 p-5">
        <div className="flex items-center gap-2">
          <BarChart3 aria-hidden size={16} className="text-brand-text" />
          <h3 className="text-sm font-semibold text-fg">{t('sa.dash.quickAccess')}</h3>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {/*
            Every target is inside the panel. Two of these were the tenant
            paths '/users' and '/settings', which a company-less platform
            account cannot reach at all — it never sees the tenant router — so
            both landed on the public catch-all. The panel's own equivalents
            are the user directory and the platform settings; a role without
            the capability for one is refused there, as it is from the sidebar.
          */}
          {[
            { id: 'manageCompanies', label: t('sa.dash.quick.manageCompanies'), icon: Building2, to: `${ADMIN_BASE}/companies` },
            { id: 'newCompany', label: t('sa.dash.quick.newCompany'), icon: Plus, to: `${ADMIN_BASE}/companies` },
            { id: 'manageUsers', label: t('sa.dash.quick.manageUsers'), icon: Users, to: `${ADMIN_BASE}/verzeichnisse` },
            { id: 'settings', label: t('common.settings'), icon: Shield, to: `${ADMIN_BASE}/einstellungen` },
          ].map(action => (
            <Link
              key={action.id}
              to={action.to}
              className={QUICK_ACTION_CLASS}
            >
              <action.icon aria-hidden size={20} />
              {action.label}
            </Link>
          ))}
          <button
            onClick={() => setActiveSection('discounts')}
            className={cn(QUICK_ACTION_CLASS, canCodes ? undefined : 'hidden')}
          >
            <Tag aria-hidden size={20} />
            {t('sa.dash.tab.discounts')}
          </button>
          <button
            onClick={() => setActiveSection('approvals')}
            className={cn('relative', QUICK_ACTION_CLASS)}
          >
            {pendingCompanies.length > 0 && (
              <Badge tone="caution" className="absolute end-2 top-2 h-[18px] px-1.5 text-[10px] font-bold">
                {pendingCompanies.length}
              </Badge>
            )}
            <ClipboardCheck aria-hidden size={20} />
            {t('sa.dash.tab.approvals')}
          </button>
          <button
            onClick={() => setActiveSection('referrals')}
            className={cn(QUICK_ACTION_CLASS, canCodes ? undefined : 'hidden')}
          >
            <Gift aria-hidden size={20} />
            {t('sa.dash.tab.referrals')}
          </button>
          <button
            onClick={() => setActiveSection('activation')}
            className={cn(QUICK_ACTION_CLASS, canCodes ? undefined : 'hidden')}
          >
            <KeyRound aria-hidden size={20} />
            {t('sa.dash.tab.activation')}
          </button>
        </div>
      </Card>

      </>}

    </div>

    {/* Confirmations for the two one-click state changes of this screen. */}
    <ConfirmDialog
      open={statusConfirm !== null}
      onClose={() => setStatusConfirm(null)}
      onConfirm={() => { if (statusConfirm) void handleStatusChange(statusConfirm.company, statusConfirm.status); }}
      title={t('sa.dash.statusConfirm.title')}
      description={statusConfirm ? t('sa.dash.statusConfirm.description', {
        name: statusConfirm.company.name,
        from: STATUS_CFG[statusConfirm.company.status]?.label ? t(STATUS_CFG[statusConfirm.company.status].label) : statusConfirm.company.status,
        to: STATUS_CFG[statusConfirm.status]?.label ? t(STATUS_CFG[statusConfirm.status].label) : statusConfirm.status,
      }) : ''}
      confirmLabel={t('sa.dash.statusConfirm.confirm')}
    />
    <ConfirmDialog
      open={suspendConfirm !== null}
      onClose={() => setSuspendConfirm(null)}
      onConfirm={() => { if (suspendConfirm) void handleSuspendApproval(suspendConfirm); }}
      title={t('sa.lifecycle.suspend.title')}
      description={suspendConfirm ? t('sa.dash.suspendConfirm.description', { name: suspendConfirm.name }) : ''}
      confirmLabel={t('sa.lifecycle.suspend.confirm')}
    />

    {/* ── Reject Modal ──────────────────────────────────────────────────────── */}
    {rejectModal && (
      <Dialog open onOpenChange={open => { if (!open && approvingId !== rejectModal.company.id) { setRejectModal(null); setRejectReason(''); } }}>
        <DialogContent className="max-w-md" onInteractOutside={event => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('sa.dash.rejectModal.title')}</DialogTitle>
            <DialogDescription>
              {/* Split so the company name keeps its bold emphasis; the two halves
                  sit either side of the name in both languages. */}
              {t('sa.dash.rejectModal.questionPrefix')}
              <strong className="text-fg">{rejectModal.company.name}</strong>
              {t('sa.dash.rejectModal.questionSuffix')}
            </DialogDescription>
          </DialogHeader>
          <Field label={t('sa.dash.rejectModal.reasonLabel')} id="reject-company-reason">
            <textarea
              id="reject-company-reason"
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={3}
              placeholder={t('sa.dash.rejectModal.reasonPlaceholder')}
              className={cn(controlFrameClass, 'h-auto min-h-0 resize-none py-2 [@media(pointer:coarse)]:h-auto')}
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setRejectModal(null); setRejectReason(''); }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleReject}
              disabled={approvingId === rejectModal.company.id}
            >
              {approvingId === rejectModal.company.id ? t('sa.dash.rejecting') : t('sa.dash.reject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
    {/* ── Manual Subscription Modal ────────────────────────────────────────── */}
    {manualSubModal && (
      <ManualSubscriptionModal
        company={manualSubModal}
        onClose={() => setManualSubModal(null)}
        onSaved={() => load(true)}
      />
    )}
  </>
  );
}

// ── Presentation helpers ──────────────────────────────────────────────────────
// Plan tiers are a status, not a series: basic is info, advanced caution,
// premium positive. Every class is written out so Tailwind finds it.

const PLAN_TONE: Record<Plan, 'info' | 'caution' | 'positive'> = {
  basic: 'info',
  advanced: 'caution',
  premium: 'positive',
};
const PLAN_SELECT_CLASS: Record<Plan, string> = {
  basic: 'bg-info-soft text-info',
  advanced: 'bg-caution-soft text-caution',
  premium: 'bg-positive-soft text-positive',
};
const PLAN_TILE_CLASS: Record<Plan, string> = {
  basic: 'border-info/20 bg-info-soft text-info',
  advanced: 'border-caution/20 bg-caution-soft text-caution',
  premium: 'border-positive/20 bg-positive-soft text-positive',
};
const PLAN_DOT_CLASS: Record<Plan, string> = {
  basic: 'bg-info-dot',
  advanced: 'bg-caution-dot',
  premium: 'bg-positive-dot',
};
const STATUS_SELECT_CLASS = {
  positive: 'bg-positive-soft text-positive',
  critical: 'bg-critical-soft text-critical',
  neutral: 'bg-neutral-soft text-neutral',
} as const;
const QUICK_ACTION_CLASS = [
  'flex flex-col items-center gap-2 rounded-tile border border-line bg-sunken p-4 text-center text-xs font-medium text-fg-muted',
  'transition-colors hover:border-brand hover:text-brand-text motion-safe:transition-all',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [@media(pointer:coarse)]:min-h-11',
].join(' ');

function StatusBadge({ status }: { status: CompanyStatus }) {
  const { t } = useTranslation();
  const cfg = STATUS_CFG[status] || STATUS_CFG.inactive;
  const Icon = cfg.Icon;
  return (
    <Badge tone={cfg.tone}>
      <Icon aria-hidden />{t(cfg.label)}
    </Badge>
  );
}

function PlanBadge({ plan }: { plan: Plan }) {
  return <Badge tone={PLAN_TONE[plan] ?? 'neutral'}>{PLAN_LABEL[plan] ?? plan}</Badge>;
}

function PlanDistributionBar({ kpis, total }: { kpis: PlatformKPIs; total: number }) {
  if (total === 0) return null;
  // Product tier names, none of them German, so none are translated.
  const segments = [
    { label: 'Basic',    count: kpis.basicCount,    plan: 'basic' as Plan },
    { label: 'Advanced', count: kpis.advancedCount, plan: 'advanced' as Plan },
    { label: 'Premium',  count: kpis.premiumCount,  plan: 'premium' as Plan },
  ].filter(s => s.count > 0);

  return (
    <div className="space-y-3">
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
        {segments.map(s => (
          <div
            key={s.label}
            className={`min-w-[4px] motion-safe:transition-all motion-safe:duration-500 ${PLAN_DOT_CLASS[s.plan]}`}
            // Data-driven: the share of companies on this tier.
            style={{ width: `${(s.count / total) * 100}%` }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        {segments.map(s => (
          <div key={s.label} className="flex items-center gap-1.5 text-xs text-fg-muted">
            <span className={`size-2.5 shrink-0 rounded-sm ${PLAN_DOT_CLASS[s.plan]}`} />
            <span>{s.label}</span>
            <span className="font-semibold tabular-nums text-fg">{s.count}</span>
            <span className="text-fg-subtle">({Math.round((s.count / total) * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}
