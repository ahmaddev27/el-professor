import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import {
  Building2, Users, Car, FileText, TrendingUp, AlertTriangle,
  CheckCircle, Clock, XCircle, PauseCircle, Plus, ExternalLink,
  RefreshCw, Zap, BarChart3, AlertCircle, ChevronRight,
  ArrowUpRight, Shield, Activity, Tag, ClipboardCheck, Gift, KeyRound, PencilLine,
} from 'lucide-react';
import DiscountCodesManagement from '../components/DiscountCodesManagement';
import ReferralCodesManagement from '../components/ReferralCodesManagement';
import ActivationCodesManagement from '../components/ActivationCodesManagement';
import ManualSubscriptionModal from '../components/ManualSubscriptionModal';
import { format, differenceInDays, isAfter, isBefore, addDays, startOfMonth } from 'date-fns';
import { de } from 'date-fns/locale';
import { calcPricing, fmt as fmtPrice } from '../utils/pricing';

// ─── Types ────────────────────────────────────────────────────────────────────

type Plan = 'basic' | 'advanced' | 'premium';
type CompanyStatus = 'active' | 'trial' | 'suspended' | 'inactive' | 'archived' | 'deleted';

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
  trial_start: string | null;
  trial_end: string | null;
  created_at: string;
  updated_at: string;
  email: string | null;
  city: string | null;
  referral_code_used: string | null;
  user_count: number;
  driver_count: number;
  active_car_count: number;
  drivers_per_car_limit: number;
  subscription_status: string | null;
  subscription_expires_at: string | null;
  subscription_started_at: string | null;
  subscription_duration_type: string | null;
}

interface PlatformKPIs {
  totalCompanies: number;
  totalUsers: number;
  totalDrivers: number;
  totalReceipts: number;
  trialCompanies: number;
  activeCompanies: number;
  suspendedCompanies: number;
  inactiveCompanies: number;
  archivedCompanies: number;
  deletedCompanies: number;
  expiredTrials: number;
  expiringIn7Days: number;
  newThisMonth: number;
  basicCount: number;
  advancedCount: number;
  premiumCount: number;
}

// ─── Countdown hook ───────────────────────────────────────────────────────────

function useCountdown(endIso: string | null): string {
  const [display, setDisplay] = useState('');
  const rafRef = useRef<number>();

  useEffect(() => {
    if (!endIso) { setDisplay(''); return; }
    const end = new Date(endIso).getTime();

    const tick = () => {
      const diff = end - Date.now();
      if (diff <= 0) { setDisplay('Abgelaufen'); return; }
      const d = Math.floor(diff / 86_400_000);
      const h = Math.floor((diff % 86_400_000) / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);
      setDisplay(
        d > 0
          ? `${d}T ${String(h).padStart(2,'0')}Std ${String(m).padStart(2,'0')}Min ${String(s).padStart(2,'0')}Sek`
          : `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      );
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [endIso]);

  return display;
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
const PLAN_LABEL: Record<Plan, string> = { basic: 'Basic', advanced: 'Advanced', premium: 'Premium' };

const STATUS_CFG: Record<CompanyStatus, { label: string; color: string; bg: string; Icon: React.ElementType }> = {
  active:    { label: 'Aktiv',      color: 'var(--success)',        bg: 'var(--success-subtle)',  Icon: CheckCircle },
  trial:     { label: 'Testphase',  color: 'var(--warning)',        bg: 'var(--warning-subtle)',  Icon: Clock },
  suspended: { label: 'Gesperrt',   color: 'var(--danger)',         bg: 'var(--danger-subtle)',   Icon: PauseCircle },
  inactive:  { label: 'Inaktiv',    color: 'var(--text-tertiary)',  bg: 'var(--bg-muted)',        Icon: XCircle },
  archived:  { label: 'Archiviert', color: '#64748b',               bg: 'rgba(100,116,139,0.12)', Icon: XCircle },
  deleted:   { label: 'Gelöscht',   color: 'var(--danger)',         bg: 'var(--danger-subtle)',   Icon: XCircle },
};

function StatusBadge({ status }: { status: CompanyStatus }) {
  const cfg = STATUS_CFG[status] || STATUS_CFG.inactive;
  const Icon = cfg.Icon;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: cfg.bg, color: cfg.color }}>
      <Icon size={10} />{cfg.label}
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

// ─── Live Countdown Cell ──────────────────────────────────────────────────────

function CountdownCell({ trialEnd }: { trialEnd: string | null }) {
  const display = useCountdown(trialEnd);
  if (!trialEnd || !display) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
  const end = new Date(trialEnd);
  const daysLeft = differenceInDays(end, new Date());
  const color = daysLeft <= 1 ? 'var(--danger)' : daysLeft <= 3 ? 'var(--warning)' : 'var(--text-secondary)';
  return (
    <span className="font-mono text-xs tabular-nums" style={{ color }}>{display}</span>
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
  const segments = [
    { label: 'Basic',    count: kpis.basicCount,    color: PLAN_COLOR.basic },
    { label: 'Advanced', count: kpis.advancedCount,  color: PLAN_COLOR.advanced },
    { label: 'Premium',  count: kpis.premiumCount,   color: PLAN_COLOR.premium },
    { label: 'Trial',    count: kpis.trialCompanies, color: 'var(--text-tertiary)' },
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
  const { enterCompany } = useSuperAdmin();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [kpis, setKpis] = useState<PlatformKPIs | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [extendingId, setExtendingId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'overview' | 'approvals' | 'discounts' | 'referrals' | 'activation'>('overview');
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<{ company: CompanyRow } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [manualSubModal, setManualSubModal] = useState<CompanyRow | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    try {
      // 1. Companies with plan + trial + subscription data
      const { data: companiesRaw, error: cErr } = await supabase
        .from('companies')
        .select('id, name, slug, status, approval_status, rejection_reason, plan, billing_cycle, subscription_car_limit, trial_start, trial_end, created_at, updated_at, email, city, referral_code_used, subscription_status, subscription_expires_at, subscription_started_at, subscription_duration_type')
        .order('created_at', { ascending: false });

      if (cErr) throw cErr;
      const raw = companiesRaw ?? [];

      // 2. User counts per company
      const { data: userCounts } = await supabase
        .from('user_profiles')
        .select('company_id')
        .not('company_id', 'is', null)
        .eq('is_super_admin', false);

      // 3. Driver counts per company (active only)
      const { data: driverCounts } = await supabase
        .from('drivers')
        .select('company_id')
        .not('company_id', 'is', null)
        .neq('status', 'inactive');

      // 3b. Active car counts per company
      const { data: carCounts } = await supabase
        .from('cars')
        .select('company_id')
        .not('company_id', 'is', null)
        .neq('status', 'inactive');

      // 4. drivers_per_car_limit from company_settings
      const { data: settingsData } = await supabase
        .from('company_settings')
        .select('company_id, drivers_per_car_limit');

      // 5. Total receipts (platform-wide)
      const { count: receiptCount } = await supabase
        .from('receipts')
        .select('id', { count: 'exact', head: true });

      // Build maps
      const ucMap: Record<string, number> = {};
      (userCounts ?? []).forEach(u => { if (u.company_id) ucMap[u.company_id] = (ucMap[u.company_id] || 0) + 1; });

      const dcMap: Record<string, number> = {};
      (driverCounts ?? []).forEach(d => { if (d.company_id) dcMap[d.company_id] = (dcMap[d.company_id] || 0) + 1; });

      const ccMap: Record<string, number> = {};
      (carCounts ?? []).forEach(c => { if (c.company_id) ccMap[c.company_id] = (ccMap[c.company_id] || 0) + 1; });

      const dpcMap: Record<string, number> = {};
      (settingsData ?? []).forEach((s: { company_id: string; drivers_per_car_limit: number }) => { if (s.company_id) dpcMap[s.company_id] = s.drivers_per_car_limit; });

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
        drivers_per_car_limit: dpcMap[c.id] ?? 4,
      }));

      setCompanies(enriched);

      // Compute KPIs
      const now = new Date();
      const monthStart = startOfMonth(now);
      const soon = addDays(now, 7);

      const totalUsers = Object.values(ucMap).reduce((a, b) => a + b, 0);
      const totalDrivers = Object.values(dcMap).reduce((a, b) => a + b, 0);

      const kpiData: PlatformKPIs = {
        totalCompanies: enriched.filter(c => c.status !== 'archived' && c.status !== 'deleted').length,
        totalUsers,
        totalDrivers,
        totalReceipts: receiptCount ?? 0,
        trialCompanies: enriched.filter(c => c.status === 'trial' && c.trial_end && isAfter(new Date(c.trial_end), now)).length,
        activeCompanies: enriched.filter(c => c.status === 'active').length,
        suspendedCompanies: enriched.filter(c => c.status === 'suspended').length,
        inactiveCompanies: enriched.filter(c => c.status === 'inactive').length,
        archivedCompanies: enriched.filter(c => c.status === 'archived').length,
        deletedCompanies: enriched.filter(c => c.status === 'deleted').length,
        expiredTrials: enriched.filter(c => c.status === 'trial' && c.trial_end && isBefore(new Date(c.trial_end), now)).length,
        expiringIn7Days: enriched.filter(c => c.status === 'trial' && c.trial_end && isAfter(new Date(c.trial_end), now) && isBefore(new Date(c.trial_end), soon)).length,
        newThisMonth: enriched.filter(c => isAfter(new Date(c.created_at), monthStart)).length,
        basicCount: enriched.filter(c => (c.plan ?? 'basic') === 'basic').length,
        advancedCount: enriched.filter(c => c.plan === 'advanced').length,
        premiumCount: enriched.filter(c => c.plan === 'premium').length,
      };
      setKpis(kpiData);
    } catch (err: any) {
      showToast('error', 'Fehler beim Laden der Plattform-Daten');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 60s for countdowns
  useEffect(() => {
    const id = setInterval(() => load(true), 60_000);
    return () => clearInterval(id);
  }, [load]);

  const handleExtendTrial = async (company: CompanyRow) => {
    if (!company.trial_end) return;
    setExtendingId(company.id);
    try {
      const newEnd = new Date(company.trial_end);
      newEnd.setDate(newEnd.getDate() + 7);
      const { error } = await supabase
        .from('companies')
        .update({ trial_end: newEnd.toISOString(), updated_at: new Date().toISOString() })
        .eq('id', company.id);
      if (error) throw error;
      showToast('success', `Testphase von ${company.name} um 7 Tage verlängert`);
      load(true);
    } catch (err: any) {
      showToast('error', err.message || 'Fehler beim Verlängern');
    } finally {
      setExtendingId(null);
    }
  };

  const handleStatusChange = async (company: CompanyRow, status: CompanyStatus) => {
    try {
      const { error } = await supabase
        .from('companies')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', company.id);
      if (error) throw error;
      showToast('success', `${company.name} → ${STATUS_CFG[status]?.label ?? status}`);
      load(true);
    } catch (err: any) {
      showToast('error', err.message || 'Fehler');
    }
  };

  const handlePlanChange = async (company: CompanyRow, plan: Plan) => {
    try {
      const { error } = await supabase
        .from('companies')
        .update({ plan, updated_at: new Date().toISOString() })
        .eq('id', company.id);
      if (error) throw error;
      showToast('success', `${company.name} → ${PLAN_LABEL[plan]}-Plan`);
      load(true);
    } catch (err: any) {
      showToast('error', err.message || 'Fehler');
    }
  };

  const handleBillingCycleChange = async (company: CompanyRow, billing_cycle: 'monthly' | 'yearly') => {
    try {
      const { error } = await supabase
        .from('companies')
        .update({ billing_cycle, updated_at: new Date().toISOString() })
        .eq('id', company.id);
      if (error) throw error;
      showToast('success', `${company.name} → ${billing_cycle === 'yearly' ? 'Jährlich' : 'Monatlich'}`);
      load(true);
    } catch (err: any) {
      showToast('error', err.message || 'Fehler');
    }
  };

  const handleCarLimitChange = async (company: CompanyRow, limit: number) => {
    if (limit < 1 || limit > 200) return;
    try {
      const { error } = await supabase
        .from('companies')
        .update({ subscription_car_limit: limit, updated_at: new Date().toISOString() })
        .eq('id', company.id);
      if (error) throw error;
      showToast('success', `${company.name} → ${limit} Fahrzeuge`);
      load(true);
    } catch (err: any) {
      showToast('error', err.message || 'Fehler');
    }
  };

  const handleApprove = async (company: CompanyRow) => {
    setApprovingId(company.id);
    try {
      const { data: { user: me } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('companies')
        .update({
          approval_status: 'approved',
          approved_at: new Date().toISOString(),
          approved_by: me?.id ?? null,
          rejection_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', company.id);
      if (error) throw error;
      showToast('success', `${company.name} freigeschaltet`);
      load(true);
    } catch (err: any) {
      showToast('error', err.message || 'Fehler');
    } finally {
      setApprovingId(null);
    }
  };

  const handleReject = async () => {
    if (!rejectModal) return;
    const company = rejectModal.company;
    setApprovingId(company.id);
    try {
      const { data: { user: me } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('companies')
        .update({
          approval_status: 'rejected',
          rejected_at: new Date().toISOString(),
          rejected_by: me?.id ?? null,
          rejection_reason: rejectReason.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', company.id);
      if (error) throw error;
      showToast('success', `${company.name} abgelehnt`);
      setRejectModal(null);
      setRejectReason('');
      load(true);
    } catch (err: any) {
      showToast('error', err.message || 'Fehler');
    } finally {
      setApprovingId(null);
    }
  };

  const handleSuspendApproval = async (company: CompanyRow) => {
    try {
      const { error } = await supabase
        .from('companies')
        .update({ approval_status: 'suspended', updated_at: new Date().toISOString() })
        .eq('id', company.id);
      if (error) throw error;
      showToast('success', `${company.name} gesperrt`);
      load(true);
    } catch (err: any) {
      showToast('error', err.message || 'Fehler');
    }
  };

  // Compute attention items
  const attentionItems: AttentionItem[] = [];
  const pendingCompanies = companies.filter(c => c.approval_status === 'pending');
  if (companies.length > 0) {
    // Pending approvals are first in attention
    for (const c of pendingCompanies) {
      attentionItems.push({ id: `${c.id}-pending`, companyName: c.name, reason: 'Wartet auf Freischaltung', severity: 'warning', company: c });
    }
    const now = new Date();
    for (const c of companies) {
      // Skip archived/deleted companies from attention items
      if (c.status === 'archived' || c.status === 'deleted') continue;
      const trialEnd = c.trial_end ? new Date(c.trial_end) : null;
      const daysLeft = trialEnd ? differenceInDays(trialEnd, now) : null;

      if (c.status === 'trial' && trialEnd && isBefore(trialEnd, now)) {
        attentionItems.push({ id: `${c.id}-expired`, companyName: c.name, reason: 'Testphase abgelaufen — kein aktiver Plan', severity: 'critical', company: c });
      } else if (c.status === 'trial' && daysLeft !== null && daysLeft <= 2) {
        attentionItems.push({ id: `${c.id}-critical`, companyName: c.name, reason: `Testphase endet in ${daysLeft <= 0 ? 'weniger als 1 Tag' : `${daysLeft} Tag${daysLeft === 1 ? '' : 'en'}`}`, severity: 'critical', company: c });
      } else if (c.status === 'trial' && daysLeft !== null && daysLeft <= 5) {
        attentionItems.push({ id: `${c.id}-warning`, companyName: c.name, reason: `Testphase endet in ${daysLeft} Tagen`, severity: 'warning', company: c });
      }
      if (c.user_count === 0) {
        attentionItems.push({ id: `${c.id}-nousers`, companyName: c.name, reason: 'Keine Benutzer angelegt', severity: 'info', company: c });
      }
      if (c.driver_count === 0 && c.status !== 'inactive') {
        attentionItems.push({ id: `${c.id}-nodrivers`, companyName: c.name, reason: 'Keine Fahrer angelegt', severity: 'info', company: c });
      }
      if (c.status === 'suspended') {
        attentionItems.push({ id: `${c.id}-suspended`, companyName: c.name, reason: 'Unternehmen ist gesperrt', severity: 'warning', company: c });
      }
    }
    // Sort: critical first
    attentionItems.sort((a, b) => {
      const rank = { critical: 0, warning: 1, info: 2 };
      return rank[a.severity] - rank[b.severity];
    });
  }

  const expiringSoon = companies.filter(c => {
    if (c.status !== 'trial' || !c.trial_end) return false;
    const end = new Date(c.trial_end);
    return isAfter(end, new Date()) && isBefore(end, addDays(new Date(), 7));
  });

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
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Plattform-Übersicht</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            Echtzeit-Überblick über alle Unternehmen, Pläne und Trials
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-colors"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Aktualisieren
          </button>
          <Link
            to="/super-admin/companies"
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-opacity hover:opacity-85"
            style={{ background: 'var(--warning)', color: 'white' }}
          >
            <Building2 size={14} />
            Alle Unternehmen
          </Link>
        </div>
      </div>

      {/* ── Section tabs ───────────────────────────────────────────────────────── */}
      <div className="flex gap-1 p-1 rounded-xl flex-wrap" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', width: 'fit-content' }}>
        {([
          { id: 'overview',    label: 'Übersicht',   icon: BarChart3 },
          { id: 'approvals',   label: 'Freischaltung', icon: ClipboardCheck, badge: pendingCompanies.length },
          { id: 'discounts',   label: 'Rabattcodes',  icon: Tag },
          { id: 'referrals',   label: 'Empfehlungen', icon: Gift },
          { id: 'activation',  label: 'Aktivierung',  icon: KeyRound },
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveSection(tab.id)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all relative"
            style={activeSection === tab.id
              ? { background: 'var(--accent)', color: '#fff' }
              : { color: 'var(--text-secondary)' }
            }
          >
            <tab.icon size={14} />
            {tab.label}
            {tab.badge !== undefined && tab.badge > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: 'var(--warning)' }}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Discount Codes section ─────────────────────────────────────────────── */}
      {activeSection === 'discounts' && <DiscountCodesManagement />}

      {/* ── Referral Codes section ─────────────────────────────────────────────── */}
      {activeSection === 'referrals' && <ReferralCodesManagement companies={companies} />}

      {/* ── Activation Codes section ───────────────────────────────────────────── */}
      {activeSection === 'activation' && <ActivationCodesManagement companies={companies} />}

      {/* ── Approvals section ────────────────────────────────────────────────── */}
      {activeSection === 'approvals' && (
        <div className="space-y-4">
          <div style={cardStyle} className="overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2">
                <ClipboardCheck size={16} style={{ color: 'var(--warning)' }} />
                <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                  Ausstehende Freischaltungen
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
                <p className="text-sm">Keine ausstehenden Anfragen</p>
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
                          {c.subscription_car_limit} Fahrzeuge · {c.billing_cycle === 'yearly' ? 'Jährlich' : 'Monatlich'}
                        </span>
                        {c.referral_code_used && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold" style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>
                            <Gift size={9} /> {c.referral_code_used}
                          </span>
                        )}
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                          Registriert: {format(new Date(c.created_at), 'dd. MMM yyyy HH:mm', { locale: de })}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => handleApprove(c)}
                        disabled={approvingId === c.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity hover:opacity-85 disabled:opacity-50"
                        style={{ background: 'var(--success)', color: 'white' }}
                      >
                        {approvingId === c.id ? <RefreshCw size={11} className="animate-spin" /> : <CheckCircle size={11} />}
                        Freischalten
                      </button>
                      <button
                        onClick={() => { setRejectModal({ company: c }); setRejectReason(''); }}
                        disabled={approvingId === c.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity hover:opacity-85 disabled:opacity-50"
                        style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid var(--danger)30' }}
                      >
                        <XCircle size={11} />
                        Ablehnen
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
              <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Alle Freischaltungs-Status</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                    {['Unternehmen', 'Freischaltung', 'Registriert', 'Empfehlungscode', ''].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {companies.filter(c => c.status !== 'deleted').map(c => {
                    const ap = c.approval_status;
                    const apColor = ap === 'approved' ? 'var(--success)' : ap === 'pending' ? 'var(--warning)' : 'var(--danger)';
                    const apBg = ap === 'approved' ? 'var(--success-subtle)' : ap === 'pending' ? 'var(--warning-subtle)' : 'var(--danger-subtle)';
                    const apLabel = ap === 'approved' ? 'Freigeschaltet' : ap === 'pending' ? 'Ausstehend' : ap === 'rejected' ? 'Abgelehnt' : 'Gesperrt';
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
                            {ap === 'approved' && (
                              <button
                                onClick={() => handleSuspendApproval(c)}
                                className="text-[11px] px-2 py-0.5 rounded border transition-colors"
                                style={{ borderColor: 'var(--border)', color: 'var(--text-tertiary)' }}
                                onMouseEnter={e => { (e.currentTarget.style.borderColor = 'var(--danger)'); (e.currentTarget.style.color = 'var(--danger)'); }}
                                onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-tertiary)'); }}
                              >
                                Sperren
                              </button>
                            )}
                            {(ap === 'rejected' || ap === 'suspended') && (
                              <button
                                onClick={() => handleApprove(c)}
                                disabled={approvingId === c.id}
                                className="text-[11px] px-2 py-0.5 rounded border transition-colors"
                                style={{ borderColor: 'var(--success)', color: 'var(--success)' }}
                              >
                                Freischalten
                              </button>
                            )}
                            {ap === 'pending' && (
                              <button
                                onClick={() => handleApprove(c)}
                                disabled={approvingId === c.id}
                                className="text-[11px] px-2 py-0.5 rounded border transition-colors"
                                style={{ borderColor: 'var(--success)', color: 'var(--success)' }}
                              >
                                {approvingId === c.id ? '…' : 'Freischalten'}
                              </button>
                            )}
                          </div>
                          {c.rejection_reason && (
                            <p className="text-[11px] mt-1 max-w-xs truncate" style={{ color: 'var(--text-tertiary)' }} title={c.rejection_reason}>
                              Grund: {c.rejection_reason}
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
                            onClick={() => { enterCompany(c as any); navigate('/overview'); }}
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiCard label="Unternehmen gesamt" value={kpis.totalCompanies} icon={Building2} color="var(--accent)" trend={kpis.newThisMonth} sub={`+${kpis.newThisMonth} diesen Monat`} />
          <KpiCard label="Benutzer gesamt" value={kpis.totalUsers} icon={Users} color="#8b5cf6" />
          <KpiCard label="Fahrer gesamt" value={kpis.totalDrivers} icon={Car} color="#06b6d4" />
          <KpiCard label="Belege gesamt" value={kpis.totalReceipts} icon={FileText} color="#64748b" />
          <KpiCard label="In Testphase" value={kpis.trialCompanies} icon={Clock} color="var(--warning)" sub={kpis.expiringIn7Days > 0 ? `${kpis.expiringIn7Days} enden bald` : undefined} />
        </div>
      )}

      {/* ── Subscription stats + Plan distribution ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Subscription breakdown */}
        {kpis && (
          <div className="lg:col-span-1 p-5 space-y-4" style={cardStyle}>
            <h3 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Status-Verteilung</h3>
            <div className="space-y-2.5">
              {[
                { label: 'Aktiv',              value: kpis.activeCompanies,    color: 'var(--success)',        Icon: CheckCircle },
                { label: 'Testphase',          value: kpis.trialCompanies,     color: 'var(--warning)',        Icon: Clock },
                { label: 'Trial abgelaufen',   value: kpis.expiredTrials,      color: 'var(--danger)',         Icon: AlertTriangle },
                { label: 'Gesperrt',           value: kpis.suspendedCompanies, color: 'var(--danger)',         Icon: PauseCircle },
                { label: 'Inaktiv',            value: kpis.inactiveCompanies,  color: 'var(--text-tertiary)',  Icon: XCircle },
                { label: 'Archiviert',         value: kpis.archivedCompanies,  color: '#64748b',               Icon: XCircle },
                { label: 'Gelöscht',           value: kpis.deletedCompanies,   color: 'var(--danger)',         Icon: XCircle },
              ].filter(row => row.value > 0 || ['Aktiv', 'Testphase'].includes(row.label)).map(row => (
                <div key={row.label} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <row.Icon size={13} style={{ color: row.color }} />
                    {row.label}
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
              <h3 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Plan-Verteilung</h3>
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{kpis.totalCompanies} Unternehmen</span>
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
              Handlungsbedarf ({attentionItems.length})
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
                    {(item.company.status === 'trial') && item.company.trial_end && (
                      <button
                        onClick={() => handleExtendTrial(item.company)}
                        disabled={extendingId === item.company.id}
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-opacity hover:opacity-80"
                        style={{ background: 'var(--warning)', color: 'white' }}
                      >
                        +7 Tage
                      </button>
                    )}
                    <button
                      onClick={() => { enterCompany(item.company as any); navigate('/overview'); }}
                      className="p-1.5 rounded-lg transition-colors"
                      style={{ color: severityColor }}
                      title="Unternehmen öffnen"
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

      {/* ── Expiring soon (with live countdown) ──────────────────────────────── */}
      {expiringSoon.length > 0 && (
        <div className="p-5 space-y-3" style={cardStyle}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock size={16} style={{ color: 'var(--warning)' }} />
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Testphase endet bald
              </h3>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
              {expiringSoon.length} Unternehmen
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Unternehmen', 'Plan', 'Verbleibende Zeit', 'Trial-Ende', ''].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {expiringSoon.map(c => (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                          style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
                          {c.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{c.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5"><PlanBadge plan={c.plan ?? 'basic'} /></td>
                    <td className="px-3 py-2.5"><CountdownCell trialEnd={c.trial_end} /></td>
                    <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {c.trial_end ? format(new Date(c.trial_end), 'dd. MMM yyyy HH:mm', { locale: de }) : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5 justify-end">
                        <button
                          onClick={() => handleExtendTrial(c)}
                          disabled={extendingId === c.id}
                          className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-opacity hover:opacity-80 flex items-center gap-1"
                          style={{ background: 'var(--warning)', color: 'white' }}
                        >
                          {extendingId === c.id ? <RefreshCw size={11} className="animate-spin" /> : <Zap size={11} />}
                          +7 Tage
                        </button>
                        <button
                          onClick={() => handleStatusChange(c, 'active')}
                          className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-opacity hover:opacity-80"
                          style={{ background: 'var(--success)', color: 'white' }}
                        >
                          Aktivieren
                        </button>
                        <button
                          onClick={() => { enterCompany(c as any); navigate('/overview'); }}
                          className="p-1.5 rounded-lg transition-colors"
                          style={{ color: 'var(--text-tertiary)' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
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
        </div>
      )}

      {/* ── Companies table ───────────────────────────────────────────────────── */}
      <div style={cardStyle} className="overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <Activity size={16} style={{ color: 'var(--accent)' }} />
            <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
              Alle Unternehmen ({companies.length})
            </h3>
          </div>
          <Link
            to="/super-admin/companies"
            className="flex items-center gap-1.5 text-xs font-semibold transition-colors"
            style={{ color: 'var(--accent)' }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.7')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            Alle verwalten <ChevronRight size={13} />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
                {['Unternehmen', 'Tarif', 'Abrechnung', 'Fahrzeuge', 'Fahrer', 'Preis', 'Status', 'Trial', 'Erstellt', ''].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>{h}</th>
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
                      onChange={e => handlePlanChange(c, e.target.value as Plan)}
                      className="text-xs rounded-lg px-2 py-1 font-semibold border-0 outline-none cursor-pointer"
                      style={{ background: PLAN_BG[c.plan ?? 'basic'], color: PLAN_COLOR[c.plan ?? 'basic'] }}
                      title="Tarif ändern"
                    >
                      <option value="basic">Basic</option>
                      <option value="advanced">Advanced</option>
                      <option value="premium">Premium</option>
                    </select>
                  </td>

                  {/* Abrechnung */}
                  <td className="px-4 py-3">
                    <select
                      value={c.billing_cycle}
                      onChange={e => handleBillingCycleChange(c, e.target.value as 'monthly' | 'yearly')}
                      className="text-xs rounded-lg px-2 py-1 border-0 outline-none cursor-pointer"
                      style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                      title="Abrechnung ändern"
                    >
                      <option value="monthly">Monatlich</option>
                      <option value="yearly">Jährlich</option>
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
                        onBlur={e => {
                          const v = parseInt(e.target.value);
                          if (!isNaN(v) && v !== c.subscription_car_limit) handleCarLimitChange(c, v);
                        }}
                        className="w-14 text-xs rounded-lg px-2 py-1 border-0 outline-none text-center font-semibold"
                        style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
                        title="Fahrzeuglimit"
                      />
                      <span className="text-[10px] whitespace-nowrap" style={{ color: c.active_car_count >= c.subscription_car_limit ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                        {c.active_car_count}/{c.subscription_car_limit}
                      </span>
                    </div>
                  </td>

                  {/* Fahrer aktiv / limit */}
                  <td className="px-4 py-3">
                    <span className="text-xs" style={{ color: c.driver_count >= (c.subscription_car_limit * c.drivers_per_car_limit) ? 'var(--danger)' : 'var(--text-secondary)' }}>
                      {c.driver_count}/{c.subscription_car_limit * c.drivers_per_car_limit}
                    </span>
                  </td>

                  {/* Calculated price */}
                  <td className="px-4 py-3">
                    {(() => {
                      const bp = calcPricing(c.plan ?? 'basic', c.subscription_car_limit, c.billing_cycle);
                      return (
                        <div>
                          <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {fmtPrice(bp.monthlyEquivalent)} €<span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>/Mo</span>
                          </p>
                          {c.billing_cycle === 'yearly' && (
                            <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                              {fmtPrice(bp.finalTotal)} €/Jahr
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
                        onChange={e => handleStatusChange(c, e.target.value as CompanyStatus)}
                        className="text-xs rounded-lg px-2 py-1 font-semibold border-0 outline-none cursor-pointer"
                        style={{
                          background: STATUS_CFG[c.status]?.bg ?? 'var(--bg-muted)',
                          color: STATUS_CFG[c.status]?.color ?? 'var(--text-secondary)',
                        }}
                        title="Status ändern"
                      >
                        <option value="active">Aktiv</option>
                        <option value="trial">Testphase</option>
                        <option value="suspended">Gesperrt</option>
                        <option value="inactive">Inaktiv</option>
                      </select>
                    )}
                  </td>

                  {/* Trial countdown */}
                  <td className="px-4 py-3">
                    {c.status === 'trial' && c.trial_end ? (
                      <div>
                        <CountdownCell trialEnd={c.trial_end} />
                        <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                          {format(new Date(c.trial_end), 'dd.MM.yyyy', { locale: de })}
                        </p>
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                    )}
                  </td>

                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {format(new Date(c.created_at), 'dd.MM.yy', { locale: de })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      {c.status === 'trial' && c.trial_end && (
                        <button
                          onClick={() => handleExtendTrial(c)}
                          disabled={extendingId === c.id}
                          className="p-1.5 rounded-lg transition-colors"
                          style={{ color: 'var(--warning)' }}
                          title="Trial verlängern (+7 Tage)"
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--warning-subtle)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          {extendingId === c.id ? <RefreshCw size={13} className="animate-spin" /> : <Zap size={13} />}
                        </button>
                      )}
                      <button
                        onClick={() => setManualSubModal(c)}
                        className="p-1.5 rounded-lg transition-colors"
                        style={{ color: 'var(--text-tertiary)' }}
                        title="Abo manuell bearbeiten"
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-subtle)'; e.currentTarget.style.color = 'var(--accent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}
                      >
                        <PencilLine size={13} />
                      </button>
                      <button
                        onClick={() => { enterCompany(c as any); navigate('/overview'); }}
                        className="p-1.5 rounded-lg transition-colors"
                        style={{ color: 'var(--accent)' }}
                        title="Als Unternehmen öffnen"
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
            <Link to="/super-admin/companies" className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>
              Alle {companies.length} Unternehmen anzeigen →
            </Link>
          </div>
        )}
      </div>

      {/* ── Recent signups (activity) ─────────────────────────────────────────── */}
      <div className="p-5 space-y-3" style={cardStyle}>
        <div className="flex items-center gap-2">
          <TrendingUp size={16} style={{ color: 'var(--success)' }} />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Neueste Registrierungen</h3>
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
                onClick={() => { enterCompany(c as any); navigate('/overview'); }}
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
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Schnellzugriff</h3>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Unternehmen verwalten', icon: Building2, color: 'var(--warning)', to: '/super-admin/companies' },
            { label: 'Neues Unternehmen', icon: Plus, color: 'var(--success)', to: '/super-admin/companies' },
            { label: 'Benutzer verwalten', icon: Users, color: 'var(--accent)', to: '/users' },
            { label: 'Einstellungen', icon: Shield, color: 'var(--text-secondary)', to: '/settings' },
          ].map(action => (
            <Link
              key={action.label}
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
            className="flex flex-col items-center gap-2 p-4 rounded-xl text-center text-xs font-medium transition-all hover:-translate-y-0.5 hover:shadow-md"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { (e.currentTarget.style.borderColor = '#06b6d4'); (e.currentTarget.style.color = '#06b6d4'); }}
            onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-secondary)'); }}
          >
            <Tag size={20} />
            Rabattcodes
          </button>
          <button
            onClick={() => setActiveSection('approvals')}
            className="relative flex flex-col items-center gap-2 p-4 rounded-xl text-center text-xs font-medium transition-all hover:-translate-y-0.5 hover:shadow-md"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { (e.currentTarget.style.borderColor = 'var(--warning)'); (e.currentTarget.style.color = 'var(--warning)'); }}
            onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-secondary)'); }}
          >
            {pendingCompanies.length > 0 && (
              <span className="absolute top-2 right-2 min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: 'var(--warning)' }}>
                {pendingCompanies.length}
              </span>
            )}
            <ClipboardCheck size={20} />
            Freischaltung
          </button>
          <button
            onClick={() => setActiveSection('referrals')}
            className="flex flex-col items-center gap-2 p-4 rounded-xl text-center text-xs font-medium transition-all hover:-translate-y-0.5 hover:shadow-md"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { (e.currentTarget.style.borderColor = '#10b981'); (e.currentTarget.style.color = '#10b981'); }}
            onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-secondary)'); }}
          >
            <Gift size={20} />
            Empfehlungen
          </button>
          <button
            onClick={() => setActiveSection('activation')}
            className="flex flex-col items-center gap-2 p-4 rounded-xl text-center text-xs font-medium transition-all hover:-translate-y-0.5 hover:shadow-md"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { (e.currentTarget.style.borderColor = 'var(--accent)'); (e.currentTarget.style.color = 'var(--accent)'); }}
            onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--border)'); (e.currentTarget.style.color = 'var(--text-secondary)'); }}
          >
            <KeyRound size={20} />
            Aktivierung
          </button>
        </div>
      </div>

      </>}

    </div>

    {/* ── Reject Modal ──────────────────────────────────────────────────────── */}
    {rejectModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <div className="w-full max-w-md rounded-2xl p-6 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <h3 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
            Registrierung ablehnen
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Möchten Sie die Registrierung von <strong style={{ color: 'var(--text-primary)' }}>{rejectModal.company.name}</strong> ablehnen?
          </p>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
              Ablehnungsgrund (optional, wird dem Unternehmen angezeigt)
            </label>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={3}
              placeholder="z.B. Unvollständige Angaben, kein Taxiunternehmen..."
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
              Abbrechen
            </button>
            <button
              onClick={handleReject}
              disabled={approvingId === rejectModal.company.id}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-opacity hover:opacity-85 disabled:opacity-50"
              style={{ background: 'var(--danger)', color: 'white' }}
            >
              {approvingId === rejectModal.company.id ? 'Wird abgelehnt…' : 'Ablehnen'}
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
