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
import {
  Alert, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  EmptyState, Field, Input, NativeSelect, cn, type BadgeProps,
} from './ui';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The code list is one page, newest first. It always was — the `.limit(200)`
 * has been there from the start — but nothing on screen said so, so on a
 * platform past 200 codes the history read as complete while the oldest codes
 * were simply absent. The number is named here so the note and the query cannot
 * drift apart.
 */
const CODES_PAGE_SIZE = 200;

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

type StatusTone = NonNullable<BadgeProps['tone']>;

const STATUS_CFG: Record<CodeStatus, { label: TranslationKey; tone: StatusTone; text: string; Icon: React.ElementType }> = {
  active:  { label: 'codes.status.active',    tone: 'positive', text: 'text-positive', Icon: CheckCircle },
  used:    { label: 'codes.status.used',      tone: 'info',     text: 'text-info',     Icon: Check },
  expired: { label: 'activation.expiredShort', tone: 'caution',  text: 'text-caution',  Icon: Clock },
  revoked: { label: 'codes.status.revoked',   tone: 'critical', text: 'text-critical', Icon: Ban },
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
    <span className={cn('font-mono text-xs tabular-nums', isUrgent ? 'text-critical' : 'text-caution')}>
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

// ─── Main Component ───────────────────────────────────────────────────────────

interface Props {
  companies?: CompanyOption[];
}

export default function ActivationCodesManagement({ companies: propCompanies }: Props) {
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [codes, setCodes]       = useState<ActivationCode[]>([]);
  /** How many codes exist in all, or null where the database did not say. */
  const [codeTotal, setCodeTotal] = useState<number | null>(null);
  const [companies, setCompanies] = useState<CompanyOption[]>(propCompanies ?? []);
  const [loading, setLoading]   = useState(true);
  /**
   * A read that did not succeed. The table then says so instead of "Keine
   * Einträge für diesen Filter", which is a claim about which codes exist.
   */
  const [loadFailed, setLoadFailed] = useState(false);
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

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      // The cap is real and the screen now says so: `count: 'exact'` asks the
      // database how many rows there are in total, so a platform past 200 codes
      // is told it is looking at a page rather than at its whole history.
      const { data: codesRaw, error, count } = await supabase
        .from('activation_codes')
        .select('id, code_last4, company_id, target_email, duration_type, custom_days, custom_expires_at, expires_at, used_at, used_company_id, revoked_at, status, created_at, deleted_at, hidden_at, hidden_reason', { count: 'exact' })
        .order('created_at', { ascending: false })
        .limit(CODES_PAGE_SIZE);
      if (error) throw error;
      setCodeTotal(typeof count === 'number' ? count : null);

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
      console.error(err);
      setCodes([]);
      setCodeTotal(null);
      setLoadFailed(true);
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  return (
    <div className="space-y-4 font-ui">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <KeyRound size={18} className="text-brand-text" />
          <h2 className="text-base font-semibold text-fg">{t('codes.title')}</h2>
          <Badge tone="brand">{t('codes.activeCount', { count: tabCounts.active })}</Badge>
        </div>
        <Button onClick={() => setShowForm(v => !v)}>
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? t('common.cancel') : t('codes.create')}
        </Button>
      </div>

      {/* Generate form */}
      {showForm && (
        <div className="glass-card rounded-surface p-6 space-y-5">
          <h3 className="text-sm font-semibold text-fg">{t('codes.generateNew')}</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={<span className="inline-flex items-center gap-1"><Building2 size={11} />{t('codes.field.companyOptional')}</span>}>
              <NativeSelect
                value={fCompanyId}
                onChange={e => setFCompanyId(e.target.value)}
              >
                <option value="">{t('codes.genericCode')}</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </NativeSelect>
            </Field>

            <Field label={<span className="inline-flex items-center gap-1"><Mail size={11} />{t('codes.field.emailOptional')}</span>}>
              <Input
                type="email"
                value={fEmail}
                onChange={e => setFEmail(e.target.value)}
                placeholder={t('codes.emailPlaceholder')}
              />
            </Field>
          </div>

          <div>
            <p className="mb-2 text-[13px] font-[550] text-fg-muted">{t('codes.field.duration')}</p>
            <div className="flex gap-2 flex-wrap">
              {(['1_monat', '3_monate', '1_jahr', 'benutzerdefiniert'] as DurationType[]).map(d => (
                <Button
                  key={d}
                  type="button"
                  variant={fDuration === d ? 'primary' : 'secondary'}
                  onClick={() => setFDuration(d)}
                >
                  {t(DURATION_LABELS[d])}
                </Button>
              ))}
            </div>
          </div>

          {fDuration === 'benutzerdefiniert' && (
            <div className="space-y-3">
              <div className="flex gap-2">
                {(['days', 'date'] as const).map(m => (
                  <Button
                    key={m}
                    type="button"
                    size="sm"
                    variant={fCustomMode === m ? 'primary' : 'secondary'}
                    onClick={() => setFCustomMode(m)}
                  >
                    {m === 'days' ? t('codes.mode.days') : t('codes.mode.expiryDate')}
                  </Button>
                ))}
              </div>
              {fCustomMode === 'days' ? (
                <Field label={t('codes.field.numberOfDays')} className="w-40">
                  <Input
                    type="number" min={1} max={3650}
                    value={fCustomDays}
                    onChange={e => setFCustomDays(e.target.value)}
                    placeholder={t('codes.daysPlaceholder')}
                  />
                </Field>
              ) : (
                <Field label={t('codes.mode.expiryDate')} className="w-fit">
                  <Input
                    type="date"
                    value={fCustomDate}
                    min={format(addDays(new Date(), 1), 'yyyy-MM-dd')}
                    onChange={e => setFCustomDate(e.target.value)}
                  />
                </Field>
              )}
            </div>
          )}

          {durationPreview() && (
            <div className="flex items-center gap-1.5 text-xs text-positive">
              <CalendarCheck size={12} />
              {durationPreview()}
            </div>
          )}

          <div className="flex gap-2 justify-end pt-1">
            <Button variant="secondary" onClick={() => setShowForm(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleGenerate} disabled={generating || !canGenerate}>
              {generating ? <RefreshCw size={13} className="motion-safe:animate-spin" /> : <KeyRound size={13} />}
              {generating ? t('codes.creating') : t('codes.create')}
            </Button>
          </div>
        </div>
      )}

      {/* Codes table */}
      <div className="glass-card rounded-surface relative overflow-x-auto">
        <div className="px-5 py-4 border-b border-line">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <KeyRound size={15} className="text-fg-subtle" />
              <h3 className="text-sm font-semibold text-fg">
                {t('codes.history', { count: filteredCodes.length })}
              </h3>
              {/* A page, not a list: said only when the database reported more codes than this page holds. */}
              {codeTotal !== null && codeTotal > codes.length && (
                <span className="text-[11px] text-fg-subtle">
                  {t('admin.read.partial', { shown: codes.length, total: codeTotal })}
                </span>
              )}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => load()}>
              <RefreshCw size={13} className={loading ? 'motion-safe:animate-spin' : ''} />
            </Button>
          </div>

          {/* Filter tabs */}
          <div className="flex gap-1.5 mt-3 flex-wrap">
            {FILTER_TABS.map(tab => (
              <Button
                key={tab.id}
                size="sm"
                variant={activeFilter === tab.id ? 'primary' : 'secondary'}
                onClick={() => setActiveFilter(tab.id)}
              >
                {t(tab.label)}
                {tabCounts[tab.id] > 0 && (
                  <span
                    className={cn(
                      'px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none tabular-nums',
                      activeFilter === tab.id ? 'bg-brand-fg/25 text-brand-fg' : 'bg-sunken text-fg-subtle',
                    )}
                  >
                    {tabCounts[tab.id]}
                  </span>
                )}
              </Button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <RefreshCw size={20} className="motion-safe:animate-spin text-fg-subtle" />
          </div>
        ) : loadFailed ? (
          /* Not "no entries for this filter" — the codes were not read. */
          <div className="p-4">
            <Alert tone="critical" className="font-ui" title={t('admin.read.failedTitle')}>
              {t('admin.read.failed')}
            </Alert>
          </div>
        ) : filteredCodes.length === 0 ? (
          <EmptyState icon={KeyRound} title={t('codes.noneForFilter')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-wash border-b border-line">
                  {TABLE_HEADER_KEYS.map(key => (
                    <th key={key} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap text-fg-subtle">{t(key)}</th>
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
                      className={cn('border-b border-line transition-colors hover:bg-sunken', (isHidden || isDeleted) && 'opacity-60')}
                    >
                      {/* Code (masked) */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={cn('font-mono text-sm font-bold', st.text)}>
                          ••{c.code_last4 ?? '????'}
                        </span>
                        {isHidden && (
                          <Badge tone="neutral" className="ml-1">
                            {t('codes.badge.hidden')}
                          </Badge>
                        )}
                        {isDeleted && (
                          <Badge tone="critical" className="ml-1">
                            {t('codes.badge.deleted')}
                          </Badge>
                        )}
                      </td>

                      {/* Company */}
                      <td className="px-4 py-3">
                        {c.company_name ? (
                          <span className="text-xs font-medium text-fg">{c.company_name}</span>
                        ) : c.used_company_name ? (
                          <span className="text-xs text-fg-subtle">{c.used_company_name}</span>
                        ) : (
                          <span className="text-fg-subtle">—</span>
                        )}
                      </td>

                      {/* Email */}
                      <td className="px-4 py-3 text-xs text-fg-muted">
                        {c.target_email ?? <span className="text-fg-subtle">—</span>}
                      </td>

                      {/* Duration */}
                      <td className="px-4 py-3">
                        <span className="text-xs text-fg-muted">
                          {t(DURATION_LABELS[c.duration_type])}
                          {c.custom_days && <span className="text-fg-subtle"> {t('codes.customDaysSuffix', { count: c.custom_days })}</span>}
                        </span>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <Badge tone={st.tone}>
                          <st.Icon size={12} />
                          {t(st.label)}
                        </Badge>
                      </td>

                      {/* Gültig bis */}
                      <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                        {c.status === 'active' && !isExpiredNow ? (
                          <CodeCountdown expiresAt={c.expires_at} />
                        ) : (
                          <span className="text-xs text-fg-subtle">
                            {format(new Date(c.expires_at), 'dd.MM.yy HH:mm', { locale: de })}
                          </span>
                        )}
                      </td>

                      {/* Used at */}
                      <td className="px-4 py-3 text-xs text-fg-muted whitespace-nowrap tabular-nums">
                        {c.used_at
                          ? format(new Date(c.used_at), 'dd.MM.yy HH:mm', { locale: de })
                          : <span className="text-fg-subtle">—</span>
                        }
                      </td>

                      {/* Created */}
                      <td className="px-4 py-3 text-xs text-fg-subtle whitespace-nowrap tabular-nums">
                        {format(new Date(c.created_at), 'dd.MM.yy HH:mm', { locale: de })}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 flex-wrap">
                          {/* Revoke — only for active, unused codes */}
                          {effectiveStatus === 'active' && isUnused && !isDeleted && !isHidden && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setConfirmAction({ type: 'revoke', code: c })}
                              title={t('codes.action.revoke')}
                              className="hover:border-critical hover:text-critical"
                            >
                              <Ban size={11} />{t('codes.action.revoke')}
                            </Button>
                          )}

                          {/* Delete — only for unused codes */}
                          {isUnused && !isDeleted && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setConfirmAction({ type: 'delete', code: c })}
                              title={t('common.delete')}
                              className="hover:border-critical hover:text-critical"
                            >
                              <Trash2 size={11} />{t('common.delete')}
                            </Button>
                          )}

                          {/* Hide — always available if not already hidden */}
                          {!isHidden && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => { setHideReason(''); setConfirmAction({ type: 'hide', code: c }); }}
                              title={t('codes.action.hide')}
                              className="hover:border-caution hover:text-caution"
                            >
                              <EyeOff size={11} />{t('codes.action.hide')}
                            </Button>
                          )}

                          {/* Details — always shown */}
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setDetailsCode(c)}
                            title={t('codes.action.details')}
                            className="hover:border-brand hover:text-brand-text"
                          >
                            <Info size={11} />{t('codes.action.details')}
                          </Button>
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
          destructive
          onConfirm={executeAction}
          onCancel={() => setConfirmAction(null)}
          busy={actionInFlight}
        />
      )}

      {confirmAction?.type === 'delete' && (
        <ConfirmDialog
          title={t('codes.confirm.deleteTitle')}
          body={t('codes.confirm.deleteBody')}
          confirmLabel={actionInFlight ? t('codes.deleting') : t('common.delete')}
          destructive
          onConfirm={executeAction}
          onCancel={() => setConfirmAction(null)}
          busy={actionInFlight}
        />
      )}

      {confirmAction?.type === 'hide' && (
        <ConfirmDialog
          title={t('codes.confirm.hideTitle')}
          body={t('codes.confirm.hideBody')}
          confirmLabel={actionInFlight ? t('codes.hiding') : t('codes.action.hide')}
          onConfirm={executeAction}
          onCancel={() => setConfirmAction(null)}
          busy={actionInFlight}
          extra={
            <Field label={t('codes.field.reasonOptional')}>
              <Input
                type="text"
                value={hideReason}
                onChange={e => setHideReason(e.target.value)}
                placeholder={t('codes.reasonPlaceholder')}
              />
            </Field>
          }
        />
      )}
    </div>
  );
}

// ─── Confirmation Dialog ──────────────────────────────────────────────────────

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  extra?: React.ReactNode;
}

// A Dialog, not the ui ConfirmDialog: it stays open while the RPC runs and the
// caller closes it by clearing confirmAction.
function ConfirmDialog({ title, body, confirmLabel, destructive = false, onConfirm, onCancel, busy = false, extra }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="max-w-sm" onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-fg-muted">{body}</DialogDescription>
        </DialogHeader>
        {extra}
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Generated Code Modal ─────────────────────────────────────────────────────

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
    // The code is shown once, so a stray click or Escape must not discard it:
    // only the two buttons close this, as before.
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        hideClose
        className="max-w-sm text-center"
        onPointerDownOutside={e => e.preventDefault()}
        onEscapeKeyDown={e => e.preventDefault()}
      >
        <DialogHeader className="items-center pr-0">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-brand/25 bg-brand-soft">
            <KeyRound className="text-brand-text" size={24} />
          </div>
          <DialogTitle className="sr-only">{t('codes.generated.label')}</DialogTitle>
          <DialogDescription className="sr-only">{t('codes.generated.hiddenAfterClose')}</DialogDescription>
        </DialogHeader>

        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-3 text-fg-subtle">
            {t('codes.generated.label')}
          </p>
          <div className="select-all rounded-tile border-2 border-brand/25 bg-brand-soft px-4 py-4 font-mono text-4xl font-bold tracking-[0.35em] text-brand-text sm:text-5xl">
            {code}
          </div>
        </div>

        <Alert tone="caution" icon={Clock} className="text-left">
          <p className="text-xs">
            {t('codes.generated.validityBefore')}{' '}
            <strong className="text-caution">{t('codes.generated.validityStrong')}</strong>{' '}
            {t('codes.generated.validityAfter')}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <CodeCountdown expiresAt={expiresAt} />
          </div>
        </Alert>

        {mail && (
          <p
            className={cn('text-xs', mail.sent ? 'text-positive' : mail.hadRecipient ? 'text-caution' : 'text-fg-subtle')}
          >
            {mail.sent
              ? tPlural({ one: 'codes.generated.mailSent.one', other: 'codes.generated.mailSent.other' }, mail.recipientCount)
              : mail.hadRecipient
                ? t('codes.generated.mailFailed')
                : t('codes.generated.mailNoRecipient')}
          </p>
        )}

        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={handleCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t('codes.copied') : t('common.copy')}
          </Button>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>

        <p className="text-[11px] text-fg-subtle">
          {t('codes.generated.hiddenAfterClose')}
        </p>
      </DialogContent>
    </Dialog>
  );
}

// ─── Details Modal ────────────────────────────────────────────────────────────

function DetailsModal({ code, onClose }: { code: ActivationCode; onClose: () => void }) {
  const { t } = useTranslation();
  const st = STATUS_CFG[code.status] ?? STATUS_CFG.expired;
  // Timestamps keep the German DD.MM.YYYY format in both languages — see src/i18n/index.ts.
  const rows: [string, React.ReactNode][] = [
    [t('codes.details.codeMasked'), <span className="font-mono">••{code.code_last4 ?? '????'}</span>],
    [t('common.status'), <Badge tone={st.tone}><st.Icon size={12} />{t(st.label)}</Badge>],
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
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('codes.details.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('codes.details.title')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 py-1.5 text-sm border-b border-line">
              <span className="text-fg-subtle">{label}</span>
              <span className="text-right font-medium text-fg">{value}</span>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
