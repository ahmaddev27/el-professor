import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { PencilLine } from 'lucide-react';
import {
  Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, Input, NativeSelect, cn,
} from './ui';
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the modal's logic and is unchanged. Everything below
  // only draws.
  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-md" onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 text-base">
            <span className="flex size-8 items-center justify-center rounded-tight bg-brand-soft text-brand-text">
              <PencilLine aria-hidden className="size-[15px]" />
            </span>
            <span>
              {t('bill.manual.title')}
              <span className="block text-xs font-normal text-fg-subtle">{company.name}</span>
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">{company.name}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* Abo-Status */}
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-[13px] font-[550] text-fg-muted">{t('bill.field.subStatus')}</legend>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={status === opt.value}
                  onClick={() => setStatus(opt.value)}
                  className={cn(
                    'rounded-control border px-3 py-2 text-xs font-semibold transition-colors [@media(pointer:coarse)]:min-h-11',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    status === opt.value
                      ? 'border-transparent bg-brand text-brand-fg'
                      : 'border-line bg-sunken text-fg-muted hover:text-fg',
                  )}
                >
                  {t(opt.label)}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Aktiv seit */}
          <Field label={t('bill.field.activeSince')}>
            <Input type="date" value={startedAt} onChange={e => setStartedAt(e.target.value)} />
          </Field>

          {/* Aktiv bis */}
          <Field label={t('bill.field.activeUntil')}>
            <Input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
          </Field>

          {/* Laufzeit */}
          <Field label={t('bill.field.termOptional')}>
            <NativeSelect value={durationType} onChange={e => setDurationType(e.target.value)}>
              {DURATION_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{t(opt.label)}</option>
              ))}
            </NativeSelect>
          </Field>

          {/* Änderungsgrund */}
          <Field label={t('bill.field.changeReason')}>
            <Input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={t('bill.manual.reasonPlaceholder')}
            />
          </Field>

          <Alert tone="caution" role="note">{t('bill.manual.warning')}</Alert>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={handleSave} loading={saving}>
            {saving ? null : <PencilLine aria-hidden />}
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
