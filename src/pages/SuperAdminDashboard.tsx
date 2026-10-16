import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { fetchCompanies } from '../lib/platformDirectoryClient';
import { collectCompanyCounts, UNKNOWN_COMPANY_COUNTS, type CompanyCounts } from '../lib/platformReadModels';
import { driversAllowance } from '../lib/panelFigures';
import {
  Building2, Users, Car, FileText, TrendingUp, AlertTriangle,
  CheckCircle, XCircle, PauseCircle, Plus, ExternalLink,
  RefreshCw, BarChart3, AlertCircle, ChevronRight,
  ArrowUpRight, Shield, Activity, Tag, ClipboardCheck, Gift, KeyRound, PencilLine,
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
import { Alert, ConfirmDialog } from '../components/ui';
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
   * red "limit reached" colour from it. There is no default any more:
   * `driversAllowance()` answers null and the cell prints a dash.
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

// ─── Shared style helpers ─────────────────────────────────────────────────────

const PLAN_COLOR: Record<Plan, string> = {
  basic:    'var(--accent)',
  advanced: '#f59e0b',
  premium:  '#10b981',
};
const PLAN_BG: Record<Plan, string> = {
  basic:    'rgba(6,182,212,0.12)',
  advanced: 'rgba(245,158,11,0.12)',
  premium:  'rgba(16,185,129,0.12)',
};
// Product tier names, not words — untranslated in both dictionaries.
const PLAN_LABEL: Record<Plan, string> = { basic: 'Basic', advanced: 'Advanced', premium: 'Premium' };

// Object keys are the values stored in `companies.status`, which drive RLS and
// the approval gates in App.tsx — never translate the key or a comparison, only
// the label. `label` holds a TranslationKey because this map is module-level
// and t() is a hook value; CompaniesPage.tsx resolves the same key set.
const STATUS_CFG: Record<CompanyStatus, { label: TranslationKey; color: string; bg: string; Icon: React.ElementType }> = {
  active:    { label: 'sa.status.active',    color: 'var(--success)',        bg: 'var(--success-subtle)',  Icon: CheckCircle },
  suspended: { label: 'sa.status.suspended', color: 'var(--danger)',         bg: 'var(--danger-subtle)',   Icon: PauseCircle },
  inactive:  { label: 'sa.status.inactive',  color: 'var(--text-tertiary)',  bg: 'var(--bg-muted)',        Icon: XCircle },
  archived:  { label: 'sa.status.archived',  color: '#64748b',               bg: 'rgba(100,116,139,0.12)', Icon: XCircle },
  deleted:   { label: 'sa.status.deleted',   color: 'var(--danger)',         bg: 'var(--danger-subtle)',   Icon: XCircle },
};

function StatusBadge({ status }: { status: CompanyStatus }) {
  const { t } = useTranslation();
  const cfg = STATUS_CFG[status] || STATUS_CFG.inactive;
  const Icon = cfg.Icon;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: cfg.bg, color: cfg.color }}>
      <Icon size={10} />{t(cfg.label)}
    </span>
  );
}

function PlanBadge({ plan }: { plan: Plan }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: PLAN_BG[plan] ?? 'var(--bg-muted)', color: PLAN_COLOR[plan] ?? 'var(--text-secondary)' }}>
      {PLAN_LABEL[plan] ?? plan}
    </span>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color?: string;
  bg?: string;
  sub?: string;
  trend?: number | null;
}

function KpiCard({ label, value, icon: Icon, color = 'var(--accent)', bg, sub, trend }: KpiCardProps) {
  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-3"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start justify-between">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: bg ?? `${color}18` }}>
          <Icon size={18} style={{ color }} />
        </div>
        {trend != null && (
          <span className="flex items-center gap-0.5 text-xs font-semibold px-1.5 py-0.5 rounded-md"
            style={{ background: trend >= 0 ? 'var(--success-subtle)' : 'var(--danger-subtle)', color: trend >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            <ArrowUpRight size={10} />{trend >= 0 ? '+' : ''}{trend}
          </span>
        )}
      </div>
      <div>
        <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{value}</p>
        <p className="text-xs font-medium mt-0.5" style={{ color: 'var(--text-secondary)' }}>{label}</p>
        {sub && <p className="text-[10px] mt-1" style={{ color: 'var(--text-tertiary)' }}>{sub}</p>}
      </div>
    </div>
  );
}

// ─── Attention Item ───────────────────────────────────────────────────────────

interface AttentionItem {
  id: string;
  companyName: string;
  reason: string;
  severity: 'critical' | 'warning' | 'info';
  company: CompanyRow;
}

// ─── Plan Distribution Bar ────────────────────────────────────────────────────

function PlanDistributionBar({ kpis, total }: { kpis: PlatformKPIs; total: number }) {
  if (total === 0) return null;
  // Product tier names, none of them German, so none are translated.
  const segments = [
    { label: 'Basic',    count: kpis.basicCount,    color: PLAN_COLOR.basic },
    { label: 'Advanced', count: kpis.advancedCount,  color: PLAN_COLOR.advanced },
    { label: 'Premium',  count: kpis.premiumCount,   color: PLAN_COLOR.premium },
  ].filter(s => s.count > 0);

  return (
    <div className="space-y-3">
      <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
        {segments.map(s => (
          <div
            key={s.label}
            className="transition-all duration-500"
            style={{ width: `${(s.count / total) * 100}%`, background: s.color, minWidth: s.count > 0 ? 4 : 0 }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        {segments.map(s => (
          <div key={s.label} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: s.color }} />
            <span>{s.label}</span>
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{s.count}</span>
            <span style={{ color: 'var(--text-tertiary)' }}>({Math.round((s.count / total) * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
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

  const cardStyle: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: '1rem',
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw size={24} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
      </div>
    );
  }

  return (
    <>
    <div className="space-y-6 pb-10">

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--warning-subtle)' }}>
              <Shield size={16} style={{ color: 'var(--warning)' }} />
            </div>
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--warning)' }}>Super Admin</span>
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('sa.dash.title')}</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {t('sa.dash.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* The one reload besides opening the page that reads the counts again. */}
          <button
            onClick={() => load(true, true)}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-colors"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {t('common.update')}
          </button>
          <Link
            to={`${ADMIN_BASE}/companies`}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-opacity hover:opacity-85"
            style={{ background: 'var(--warning-solid)', color: 'white' }}
          >
            <Building2 size={14} />
            {t('sa.dash.allCompanies')}
          </Link>
        </div>
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
      <div className="flex gap-1 p-1 rounded-xl flex-wrap" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', width: 'fit-content' }}>
        {([
          { id: 'overview',    label: t('sa.dash.tab.overview'),   icon: BarChart3,      visible: true },
          { id: 'approvals',   label: t('sa.dash.tab.approvals'),  icon: ClipboardCheck, visible: true, badge: pendingCompanies.length },
          { id: 'discounts',   label: t('sa.dash.tab.discounts'),  icon: Tag,            visible: canCodes },
          { id: 'referrals',   label: t('sa.dash.tab.referrals'),  icon: Gift,           visible: canCodes },
          { id: 'activation',  label: t('sa.dash.tab.activation'), icon: KeyRound,       visible: canCodes },
        ] as const).filter(tab => tab.visible).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveSection(tab.id)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all relative"
            style={activeSection === tab.id
              ? { background: 'var(--accent)', color: 'var(--text-inverse)' }
              : { color: 'var(--text-secondary)' }
            }
          >
            <tab.icon size={14} />
            {tab.label}
            {tab.badge !== undefined && tab.badge > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: 'var(--warning-solid)' }}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Discount Codes section ─────────────────────────────────────────────── */}
      {canCodes && activeSection === 'discounts' && <DiscountCodesManagement />}

      {/* ── Referral Codes section ─────────────────────────────────────────────── */}
      {canCodes && activeSection === 'referrals' && <ReferralCodesManagement companies={companies} companiesKnown={companiesKnown} />}

      {/* ── Activation Codes section ───────────────────────────────────────────── */}
      {canCodes && activeSection === 'activation' && <ActivationCodesManagement companies={companies} />}

      {/* ── Approvals section ────────────────────────────────────────────────── */}
      {activeSection === 'approvals' && (
        <div className="space-y-4">
          <div style={cardStyle} className="overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2">
                <ClipboardCheck size={16} style={{ color: 'var(--warning)' }} />
                <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                  {t('sa.dash.pendingApprovals')}
                </h3>
                {pendingCompanies.length > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
                    {pendingCompanies.length}
                  </span>
                )}
              </div>
            </div>
            {pendingCompanies.length === 0 ? (
              <div className="px-5 py-10 text-center" style={{ color: 'var(--text-tertiary)' }}>
                <CheckCircle size={32} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">{t('sa.dash.noPendingRequests')}</p>
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {pendingCompanies.map(c => (
                  <div key={c.id} className="flex items-center gap-4 px-5 py-4 flex-wrap"
                    style={{ borderBottomColor: 'var(--border)' }}>
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold flex-shrink-0"
                      style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
                      {c.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm truncate" style={{ color: 'var(--text-primary)' }}>{c.name}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <PlanBadge plan={c.plan ?? 'basic'} />
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                          {t('sa.dash.carsCount', { count: c.subscription_car_limit })} · {t(c.billing_cycle === 'yearly' ? 'sa.dash.cycle.yearly' : 'sa.dash.cycle.monthly')}
                        </span>
                        {c.referral_code_used && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold" style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>
                            <Gift size={9} /> {c.referral_code_used}
                          </span>
                        )}
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                          {t('sa.dash.registeredAt', { date: format(new Date(c.created_at), 'dd. MMM yyyy HH:mm', { locale: de }) })}
                        </span>
                      </div>
                    </div>
                    <div className={`${canLifecycle ? 'flex' : 'hidden'} items-center gap-2 flex-shrink-0`}>
                      <button
                        onClick={() => handleApprove(c)}
                        disabled={approvingId === c.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity hover:opacity-85 disabled:opacity-50"
                        style={{ background: 'var(--success-solid)', color: 'white' }}
                      >
                        {approvingId === c.id ? <RefreshCw size={11} className="animate-spin" /> : <CheckCircle size={11} />}
                        {t('sa.dash.approve')}
                      </button>
                      <button
                        onClick={() => { setRejectModal({ company: c }); setRejectReason(''); }}
                        disabled={approvingId === c.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity hover:opacity-85 disabled:opacity-50"
                        style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid var(--danger)30' }}
                      >
                        <XCircle size={11} />
                        {t('sa.dash.reject')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Approved / rejected / suspended table */}
          <div style={cardStyle} className="overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <Activity size={16} style={{ color: 'var(--text-tertiary)' }} />
              <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{t('sa.dash.allApprovalStatuses')}</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                    {([
                      'sa.dash.col.company', 'sa.dash.col.approval',
                      'sa.dash.col.registered', 'sa.dash.col.referralCode', null,
                    ] as const).map((h, i) => (
                      <th key={i} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{h ? t(h) : ''}</th>
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
                    const apColor = suspended || ap === 'rejected' ? 'var(--danger)'
                      : ap === 'approved' ? 'var(--success)'
                        : ap === 'pending' ? 'var(--warning)' : 'var(--danger)';
                    const apBg = suspended || ap === 'rejected' ? 'var(--danger-subtle)'
                      : ap === 'approved' ? 'var(--success-subtle)'
                        : ap === 'pending' ? 'var(--warning-subtle)' : 'var(--danger-subtle)';
                    const apLabel = t(
                      suspended ? 'sa.dash.approval.suspended'
                        : ap === 'approved' ? 'sa.dash.approval.approved'
                          : ap === 'pending' ? 'sa.dash.approval.pending'
                            : ap === 'rejected' ? 'sa.dash.approval.rejected'
                              : 'sa.dash.approval.suspended',
                    );
                    return (
                      <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>
                              {c.name.charAt(0).toUpperCase()}
                            </div>
                            <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{c.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: apBg, color: apColor }}>
                              {apLabel}
                            </span>
                            {canLifecycle && ap === 'approved' && !suspended && (
                              <button
                                onClick={() => setSuspendConfirm(c)}
                                className="text-[11px] px-2 py-0.5 rounded border transition-colors"
                                style={{ borderColor: 'var(--border)', color: 'var(--text-tertiary)' }}
                                onMouseEnter={e => { (e.currentTarget.style.borderColor = 'var(--danger)'); (e.currentTarget.style.color = 'var(--danger)'); }}
                                onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-tertiary)'); }}
                              >
                                {t('sa.dash.suspend')}
                              </button>
                            )}
                            {/*
                              The way back from a suspension is `reactivate`,
                              not `approve`: approval is not what was taken
                              away, and re-approving an already-approved company
                              would leave it suspended with a green badge.
                            */}
                            {canLifecycle && suspended && (
                              <button
                                onClick={() => handleReactivate(c)}
                                disabled={approvingId === c.id}
                                className="text-[11px] px-2 py-0.5 rounded border transition-colors"
                                style={{ borderColor: 'var(--success)', color: 'var(--success)' }}
                              >
                                {approvingId === c.id ? '…' : t('sa.lifecycle.reactivate.confirm')}
                              </button>
                            )}
                            {canLifecycle && !suspended && ap === 'rejected' && (
                              <button
                                onClick={() => handleApprove(c)}
                                disabled={approvingId === c.id}
                                className="text-[11px] px-2 py-0.5 rounded border transition-colors"
                                style={{ borderColor: 'var(--success)', color: 'var(--success)' }}
                              >
                                {t('sa.dash.approve')}
                              </button>
                            )}
                            {canLifecycle && !suspended && ap === 'pending' && (
                              <button
                                onClick={() => handleApprove(c)}
                                disabled={approvingId === c.id}
                                className="text-[11px] px-2 py-0.5 rounded border transition-colors"
                                style={{ borderColor: 'var(--success)', color: 'var(--success)' }}
                              >
                                {approvingId === c.id ? '…' : t('sa.dash.approve')}
                              </button>
                            )}
                          </div>
                          {c.rejection_reason && (
                            <p className="text-[11px] mt-1 max-w-xs truncate" style={{ color: 'var(--text-tertiary)' }} title={c.rejection_reason}>
                              {t('sa.dash.reasonPrefix', { reason: c.rejection_reason })}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          {format(new Date(c.created_at), 'dd.MM.yyyy', { locale: de })}
                        </td>
                        <td className="px-4 py-3">
                          {c.referral_code_used ? (
                            <span className="font-mono text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>
                              {c.referral_code_used}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            hidden={!canOpenCompany} onClick={() => { void enterCompany(c as any); }}
                            className="p-1.5 rounded-lg transition-colors"
                            style={{ color: 'var(--text-tertiary)' }}
                            onMouseEnter={e => { (e.currentTarget.style.background = 'var(--bg-muted)'); (e.currentTarget.style.color = 'var(--accent)'); }}
                            onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--text-tertiary)'); }}
                          >
                            <ExternalLink size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Overview section ──────────────────────────────────────────────────── */}
      {activeSection === 'overview' && <>

      {/* ── KPI Grid ──────────────────────────────────────────────────────────── */}
      {kpis && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard label={t('sa.dash.kpi.companies')} value={kpis.totalCompanies} icon={Building2} color="var(--accent)" trend={kpis.newThisMonth} sub={t('sa.dash.kpi.newThisMonth', { count: kpis.newThisMonth })} />
          {/* Users and drivers are summed from the audited read model. The
              receipt total has no read model at all, so it is unknown rather
              than zero — a dash, never a number nobody read. */}
          <KpiCard label={t('sa.dash.kpi.users')} value={kpis.countsKnown ? kpis.totalUsers : '–'} icon={Users} color="#8b5cf6" />
          <KpiCard label={t('sa.dash.kpi.drivers')} value={kpis.countsKnown ? kpis.totalDrivers : '–'} icon={Car} color="#06b6d4" />
          <KpiCard label={t('sa.dash.kpi.receipts')} value={kpis.totalReceipts ?? '–'} icon={FileText} color="#64748b" />
        </div>
      )}

      {/* ── Subscription stats + Plan distribution ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Subscription breakdown */}
        {kpis && (
          <div className="lg:col-span-1 p-5 space-y-4" style={cardStyle}>
            <h3 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{t('sa.dash.statusDistribution')}</h3>
            <div className="space-y-2.5">
              {([
                // `alwaysShow` replaces a filter that matched on the German label.
                // Active stays visible at zero; the rest appear only when non-zero.
                { id: 'active',       labelKey: 'sa.status.active',            value: kpis.activeCompanies,    color: 'var(--success)',        Icon: CheckCircle, alwaysShow: true },
                { id: 'suspended',    labelKey: 'sa.status.suspended',         value: kpis.suspendedCompanies, color: 'var(--danger)',         Icon: PauseCircle },
                { id: 'inactive',     labelKey: 'sa.status.inactive',          value: kpis.inactiveCompanies,  color: 'var(--text-tertiary)',  Icon: XCircle },
                { id: 'archived',     labelKey: 'sa.status.archived',          value: kpis.archivedCompanies,  color: '#64748b',               Icon: XCircle },
                { id: 'deleted',      labelKey: 'sa.status.deleted',           value: kpis.deletedCompanies,   color: 'var(--danger)',         Icon: XCircle },
              ] as const).filter(row => row.value > 0 || 'alwaysShow' in row).map(row => (
                <div key={row.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <row.Icon size={13} style={{ color: row.color }} />
                    {t(row.labelKey)}
                  </div>
                  <span className="font-bold text-sm" style={{ color: row.value > 0 ? row.color : 'var(--text-tertiary)' }}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Plan distribution */}
        {kpis && (
          <div className="lg:col-span-2 p-5 space-y-4" style={cardStyle}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{t('sa.dash.planDistribution')}</h3>
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('sa.dash.companiesCount', { count: kpis.totalCompanies })}</span>
            </div>
            <PlanDistributionBar kpis={kpis} total={kpis.totalCompanies} />
            <div className="grid grid-cols-3 gap-3 pt-1">
              {[
                { plan: 'basic' as Plan,    count: kpis.basicCount    },
                { plan: 'advanced' as Plan, count: kpis.advancedCount },
                { plan: 'premium' as Plan,  count: kpis.premiumCount  },
              ].map(({ plan, count }) => (
                <div key={plan} className="p-3 rounded-xl text-center" style={{ background: PLAN_BG[plan], border: `1px solid ${PLAN_COLOR[plan]}30` }}>
                  <p className="text-xl font-bold" style={{ color: PLAN_COLOR[plan] }}>{count}</p>
                  <p className="text-xs font-semibold mt-0.5" style={{ color: PLAN_COLOR[plan] }}>{PLAN_LABEL[plan]}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Needs attention ───────────────────────────────────────────────────── */}
      {attentionItems.length > 0 && (
        <div className="p-5 space-y-3" style={cardStyle}>
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {t('sa.dash.attentionTitle', { count: attentionItems.length })}
            </h3>
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {attentionItems.map(item => {
              const severityColor = item.severity === 'critical' ? 'var(--danger)' : item.severity === 'warning' ? 'var(--warning)' : 'var(--accent)';
              const severityBg = item.severity === 'critical' ? 'var(--danger-subtle)' : item.severity === 'warning' ? 'var(--warning-subtle)' : 'var(--accent-subtle)';
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl"
                  style={{ background: severityBg, border: `1px solid ${severityColor}30` }}
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <AlertCircle size={14} style={{ color: severityColor, flexShrink: 0, marginTop: 1 }} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{item.companyName}</p>
                      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{item.reason}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      hidden={!canOpenCompany} onClick={() => { void enterCompany(item.company as any); }}
                      className="p-1.5 rounded-lg transition-colors"
                      style={{ color: severityColor }}
                      title={t('sa.dash.openCompany')}
                      onMouseEnter={e => (e.currentTarget.style.background = severityBg)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <ExternalLink size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Companies table ───────────────────────────────────────────────────── */}
      <div style={cardStyle} className="overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <Activity size={16} style={{ color: 'var(--accent)' }} />
            <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
              {t('sa.dash.allCompaniesCount', { count: companies.length })}
            </h3>
          </div>
          <Link
            to={`${ADMIN_BASE}/companies`}
            className="flex items-center gap-1.5 text-xs font-semibold transition-colors"
            style={{ color: 'var(--accent)' }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.7')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            {t('sa.dash.manageAll')} <ChevronRight size={13} />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
                {([
                  'sa.dash.col.company', 'sa.dash.col.tariff', 'sa.dash.col.billing',
                  'sa.dash.col.cars', 'sa.dash.col.drivers', 'sa.dash.col.price',
                  'common.status', 'sa.dash.col.created', null,
                ] as const).map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>{h ? t(h) : ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentCompanies.map(c => (
                <tr
                  key={c.id}
                  style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                        style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>
                        {c.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{c.name}</p>
                        <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{c.slug}</p>
                      </div>
                    </div>
                  </td>
                  {/* Tarif */}
                  <td className="px-4 py-3">
                    <select
                      value={c.plan ?? 'basic'}
                      disabled={!canBilling}
                      onChange={e => handlePlanChange(c, e.target.value as Plan)}
                      className="text-xs rounded-lg px-2 py-1 font-semibold border-0 outline-none cursor-pointer"
                      style={{ background: PLAN_BG[c.plan ?? 'basic'], color: PLAN_COLOR[c.plan ?? 'basic'] }}
                      title={t('sa.dash.changeTariff')}
                    >
                      {/* Product tier names — untranslated in both languages. */}
                      <option value="basic">Basic</option>
                      <option value="advanced">Advanced</option>
                      <option value="premium">Premium</option>
                    </select>
                  </td>

                  {/* Abrechnung */}
                  <td className="px-4 py-3">
                    <select
                      value={c.billing_cycle}
                      disabled={!canBilling}
                      onChange={e => handleBillingCycleChange(c, e.target.value as 'monthly' | 'yearly')}
                      className="text-xs rounded-lg px-2 py-1 border-0 outline-none cursor-pointer"
                      style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                      title={t('sa.dash.changeBilling')}
                    >
                      <option value="monthly">{t('sa.dash.cycle.monthly')}</option>
                      <option value="yearly">{t('sa.dash.cycle.yearly')}</option>
                    </select>
                  </td>

                  {/* Fahrzeuge limit + aktive */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={1}
                        max={200}
                        defaultValue={c.subscription_car_limit}
                        disabled={!canBilling}
                        onBlur={e => {
                          const v = parseInt(e.target.value);
                          if (!isNaN(v) && v !== c.subscription_car_limit) handleCarLimitChange(c, v);
                        }}
                        className="w-14 text-xs rounded-lg px-2 py-1 border-0 outline-none text-center font-semibold"
                        style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
                        title={t('sa.dash.carLimit')}
                      />
                      <span className="text-[10px] whitespace-nowrap" style={{ color: c.counts_known && c.active_car_count >= c.subscription_car_limit ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                        {c.counts_known ? c.active_car_count : '–'}/{c.subscription_car_limit}
                      </span>
                    </div>
                  </td>

                  {/* Fahrer aktiv / limit */}
                  <td className="px-4 py-3">
                    {(() => {
                      // Both halves of the fraction, and the red colour, now come
                      // from figures that were read. An unknown allowance is a
                      // dash, never a plausible number.
                      const allowance = driversAllowance(c.subscription_car_limit, c.drivers_per_car_limit);
                      const atLimit = c.counts_known && allowance !== null && c.driver_count >= allowance;
                      return (
                        <span className="text-xs" style={{ color: atLimit ? 'var(--danger)' : 'var(--text-secondary)' }}>
                          {c.counts_known ? c.driver_count : '–'}/{allowance ?? '–'}
                        </span>
                      );
                    })()}
                  </td>

                  {/* Calculated price */}
                  <td className="px-4 py-3">
                    {(() => {
                      const bp = calcPricing(priceBook, c.plan ?? 'basic', c.subscription_car_limit, c.billing_cycle);
                      return (
                        <div>
                          <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {fmtPrice(bp.monthlyEquivalent)} €<span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>{t('sa.dash.perMonthShort')}</span>
                          </p>
                          {c.billing_cycle === 'yearly' && (
                            <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
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
                      <select
                        value={c.status}
                        disabled={!canLifecycle}
                        onChange={e => setStatusConfirm({ company: c, status: e.target.value as CompanyStatus })}
                        className="text-xs rounded-lg px-2 py-1 font-semibold border-0 outline-none cursor-pointer"
                        style={{
                          background: STATUS_CFG[c.status]?.bg ?? 'var(--bg-muted)',
                          color: STATUS_CFG[c.status]?.color ?? 'var(--text-secondary)',
                        }}
                        title={t('sa.dash.changeStatus')}
                      >
                        {/* `value` is the stored companies.status — only the label is translated. */}
                        <option value="active">{t('sa.status.active')}</option>
                        <option value="suspended">{t('sa.status.suspended')}</option>
                        <option value="inactive">{t('sa.status.inactive')}</option>
                      </select>
                    )}
                  </td>

                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {format(new Date(c.created_at), 'dd.MM.yy', { locale: de })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        hidden={!canBilling}
                        onClick={() => setManualSubModal(c)}
                        className="p-1.5 rounded-lg transition-colors"
                        style={{ color: 'var(--text-tertiary)' }}
                        title={t('sa.dash.editSubscriptionManually')}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-subtle)'; e.currentTarget.style.color = 'var(--accent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}
                      >
                        <PencilLine size={13} />
                      </button>
                      <button
                        hidden={!canOpenCompany} onClick={() => { void enterCompany(c as any); }}
                        className="p-1.5 rounded-lg transition-colors"
                        style={{ color: 'var(--accent)' }}
                        title={t('sa.dash.openAsCompany')}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <ExternalLink size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {companies.length > 8 && (
          <div className="px-5 py-3 border-t text-center" style={{ borderColor: 'var(--border)' }}>
            <Link to={`${ADMIN_BASE}/companies`} className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>
              {t('sa.dash.showAllCompanies', { count: companies.length })}
            </Link>
          </div>
        )}
      </div>

      {/* ── Recent signups (activity) ─────────────────────────────────────────── */}
      <div className="p-5 space-y-3" style={cardStyle}>
        <div className="flex items-center gap-2">
          <TrendingUp size={16} style={{ color: 'var(--success)' }} />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('sa.dash.recentSignups')}</h3>
        </div>
        {companies.slice(0, 5).map(c => (
          <div key={c.id} className="flex items-center justify-between gap-3 py-1.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold flex-shrink-0"
                style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>
                {c.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{c.name}</p>
                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  <StatusBadge status={c.status} />
                  <PlanBadge plan={c.plan ?? 'basic'} />
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {format(new Date(c.created_at), 'dd. MMM', { locale: de })}
              </span>
              <button
                hidden={!canOpenCompany} onClick={() => { void enterCompany(c as any); }}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--text-tertiary)' }}
                onMouseEnter={e => { (e.currentTarget.style.background = 'var(--bg-muted)'); (e.currentTarget.style.color = 'var(--accent)'); }}
                onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--text-tertiary)'); }}
              >
                <ExternalLink size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Quick actions ─────────────────────────────────────────────────────── */}
      <div className="p-5 space-y-3" style={cardStyle}>
        <div className="flex items-center gap-2">
          <BarChart3 size={16} style={{ color: 'var(--accent)' }} />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('sa.dash.quickAccess')}</h3>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/*
            Every target is inside the panel. Two of these were the tenant
            paths '/users' and '/settings', which a company-less platform
            account cannot reach at all — it never sees the tenant router — so
            both landed on the public catch-all. The panel's own equivalents
            are the user directory and the platform settings; a role without
            the capability for one is refused there, as it is from the sidebar.
          */}
          {[
            { id: 'manageCompanies', label: t('sa.dash.quick.manageCompanies'), icon: Building2, color: 'var(--warning)', to: `${ADMIN_BASE}/companies` },
            { id: 'newCompany', label: t('sa.dash.quick.newCompany'), icon: Plus, color: 'var(--success)', to: `${ADMIN_BASE}/companies` },
            { id: 'manageUsers', label: t('sa.dash.quick.manageUsers'), icon: Users, color: 'var(--accent)', to: `${ADMIN_BASE}/verzeichnisse` },
            { id: 'settings', label: t('common.settings'), icon: Shield, color: 'var(--text-secondary)', to: `${ADMIN_BASE}/einstellungen` },
          ].map(action => (
            <Link
              key={action.id}
              to={action.to}
              className="flex flex-col items-center gap-2 p-4 rounded-xl text-center text-xs font-medium transition-all hover:-translate-y-0.5 hover:shadow-md"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
              onMouseEnter={e => { (e.currentTarget.style.borderColor = action.color); (e.currentTarget.style.color = action.color); }}
              onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-secondary)'); }}
            >
              <action.icon size={20} />
              {action.label}
            </Link>
          ))}
          <button
            onClick={() => setActiveSection('discounts')}
            className={`${canCodes ? 'flex' : 'hidden'} flex-col items-center gap-2 p-4 rounded-xl text-center text-xs font-medium transition-all hover:-translate-y-0.5 hover:shadow-md`}
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { (e.currentTarget.style.borderColor = '#06b6d4'); (e.currentTarget.style.color = '#06b6d4'); }}
            onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-secondary)'); }}
          >
            <Tag size={20} />
            {t('sa.dash.tab.discounts')}
          </button>
          <button
            onClick={() => setActiveSection('approvals')}
            className="relative flex flex-col items-center gap-2 p-4 rounded-xl text-center text-xs font-medium transition-all hover:-translate-y-0.5 hover:shadow-md"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { (e.currentTarget.style.borderColor = 'var(--warning)'); (e.currentTarget.style.color = 'var(--warning)'); }}
            onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-secondary)'); }}
          >
            {pendingCompanies.length > 0 && (
              <span className="absolute top-2 right-2 min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: 'var(--warning-solid)' }}>
                {pendingCompanies.length}
              </span>
            )}
            <ClipboardCheck size={20} />
            {t('sa.dash.tab.approvals')}
          </button>
          <button
            onClick={() => setActiveSection('referrals')}
            className={`${canCodes ? 'flex' : 'hidden'} flex-col items-center gap-2 p-4 rounded-xl text-center text-xs font-medium transition-all hover:-translate-y-0.5 hover:shadow-md`}
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { (e.currentTarget.style.borderColor = '#10b981'); (e.currentTarget.style.color = '#10b981'); }}
            onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-secondary)'); }}
          >
            <Gift size={20} />
            {t('sa.dash.tab.referrals')}
          </button>
          <button
            onClick={() => setActiveSection('activation')}
            className={`${canCodes ? 'flex' : 'hidden'} flex-col items-center gap-2 p-4 rounded-xl text-center text-xs font-medium transition-all hover:-translate-y-0.5 hover:shadow-md`}
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { (e.currentTarget.style.borderColor = 'var(--accent)'); (e.currentTarget.style.color = 'var(--accent)'); }}
            onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-secondary)'); }}
          >
            <KeyRound size={20} />
            {t('sa.dash.tab.activation')}
          </button>
        </div>
      </div>

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
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <div className="w-full max-w-md rounded-2xl p-6 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <h3 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
            {t('sa.dash.rejectModal.title')}
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {/* Split so the company name keeps its bold emphasis; the two halves
                sit either side of the name in both languages. */}
            {t('sa.dash.rejectModal.questionPrefix')}
            <strong style={{ color: 'var(--text-primary)' }}>{rejectModal.company.name}</strong>
            {t('sa.dash.rejectModal.questionSuffix')}
          </p>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('sa.dash.rejectModal.reasonLabel')}
            </label>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={3}
              placeholder={t('sa.dash.rejectModal.reasonPlaceholder')}
              className="w-full px-3 py-2.5 rounded-xl text-sm resize-none focus:outline-none"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => { setRejectModal(null); setRejectReason(''); }}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleReject}
              disabled={approvingId === rejectModal.company.id}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-opacity hover:opacity-85 disabled:opacity-50"
              style={{ background: 'var(--danger-solid)', color: 'white' }}
            >
              {approvingId === rejectModal.company.id ? t('sa.dash.rejecting') : t('sa.dash.reject')}
            </button>
          </div>
        </div>
      </div>
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
