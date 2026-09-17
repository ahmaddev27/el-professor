import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { X, RefreshCw, PencilLine } from 'lucide-react';
import { format } from 'date-fns';

type SubStatus = 'inactive' | 'active' | 'expired' | 'suspended';

interface Company {
  id: string;
  name: string;
  subscription_status?: string | null;
  subscription_expires_at?: string | null;
  subscription_started_at?: string | null;
  subscription_duration_type?: string | null;
}

interface Props {
  company: Company;
  onClose: () => void;
  onSaved: () => void;
}

// `label` holds a TranslationKey: these lists are module-level and t() is a hook
// value. `value` is the status/duration as stored in the database — never translated.
const STATUS_OPTIONS: { value: SubStatus; label: TranslationKey }[] = [
  { value: 'inactive',  label: 'bill.subStatus.inactive' },
  { value: 'active',    label: 'bill.subStatus.active' },
  { value: 'expired',   label: 'bill.subStatus.expired' },
  { value: 'suspended', label: 'bill.subStatus.suspended' },
];

const DURATION_OPTIONS: { value: string; label: TranslationKey }[] = [
  { value: '',                  label: 'bill.duration.none' },
  { value: '1_monat',           label: 'activation.duration.1month' },
  { value: '3_monate',          label: 'activation.duration.3months' },
  { value: '1_jahr',            label: 'activation.duration.1year' },
  { value: 'benutzerdefiniert', label: 'activation.custom' },
];

function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  try { return format(new Date(iso), 'yyyy-MM-dd'); } catch { return ''; }
}

export default function ManualSubscriptionModal({ company, onClose, onSaved }: Props) {
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [status, setStatus]         = useState<SubStatus>((company.subscription_status as SubStatus) || 'inactive');
  const [startedAt, setStartedAt]   = useState(toDateInputValue(company.subscription_started_at));
  const [expiresAt, setExpiresAt]   = useState(toDateInputValue(company.subscription_expires_at));
  const [durationType, setDurationType] = useState(company.subscription_duration_type ?? '');
  const [reason, setReason]         = useState('');
  const [saving, setSaving]         = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data } = await supabase.rpc('update_company_subscription_manual', {
        p_company_id:                company.id,
        p_subscription_status:       status,
        p_subscription_started_at:   startedAt ? new Date(startedAt).toISOString() : null,
        p_subscription_expires_at:   expiresAt ? new Date(expiresAt).toISOString() : null,
        p_subscription_duration_type: durationType || null,
        p_reason:                    reason.trim() || null,
      });
      const result = data as { success: boolean; error?: string };
      if (!result?.success) throw new Error(result?.error ?? t('bill.saveFailed'));
      showToast('success', t('bill.subUpdated'));
      onSaved();
      onClose();
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.65)' }}>
      <div className="w-full max-w-md rounded-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(6,182,212,0.12)' }}>
              <PencilLine size={15} style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <h3 className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{t('bill.manual.title')}</h3>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{company.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg" style={{ color: 'var(--text-tertiary)' }}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">

          {/* Abo-Status */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>
              {t('bill.field.subStatus')}
            </label>
            <div className="flex gap-2 flex-wrap">
              {STATUS_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setStatus(opt.value)}
                  className="px-3 py-2 rounded-xl text-xs font-semibold transition-all"
                  style={status === opt.value
                    ? { background: 'var(--accent)', color: 'var(--text-inverse)' }
                    : { background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }
                  }
                >
                  {t(opt.label)}
                </button>
              ))}
            </div>
          </div>

          {/* Aktiv seit */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('bill.field.activeSince')}
            </label>
            <input
              type="date"
              value={startedAt}
              onChange={e => setStartedAt(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </div>

          {/* Aktiv bis */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('bill.field.activeUntil')}
            </label>
            <input
              type="date"
              value={expiresAt}
              onChange={e => setExpiresAt(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </div>

          {/* Laufzeit */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('bill.field.termOptional')}
            </label>
            <select
              value={durationType}
              onChange={e => setDurationType(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            >
              {DURATION_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{t(opt.label)}</option>
              ))}
            </select>
          </div>

          {/* Änderungsgrund */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('bill.field.changeReason')}
            </label>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={t('bill.manual.reasonPlaceholder')}
              className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </div>

          <p className="text-[11px] p-3 rounded-xl" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: 'var(--text-secondary)' }}>
            {t('bill.manual.warning')}
          </p>
        </div>

        {/* Footer */}
        <div className="flex gap-2 justify-end px-6 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-opacity hover:opacity-85 disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #06b6d4, #3b82f6)', color: '#fff' }}
          >
            {saving ? <RefreshCw size={13} className="animate-spin" /> : <PencilLine size={13} />}
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
