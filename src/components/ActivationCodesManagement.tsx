import React, { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  KeyRound, Plus, Copy, Check, X, RefreshCw, ChevronDown,
  CalendarCheck, Clock, Ban, CheckCircle, AlertTriangle,
  Building2, Mail, Calendar, Trash2, EyeOff, Info,
} from 'lucide-react';
import { format, addDays, addMonths, addYears } from 'date-fns';
import { de } from 'date-fns/locale';

// ─── Types ────────────────────────────────────────────────────────────────────

type DurationType = '1_monat' | '3_monate' | '1_jahr' | 'benutzerdefiniert';
type CodeStatus   = 'active' | 'used' | 'expired' | 'revoked';
type FilterTab    = 'active' | 'used' | 'expired' | 'revoked' | 'hidden' | 'all';

interface ActivationCode {
  id: string;
  code_last4: string | null;
  company_id: string | null;
  company_name?: string;
  target_email: string | null;
  duration_type: DurationType;
  custom_days: number | null;
  custom_expires_at: string | null;
  expires_at: string;
  used_at: string | null;
  used_company_id: string | null;
  used_company_name?: string;
  revoked_at: string | null;
  status: CodeStatus;
  created_at: string;
  deleted_at: string | null;
  hidden_at: string | null;
  hidden_reason: string | null;
}

interface CompanyOption {
  id: string;
  name: string;
  subscription_status: string;
  subscription_expires_at: string | null;
}

// ─── Confirmation Dialog ──────────────────────────────────────────────────────

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  confirmColor?: string;
  onConfirm: () => void;
  onCancel: () => void;
  extra?: React.ReactNode;
}

function ConfirmDialog({ title, body, confirmLabel, confirmColor = '#ef4444', onConfirm, onCancel, extra }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.65)' }}>
      <div className="w-full max-w-sm rounded-2xl p-6 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{body}</p>
        {extra}
        <div className="flex gap-2 justify-end pt-1">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm font-semibold"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl text-sm font-semibold"
            style={{ background: confirmColor, color: '#fff' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// `label` holds a TranslationKey throughout this section: these maps are
// module-level and t() is a hook value. Every consumer resolves it. The record
// keys and tab ids are the stored duration / status values and are never
// translated — only the label a user reads.
const DURATION_LABELS: Record<DurationType, TranslationKey> = {
  '1_monat':           'activation.duration.1month',
  '3_monate':          'activation.duration.3months',
  '1_jahr':            'activation.duration.1year',
  'benutzerdefiniert': 'activation.custom',
};

const STATUS_CFG: Record<CodeStatus, { label: TranslationKey; color: string; bg: string; Icon: React.ElementType }> = {
  active:  { label: 'codes.status.active',    color: '#10b981', bg: 'rgba(16,185,129,0.1)',  Icon: CheckCircle },
  used:    { label: 'codes.status.used',      color: '#06b6d4', bg: 'rgba(6,182,212,0.1)',   Icon: Check },
  expired: { label: 'activation.expiredShort', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',  Icon: Clock },
  revoked: { label: 'codes.status.revoked',   color: '#ef4444', bg: 'rgba(239,68,68,0.1)',   Icon: Ban },
};

const FILTER_TABS: { id: FilterTab; label: TranslationKey }[] = [
  { id: 'all',     label: 'common.all' },
  { id: 'active',  label: 'codes.status.active' },
  { id: 'used',    label: 'codes.status.used' },
  { id: 'expired', label: 'activation.expiredShort' },
  { id: 'revoked', label: 'codes.status.revoked' },
  { id: 'hidden',  label: 'codes.filter.hidden' },
];

// Column headers of the code table, in render order.
const TABLE_HEADER_KEYS: TranslationKey[] = [
  'codes.col.code',
  'codes.col.company',
  'codes.col.email',
  'codes.field.duration',
  'common.status',
  'codes.col.validUntil',
  'codes.details.usedAt',
  'codes.details.created',
  'codes.col.actions',
];

// ─── Countdown for active codes ───────────────────────────────────────────────

function CodeCountdown({ expiresAt }: { expiresAt: string }) {
  const { t } = useTranslation();
  const [display, setDisplay] = useState('');
  const rafRef = useRef<number>();

  useEffect(() => {
    const end = new Date(expiresAt).getTime();
    const tick = () => {
      const diff = end - Date.now();
      if (diff <= 0) { setDisplay(t('activation.expiredShort')); return; }
      const s = Math.floor(diff / 1000);
      const m = Math.floor(s / 60);
      const sec = s % 60;
      setDisplay(`${m}:${String(sec).padStart(2, '0')}`);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [expiresAt, t]);

  const end = new Date(expiresAt).getTime();
  const isUrgent = end - Date.now() < 30_000;
  return (
    <span className="font-mono text-xs tabular-nums" style={{ color: isUrgent ? '#ef4444' : '#f59e0b' }}>
      {display}
    </span>
  );
}

// ─── Generated Code Modal ─────────────────────────────────────────────────────

/** What generate-activation-code reported about mailing the code. */
interface GeneratedCodeMail {
  sent: boolean;
  recipientCount: number;
  /** Whether the form named a target address or a company. */
  hadRecipient: boolean;
}

function GeneratedCodeModal({
  code,
  expiresAt,
  mail,
  onClose,
}: {
  code: string;
  expiresAt: string;
  mail: GeneratedCodeMail | null;
  onClose: () => void;
}) {
  const { t, tPlural } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-sm rounded-2xl p-7 space-y-5 text-center" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mx-auto">
          <KeyRound className="text-emerald-400" size={24} />
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-tertiary)' }}>
            {t('codes.generated.label')}
          </p>
          <div
            className="text-5xl font-mono font-bold tracking-[0.25em] py-4 px-6 rounded-2xl select-all"
            style={{ background: 'rgba(16,185,129,0.08)', border: '2px solid rgba(16,185,129,0.25)', color: '#10b981', letterSpacing: '0.35em' }}
          >
            {code}
          </div>
        </div>

        <div className="p-3 rounded-xl" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('codes.generated.validityBefore')}{' '}
            <strong style={{ color: '#f59e0b' }}>{t('codes.generated.validityStrong')}</strong>{' '}
            {t('codes.generated.validityAfter')}
          </p>
          <div className="mt-1.5 flex items-center justify-center gap-1.5">
            <Clock size={11} style={{ color: '#f59e0b' }} />
            <CodeCountdown expiresAt={expiresAt} />
          </div>
        </div>

        {mail && (
          <p
            className="text-xs"
            style={{ color: mail.sent ? 'var(--success)' : mail.hadRecipient ? 'var(--warning)' : 'var(--text-tertiary)' }}
          >
            {mail.sent
              ? tPlural({ one: 'codes.generated.mailSent.one', other: 'codes.generated.mailSent.other' }, mail.recipientCount)
              : mail.hadRecipient
                ? t('codes.generated.mailFailed')
                : t('codes.generated.mailNoRecipient')}
          </p>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleCopy}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all"
            style={{ background: copied ? 'rgba(16,185,129,0.15)' : 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', color: '#10b981' }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t('codes.copied') : t('common.copy')}
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            {t('common.close')}
          </button>
        </div>

        <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {t('codes.generated.hiddenAfterClose')}
        </p>
      </div>
    </div>
  );
}

// ─── Details Modal ────────────────────────────────────────────────────────────

function DetailsModal({ code, onClose }: { code: ActivationCode; onClose: () => void }) {
  const { t } = useTranslation();
  const st = STATUS_CFG[code.status] ?? STATUS_CFG.expired;
  // Timestamps keep the German DD.MM.YYYY format in both languages — see src/i18n/index.ts.
  const rows: [string, React.ReactNode][] = [
    [t('codes.details.codeMasked'), <span className="font-mono">••{code.code_last4 ?? '????'}</span>],
    [t('common.status'), <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: st.bg, color: st.color }}><st.Icon size={10} />{t(st.label)}</span>],
    [t('codes.details.duration'), DURATION_LABELS[code.duration_type] ? t(DURATION_LABELS[code.duration_type]) : code.duration_type],
    [t('codes.details.created'), format(new Date(code.created_at), 'dd.MM.yyyy HH:mm', { locale: de })],
    [t('codes.details.validUntilCode'), format(new Date(code.expires_at), 'dd.MM.yyyy HH:mm', { locale: de })],
    [t('codes.details.targetCompany'), code.company_name ?? '—'],
    [t('codes.details.targetEmail'), code.target_email ?? '—'],
    [t('codes.details.usedAt'), code.used_at ? format(new Date(code.used_at), 'dd.MM.yyyy HH:mm', { locale: de }) : '—'],
    [t('codes.details.usedBy'), code.used_company_name ?? '—'],
    [t('codes.details.revokedAt'), code.revoked_at ? format(new Date(code.revoked_at), 'dd.MM.yyyy HH:mm', { locale: de }) : '—'],
    [t('codes.details.hiddenAt'), code.hidden_at ? format(new Date(code.hidden_at), 'dd.MM.yyyy HH:mm', { locale: de }) : '—'],
    [t('codes.details.hideReason'), code.hidden_reason ?? '—'],
    [t('codes.details.deletedAt'), code.deleted_at ? format(new Date(code.deleted_at), 'dd.MM.yyyy HH:mm', { locale: de }) : '—'],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.65)' }}>
      <div className="w-full max-w-md rounded-2xl p-6 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold" style={{ color: 'var(--text-primary)' }}>{t('codes.details.title')}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg" style={{ color: 'var(--text-tertiary)' }}>
            <X size={16} />
          </button>
        </div>
        <div className="space-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 py-1.5 text-sm" style={{ borderBottom: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--text-tertiary)' }}>{label}</span>
              <span className="text-right font-medium" style={{ color: 'var(--text-primary)' }}>{value}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-end pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-semibold"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface Props {
  companies?: CompanyOption[];
}

export default function ActivationCodesManagement({ companies: propCompanies }: Props) {
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [codes, setCodes]       = useState<ActivationCode[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>(propCompanies ?? []);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');

  // Confirmation state
  type ConfirmAction = { type: 'revoke' | 'delete' | 'hide'; code: ActivationCode };
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [hideReason, setHideReason] = useState('');
  const [actionInFlight, setActionInFlight] = useState(false);

  // Details modal
  const [detailsCode, setDetailsCode] = useState<ActivationCode | null>(null);

  // Generate form state
  const [fCompanyId, setFCompanyId] = useState('');
  const [fEmail, setFEmail]         = useState('');
  const [fDuration, setFDuration]   = useState<DurationType>('1_monat');
  const [fCustomDays, setFCustomDays] = useState('');
  const [fCustomDate, setFCustomDate] = useState('');
  const [fCustomMode, setFCustomMode] = useState<'days' | 'date'>('days');

  // Generated code modal
  const [generatedCode, setGeneratedCode] = useState<{ code: string; expiresAt: string; mail: GeneratedCodeMail | null } | null>(null);

  const cardStyle: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: '1rem',
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: codesRaw, error } = await supabase
        .from('activation_codes')
        .select('id, code_last4, company_id, target_email, duration_type, custom_days, custom_expires_at, expires_at, used_at, used_company_id, revoked_at, status, created_at, deleted_at, hidden_at, hidden_reason')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;

      const allCompanyIds = new Set<string>();
      (codesRaw ?? []).forEach(c => {
        if (c.company_id) allCompanyIds.add(c.company_id);
        if (c.used_company_id) allCompanyIds.add(c.used_company_id);
      });
      let nameMap: Record<string, string> = {};
      if (allCompanyIds.size > 0) {
        const { data: cNames } = await supabase
          .from('companies')
          .select('id, name')
          .in('id', [...allCompanyIds]);
        (cNames ?? []).forEach((c: { id: string; name: string }) => { nameMap[c.id] = c.name; });
      }

      setCodes(
        (codesRaw ?? []).map(c => ({
          ...c,
          duration_type: c.duration_type as DurationType,
          status: c.status as CodeStatus,
          company_name: c.company_id ? nameMap[c.company_id] : undefined,
          used_company_name: c.used_company_id ? nameMap[c.used_company_id] : undefined,
        }))
      );

      if (!propCompanies) {
        const { data: comps } = await supabase
          .from('companies')
          .select('id, name, subscription_status, subscription_expires_at')
          .not('status', 'in', '("deleted","archived")')
          .order('name');
        setCompanies(comps ?? []);
      }
    } catch (err: any) {
      showToast('error', err.message || t('common.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [propCompanies]);

  useEffect(() => { load(); }, [load]);

  // ── Filter logic ─────────────────────────────────────────────────────────────

  const filteredCodes = codes.filter(c => {
    const isHidden  = !!c.hidden_at;
    const isDeleted = !!c.deleted_at;
    const isExpiredNow = c.status === 'active' && new Date(c.expires_at) < new Date();
    const effectiveStatus = isExpiredNow ? 'expired' : c.status;

    if (activeFilter === 'hidden')  return isHidden;
    if (activeFilter === 'all')     return !isDeleted; // deleted only shown in 'hidden' tab via hide mechanism
    // In normal status tabs, hide hidden+deleted from view
    if (isHidden || isDeleted) return false;
    if (activeFilter === 'active')  return effectiveStatus === 'active';
    if (activeFilter === 'used')    return effectiveStatus === 'used';
    if (activeFilter === 'expired') return effectiveStatus === 'expired';
    if (activeFilter === 'revoked') return effectiveStatus === 'revoked';
    return true;
  });

  const tabCounts = {
    all:     codes.filter(c => !c.deleted_at).length,
    active:  codes.filter(c => !c.hidden_at && !c.deleted_at && c.status === 'active' && new Date(c.expires_at) >= new Date()).length,
    used:    codes.filter(c => !c.hidden_at && !c.deleted_at && c.status === 'used').length,
    expired: codes.filter(c => !c.hidden_at && !c.deleted_at && (c.status === 'expired' || (c.status === 'active' && new Date(c.expires_at) < new Date()))).length,
    revoked: codes.filter(c => !c.hidden_at && !c.deleted_at && c.status === 'revoked').length,
    hidden:  codes.filter(c => !!c.hidden_at).length,
  };

  // ── Actions ───────────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const body: Record<string, unknown> = { duration_type: fDuration };
      if (fCompanyId) body.company_id = fCompanyId;
      if (fEmail.trim()) body.target_email = fEmail.trim();
      if (fDuration === 'benutzerdefiniert') {
        if (fCustomMode === 'days' && fCustomDays) body.custom_days = parseInt(fCustomDays);
        if (fCustomMode === 'date' && fCustomDate) body.custom_expires_at = new Date(fCustomDate).toISOString();
      }

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-activation-code`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
            'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || t('codes.generateFailed'));

      setGeneratedCode({
        code: data.code,
        expiresAt: data.expires_at,
        // Absent when an older function answered; then the screen says nothing about mail.
        mail: typeof data.mail_sent === 'boolean'
          ? {
              sent: data.mail_sent,
              recipientCount: Number(data.recipient_count) || 0,
              hadRecipient: Boolean(fCompanyId) || Boolean(fEmail.trim()),
            }
          : null,
      });
      setShowForm(false);
      setFCompanyId(''); setFEmail(''); setFDuration('1_monat');
      setFCustomDays(''); setFCustomDate('');
      load();
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    } finally {
      setGenerating(false);
    }
  };

  const executeAction = async () => {
    if (!confirmAction) return;
    setActionInFlight(true);
    try {
      const { type, code } = confirmAction;

      if (type === 'revoke') {
        const { data } = await supabase.rpc('revoke_activation_code', { p_code_id: code.id });
        const result = data as { success: boolean; error?: string };
        if (!result?.success) throw new Error(result?.error ?? t('codes.revokeFailed'));
        showToast('success', t('codes.revoked'));
      }

      if (type === 'delete') {
        const { data } = await supabase.rpc('delete_activation_code', { p_code_id: code.id });
        const result = data as { success: boolean; error?: string };
        if (!result?.success) throw new Error(result?.error ?? t('common.errorDelete'));
        showToast('success', t('codes.deleted'));
      }

      if (type === 'hide') {
        const { data } = await supabase.rpc('hide_activation_code', {
          p_code_id: code.id,
          p_reason: hideReason.trim() || null,
        });
        const result = data as { success: boolean; error?: string };
        if (!result?.success) throw new Error(result?.error ?? t('codes.hideFailed'));
        showToast('success', t('codes.hidden'));
      }

      setConfirmAction(null);
      setHideReason('');
      load();
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    } finally {
      setActionInFlight(false);
    }
  };

  // ── Duration preview ──────────────────────────────────────────────────────────

  const durationPreview = () => {
    const base = new Date();
    // Dates keep the German DD.MM.YYYY format in both languages — see src/i18n/index.ts.
    const validUntil = (d: Date) => t('codes.validUntilDate', { date: format(d, 'dd.MM.yyyy', { locale: de }) });
    if (fDuration === '1_monat')  return validUntil(addMonths(base, 1));
    if (fDuration === '3_monate') return validUntil(addMonths(base, 3));
    if (fDuration === '1_jahr')   return validUntil(addYears(base, 1));
    if (fDuration === 'benutzerdefiniert') {
      if (fCustomMode === 'days' && fCustomDays) return validUntil(addDays(base, parseInt(fCustomDays)));
      if (fCustomMode === 'date' && fCustomDate) return validUntil(new Date(fCustomDate));
    }
    return null;
  };

  const canGenerate = fDuration !== 'benutzerdefiniert' ||
    (fCustomMode === 'days' ? !!fCustomDays && parseInt(fCustomDays) > 0 : !!fCustomDate);

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <KeyRound size={18} style={{ color: 'var(--accent)' }} />
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('codes.title')}</h2>
          <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>
            {t('codes.activeCount', { count: tabCounts.active })}
          </span>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold transition-opacity hover:opacity-85"
          style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? t('common.cancel') : t('codes.create')}
        </button>
      </div>

      {/* Generate form */}
      {showForm && (
        <div className="p-6 space-y-5" style={cardStyle}>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('codes.generateNew')}</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                <Building2 size={10} className="inline mr-1" />{t('codes.field.companyOptional')}
              </label>
              <select
                value={fCompanyId}
                onChange={e => setFCompanyId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              >
                <option value="">{t('codes.genericCode')}</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                <Mail size={10} className="inline mr-1" />{t('codes.field.emailOptional')}
              </label>
              <input
                type="email"
                value={fEmail}
                onChange={e => setFEmail(e.target.value)}
                placeholder={t('codes.emailPlaceholder')}
                className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>{t('codes.field.duration')}</label>
            <div className="flex gap-2 flex-wrap">
              {(['1_monat', '3_monate', '1_jahr', 'benutzerdefiniert'] as DurationType[]).map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setFDuration(d)}
                  className="px-3 py-2 rounded-xl text-sm font-semibold transition-all"
                  style={fDuration === d
                    ? { background: 'var(--accent)', color: 'var(--text-inverse)' }
                    : { background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }
                  }
                >
                  {t(DURATION_LABELS[d])}
                </button>
              ))}
            </div>
          </div>

          {fDuration === 'benutzerdefiniert' && (
            <div className="space-y-3">
              <div className="flex gap-2">
                {(['days', 'date'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setFCustomMode(m)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                    style={fCustomMode === m
                      ? { background: 'var(--accent)', color: 'var(--text-inverse)' }
                      : { border: '1px solid var(--border)', color: 'var(--text-secondary)' }
                    }
                  >
                    {m === 'days' ? t('codes.mode.days') : t('codes.mode.expiryDate')}
                  </button>
                ))}
              </div>
              {fCustomMode === 'days' ? (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>{t('codes.field.numberOfDays')}</label>
                  <input
                    type="number" min={1} max={3650}
                    value={fCustomDays}
                    onChange={e => setFCustomDays(e.target.value)}
                    placeholder={t('codes.daysPlaceholder')}
                    className="w-32 px-3 py-2.5 rounded-xl text-sm focus:outline-none"
                    style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>{t('codes.mode.expiryDate')}</label>
                  <input
                    type="date"
                    value={fCustomDate}
                    min={format(addDays(new Date(), 1), 'yyyy-MM-dd')}
                    onChange={e => setFCustomDate(e.target.value)}
                    className="px-3 py-2.5 rounded-xl text-sm focus:outline-none"
                    style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  />
                </div>
              )}
            </div>
          )}

          {durationPreview() && (
            <div className="flex items-center gap-1.5 text-xs" style={{ color: '#10b981' }}>
              <CalendarCheck size={12} />
              {durationPreview()}
            </div>
          )}

          <div className="flex gap-2 justify-end pt-1">
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2.5 rounded-xl text-sm font-semibold"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleGenerate}
              disabled={generating || !canGenerate}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-opacity hover:opacity-85 disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
            >
              {generating ? <RefreshCw size={13} className="animate-spin" /> : <KeyRound size={13} />}
              {generating ? t('codes.creating') : t('codes.create')}
            </button>
          </div>
        </div>
      )}

      {/* Codes table */}
      <div style={cardStyle} className="overflow-hidden">
        <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <KeyRound size={15} style={{ color: 'var(--text-tertiary)' }} />
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('codes.history', { count: filteredCodes.length })}
              </h3>
            </div>
            <button
              onClick={() => load()}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: 'var(--text-tertiary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          {/* Filter tabs */}
          <div className="flex gap-1.5 mt-3 flex-wrap">
            {FILTER_TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveFilter(tab.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={activeFilter === tab.id
                  ? { background: 'var(--accent)', color: 'var(--text-inverse)' }
                  : { background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }
                }
              >
                {t(tab.label)}
                {tabCounts[tab.id] > 0 && (
                  <span
                    className="px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none"
                    style={activeFilter === tab.id
                      ? { background: 'rgba(255,255,255,0.25)', color: '#fff' }
                      : { background: 'var(--bg-muted)', color: 'var(--text-tertiary)' }
                    }
                  >
                    {tabCounts[tab.id]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <RefreshCw size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
          </div>
        ) : filteredCodes.length === 0 ? (
          <div className="py-10 text-center" style={{ color: 'var(--text-tertiary)' }}>
            <KeyRound size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('codes.noneForFilter')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                  {TABLE_HEADER_KEYS.map(key => (
                    <th key={key} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>{t(key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredCodes.map(c => {
                  const isExpiredNow = c.status === 'active' && new Date(c.expires_at) < new Date();
                  const effectiveStatus: CodeStatus = isExpiredNow ? 'expired' : c.status;
                  const st = STATUS_CFG[effectiveStatus] ?? STATUS_CFG.expired;
                  const isUnused = !c.used_at && !c.used_company_id;
                  const isHidden = !!c.hidden_at;
                  const isDeleted = !!c.deleted_at;

                  return (
                    <tr
                      key={c.id}
                      style={{ borderBottom: '1px solid var(--border)', opacity: isHidden || isDeleted ? 0.6 : 1 }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* Code (masked) */}
                      <td className="px-4 py-3">
                        <span className="font-mono text-sm font-bold" style={{ color: st.color }}>
                          ••{c.code_last4 ?? '????'}
                        </span>
                        {isHidden && (
                          <span className="ml-1 text-[10px] px-1 py-0.5 rounded" style={{ background: 'rgba(148,163,184,0.15)', color: 'var(--text-tertiary)' }}>
                            {t('codes.badge.hidden')}
                          </span>
                        )}
                        {isDeleted && (
                          <span className="ml-1 text-[10px] px-1 py-0.5 rounded" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--danger)' }}>
                            {t('codes.badge.deleted')}
                          </span>
                        )}
                      </td>

                      {/* Company */}
                      <td className="px-4 py-3">
                        {c.company_name ? (
                          <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{c.company_name}</span>
                        ) : c.used_company_name ? (
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{c.used_company_name}</span>
                        ) : (
                          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                        )}
                      </td>

                      {/* Email */}
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {c.target_email ?? <span style={{ color: 'var(--text-tertiary)' }}>—</span>}
                      </td>

                      {/* Duration */}
                      <td className="px-4 py-3">
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {t(DURATION_LABELS[c.duration_type])}
                          {c.custom_days && <span style={{ color: 'var(--text-tertiary)' }}> {t('codes.customDaysSuffix', { count: c.custom_days })}</span>}
                        </span>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
                          style={{ background: st.bg, color: st.color }}>
                          <st.Icon size={10} />
                          {t(st.label)}
                        </span>
                      </td>

                      {/* Gültig bis */}
                      <td className="px-4 py-3">
                        {c.status === 'active' && !isExpiredNow ? (
                          <CodeCountdown expiresAt={c.expires_at} />
                        ) : (
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {format(new Date(c.expires_at), 'dd.MM.yy HH:mm', { locale: de })}
                          </span>
                        )}
                      </td>

                      {/* Used at */}
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {c.used_at
                          ? format(new Date(c.used_at), 'dd.MM.yy HH:mm', { locale: de })
                          : <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                        }
                      </td>

                      {/* Created */}
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {format(new Date(c.created_at), 'dd.MM.yy HH:mm', { locale: de })}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 flex-wrap">
                          {/* Revoke — only for active, unused codes */}
                          {effectiveStatus === 'active' && isUnused && !isDeleted && !isHidden && (
                            <button
                              onClick={() => setConfirmAction({ type: 'revoke', code: c })}
                              title={t('codes.action.revoke')}
                              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors"
                              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = '#ef4444'; e.currentTarget.style.color = '#ef4444'; }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                            >
                              <Ban size={11} />{t('codes.action.revoke')}
                            </button>
                          )}

                          {/* Delete — only for unused codes */}
                          {isUnused && !isDeleted && (
                            <button
                              onClick={() => setConfirmAction({ type: 'delete', code: c })}
                              title={t('common.delete')}
                              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors"
                              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = '#ef4444'; e.currentTarget.style.color = '#ef4444'; }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                            >
                              <Trash2 size={11} />{t('common.delete')}
                            </button>
                          )}

                          {/* Hide — always available if not already hidden */}
                          {!isHidden && (
                            <button
                              onClick={() => { setHideReason(''); setConfirmAction({ type: 'hide', code: c }); }}
                              title={t('codes.action.hide')}
                              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors"
                              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--warning)'; e.currentTarget.style.color = 'var(--warning)'; }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                            >
                              <EyeOff size={11} />{t('codes.action.hide')}
                            </button>
                          )}

                          {/* Details — always shown */}
                          <button
                            onClick={() => setDetailsCode(c)}
                            title={t('codes.action.details')}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors"
                            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)'; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                          >
                            <Info size={11} />{t('codes.action.details')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Generated code modal */}
      {generatedCode && (
        <GeneratedCodeModal
          code={generatedCode.code}
          expiresAt={generatedCode.expiresAt}
          mail={generatedCode.mail}
          onClose={() => setGeneratedCode(null)}
        />
      )}

      {/* Details modal */}
      {detailsCode && (
        <DetailsModal code={detailsCode} onClose={() => setDetailsCode(null)} />
      )}

      {/* Confirmation dialogs */}
      {confirmAction?.type === 'revoke' && (
        <ConfirmDialog
          title={t('codes.confirm.revokeTitle')}
          body={t('codes.confirm.revokeBody')}
          confirmLabel={actionInFlight ? t('codes.revoking') : t('codes.action.revoke')}
          confirmColor="#ef4444"
          onConfirm={executeAction}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {confirmAction?.type === 'delete' && (
        <ConfirmDialog
          title={t('codes.confirm.deleteTitle')}
          body={t('codes.confirm.deleteBody')}
          confirmLabel={actionInFlight ? t('codes.deleting') : t('common.delete')}
          confirmColor="#ef4444"
          onConfirm={executeAction}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {confirmAction?.type === 'hide' && (
        <ConfirmDialog
          title={t('codes.confirm.hideTitle')}
          body={t('codes.confirm.hideBody')}
          confirmLabel={actionInFlight ? t('codes.hiding') : t('codes.action.hide')}
          confirmColor="#f59e0b"
          onConfirm={executeAction}
          onCancel={() => setConfirmAction(null)}
          extra={
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                {t('codes.field.reasonOptional')}
              </label>
              <input
                type="text"
                value={hideReason}
                onChange={e => setHideReason(e.target.value)}
                placeholder={t('codes.reasonPlaceholder')}
                className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
            </div>
          }
        />
      )}
    </div>
  );
}
