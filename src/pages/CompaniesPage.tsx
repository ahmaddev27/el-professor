import React, { useState, useEffect, useCallback } from 'react';
import {
  Building2, Plus, Search, Eye, CreditCard as Edit2, MoreVertical,
  CheckCircle, XCircle, PauseCircle, AlertCircle, Users, ChevronRight,
  Globe, Mail, Phone, MapPin, Calendar, RefreshCw, ArrowLeft, User,
  Shield, X, Save, ExternalLink, Archive, Trash2, AlertTriangle,
  RotateCcw, Lock, ChevronDown,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin, CompanyListItem } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { format, differenceInDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

type CompanyStatus = 'active' | 'trial' | 'suspended' | 'inactive' | 'archived' | 'deleted';

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
  status: 'active' | 'trial' | 'suspended' | 'inactive';
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
const STATUS_CONFIG: Record<CompanyStatus, { label: TranslationKey; icon: React.ElementType; color: string; bg: string }> = {
  active:    { label: 'sa.status.active',    icon: CheckCircle,    color: 'var(--success)',        bg: 'var(--success-subtle)' },
  trial:     { label: 'sa.status.trial',     icon: AlertCircle,    color: 'var(--warning)',        bg: 'var(--warning-subtle)' },
  suspended: { label: 'sa.status.suspended', icon: PauseCircle,    color: 'var(--danger)',         bg: 'var(--danger-subtle)' },
  inactive:  { label: 'sa.status.inactive',  icon: XCircle,        color: 'var(--text-tertiary)',  bg: 'var(--bg-muted)' },
  archived:  { label: 'sa.status.archived',  icon: Archive,        color: '#64748b',               bg: 'rgba(100,116,139,0.12)' },
  deleted:   { label: 'sa.status.deleted',   icon: Trash2,         color: 'var(--danger)',         bg: 'var(--danger-subtle)' },
};

// ─── Shared primitives ────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  padding: '0.5rem 0.75rem',
  outline: 'none',
  width: '100%',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: '0.25rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

function StatusBadge({ status }: { status: CompanyStatus }) {
  const { t } = useTranslation();
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.inactive;
  const Icon = cfg.icon;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: cfg.bg, color: cfg.color }}>
      <Icon size={11} />{t(cfg.label)}
    </span>
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

  const needsTyping = meta.dangerLevel === 'critical';
  const canConfirm = needsTyping ? confirmText.trim() === company.name.trim() : true;

  const borderColor = meta.dangerLevel === 'critical'
    ? 'var(--danger)'
    : meta.dangerLevel === 'high'
      ? 'rgba(245,158,11,0.5)'
      : 'var(--border)';

  const btnColor = meta.dangerLevel === 'medium' ? 'var(--warning)' : 'var(--danger)';

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)' }}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: `1px solid ${borderColor}`, boxShadow: 'var(--shadow-lg)' }}>
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: meta.dangerLevel === 'critical' ? 'var(--danger-subtle)' : 'var(--warning-subtle)' }}>
              {meta.dangerLevel === 'critical'
                ? <Trash2 size={16} style={{ color: 'var(--danger)' }} />
                : <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
              }
            </div>
            <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{t(meta.title)}</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg" style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Company pill */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
              style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>
              {company.name.charAt(0).toUpperCase()}
            </div>
            <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{company.name}</span>
            <StatusBadge status={company.status as CompanyStatus} />
          </div>

          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{t(meta.description)}</p>

          {needsTyping && (
            <div>
              <label style={labelStyle}>{t('sa.lifecycle.typeNameLabel')}</label>
              <input
                style={inputStyle}
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={company.name}
                autoFocus
              />
              {confirmText.length > 0 && confirmText.trim() !== company.name.trim() && (
                <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{t('sa.lifecycle.nameMismatch')}</p>
              )}
            </div>
          )}

          {meta.dangerLevel === 'critical' && (
            <div className="flex items-start gap-2 p-3 rounded-xl" style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}>
              <AlertTriangle size={14} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
              <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
                {t('sa.lifecycle.criticalWarning')}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium transition-colors"
            style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            {t('common.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm || busy}
            className="px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 transition-opacity"
            style={{ background: btnColor, color: 'white', opacity: (!canConfirm || busy) ? 0.5 : 1 }}
          >
            {busy && <RefreshCw size={13} className="animate-spin" />}
            {t(meta.confirmLabel)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Create Company Modal ─────────────────────────────────────────────────────

interface CreateCompanyModalProps {
  onClose: () => void;
  onCreated: (company: CompanyListItem) => void;
}

function CreateCompanyModal({ onClose, onCreated }: CreateCompanyModalProps) {
  const { showToast } = useToast();
  const { t } = useTranslation();
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
      const { data, error } = await supabase.from('companies').insert({
        name: form.name.trim(), slug: form.slug.trim(),
        legal_name: form.legal_name.trim() || null, email: form.email.trim() || null,
        phone: form.phone.trim() || null, address: form.address.trim() || null,
        city: form.city.trim() || null, postal_code: form.postal_code.trim() || null,
        country: form.country.trim() || 'Deutschland', status: form.status,
      }).select().single();
      if (error) throw error;
      setCreatedCompany(data as CompanyListItem);
      setStep(2);
      showToast('success', t('sa.companies.toast.created'));
    } catch (err: any) {
      showToast('error', err.message?.includes('unique') ? t('sa.companies.errorSlugTaken') : err.message || t('common.error'));
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
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ email: adminForm.email.trim(), full_name: adminForm.full_name.trim(), role: 'admin', company_id: createdCompany.id, password: adminForm.password }),
      });
      const result = await response.json();
      // The manage-users edge function already answers in German and its text
      // is shown verbatim; only our own fallback is translated.
      if (!response.ok) throw new Error(result.error || t('common.error'));
      showToast('success', t('sa.companies.toast.adminCreated'));
      onCreated(createdCompany);
    } catch (err: any) {
      showToast('error', err.message || t('sa.companies.errorCreateAdmin'));
    } finally {
      setAdminSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between p-6 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--accent-subtle)' }}>
              <Building2 size={20} style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t(step === 1 ? 'sa.companies.createTitle' : 'sa.companies.firstAdminTitle')}</h2>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('sa.companies.stepOfTwo', { step })}</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}><X size={16} /></button>
        </div>

        {step === 1 && (
          <form onSubmit={handleCreateCompany} className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label style={labelStyle}>{t('sa.companies.field.name')}</label>
                <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="El-Professor GmbH" required />
              </div>
              <div>
                <label style={labelStyle}>{t('sa.companies.field.slug')}</label>
                <input style={inputStyle} value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))} placeholder="el-professor" required />
              </div>
              <div>
                <label style={labelStyle}>{t('common.status')}</label>
                {/* `value` is the stored companies.status — only the label is translated. */}
                <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as any }))}>
                  <option value="active">{t('sa.status.active')}</option>
                  <option value="trial">{t('sa.status.trial')}</option>
                  <option value="suspended">{t('sa.status.suspended')}</option>
                  <option value="inactive">{t('sa.status.inactive')}</option>
                </select>
              </div>
              <div className="col-span-2"><label style={labelStyle}>{t('sa.companies.field.legalName')}</label><input style={inputStyle} value={form.legal_name} onChange={e => setForm(f => ({ ...f, legal_name: e.target.value }))} /></div>
              <div><label style={labelStyle}>{t('sa.companies.field.email')}</label><input type="email" style={inputStyle} value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
              <div><label style={labelStyle}>{t('sa.companies.field.phone')}</label><input style={inputStyle} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
              <div className="col-span-2"><label style={labelStyle}>{t('common.address')}</label><input style={inputStyle} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></div>
              <div><label style={labelStyle}>{t('sa.companies.field.postalCode')}</label><input style={inputStyle} value={form.postal_code} onChange={e => setForm(f => ({ ...f, postal_code: e.target.value }))} /></div>
              <div><label style={labelStyle}>{t('sa.companies.field.city')}</label><input style={inputStyle} value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} /></div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>{t('common.cancel')}</button>
              <button type="submit" disabled={saving} className="px-5 py-2 rounded-lg text-sm font-semibold flex items-center gap-2" style={{ background: 'var(--accent)', color: 'white', opacity: saving ? 0.7 : 1 }}>
                {saving ? <RefreshCw size={14} className="animate-spin" /> : <Building2 size={14} />}{t('sa.companies.createButton')}</button>
            </div>
          </form>
        )}

        {step === 2 && createdCompany && (
          <div className="p-6 space-y-5">
            <div className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--success-subtle)' }}>
              <CheckCircle size={16} style={{ color: 'var(--success)' }} />
              <p className="text-sm font-medium" style={{ color: 'var(--success)' }}>{t('sa.companies.createdNotice', { name: createdCompany.name })}</p>
            </div>
            <form onSubmit={handleCreateAdmin} className="space-y-4">
              <div><label style={labelStyle}>{t('sa.companies.field.fullName')}</label><input style={inputStyle} value={adminForm.full_name} onChange={e => setAdminForm(f => ({ ...f, full_name: e.target.value }))} required /></div>
              <div><label style={labelStyle}>{t('sa.companies.field.emailRequired')}</label><input type="email" style={inputStyle} value={adminForm.email} onChange={e => setAdminForm(f => ({ ...f, email: e.target.value }))} required /></div>
              <div><label style={labelStyle}>{t('sa.companies.field.tempPassword')}</label><input type="text" style={inputStyle} value={adminForm.password} onChange={e => setAdminForm(f => ({ ...f, password: e.target.value }))} minLength={8} required /></div>
              <div className="flex justify-between gap-3 pt-2">
                <button type="button" onClick={() => onCreated(createdCompany)} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>{t('sa.companies.skip')}</button>
                <button type="submit" disabled={adminSaving} className="px-5 py-2 rounded-lg text-sm font-semibold flex items-center gap-2" style={{ background: 'var(--accent)', color: 'white', opacity: adminSaving ? 0.7 : 1 }}>
                  {adminSaving ? <RefreshCw size={14} className="animate-spin" /> : <User size={14} />}{t('sa.companies.createAdmin')}</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
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
    status: (['active','trial','suspended','inactive'].includes(company.status) ? company.status : 'inactive') as any,
  });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.slug.trim()) { showToast('error', t('sa.companies.errorNameSlugRequired')); return; }
    try {
      setSaving(true);
      const { data, error } = await supabase.from('companies').update({
        name: form.name.trim(), slug: form.slug.trim(),
        legal_name: form.legal_name.trim() || null, email: form.email.trim() || null,
        phone: form.phone.trim() || null, address: form.address.trim() || null,
        city: form.city.trim() || null, postal_code: form.postal_code.trim() || null,
        country: form.country.trim() || 'Deutschland', status: form.status,
        updated_at: new Date().toISOString(),
      }).eq('id', company.id).select().single();
      if (error) throw error;
      showToast('success', t('sa.companies.toast.updated'));
      onUpdated(data as CompanyListItem);
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between p-6 border-b" style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('sa.companies.editTitle', { name: company.name })}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}><X size={16} /></button>
        </div>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2"><label style={labelStyle}>{t('sa.companies.field.name')}</label><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required /></div>
            <div><label style={labelStyle}>{t('sa.companies.field.slug')}</label><input style={inputStyle} value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} required /></div>
            <div><label style={labelStyle}>{t('common.status')}</label>
              {/* `value` is the stored companies.status — only the label is translated. */}
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as any }))}>
                <option value="active">{t('sa.status.active')}</option><option value="trial">{t('sa.status.trial')}</option>
                <option value="suspended">{t('sa.status.suspended')}</option><option value="inactive">{t('sa.status.inactive')}</option>
              </select>
            </div>
            <div className="col-span-2"><label style={labelStyle}>{t('sa.companies.field.legalName')}</label><input style={inputStyle} value={form.legal_name} onChange={e => setForm(f => ({ ...f, legal_name: e.target.value }))} /></div>
            <div><label style={labelStyle}>{t('sa.companies.field.email')}</label><input type="email" style={inputStyle} value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
            <div><label style={labelStyle}>{t('sa.companies.field.phone')}</label><input style={inputStyle} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
            <div className="col-span-2"><label style={labelStyle}>{t('common.address')}</label><input style={inputStyle} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></div>
            <div><label style={labelStyle}>{t('sa.companies.field.postalCode')}</label><input style={inputStyle} value={form.postal_code} onChange={e => setForm(f => ({ ...f, postal_code: e.target.value }))} /></div>
            <div><label style={labelStyle}>{t('sa.companies.field.city')}</label><input style={inputStyle} value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} /></div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>{t('common.cancel')}</button>
            <button type="submit" disabled={saving} className="px-5 py-2 rounded-lg text-sm font-semibold flex items-center gap-2" style={{ background: 'var(--accent)', color: 'white', opacity: saving ? 0.7 : 1 }}>
              {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}{t('common.save')}</button>
          </div>
        </form>
      </div>
    </div>
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
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ full_name: '', email: '', password: '', role: 'admin' });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.full_name.trim() || !form.email.trim() || !form.password.trim()) { showToast('error', t('sa.companies.errorAllFieldsRequired')); return; }
    if (form.password.length < 8) { showToast('error', t('sa.companies.errorPasswordShort')); return; }
    try {
      setSaving(true);
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ email: form.email.trim(), full_name: form.full_name.trim(), role: form.role, company_id: company.id, password: form.password }),
      });
      const result = await response.json();
      // The manage-users edge function already answers in German and its text
      // is shown verbatim; only our own fallback is translated.
      if (!response.ok) throw new Error(result.error || t('common.error'));
      showToast('success', t('sa.companies.toast.userCreated'));
      onInvited();
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-md rounded-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between p-6 border-b" style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('sa.companies.addUser')}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div><label style={labelStyle}>{t('sa.companies.field.nameRequired')}</label><input style={inputStyle} value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} required /></div>
          <div><label style={labelStyle}>{t('sa.companies.field.emailRequired')}</label><input type="email" style={inputStyle} value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required /></div>
          <div><label style={labelStyle}>{t('sa.companies.field.role')}</label>
            {/* `value` is the stored user_profiles.role — only the label is translated. */}
            <select style={inputStyle} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
              <option value="admin">{t('sa.companies.role.admin')}</option><option value="creator">{t('sa.companies.role.creator')}</option><option value="viewer">{t('sa.companies.role.viewer')}</option>
            </select>
          </div>
          <div><label style={labelStyle}>{t('sa.companies.field.tempPassword')}</label><input type="text" style={inputStyle} value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} minLength={8} required /></div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>{t('common.cancel')}</button>
            <button type="submit" disabled={saving} className="px-5 py-2 rounded-lg text-sm font-semibold flex items-center gap-2" style={{ background: 'var(--accent)', color: 'white', opacity: saving ? 0.7 : 1 }}>
              {saving ? <RefreshCw size={14} className="animate-spin" /> : <User size={14} />}{t('sa.companies.create')}</button>
          </div>
        </form>
      </div>
    </div>
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
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const { showToast } = useToast();
  const { t } = useTranslation();

  const isArchived = company.status === 'archived';
  const isDeleted = company.status === 'deleted';
  const isOperational = !isArchived && !isDeleted;

  const loadUsers = useCallback(async () => {
    try {
      setLoadingUsers(true);
      const { data, error } = await supabase.from('user_profiles')
        .select('id, user_id, email, full_name, role, status, is_super_admin, created_at')
        .eq('company_id', company.id).order('created_at');
      if (error) throw error;
      setUsers(data || []);
    } catch {
      showToast('error', t('sa.companies.errorLoadUsers'));
    } finally {
      setLoadingUsers(false);
    }
  }, [company.id, t]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <button onClick={onBack} className="flex items-center gap-1.5 text-sm mb-3 transition-colors" style={{ color: 'var(--text-secondary)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}>
            <ArrowLeft size={14} />{t('sa.companies.backToAll')}
          </button>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-xl font-bold"
              style={{ background: isArchived ? 'rgba(100,116,139,0.15)' : 'var(--accent-subtle)', color: isArchived ? '#64748b' : 'var(--accent)' }}>
              {company.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{company.name}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)' }}>{company.slug}</code>
                <StatusBadge status={company.status as CompanyStatus} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {isOperational && (
            <button onClick={() => onEnterCompany(company)} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold"
              style={{ background: 'var(--accent)', color: 'white' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
              <ExternalLink size={14} />{t('sa.companies.openAsCompany')}
            </button>
          )}
          {isOperational && (
            <button onClick={() => onEdit(company)} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
              onMouseEnter={e => { (e.currentTarget.style.background = 'var(--bg-muted)'); (e.currentTarget.style.color = 'var(--text-primary)'); }}
              onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--text-secondary)'); }}>
              <Edit2 size={14} />{t('common.edit')}
            </button>
          )}

          {/* Lifecycle actions dropdown */}
          <div className="relative">
            <button onClick={() => setActionMenuOpen(v => !v)}
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-colors"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <MoreVertical size={14} />{t('sa.companies.actions')}<ChevronDown size={12} />
            </button>
            {actionMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setActionMenuOpen(false)} />
                <div className="absolute right-0 mt-1 w-52 rounded-xl z-20 overflow-hidden py-1"
                  style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>

                  {/* Operational status changes */}
                  {isOperational && company.status !== 'active' && (
                    <button onClick={() => { onLifecycleAction(company, 'reactivate'); setActionMenuOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors"
                      style={{ color: 'var(--success)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--success-subtle)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <CheckCircle size={14} />{t('sa.lifecycle.reactivate.confirm')}
                    </button>
                  )}
                  {isOperational && company.status !== 'suspended' && (
                    <button onClick={() => { onLifecycleAction(company, 'suspend'); setActionMenuOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors"
                      style={{ color: 'var(--warning)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--warning-subtle)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <PauseCircle size={14} />{t('sa.companies.menu.suspend')}
                    </button>
                  )}

                  {/* Archive */}
                  {isOperational && (
                    <button onClick={() => { onLifecycleAction(company, 'archive'); setActionMenuOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors"
                      style={{ color: '#64748b' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(100,116,139,0.1)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <Archive size={14} />{t('sa.lifecycle.archive.confirm')}
                    </button>
                  )}

                  {/* Restore from archive */}
                  {isArchived && (
                    <button onClick={() => { onLifecycleAction(company, 'restore'); setActionMenuOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors"
                      style={{ color: 'var(--accent)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <RotateCcw size={14} />{t('sa.companies.menu.restoreFromArchive')}
                    </button>
                  )}

                  {/* Restore from soft delete */}
                  {isDeleted && (
                    <button onClick={() => { onLifecycleAction(company, 'restore'); setActionMenuOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors"
                      style={{ color: 'var(--accent)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
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
        <div className="flex items-center gap-3 p-4 rounded-2xl"
          style={{
            background: isDeleted ? 'var(--danger-subtle)' : 'rgba(100,116,139,0.1)',
            border: `1px solid ${isDeleted ? 'var(--danger)' : '#64748b50'}`,
          }}>
          {isDeleted ? <Trash2 size={16} style={{ color: 'var(--danger)' }} /> : <Archive size={16} style={{ color: '#64748b' }} />}
          <div>
            <p className="font-semibold text-sm" style={{ color: isDeleted ? 'var(--danger)' : '#64748b' }}>
              {t(isDeleted ? 'sa.companies.banner.deletedTitle' : 'sa.status.archived')}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              {t(isDeleted ? 'sa.companies.banner.deletedBody' : 'sa.companies.banner.archivedBody')}
            </p>
          </div>
        </div>
      )}

      {/* Info cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 rounded-2xl p-5 space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <h3 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{t('sa.companies.companyData')}</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {company.legal_name && (
              <div><p style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('sa.companies.legalName')}</p>
                <p style={{ color: 'var(--text-primary)' }}>{company.legal_name}</p></div>
            )}
            {company.email && (
              <div className="flex items-start gap-2">
                <Mail size={13} style={{ color: 'var(--text-tertiary)', marginTop: 2 }} />
                <div><p style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('sa.companies.email')}</p>
                  <p style={{ color: 'var(--text-primary)' }}>{company.email}</p></div>
              </div>
            )}
            {company.phone && (
              <div className="flex items-start gap-2">
                <Phone size={13} style={{ color: 'var(--text-tertiary)', marginTop: 2 }} />
                <div><p style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('sa.companies.phone')}</p>
                  <p style={{ color: 'var(--text-primary)' }}>{company.phone}</p></div>
              </div>
            )}
            {(company.city || company.address) && (
              <div className="flex items-start gap-2">
                <MapPin size={13} style={{ color: 'var(--text-tertiary)', marginTop: 2 }} />
                <div><p style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('common.address')}</p>
                  <p style={{ color: 'var(--text-primary)' }}>{[company.address, company.postal_code, company.city, company.country].filter(Boolean).join(', ')}</p></div>
              </div>
            )}
            <div className="flex items-start gap-2">
              <Globe size={13} style={{ color: 'var(--text-tertiary)', marginTop: 2 }} />
              <div><p style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('sa.companies.slug')}</p>
                <p style={{ color: 'var(--text-primary)' }}>{company.slug}</p></div>
            </div>
            <div className="flex items-start gap-2">
              <Calendar size={13} style={{ color: 'var(--text-tertiary)', marginTop: 2 }} />
              <div><p style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('sa.companies.created')}</p>
                <p style={{ color: 'var(--text-primary)' }}>{format(new Date(company.created_at), 'dd.MM.yyyy', { locale: de })}</p></div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl p-5 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <h3 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{t('sa.companies.statistics')}</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}><Users size={14} />{t('sa.companies.users')}</div>
              <span className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>{users.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}><Shield size={14} />{t('sa.companies.admins')}</div>
              <span className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>{users.filter(u => u.role === 'admin').length}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Users table */}
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('sa.companies.usersCount', { count: users.length })}</h3>
          {isOperational && (
            <button onClick={() => setShowInviteModal(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
              <Plus size={12} />{t('sa.companies.addUser')}
            </button>
          )}
        </div>
        {loadingUsers ? (
          <div className="flex items-center justify-center py-10"><RefreshCw size={18} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} /></div>
        ) : users.length === 0 ? (
          <div className="py-10 text-center"><Users size={28} className="mx-auto mb-2" style={{ color: 'var(--text-tertiary)' }} /><p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('sa.companies.noUsers')}</p></div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {([
                  'sa.companies.col.name', 'sa.companies.email',
                  'sa.companies.col.role', 'common.status', 'sa.companies.created',
                ] as const).map((h, i) => (
                  <th key={i} className="px-5 py-3 text-left" style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{t(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <td className="px-5 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>{u.full_name || '—'}</td>
                  <td className="px-5 py-3" style={{ color: 'var(--text-secondary)' }}>{u.email}</td>
                  <td className="px-5 py-3">
                    <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: u.role === 'admin' ? 'var(--danger-subtle)' : 'var(--bg-muted)', color: u.role === 'admin' ? 'var(--danger)' : 'var(--text-secondary)' }}>{u.role}</span>
                  </td>
                  <td className="px-5 py-3">
                    <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: u.status === 'active' ? 'var(--success-subtle)' : 'var(--bg-muted)', color: u.status === 'active' ? 'var(--success)' : 'var(--text-tertiary)' }}>{u.status}</span>
                  </td>
                  <td className="px-5 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>{format(new Date(u.created_at), 'dd.MM.yyyy')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Danger Zone */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--danger)', background: 'var(--danger-subtle)' }}>
        <button
          onClick={() => setDangerOpen(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-left"
        >
          <div className="flex items-center gap-2">
            <Lock size={14} style={{ color: 'var(--danger)' }} />
            <span className="font-semibold text-sm" style={{ color: 'var(--danger)' }}>{t('sa.companies.dangerZone')}</span>
          </div>
          <ChevronDown size={14} style={{ color: 'var(--danger)', transform: dangerOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </button>

        {dangerOpen && (
          <div className="px-5 pb-5 space-y-3 border-t" style={{ borderColor: 'var(--danger)' }}>
            <p className="text-xs pt-3" style={{ color: 'var(--text-secondary)' }}>
              {t('sa.companies.dangerZoneNote')}
            </p>

            <div className="space-y-2">
              {/* Soft delete */}
              {company.status !== 'deleted' && (
                <div className="flex items-center justify-between p-3 rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  <div>
                    <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{t('sa.lifecycle.softDelete.confirm')}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('sa.companies.softDeleteNote')}</p>
                  </div>
                  <button onClick={() => onLifecycleAction(company, 'softDelete')}
                    className="ml-4 flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                    style={{ background: 'var(--danger)', color: 'white' }}>
                    <Trash2 size={12} />{t('sa.companies.markForDeletion')}
                  </button>
                </div>
              )}

              {/* Hard delete — only available when already soft-deleted */}
              {company.status === 'deleted' && (
                <div className="flex items-center justify-between p-3 rounded-xl" style={{ background: 'rgba(239,68,68,0.12)', border: '2px solid var(--danger)' }}>
                  <div>
                    <p className="font-semibold text-sm" style={{ color: 'var(--danger)' }}>{t('sa.lifecycle.hardDelete.confirm')}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      {t('sa.companies.hardDeleteNote')}
                    </p>
                  </div>
                  <button onClick={() => onLifecycleAction(company, 'hardDelete')}
                    className="ml-4 flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5"
                    style={{ background: 'var(--danger)', color: 'white' }}>
                    <Trash2 size={12} />{t('sa.lifecycle.hardDelete.confirm')}
                  </button>
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
  const { enterCompany } = useSuperAdmin();
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [companies, setCompanies] = useState<CompanyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CompanyStatus>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCompany, setEditingCompany] = useState<CompanyListItem | null>(null);
  const [viewingCompany, setViewingCompany] = useState<CompanyListItem | null>(null);
  const [lifecycleModal, setLifecycleModal] = useState<{ action: LifecycleAction; company: CompanyListItem } | null>(null);

  const loadCompanies = useCallback(async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase.from('companies').select('*').order('created_at', { ascending: false });
      if (error) throw error;

      const companyIds = (data || []).map(c => c.id);
      if (companyIds.length > 0) {
        const { data: profileCounts } = await supabase.from('user_profiles').select('company_id').in('company_id', companyIds);
        const countMap: Record<string, number> = {};
        profileCounts?.forEach(p => { if (p.company_id) countMap[p.company_id] = (countMap[p.company_id] || 0) + 1; });
        setCompanies((data || []).map(c => ({ ...c, user_count: countMap[c.id] || 0 })));
      } else {
        setCompanies(data || []);
      }
    } catch {
      showToast('error', t('sa.companies.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  // Execute lifecycle action
  const executeLifecycleAction = async (action: LifecycleAction, company: CompanyListItem): Promise<void> => {
    const now = new Date().toISOString();

    if (action === 'suspend') {
      const { error } = await supabase.from('companies').update({ status: 'suspended', updated_at: now }).eq('id', company.id);
      if (error) throw error;
      // Deactivate all company users
      await supabase.from('user_profiles').update({ status: 'suspended' }).eq('company_id', company.id).neq('is_super_admin', true);
      showToast('success', t('sa.companies.toast.suspended', { name: company.name }));
    }

    if (action === 'reactivate') {
      const { error } = await supabase.from('companies').update({ status: 'active', updated_at: now }).eq('id', company.id);
      if (error) throw error;
      // Restore users to active
      await supabase.from('user_profiles').update({ status: 'active' }).eq('company_id', company.id).eq('status', 'suspended');
      showToast('success', t('sa.companies.toast.reactivated', { name: company.name }));
    }

    if (action === 'archive') {
      const { error } = await supabase.from('companies').update({ status: 'archived', archived_at: now, updated_at: now }).eq('id', company.id);
      if (error) throw error;
      // Deactivate all company users
      await supabase.from('user_profiles').update({ status: 'deactivated' }).eq('company_id', company.id).neq('is_super_admin', true);
      showToast('success', t('sa.companies.toast.archived', { name: company.name }));
    }

    if (action === 'restore') {
      const { error } = await supabase.from('companies').update({
        status: 'inactive', archived_at: null, deleted_at: null, updated_at: now,
      }).eq('id', company.id);
      if (error) throw error;
      showToast('success', t('sa.companies.toast.restored', { name: company.name, status: t('sa.status.inactive') }));
    }

    if (action === 'softDelete') {
      const { error } = await supabase.from('companies').update({ status: 'deleted', deleted_at: now, updated_at: now }).eq('id', company.id);
      if (error) throw error;
      // Deactivate all company users
      await supabase.from('user_profiles').update({ status: 'deactivated' }).eq('company_id', company.id).neq('is_super_admin', true);
      showToast('success', t('sa.companies.toast.softDeleted', { name: company.name }));
    }

    if (action === 'hardDelete') {
      // CASCADE delete handles all related rows
      const { error } = await supabase.from('companies').delete().eq('id', company.id);
      if (error) throw error;
      showToast('success', t('sa.companies.toast.hardDeleted', { name: company.name }));
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

  const handleEnterCompany = (company: CompanyListItem) => {
    enterCompany(company);
    showToast('success', t('sa.companies.toast.nowActiveAs', { name: company.name }));
  };

  const filtered = companies.filter(c => {
    const matchSearch = !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.slug.toLowerCase().includes(search.toLowerCase()) ||
      (c.email || '').toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || c.status === statusFilter;
    return matchSearch && matchStatus;
  });

  if (!isSuperAdmin) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Shield size={40} className="mx-auto mb-3" style={{ color: 'var(--text-tertiary)' }} />
          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('sa.companies.noAccess')}</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>{t('sa.companies.superAdminsOnly')}</p>
        </div>
      </div>
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
          onEnterCompany={handleEnterCompany}
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
  const filterOptions: Array<'all' | CompanyStatus> = ['all', 'active', 'trial', 'suspended', 'inactive', 'archived', 'deleted'];
  // Keys are the stored companies.status values the filter compares against.
  const filterLabels: Record<string, TranslationKey> = {
    all: 'common.all',
    active: 'sa.status.active',
    trial: 'sa.status.trial',
    suspended: 'sa.status.suspended',
    inactive: 'sa.status.inactive',
    archived: 'sa.status.archived',
    deleted: 'sa.status.deleted',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('sa.companies.title')}</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('sa.companies.subtitle', { count: companies.length })}</p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold"
          style={{ background: 'var(--accent)', color: 'white' }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
          <Plus size={16} />{t('sa.companies.createButton')}
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
          <input style={{ ...inputStyle, paddingLeft: '2rem' }} placeholder={t('sa.companies.searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {filterOptions.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={{ background: statusFilter === s ? 'var(--accent)' : 'var(--bg-subtle)', color: statusFilter === s ? 'white' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              {t(filterLabels[s])}
            </button>
          ))}
        </div>
        <button onClick={loadCompanies} className="p-2 rounded-lg transition-colors" style={{ color: 'var(--text-tertiary)', border: '1px solid var(--border)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}><RefreshCw size={14} /></button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 rounded-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <Building2 size={40} className="mb-3" style={{ color: 'var(--text-tertiary)' }} />
          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t(search || statusFilter !== 'all' ? 'sa.companies.noMatches' : 'sa.companies.noneYet')}</p>
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {([
                  'sa.companies.col.company', 'common.status', 'sa.companies.col.emailCity',
                  'sa.companies.users', 'sa.companies.created', null,
                ] as const).map((h, i) => (
                  <th key={i} className="px-5 py-3.5 text-left" style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{h ? t(h) : ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(company => {
                const isArchived = company.status === 'archived';
                const isDeleted = company.status === 'deleted';
                const dimmed = isArchived || isDeleted;
                return (
                  <tr key={company.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', opacity: dimmed ? 0.65 : 1 }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    onClick={() => setViewingCompany(company)}>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm flex-shrink-0"
                          style={{ background: isArchived ? 'rgba(100,116,139,0.15)' : 'var(--accent-subtle)', color: isArchived ? '#64748b' : 'var(--accent)' }}>
                          {isArchived ? <Archive size={14} /> : company.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{company.name}</p>
                          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{company.slug}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4"><StatusBadge status={company.status as CompanyStatus} /></td>
                    <td className="px-5 py-4">
                      <div style={{ color: 'var(--text-secondary)' }}>
                        {company.email && <p>{company.email}</p>}
                        {company.city && <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{company.city}</p>}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                        <Users size={13} />{(company as any).user_count ?? 0}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {format(new Date(company.created_at), 'dd.MM.yyyy')}
                    </td>
                    <td className="px-5 py-4" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5 justify-end">
                        <button onClick={() => setViewingCompany(company)} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-tertiary)' }} title={t('sa.companies.details')}
                          onMouseEnter={e => { (e.currentTarget.style.background = 'var(--bg-muted)'); (e.currentTarget.style.color = 'var(--text-primary)'); }}
                          onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--text-tertiary)'); }}>
                          <Eye size={14} />
                        </button>
                        {!isArchived && !isDeleted && (
                          <>
                            <button onClick={() => setEditingCompany(company)} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-tertiary)' }} title={t('common.edit')}
                              onMouseEnter={e => { (e.currentTarget.style.background = 'var(--bg-muted)'); (e.currentTarget.style.color = 'var(--text-primary)'); }}
                              onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--text-tertiary)'); }}>
                              <Edit2 size={14} />
                            </button>
                            <button onClick={() => handleEnterCompany(company)} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--accent)' }} title={t('sa.companies.openAsCompany')}
                              onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                              <ExternalLink size={14} />
                            </button>
                          </>
                        )}
                        {(isArchived || isDeleted) && (
                          <button onClick={() => handleLifecycleAction(company, 'restore')} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--accent)' }} title={t('sa.lifecycle.restore.confirm')}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                            <RotateCcw size={14} />
                          </button>
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
