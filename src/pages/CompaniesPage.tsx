import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, Plus, Search, Eye, Pencil as Edit2, MoreVertical,
  CheckCircle, XCircle, PauseCircle, Users, ChevronRight,
  Globe, Mail, Phone, MapPin, Calendar, RefreshCw, ArrowLeft, User,
  Shield, Save, ExternalLink, Archive, Trash2, AlertTriangle,
  RotateCcw, Lock, ChevronDown, Download,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { callPlatformRpc } from '../lib/platformRpc';
import {
  deleteCompanyCompletely,
  fetchDeletionPreview,
  IncompleteDeletionError,
} from '../lib/platformCompanyDeletion';
import { CompanyDeletionPreview, type PreviewState } from '../components/CompanyDeletionPreview';
import { fetchCompanies, fetchUsers } from '../lib/platformDirectoryClient';
import { platformReadRefusalKey } from '../lib/platformReadModels';
import { contextRefusalMessage } from '../lib/supportSession';
import { fetchPlatformAccess, openCompanyContext } from '../lib/supportSessionClient';
import { withCompanyWriteSession, type CompanyWriteSessionPurpose } from '../lib/companyWriteSession';
import { TENANT_HOME } from '../lib/adminGate';
import { useAuth, type CompanyStatus } from '../contexts/AuthContext';
import { useSuperAdmin, CompanyListItem } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { format, differenceInDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import CompanyModulesCard from '../components/admin/CompanyModulesCard';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { buildCompaniesExport } from '../lib/panelExports';
import { useExportChrome } from '../hooks/useExportChrome';
import { berlinToday } from '../utils/salaryCashReceiptFlow';
import {
  Alert, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  EmptyState, Field, Input, NativeSelect, PageHeader, Tabs, TabsList, TabsTrigger, cn,
  type BadgeProps,
} from '../components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

// CompanyStatus is imported from AuthContext, which reads the column on every
// load: the six values companies_status_check allows, declared once.

interface CompanyUser {
  id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  role: string;
  status: string;
  is_super_admin: boolean;
  created_at: string;
}

interface CompanyFormData {
  name: string;
  slug: string;
  legal_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  postal_code: string;
  country: string;
  status: 'active' | 'suspended' | 'inactive';
}

interface AdminFormData {
  full_name: string;
  email: string;
  password: string;
}

// ─── Status config ────────────────────────────────────────────────────────────

// Object keys are the values stored in `companies.status`, which drive RLS and
// the approval gates in App.tsx — never translate the key or a comparison, only
// the label. `label` holds a TranslationKey because this map is module-level
// and t() is a hook value; SuperAdminDashboard.tsx resolves the same key set.
// `tone` is the Badge tone the status is drawn in: the word and the icon carry
// the meaning, the tone only the emphasis.
const STATUS_CONFIG: Record<CompanyStatus, { label: TranslationKey; icon: React.ElementType; tone: BadgeProps['tone'] }> = {
  active:    { label: 'sa.status.active',    icon: CheckCircle,    tone: 'positive' },
  suspended: { label: 'sa.status.suspended', icon: PauseCircle,    tone: 'critical' },
  inactive:  { label: 'sa.status.inactive',  icon: XCircle,        tone: 'neutral' },
  archived:  { label: 'sa.status.archived',  icon: Archive,        tone: 'neutral' },
  deleted:   { label: 'sa.status.deleted',   icon: Trash2,         tone: 'critical' },
};

// ─── Shared primitives ────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CompanyStatus }) {
  const { t } = useTranslation();
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.inactive;
  const Icon = cfg.icon;
  return (
    <Badge tone={cfg.tone}>
      <Icon aria-hidden />{t(cfg.label)}
    </Badge>
  );
}

// ─── Lifecycle Confirmation Modal ─────────────────────────────────────────────

type LifecycleAction = 'suspend' | 'reactivate' | 'archive' | 'restore' | 'softDelete' | 'hardDelete';

interface LifecycleConfirmProps {
  action: LifecycleAction;
  company: CompanyListItem;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

// `title` / `description` / `confirmLabel` hold TranslationKeys: this map is
// module-level and t() is a hook value. LifecycleConfirmModal resolves them.
const LIFECYCLE_META: Record<LifecycleAction, {
  title: TranslationKey;
  description: TranslationKey;
  confirmLabel: TranslationKey;
  confirmPlaceholder?: TranslationKey;
  confirmMatch?: string;
  dangerLevel: 'medium' | 'high' | 'critical';
}> = {
  suspend: {
    title: 'sa.lifecycle.suspend.title',
    description: 'sa.lifecycle.suspend.description',
    confirmLabel: 'sa.lifecycle.suspend.confirm',
    dangerLevel: 'medium',
  },
  reactivate: {
    title: 'sa.lifecycle.reactivate.title',
    description: 'sa.lifecycle.reactivate.description',
    confirmLabel: 'sa.lifecycle.reactivate.confirm',
    dangerLevel: 'medium',
  },
  archive: {
    title: 'sa.lifecycle.archive.title',
    description: 'sa.lifecycle.archive.description',
    confirmLabel: 'sa.lifecycle.archive.confirm',
    dangerLevel: 'high',
  },
  restore: {
    title: 'sa.lifecycle.restore.title',
    description: 'sa.lifecycle.restore.description',
    confirmLabel: 'sa.lifecycle.restore.confirm',
    dangerLevel: 'medium',
  },
  softDelete: {
    title: 'sa.lifecycle.softDelete.title',
    description: 'sa.lifecycle.softDelete.description',
    confirmLabel: 'sa.lifecycle.softDelete.confirm',
    dangerLevel: 'high',
  },
  hardDelete: {
    title: 'sa.lifecycle.hardDelete.title',
    description: 'sa.lifecycle.hardDelete.description',
    confirmLabel: 'sa.lifecycle.hardDelete.confirm',
    confirmPlaceholder: 'sa.lifecycle.hardDelete.placeholder',
    dangerLevel: 'critical',
  },
};

function LifecycleConfirmModal({ action, company, onConfirm, onClose }: LifecycleConfirmProps) {
  const { t } = useTranslation();
  const meta = LIFECYCLE_META[action];
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  // A refusal stays inside the modal: a toast behind an open overlay is easy to miss.
  const [failure, setFailure] = useState<string | null>(null);

  const needsTyping = meta.dangerLevel === 'critical';

  // The complete deletion shows what it will remove before it asks for the name,
  // counted by the same database function that then carries it out. Confirming
  // waits for it: a name typed against a preview that never loaded is a
  // deletion of something the operator was not shown.
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  useEffect(() => {
    if (action !== 'hardDelete') return;
    let current = true;
    setPreview({ status: 'loading' });
    fetchDeletionPreview(company.id)
      .then(p => { if (current) setPreview({ status: 'ready', preview: p }); })
      .catch((err: unknown) => {
        if (current) setPreview({ status: 'failed', message: err instanceof Error ? err.message : t('common.error') });
      });
    return () => { current = false; };
  }, [action, company.id, t]);

  const previewReady = action !== 'hardDelete' || preview.status === 'ready';
  const canConfirm = (needsTyping ? confirmText.trim() === company.name.trim() : true) && previewReady;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm();
    } catch (err: any) {
      // callPlatformRpc throws the sentence the database wrote; a PostgREST error is not an Error but carries .message.
      setFailure(err?.message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent
        className={cn('max-w-md', meta.dangerLevel === 'critical' ? 'border-critical' : meta.dangerLevel === 'high' ? 'border-caution/50' : '')}
        // The old overlay ignored a click beside the dialog, and so does this one.
        onInteractOutside={event => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-tile', meta.dangerLevel === 'critical' ? 'bg-critical-soft text-critical' : 'bg-caution-soft text-caution')}>
              {meta.dangerLevel === 'critical'
                ? <Trash2 aria-hidden className="size-4" />
                : <AlertTriangle aria-hidden className="size-4" />
              }
            </span>
            {t(meta.title)}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Company pill */}
          <div className="flex flex-wrap items-center gap-2 rounded-tile border border-line bg-sunken px-3 py-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-tight bg-brand-soft text-xs font-bold text-brand-text">
              {company.name.charAt(0).toUpperCase()}
            </div>
            <span className="min-w-0 break-words text-sm font-semibold text-fg">{company.name}</span>
            <StatusBadge status={company.status as CompanyStatus} />
          </div>

          <DialogDescription className="text-sm leading-relaxed text-fg-muted">{t(meta.description)}</DialogDescription>

          {action === 'hardDelete' && <CompanyDeletionPreview state={preview} />}

          {needsTyping && (
            <Field
              label={t('sa.lifecycle.typeNameLabel')}
              error={confirmText.length > 0 && confirmText.trim() !== company.name.trim() ? t('sa.lifecycle.nameMismatch') : undefined}
            >
              <Input
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={company.name}
                autoFocus
              />
            </Field>
          )}

          {meta.dangerLevel === 'critical' && (
            <Alert tone="critical">{t('sa.lifecycle.criticalWarning')}</Alert>
          )}

          {failure && (
            <Alert tone="critical" title={t('sa.lifecycle.failedTitle')}>{failure}</Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          {/* A FILL under a label: `danger` is the -solid fill with its own label colour. */}
          <Button
            variant={meta.dangerLevel === 'medium' ? 'primary' : 'danger'}
            onClick={handleConfirm}
            disabled={!canConfirm || busy}
          >
            {busy && <RefreshCw size={13} className="motion-safe:animate-spin" />}
            {t(meta.confirmLabel)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── A support session around one account write (plan 3.13a) ─────────────────

/*
  Since 3.13a `manage-users` acts for a platform account only on the company of
  its open support session, so the two flows here that create an account for a
  company — the wizard's first administrator and "Benutzer hinzufügen" — open
  an audited support session on that company themselves, with a fixed reason,
  around the one `create` call (`withCompanyWriteSession`, which also decides
  when to reuse a session and when to refuse).

  The session is opened with the raw client rather than the provider's
  `openCompany`, so nothing is installed: no bar appears and `effectiveCompanyId`
  never moves. It is closed with the provider's `closeCompany`, which marks the
  close as intended (no "session ended" notice) and re-asks `platform_whoami()`,
  so the provider follows even if a focus re-ask saw the session meanwhile. A
  refusal re-asks too, so the bar shows the session the operator has to end.

  Resolves the write's value, or `undefined` when the flow refused — the refusal
  is then already on screen. Throws the write's own error, or the database's
  refusal to open the session, for the caller to show with
  `contextRefusalMessage` (a sentence, never a reason code).
*/
function useCompanyWriteSession() {
  const { closeCompany, reloadPlatformAccess } = useSuperAdmin();
  const { showToast } = useToast();
  const { t } = useTranslation();

  return useCallback(async <T,>(
    companyId: string,
    purpose: CompanyWriteSessionPurpose,
    act: () => Promise<T>,
  ): Promise<T | undefined> => {
    const outcome = await withCompanyWriteSession(companyId, purpose, {
      currentAccess: fetchPlatformAccess,
      open: async (id, reason) => { await openCompanyContext(id, 'support', reason); },
      close: closeCompany,
    }, act);

    if (!outcome.ok) {
      reloadPlatformAccess();
      showToast('error', t(outcome.refusal === 'view_open'
        ? 'sa.companies.session.viewOpen'
        : 'sa.companies.session.otherCompanyOpen'));
      return undefined;
    }
    if (outcome.closeFailed) {
      showToast('warning', t('sa.companies.session.closeFailed'));
    }
    return outcome.value;
  }, [closeCompany, reloadPlatformAccess, showToast, t]);
}

/**
 * `manage-users/create` for one company. The function answers in German and its
 * text is shown verbatim — `support_session_required` included, which the
 * session around this call makes unreachable; only the fallback is translated.
 */
async function createCompanyAccount(body: Record<string, unknown>, fallback: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || fallback);
}

// ─── Create Company Modal ─────────────────────────────────────────────────────

interface CreateCompanyModalProps {
  onClose: () => void;
  onCreated: (company: CompanyListItem) => void;
}

function CreateCompanyModal({ onClose, onCreated }: CreateCompanyModalProps) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const inSupportSession = useCompanyWriteSession();
  const [step, setStep] = useState<1 | 2>(1);
  const [saving, setSaving] = useState(false);
  const [createdCompany, setCreatedCompany] = useState<CompanyListItem | null>(null);

  const [form, setForm] = useState<CompanyFormData>({
    name: '', slug: '', legal_name: '', email: '', phone: '',
    // `country` is a value written to companies.country, not a label.
    address: '', city: '', postal_code: '', country: 'Deutschland', status: 'active',
  });
  const [adminForm, setAdminForm] = useState<AdminFormData>({ full_name: '', email: '', password: '' });
  const [adminSaving, setAdminSaving] = useState(false);

  useEffect(() => {
    if (form.name && !form.slug) {
      const slug = form.name.toLowerCase()
        .replace(/[äöü]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue' }[c] || c))
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      setForm(f => ({ ...f, slug }));
    }
  }, [form.name]);

  const handleCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.slug.trim()) { showToast('error', t('sa.companies.errorNameSlugRequired')); return; }
    try {
      setSaving(true);
      const result = await callPlatformRpc('platform_company_create', {
        p_name: form.name.trim(), p_slug: form.slug.trim(),
        p_legal_name: form.legal_name.trim() || null, p_email: form.email.trim() || null,
        p_phone: form.phone.trim() || null, p_address: form.address.trim() || null,
        p_city: form.city.trim() || null, p_postal_code: form.postal_code.trim() || null,
        p_country: form.country.trim() || 'Deutschland', p_status: form.status,
      });
      setCreatedCompany(result.company as CompanyListItem);
      setStep(2);
      showToast('success', t('sa.companies.toast.created'));
    } catch (err: any) {
      showToast('error', err?.reason === 'slug_taken' ? t('sa.companies.errorSlugTaken') : err.message || t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminForm.full_name.trim() || !adminForm.email.trim() || !adminForm.password.trim()) {
      showToast('error', t('sa.companies.errorAllFieldsRequired')); return;
    }
    if (adminForm.password.length < 8) { showToast('error', t('sa.companies.errorPasswordShort')); return; }
    if (!createdCompany) return;
    try {
      setAdminSaving(true);
      const created = await inSupportSession(createdCompany.id, 'firstAdmin', async () => {
        await createCompanyAccount(
          { email: adminForm.email.trim(), full_name: adminForm.full_name.trim(), role: 'admin', company_id: createdCompany.id, password: adminForm.password },
          t('common.error'));
        return true;
      });
      if (!created) return;
      showToast('success', t('sa.companies.toast.adminCreated'));
      onCreated(createdCompany);
    } catch (err: any) {
      showToast('error', contextRefusalMessage(err, t) || t('sa.companies.errorCreateAdmin'));
    } finally {
      setAdminSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl" onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-lg">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-brand-soft text-brand-text">
              <Building2 aria-hidden className="size-5" />
            </span>
            {t(step === 1 ? 'sa.companies.createTitle' : 'sa.companies.firstAdminTitle')}
          </DialogTitle>
          <DialogDescription>{t('sa.companies.stepOfTwo', { step })}</DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <form onSubmit={handleCreateCompany} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('sa.companies.field.name')} className="sm:col-span-2">
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="El-Professor GmbH" required />
              </Field>
              <Field label={t('sa.companies.field.slug')}>
                <Input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))} placeholder="el-professor" required />
              </Field>
              <Field label={t('common.status')}>
                {/* `value` is the stored companies.status — only the label is translated. */}
                <NativeSelect value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as any }))}>
                  <option value="active">{t('sa.status.active')}</option>
                  <option value="suspended">{t('sa.status.suspended')}</option>
                  <option value="inactive">{t('sa.status.inactive')}</option>
                </NativeSelect>
              </Field>
              <Field label={t('sa.companies.field.legalName')} className="sm:col-span-2"><Input value={form.legal_name} onChange={e => setForm(f => ({ ...f, legal_name: e.target.value }))} /></Field>
              <Field label={t('sa.companies.field.email')}><Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></Field>
              <Field label={t('sa.companies.field.phone')}><Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></Field>
              <Field label={t('common.address')} className="sm:col-span-2"><Input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></Field>
              <Field label={t('sa.companies.field.postalCode')}><Input value={form.postal_code} onChange={e => setForm(f => ({ ...f, postal_code: e.target.value }))} /></Field>
              <Field label={t('sa.companies.field.city')}><Input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} /></Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={saving}>
                {saving ? <RefreshCw size={14} className="motion-safe:animate-spin" /> : <Building2 size={14} />}{t('sa.companies.createButton')}</Button>
            </DialogFooter>
          </form>
        )}

        {step === 2 && createdCompany && (
          <div className="space-y-5">
            <Alert tone="positive">{t('sa.companies.createdNotice', { name: createdCompany.name })}</Alert>
            <form onSubmit={handleCreateAdmin} className="space-y-4">
              <Field label={t('sa.companies.field.fullName')}><Input value={adminForm.full_name} onChange={e => setAdminForm(f => ({ ...f, full_name: e.target.value }))} required /></Field>
              <Field label={t('sa.companies.field.emailRequired')}><Input type="email" value={adminForm.email} onChange={e => setAdminForm(f => ({ ...f, email: e.target.value }))} required /></Field>
              <Field label={t('sa.companies.field.tempPassword')}><Input type="text" value={adminForm.password} onChange={e => setAdminForm(f => ({ ...f, password: e.target.value }))} minLength={8} required /></Field>
              <DialogFooter className="sm:justify-between">
                <Button type="button" variant="secondary" onClick={() => onCreated(createdCompany)}>{t('sa.companies.skip')}</Button>
                <Button type="submit" disabled={adminSaving}>
                  {adminSaving ? <RefreshCw size={14} className="motion-safe:animate-spin" /> : <User size={14} />}{t('sa.companies.createAdmin')}</Button>
              </DialogFooter>
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit Company Modal ───────────────────────────────────────────────────────

interface EditCompanyModalProps {
  company: CompanyListItem;
  onClose: () => void;
  onUpdated: (company: CompanyListItem) => void;
}

function EditCompanyModal({ company, onClose, onUpdated }: EditCompanyModalProps) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CompanyFormData>({
    name: company.name, slug: company.slug,
    legal_name: company.legal_name || '', email: company.email || '',
    phone: company.phone || '', address: company.address || '',
    city: company.city || '', postal_code: company.postal_code || '',
    country: company.country || 'Deutschland',
    status: (['active','suspended','inactive'].includes(company.status) ? company.status : 'inactive') as any,
  });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.slug.trim()) { showToast('error', t('sa.companies.errorNameSlugRequired')); return; }
    try {
      setSaving(true);
      const result = await callPlatformRpc('platform_company_update', {
        p_company_id: company.id,
        p_name: form.name.trim(), p_slug: form.slug.trim(),
        p_legal_name: form.legal_name.trim() || null, p_email: form.email.trim() || null,
        p_phone: form.phone.trim() || null, p_address: form.address.trim() || null,
        p_city: form.city.trim() || null, p_postal_code: form.postal_code.trim() || null,
        p_country: form.country.trim() || 'Deutschland', p_status: form.status,
      });
      showToast('success', t('sa.companies.toast.updated'));
      onUpdated(result.company as CompanyListItem);
    } catch (err: any) {
      showToast('error', err?.reason === 'slug_taken' ? t('sa.companies.errorSlugTaken') : err.message || t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl" onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-lg">{t('sa.companies.editTitle', { name: company.name })}</DialogTitle>
          <DialogDescription className="sr-only">{company.slug}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('sa.companies.field.name')} className="sm:col-span-2"><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required /></Field>
            <Field label={t('sa.companies.field.slug')}><Input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} required /></Field>
            <Field label={t('common.status')}>
              {/* `value` is the stored companies.status — only the label is translated. */}
              <NativeSelect value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as any }))}>
                <option value="active">{t('sa.status.active')}</option>
                <option value="suspended">{t('sa.status.suspended')}</option><option value="inactive">{t('sa.status.inactive')}</option>
              </NativeSelect>
            </Field>
            <Field label={t('sa.companies.field.legalName')} className="sm:col-span-2"><Input value={form.legal_name} onChange={e => setForm(f => ({ ...f, legal_name: e.target.value }))} /></Field>
            <Field label={t('sa.companies.field.email')}><Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></Field>
            <Field label={t('sa.companies.field.phone')}><Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></Field>
            <Field label={t('common.address')} className="sm:col-span-2"><Input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></Field>
            <Field label={t('sa.companies.field.postalCode')}><Input value={form.postal_code} onChange={e => setForm(f => ({ ...f, postal_code: e.target.value }))} /></Field>
            <Field label={t('sa.companies.field.city')}><Input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} /></Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={saving}>
              {saving ? <RefreshCw size={14} className="motion-safe:animate-spin" /> : <Save size={14} />}{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Invite Admin Modal ───────────────────────────────────────────────────────

interface InviteAdminModalProps {
  company: CompanyListItem;
  onClose: () => void;
  onInvited: () => void;
}

function InviteAdminModal({ company, onClose, onInvited }: InviteAdminModalProps) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const inSupportSession = useCompanyWriteSession();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ full_name: '', email: '', password: '', role: 'admin' });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.full_name.trim() || !form.email.trim() || !form.password.trim()) { showToast('error', t('sa.companies.errorAllFieldsRequired')); return; }
    if (form.password.length < 8) { showToast('error', t('sa.companies.errorPasswordShort')); return; }
    try {
      setSaving(true);
      const created = await inSupportSession(company.id, 'addUser', async () => {
        await createCompanyAccount(
          { email: form.email.trim(), full_name: form.full_name.trim(), role: form.role, company_id: company.id, password: form.password },
          t('common.error'));
        return true;
      });
      if (!created) return;
      showToast('success', t('sa.companies.toast.userCreated'));
      onInvited();
    } catch (err: any) {
      showToast('error', contextRefusalMessage(err, t) || t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md" onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-lg">{t('sa.companies.addUser')}</DialogTitle>
          <DialogDescription className="sr-only">{company.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label={t('sa.companies.field.nameRequired')}><Input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} required /></Field>
          <Field label={t('sa.companies.field.emailRequired')}><Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required /></Field>
          <Field label={t('sa.companies.field.role')}>
            {/* `value` is the stored user_profiles.role — only the label is translated. */}
            <NativeSelect value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
              <option value="admin">{t('sa.companies.role.admin')}</option><option value="creator">{t('sa.companies.role.creator')}</option><option value="viewer">{t('sa.companies.role.viewer')}</option>
            </NativeSelect>
          </Field>
          <Field label={t('sa.companies.field.tempPassword')}><Input type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} minLength={8} required /></Field>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={saving}>
              {saving ? <RefreshCw size={14} className="motion-safe:animate-spin" /> : <User size={14} />}{t('sa.companies.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Company Detail View ──────────────────────────────────────────────────────

interface CompanyDetailProps {
  company: CompanyListItem;
  onBack: () => void;
  onEdit: (company: CompanyListItem) => void;
  onLifecycleAction: (company: CompanyListItem, action: LifecycleAction) => void;
  onEnterCompany: (company: CompanyListItem) => void;
  onRefresh: () => void;
}

function CompanyDetail({ company, onBack, onEdit, onLifecycleAction, onEnterCompany, onRefresh }: CompanyDetailProps) {
  const [users, setUsers] = useState<CompanyUser[]>([]);
  // The true count, from the read model, so a company with more users than one
  // page holds still shows the right figure; null means "not readable here".
  const [usersTotal, setUsersTotal] = useState<number | null>(null);
  const [usersProblem, setUsersProblem] = useState<TranslationKey | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const { showToast } = useToast();
  const { t } = useTranslation();
  // Hidden for a role without the capability; the database refuses regardless.
  const { platformCan } = useSuperAdmin();
  const canLifecycle = platformCan('companies.lifecycle');
  const canHardDelete = platformCan('companies.hard_delete');
  const canManageUsers = platformCan('company_users.manage');
  const canOpenCompany = platformCan('business.read');

  const isArchived = company.status === 'archived';
  const isDeleted = company.status === 'deleted';
  const isOperational = !isArchived && !isDeleted;

  /*
    The drawer's user list comes from the audited read model, not from
    user_profiles directly. Since 20260917140000 (plan 3.4) a platform account
    reads no company's profiles with its own JWT, so the direct query returned
    `[]` with `error === null` — no throw, no toast — and the drawer showed
    "Benutzer 0" and its empty state for a company with twelve of them, while
    the Benutzer-verwalten actions stayed enabled. platform_users_list answers
    under business.read, takes the company as p_company_id, and records the read.

    The counts come from the model's `total`, not from items.length, so they
    stay true for a company with more users than one page holds while the table
    lists the first page. A refusal or a transport failure leaves them unknown
    and the figures show a dash, never a number that would be false.

    Two differences are by design rather than losses: the directory omits
    accounts carrying a platform_staff row (the team page is 3.12's), and it
    returns reduced columns — `id` is mapped from user_id, whose only use here
    is the row key.
  */
  const loadUsers = useCallback(async () => {
    try {
      setLoadingUsers(true);
      setUsersProblem(null);
      const page = await fetchUsers({
        companyId: company.id, search: '', status: null,
        sort: 'created_at_asc', pageIndex: 0,
      });
      if (!page.ok) {
        setUsers([]);
        setUsersTotal(null);
        setUsersProblem(platformReadRefusalKey(page.reason));
        return;
      }
      setUsers(page.items.map(u => ({
        id: u.user_id,
        user_id: u.user_id,
        email: u.email ?? '',
        full_name: u.full_name,
        role: u.role ?? '',
        status: u.status ?? '',
        is_super_admin: false,
        created_at: u.created_at ?? '',
      })));
      setUsersTotal(page.total);
    } catch {
      setUsers([]);
      setUsersTotal(null);
      setUsersProblem(platformReadRefusalKey('failed'));
      showToast('error', t('sa.companies.errorLoadUsers'));
    } finally {
      setLoadingUsers(false);
    }
  }, [company.id, t]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  return (
    <div className="space-y-6 font-ui">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" className="-ml-2.5 mb-3" onClick={onBack}>
            <ArrowLeft size={14} />{t('sa.companies.backToAll')}
          </Button>
          <div className="flex items-center gap-3">
            <div className={cn('flex size-12 shrink-0 items-center justify-center rounded-surface text-xl font-bold', isArchived ? 'bg-neutral-soft text-neutral' : 'bg-brand-soft text-brand-text')}>
              {company.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h1 className="break-words text-2xl font-semibold leading-[1.2] tracking-[-0.025em] text-fg">{company.name}</h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <code className="rounded-chip bg-sunken px-1.5 py-0.5 text-xs text-fg-muted">{company.slug}</code>
                <StatusBadge status={company.status as CompanyStatus} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isOperational && canOpenCompany && (
            <Button onClick={() => onEnterCompany(company)}>
              <ExternalLink size={14} />{t('sa.companies.openAsCompany')}
            </Button>
          )}
          {isOperational && canLifecycle && (
            <Button variant="secondary" onClick={() => onEdit(company)}>
              <Edit2 size={14} />{t('common.edit')}
            </Button>
          )}

          {/* Lifecycle actions dropdown */}
          <div className="relative [&[hidden]]:hidden" hidden={!canLifecycle}>
            <Button variant="secondary" onClick={() => setActionMenuOpen(v => !v)}>
              <MoreVertical size={14} />{t('sa.companies.actions')}<ChevronDown size={12} />
            </Button>
            {actionMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setActionMenuOpen(false)} />
                <div className="glass-strong absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-tile py-1">

                  {/* Operational status changes */}
                  {isOperational && company.status !== 'active' && (
                    <button onClick={() => { onLifecycleAction(company, 'reactivate'); setActionMenuOpen(false); }}
                      className={`${MENU_ITEM_CLASS} text-positive hover:bg-positive-soft`}>
                      <CheckCircle size={14} />{t('sa.lifecycle.reactivate.confirm')}
                    </button>
                  )}
                  {isOperational && company.status !== 'suspended' && (
                    <button onClick={() => { onLifecycleAction(company, 'suspend'); setActionMenuOpen(false); }}
                      className={`${MENU_ITEM_CLASS} text-caution hover:bg-caution-soft`}>
                      <PauseCircle size={14} />{t('sa.companies.menu.suspend')}
                    </button>
                  )}

                  {/* Archive */}
                  {isOperational && (
                    <button onClick={() => { onLifecycleAction(company, 'archive'); setActionMenuOpen(false); }}
                      className={`${MENU_ITEM_CLASS} text-fg-muted hover:bg-sunken`}>
                      <Archive size={14} />{t('sa.lifecycle.archive.confirm')}
                    </button>
                  )}

                  {/* Restore from archive */}
                  {isArchived && (
                    <button onClick={() => { onLifecycleAction(company, 'restore'); setActionMenuOpen(false); }}
                      className={`${MENU_ITEM_CLASS} text-brand-text hover:bg-brand-soft`}>
                      <RotateCcw size={14} />{t('sa.companies.menu.restoreFromArchive')}
                    </button>
                  )}

                  {/* Restore from soft delete */}
                  {isDeleted && (
                    <button onClick={() => { onLifecycleAction(company, 'restore'); setActionMenuOpen(false); }}
                      className={`${MENU_ITEM_CLASS} text-brand-text hover:bg-brand-soft`}>
                      <RotateCcw size={14} />{t('sa.companies.menu.undoDeletion')}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Archived/Deleted notice banner */}
      {(isArchived || isDeleted) && (
        <Alert
          tone={isDeleted ? 'critical' : 'neutral'}
          icon={isDeleted ? Trash2 : Archive}
          title={t(isDeleted ? 'sa.companies.banner.deletedTitle' : 'sa.status.archived')}
        >
          {t(isDeleted ? 'sa.companies.banner.deletedBody' : 'sa.companies.banner.archivedBody')}
        </Alert>
      )}

      {/* Info cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="glass-card space-y-3 rounded-surface p-5 md:col-span-2">
          <h3 className={SECTION_LABEL_CLASS}>{t('sa.companies.companyData')}</h3>
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {company.legal_name && (
              <InfoItem label={t('sa.companies.legalName')}>{company.legal_name}</InfoItem>
            )}
            {company.email && (
              <InfoItem icon={Mail} label={t('sa.companies.email')}>{company.email}</InfoItem>
            )}
            {company.phone && (
              <InfoItem icon={Phone} label={t('sa.companies.phone')}>{company.phone}</InfoItem>
            )}
            {(company.city || company.address) && (
              <InfoItem icon={MapPin} label={t('common.address')}>{[company.address, company.postal_code, company.city, company.country].filter(Boolean).join(', ')}</InfoItem>
            )}
            <InfoItem icon={Globe} label={t('sa.companies.slug')}>{company.slug}</InfoItem>
            <InfoItem icon={Calendar} label={t('sa.companies.created')}>{format(new Date(company.created_at), 'dd.MM.yyyy', { locale: de })}</InfoItem>
          </div>
        </div>

        <div className="glass-card space-y-4 rounded-surface p-5">
          <h3 className={SECTION_LABEL_CLASS}>{t('sa.companies.statistics')}</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-fg-muted"><Users size={14} />{t('sa.companies.users')}</div>
              <span className="text-lg font-bold tabular-nums text-fg">{usersTotal ?? '–'}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-fg-muted"><Shield size={14} />{t('sa.companies.admins')}</div>
              {/* Counted from the page in hand, so it is only the truth when
                  the page holds every user; otherwise it says so. */}
              <span className="text-lg font-bold tabular-nums text-fg">
                {usersTotal !== null && usersTotal === users.length ? users.filter(u => u.role === 'admin').length : '–'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Modules (per-company sidebar modules, slice 1). Its own component and
          on the design system's tokens rather than this file's inline style
          objects — the reason is in that file's header. `canLifecycle` is the
          capability its RPC asks, so the checkboxes are drawn read-only for a
          role that would be refused; the database refuses regardless. */}
      <CompanyModulesCard companyId={company.id} canEdit={canLifecycle} />

      {/* Users table */}
      <div className="glass-card relative overflow-x-auto rounded-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
          <h3 className="font-semibold text-fg">
            {usersTotal === null ? t('sa.companies.users') : t('sa.companies.usersCount', { count: usersTotal })}
          </h3>
          {isOperational && canManageUsers && (
            <Button variant="secondary" size="sm" onClick={() => setShowInviteModal(true)}>
              <Plus size={12} />{t('sa.companies.addUser')}
            </Button>
          )}
        </div>
        {loadingUsers ? (
          <div className="flex items-center justify-center py-10"><RefreshCw size={18} className="text-fg-subtle motion-safe:animate-spin" /></div>
        ) : usersProblem ? (
          // "Not readable from here" is not "this company has no users".
          <EmptyState icon={Users} size="sm" title={t(usersProblem)} />
        ) : users.length === 0 ? (
          <EmptyState icon={Users} size="sm" title={t('sa.companies.noUsers')} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-wash">
                {([
                  'sa.companies.col.name', 'sa.companies.email',
                  'sa.companies.col.role', 'common.status', 'sa.companies.created',
                ] as const).map((h, i) => (
                  <th key={i} className={TH_CLASS}>{t(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-line hover:bg-sunken">
                  <td className="px-5 py-3 font-medium text-fg">{u.full_name || '—'}</td>
                  <td className="px-5 py-3 text-fg-muted">{u.email}</td>
                  <td className="px-5 py-3">
                    <Badge tone={u.role === 'admin' ? 'critical' : 'neutral'}>{u.role}</Badge>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={u.status === 'active' ? 'positive' : 'neutral'}>{u.status}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-xs tabular-nums text-fg-subtle">{format(new Date(u.created_at), 'dd.MM.yyyy')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Danger Zone */}
      <div className="overflow-hidden rounded-surface border border-critical bg-critical-soft" hidden={!canLifecycle && !canHardDelete}>
        <button
          onClick={() => setDangerOpen(v => !v)}
          className="flex w-full items-center justify-between px-5 py-4 text-left [@media(pointer:coarse)]:min-h-11"
        >
          <div className="flex items-center gap-2">
            <Lock size={14} className="text-critical" />
            <span className="text-sm font-semibold text-critical">{t('sa.companies.dangerZone')}</span>
          </div>
          <ChevronDown size={14} className={cn('text-critical motion-safe:transition-transform motion-safe:duration-200', dangerOpen && 'rotate-180')} />
        </button>

        {dangerOpen && (
          <div className="space-y-3 border-t border-critical px-5 pb-5">
            <p className="pt-3 text-xs text-fg-muted">
              {t('sa.companies.dangerZoneNote')}
            </p>

            <div className="space-y-2">
              {/* Soft delete */}
              {company.status !== 'deleted' && canLifecycle && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-tile border border-line bg-raised p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">{t('sa.lifecycle.softDelete.confirm')}</p>
                    <p className="mt-0.5 text-xs text-fg-muted">{t('sa.companies.softDeleteNote')}</p>
                  </div>
                  <Button variant="danger" size="sm" onClick={() => onLifecycleAction(company, 'softDelete')}>
                    <Trash2 size={12} />{t('sa.companies.markForDeletion')}
                  </Button>
                </div>
              )}

              {/* Hard delete — only available when already soft-deleted */}
              {company.status === 'deleted' && canHardDelete && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-tile border-2 border-critical bg-critical-soft p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-critical">{t('sa.lifecycle.hardDelete.confirm')}</p>
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {t('sa.companies.hardDeleteNote')}
                    </p>
                  </div>
                  <Button variant="danger" size="sm" className="font-bold" onClick={() => onLifecycleAction(company, 'hardDelete')}>
                    <Trash2 size={12} />{t('sa.lifecycle.hardDelete.confirm')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {showInviteModal && (
        <InviteAdminModal company={company} onClose={() => setShowInviteModal(false)} onInvited={() => { setShowInviteModal(false); loadUsers(); onRefresh(); }} />
      )}
    </div>
  );
}

// ─── Main Companies Page ──────────────────────────────────────────────────────

export default function CompaniesPage() {
  const { isSuperAdmin } = useAuth();
  const { openCompany, platformCan } = useSuperAdmin();
  const navigate = useNavigate();
  // Hidden for a role without the capability; the database refuses regardless.
  const canLifecycle = platformCan('companies.lifecycle');
  const canOpenCompany = platformCan('business.read');
  const { showToast } = useToast();
  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  const exportChrome = useExportChrome();

  const [companies, setCompanies] = useState<CompanyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * The `companies` read did not succeed.
   *
   * It had no flag at all: the catch showed a toast and left `companies` at
   * whatever it held — `[]` on a first load — so the screen drew "Noch keine
   * Unternehmen" over a platform that has nineteen, and the header's count said
   * 0. A toast is gone in four seconds; the claim stays. **The rule: a list whose
   * read did not succeed is not an empty list**, and the Excel export below is
   * withheld while this is set, because a file makes that claim with more
   * authority than a screen does.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CompanyStatus>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCompany, setEditingCompany] = useState<CompanyListItem | null>(null);
  const [viewingCompany, setViewingCompany] = useState<CompanyListItem | null>(null);
  const [lifecycleModal, setLifecycleModal] = useState<{ action: LifecycleAction; company: CompanyListItem } | null>(null);

  const loadCompanies = useCallback(async () => {
    try {
      setLoading(true);
      setLoadFailed(false);
      const { data, error } = await supabase.from('companies').select('*').order('created_at', { ascending: false });
      if (error) throw error;

      // The user count per company comes from the audited read model. Counting
      // user_profiles here with the caller's own JWT returns 0 for every
      // company since 20260917140000 (plan 3.4): a platform account reads no
      // company's profiles directly any more, so the column would tell the
      // owner that every customer has no users. platform_companies_list
      // computes the same figure server-side, under companies.read, and records
      // the read.
      //
      // One page, which is what fetchCompanies offers by design — it is a
      // convenience and every call writes an audit row. A company beyond that
      // page gets no count, and so does a refusal or a transport failure: the
      // column then shows a dash, because a missing number is honest where a 0
      // is not, and the list itself must still render either way.
      const userCounts: Record<string, number> = {};
      try {
        const page = await fetchCompanies();
        if (page.ok) {
          for (const row of page.items) userCounts[row.id] = row.user_count;
        }
      } catch {
        /* the count stays unknown; the companies still list */
      }
      setCompanies((data || []).map(c => ({ ...c, user_count: userCounts[c.id] })) as CompanyListItem[]);
    } catch {
      setLoadFailed(true);
      showToast('error', t('sa.companies.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  // Execute lifecycle action
  // The company row and its users' status change together, in one transaction,
  // and the change is audited. The RPC skips a user who is platform staff, as
  // this screen skipped the profiles it saw flagged.
  const LIFECYCLE_RPC_ACTION: Record<Exclude<LifecycleAction, 'hardDelete'>, string> = {
    suspend: 'suspend', reactivate: 'reactivate', archive: 'archive',
    restore: 'restore', softDelete: 'mark_deleted',
  };

  const executeLifecycleAction = async (action: LifecycleAction, company: CompanyListItem): Promise<void> => {
    if (action !== 'hardDelete') {
      await callPlatformRpc('platform_company_lifecycle', {
        p_company_id: company.id,
        p_action: LIFECYCLE_RPC_ACTION[action],
      });
      const toastKey = {
        suspend: 'sa.companies.toast.suspended', reactivate: 'sa.companies.toast.reactivated',
        archive: 'sa.companies.toast.archived', softDelete: 'sa.companies.toast.softDeleted',
      }[action as Exclude<LifecycleAction, 'hardDelete' | 'restore'>];
      if (action === 'restore') {
        showToast('success', t('sa.companies.toast.restored', { name: company.name, status: t('sa.status.inactive') }));
      } else {
        showToast('success', t(toastKey as TranslationKey, { name: company.name }));
      }
    }

    if (action === 'hardDelete') {
      // Not a direct delete any more: login accounts and stored files cannot be
      // removed from the browser, and the open-context guard needs the caller's
      // own token. See platformCompanyDeletion.ts.
      try {
        const outcome = await deleteCompanyCompletely(company.id, company.name);
        showToast('success', t('sa.deletion.done', {
          name: company.name, rows: outcome.rowsTotal, accounts: outcome.accountsDeleted,
        }));
      } catch (err) {
        // The company is gone but a clean-up step did not finish: say what
        // remains, refresh the list, and do not leave the operator on a company
        // that no longer exists.
        if (err instanceof IncompleteDeletionError) {
          showToast('error', err.message);
          setViewingCompany(null);
          await loadCompanies();
          return;
        }
        throw err;
      }
      setViewingCompany(null);
    }

    await loadCompanies();
    if (viewingCompany?.id === company.id && action !== 'hardDelete') {
      const updated = companies.find(c => c.id === company.id);
      if (updated) setViewingCompany(updated);
    }
  };

  const handleLifecycleAction = (company: CompanyListItem, action: LifecycleAction) => {
    setLifecycleModal({ action, company });
  };

  /*
    Opening a company asks the database for a **read** context (plan 3.4b).

    Least privilege, and it is also the shorter road: `view` needs no reason,
    and the bar inside the company offers "Support-Sitzung starten" for the
    moment something actually has to be written. Opening straight into a write
    session would mean asking for a justification before anyone knows whether
    one is needed.

    The context is the database's answer, not this click's: on success the tab
    goes into the company, on refusal it says which refusal it was and stays.
  */
  const handleEnterCompany = async (company: CompanyListItem) => {
    try {
      await openCompany(company, 'view');
      showToast('success', t('sa.companies.toast.nowActiveAs', { name: company.name }));
      navigate(TENANT_HOME);
    } catch (error) {
      showToast('error', contextRefusalMessage(error, t));
    }
  };

  /**
   * The customer list as a workbook.
   *
   * **The rule being preserved: a file says what it holds.** Unlike every other
   * panel screen, this one reads `public.companies` directly — the one table
   * decision D14 left readable on `companies.read`, because choosing a company
   * to open a context on cannot itself require a context — so the file covers
   * every row the screen read and the band says "ganze Liste" rather than naming
   * a page. What it does not claim is a *complete platform*: PostgREST answers a
   * `select('*')` with at most 1000 rows, and a nineteen-customer platform is
   * nowhere near that, but the wording is about the screen's own list either way.
   *
   * The columns are the screen's own five plus the slug. `select('*')` also hands
   * this page `legal_name`, `phone`, `address`, `postal_code`, `country` and
   * `logo_url`; none is on screen and none is in the file — the recipient's
   * postal address already travels on the invoice PDF, which is the document
   * that needs it. Widening this is a data protection decision.
   *
   * `user_count` is absent for a company `platform_companies_list` did not reach
   * on its one page; the builder writes an em dash there and names how many rows
   * are affected, exactly as the table prints a dash. There is deliberately no
   * totals row: a sum over a column with unknown cells is a wrong number.
   */
  const handleExport = () => {
    try {
      exportPicker.table('companies', buildCompaniesExport({
        rows: filtered.map(company => ({
          name: company.name,
          slug: company.slug,
          status: company.status,
          email: company.email,
          city: company.city,
          created_at: company.created_at,
          user_count: company.user_count,
        })),
        filters: [
          {
            label: t('common.status'),
            value: statusFilter === 'all' ? t('common.all') : t(STATUS_CONFIG[statusFilter].label),
          },
          { label: t('sa.companies.export.filterSearch'), value: search || null },
        ],
        filterLineTemplate: t('ui.export.filterLine'),
        today: berlinToday(),
        labels: {
          sheetTitle: t('sa.companies.title'),
          name: t('sa.companies.col.name'),
          slug: t('sa.companies.export.slug'),
          status: t('common.status'),
          email: t('sa.companies.export.email'),
          city: t('sa.companies.export.city'),
          users: t('sa.companies.users'),
          created: t('sa.companies.created'),
          // STATUS_CONFIG, the module-level map `StatusBadge` draws from, so the
          // word in the file is the word on the badge. A value outside the six
          // the CHECK constraint allows is written verbatim by the builder.
          statusNames: Object.fromEntries(
            Object.entries(STATUS_CONFIG).map(([status, config]): [string, string] => [status, t(config.label)]),
          ),
          scopeWhole: t('admin.export.scope.whole'),
          countsIncomplete: t('sa.companies.export.countsIncomplete'),
          chrome: exportChrome,
        },
      }));
    } catch (error: any) {
      showToast('error', t('ui.export.failed'), error?.message);
    }
  };

  const filtered = companies.filter(c => {
    const matchSearch = !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.slug.toLowerCase().includes(search.toLowerCase()) ||
      (c.email || '').toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || c.status === statusFilter;
    return matchSearch && matchStatus;
  });

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is this screen's logic, bar the look of STATUS_CONFIG
  // (its colours became a Badge tone) and the two constants the lifecycle dialog
  // painted with. Everything below only draws.

  if (!isSuperAdmin) {
    return (
      <EmptyState
        icon={Shield}
        className="h-64"
        title={t('sa.companies.noAccess')}
        description={t('sa.companies.superAdminsOnly')}
      />
    );
  }

  // ── Detail view ──
  if (viewingCompany) {
    return (
      <>
        <CompanyDetail
          company={viewingCompany}
          onBack={() => setViewingCompany(null)}
          onEdit={c => { setEditingCompany(c); setViewingCompany(null); }}
          onLifecycleAction={handleLifecycleAction}
          onEnterCompany={company => { void handleEnterCompany(company); }}
          onRefresh={loadCompanies}
        />
        {lifecycleModal && (
          <LifecycleConfirmModal
            action={lifecycleModal.action}
            company={lifecycleModal.company}
            onClose={() => setLifecycleModal(null)}
            onConfirm={async () => {
              await executeLifecycleAction(lifecycleModal.action, lifecycleModal.company);
              setLifecycleModal(null);
            }}
          />
        )}
      </>
    );
  }

  // ── List view ──
  const filterOptions: Array<'all' | CompanyStatus> = ['all', 'active', 'suspended', 'inactive', 'archived', 'deleted'];
  // Keys are the stored companies.status values the filter compares against.
  const filterLabels: Record<string, TranslationKey> = {
    all: 'common.all',
    active: 'sa.status.active',
    suspended: 'sa.status.suspended',
    inactive: 'sa.status.inactive',
    archived: 'sa.status.archived',
    deleted: 'sa.status.deleted',
  };

  return (
    <div className="space-y-6 font-ui">
      {/* Header */}
      <PageHeader
        className="pb-0"
        title={t('sa.companies.title')}
        /* "Super Admin — N Unternehmen" over a failed read said 0, which is a
           figure this screen did not read. The Alert below says so instead. */
        description={!loadFailed ? t('sa.companies.subtitle', { count: companies.length }) : undefined}
        actions={
          <>
            {/* The customer list as a workbook. Withheld while the read failed or
                is running, and while the filter matches nothing: a file of nought
                customers is a claim. */}
            <Button
              variant="secondary"
              disabled={loading || loadFailed || filtered.length === 0}
              onClick={handleExport}
              title={t('common.exportExcel')}
            >
              <Download size={16} />{t('admin.export.download')}
            </Button>
            <Button onClick={() => setShowCreateModal(true)} className={canLifecycle ? 'flex' : 'hidden'}>
              <Plus size={16} />{t('sa.companies.createButton')}
            </Button>
          </>
        }
      />

      {/* A read that did not succeed. The list below may be empty or stale, and
          either way the export stays disabled — this is the sentence the toast
          could not be, because a toast is gone in four seconds. */}
      {loadFailed && (
        <Alert tone="critical" className="font-ui" title={t('sa.companies.loadFailed')}>
          {t('sa.companies.loadFailedBody')}
        </Alert>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input className="pl-8" aria-label={t('sa.companies.searchPlaceholder')} placeholder={t('sa.companies.searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Tabs value={statusFilter} onValueChange={value => setStatusFilter(value as 'all' | CompanyStatus)} className="max-w-full">
          <TabsList variant="segmented">
            {filterOptions.map(s => (
              <TabsTrigger key={s} value={s}>{t(filterLabels[s])}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button variant="secondary" size="icon" onClick={loadCompanies} title={t('admin.common.refresh')} aria-label={t('admin.common.refresh')}>
          <RefreshCw size={14} />
        </Button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20"><RefreshCw size={24} className="text-fg-subtle motion-safe:animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="glass-card rounded-surface">
          {/* "Noch keine Unternehmen" is a claim about the platform. After a
              failed read it is not one this screen may make, so it says what
              actually happened instead — the Alert above carries the detail. */}
          <EmptyState
            icon={Building2}
            title={t(loadFailed
              ? 'sa.companies.loadFailed'
              : search || statusFilter !== 'all' ? 'sa.companies.noMatches' : 'sa.companies.noneYet')}
          />
        </div>
      ) : (
        <div className="glass-card relative overflow-x-auto rounded-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-wash">
                {([
                  'sa.companies.col.company', 'common.status', 'sa.companies.col.emailCity',
                  'sa.companies.users', 'sa.companies.created', null,
                ] as const).map((h, i) => (
                  <th key={i} className={TH_CLASS}>{h ? t(h) : ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(company => {
                const isArchived = company.status === 'archived';
                const isDeleted = company.status === 'deleted';
                const dimmed = isArchived || isDeleted;
                return (
                  <tr key={company.id} className={cn('cursor-pointer border-b border-line hover:bg-sunken', dimmed && 'opacity-[.65]')}
                    onClick={() => setViewingCompany(company)}>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-tile text-sm font-bold', isArchived ? 'bg-neutral-soft text-neutral' : 'bg-brand-soft text-brand-text')}>
                          {isArchived ? <Archive size={14} /> : company.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-semibold text-fg">{company.name}</p>
                          <p className="text-xs text-fg-subtle">{company.slug}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4"><StatusBadge status={company.status as CompanyStatus} /></td>
                    <td className="px-5 py-4">
                      <div className="text-fg-muted">
                        {company.email && <p>{company.email}</p>}
                        {company.city && <p className="text-xs text-fg-subtle">{company.city}</p>}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span className="flex items-center gap-1.5 text-sm tabular-nums text-fg-muted">
                        <Users size={13} />{(company as any).user_count ?? '–'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-xs tabular-nums text-fg-subtle">
                      {format(new Date(company.created_at), 'dd.MM.yyyy')}
                    </td>
                    <td className="px-5 py-4" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button variant="ghost" size="icon-sm" onClick={() => setViewingCompany(company)} title={t('sa.companies.details')} aria-label={t('sa.companies.details')}>
                          <Eye size={14} />
                        </Button>
                        {!isArchived && !isDeleted && (
                          <>
                            <Button variant="ghost" size="icon-sm" className="[&[hidden]]:hidden" hidden={!canLifecycle} onClick={() => setEditingCompany(company)} title={t('common.edit')} aria-label={t('common.edit')}>
                              <Edit2 size={14} />
                            </Button>
                            <Button variant="ghost" size="icon-sm" className="text-brand-text hover:text-brand-text [&[hidden]]:hidden" hidden={!canOpenCompany} onClick={() => { void handleEnterCompany(company); }} title={t('sa.companies.openAsCompany')} aria-label={t('sa.companies.openAsCompany')}>
                              <ExternalLink size={14} />
                            </Button>
                          </>
                        )}
                        {(isArchived || isDeleted) && (
                          <Button variant="ghost" size="icon-sm" className="text-brand-text hover:text-brand-text [&[hidden]]:hidden" hidden={!canLifecycle} onClick={() => handleLifecycleAction(company, 'restore')} title={t('sa.lifecycle.restore.confirm')} aria-label={t('sa.lifecycle.restore.confirm')}>
                            <RotateCcw size={14} />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      {showCreateModal && (
        <CreateCompanyModal onClose={() => setShowCreateModal(false)} onCreated={c => { setShowCreateModal(false); loadCompanies(); setViewingCompany(c); }} />
      )}
      {editingCompany && (
        <EditCompanyModal company={editingCompany} onClose={() => setEditingCompany(null)}
          onUpdated={updated => { setEditingCompany(null); loadCompanies(); if (viewingCompany?.id === updated.id) setViewingCompany(updated); }} />
      )}
      {lifecycleModal && (
        <LifecycleConfirmModal
          action={lifecycleModal.action}
          company={lifecycleModal.company}
          onClose={() => setLifecycleModal(null)}
          onConfirm={async () => {
            await executeLifecycleAction(lifecycleModal.action, lifecycleModal.company);
            setLifecycleModal(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Presentation helpers (phase 5) ───────────────────────────────────────────
// Module-level so the components above can use them; they only draw.

const MENU_ITEM_CLASS = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors [@media(pointer:coarse)]:min-h-11';
const SECTION_LABEL_CLASS = 'text-sm font-semibold uppercase tracking-wide text-fg-subtle';
const TH_CLASS = 'whitespace-nowrap px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-subtle';

function InfoItem({ icon: Icon, label, children }: { icon?: React.ElementType; label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={Icon ? 'flex items-start gap-2' : undefined}>
      {Icon && <Icon size={13} className="mt-0.5 shrink-0 text-fg-subtle" />}
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</p>
        <p className="break-words text-fg">{children}</p>
      </div>
    </div>
  );
}
