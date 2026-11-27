import { useState, useEffect } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { callPlatformRpc } from '../lib/platformRpc';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, Input, NativeSelect, cn,
} from './ui';
import { controlFrameClass } from './ui/Input';

interface Plan {
  id: string;
  name: string;
  monthly_price: number;
  included_cars: number;
  drivers_per_car_limit: number;
  is_active: boolean;
}

interface Props {
  plans: Plan[];
  onClose: () => void;
  onAssigned: () => void;
}

export default function AssignSubscriptionModal({ plans, onClose, onAssigned }: Props) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [planId, setPlanId] = useState('');
  const [billingDay, setBillingDay] = useState('1');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('companies').select('id, name').order('name');
      if (data) setCompanies(data);
      setLoading(false);
    })();
  }, []);

  const activePlans = plans.filter(p => p.is_active);
  const selectedPlan = activePlans.find(p => p.id === planId);

  const handleSubmit = async () => {
    if (!companyId || !planId) {
      showToast('error', t('bill.assign.selectBoth'));
      return;
    }
    setSaving(true);
    try {
      // One transaction instead of three requests: the subscription row, the
      // company's car limit and the settings' drivers-per-car limit are the
      // plan's, read from the plan in the database rather than sent from here.
      await callPlatformRpc('platform_subscription_assign', {
        p_company_id: companyId,
        p_plan_id: planId,
        p_billing_day: parseInt(billingDay) || 1,
        p_notes: notes || null,
      });

      showToast('success', t('bill.assign.success'));
      onAssigned();
      onClose();
    } catch (err: any) {
      showToast('error', t('bill.errorWithMessage', { message: err.message || t('common.unknown') }));
    } finally {
      setSaving(false);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the dialog's logic and is unchanged, bar the
  // `inputStyle` object, which was only look and is classes now. Everything
  // below only draws.

  const textareaClass = cn(
    controlFrameClass,
    'h-auto min-h-12 resize-y py-2 [@media(pointer:coarse)]:h-auto',
  );

  return (
    <Dialog
      open
      onOpenChange={open => {
        // The dialog stays open while the save runs, so a failure is shown in it.
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-w-md" onInteractOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-brand-soft text-brand-text">
              <Plus aria-hidden className="size-5" />
            </span>
            {t('bill.assign.title')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('bill.assign.title')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 aria-hidden className="size-6 text-brand-text motion-safe:animate-spin" />
            </div>
          ) : (
            <>
              <Field label={t('bill.field.companyRequired')}>
                <NativeSelect value={companyId} onChange={e => setCompanyId(e.target.value)}>
                  <option value="">{t('bill.assign.pickCompany')}</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </NativeSelect>
              </Field>
              <Field label={t('bill.field.planRequired')}>
                <NativeSelect value={planId} onChange={e => setPlanId(e.target.value)}>
                  <option value="">{t('bill.assign.pickPlan')}</option>
                  {activePlans.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} – {t('bill.pricePerMonth', { price: p.monthly_price.toLocaleString('de-DE', { minimumFractionDigits: 2 }) })}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {selectedPlan && (
                <div className="rounded-tile border border-line bg-sunken p-3 text-sm">
                  <p className="text-fg"><strong>{selectedPlan.name}</strong></p>
                  <p className="text-fg-muted">{t('bill.planSummary', { cars: selectedPlan.included_cars, drivers: selectedPlan.drivers_per_car_limit })}</p>
                  <p className="whitespace-nowrap font-semibold tabular-nums text-brand-text">{t('bill.pricePerMonth', { price: selectedPlan.monthly_price.toLocaleString('de-DE', { minimumFractionDigits: 2 }) })}</p>
                </div>
              )}
              <Field label={t('bill.field.billingDay')}>
                <Input type="number" min="1" max="28" value={billingDay} onChange={e => setBillingDay(e.target.value)} />
              </Field>
              <Field label={t('bill.field.noteOptional')} id="assign-subscription-note">
                <textarea id="assign-subscription-note" value={notes} onChange={e => setNotes(e.target.value)} className={textareaClass} placeholder={t('bill.notePlaceholder')} />
              </Field>
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={saving || !companyId || !planId}
            loading={saving}
          >
            {saving ? null : <Plus aria-hidden />}
            {saving ? t('common.saving') : t('bill.assign.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
