import React, { useState, useEffect } from 'react';
import { X, Plus, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';

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
      showToast('error', 'Bitte Firma und Plan ausw\u00E4hlen');
      return;
    }
    const plan = activePlans.find(p => p.id === planId);
    if (!plan) return;

    setSaving(true);
    try {
      const { error } = await supabase.from('company_subscriptions').insert({
        company_id: companyId,
        plan_id: planId,
        status: 'active',
        starts_at: new Date().toISOString().split('T')[0],
        billing_day: parseInt(billingDay) || 1,
        monthly_price: plan.monthly_price,
        payment_method: 'cash',
        notes: notes || null,
      });

      if (error) throw error;

      // Sync plan limits to company
      await supabase.from('companies').update({
        subscription_car_limit: plan.included_cars,
      }).eq('id', companyId);

      await supabase.from('company_settings').update({
        drivers_per_car_limit: plan.drivers_per_car_limit,
      }).eq('company_id', companyId);

      showToast('success', 'Abonnement zugewiesen');
      onAssigned();
      onClose();
    } catch (err: any) {
      showToast('error', 'Fehler: ' + (err.message || 'Unbekannt'));
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.625rem 0.75rem',
    borderRadius: '0.75rem',
    fontSize: '0.875rem',
    background: 'var(--bg-subtle)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="rounded-2xl w-full max-w-md" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between p-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(6,182,212,0.12)' }}>
              <Plus size={20} style={{ color: 'var(--accent)' }} />
            </div>
            <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>Abo zuweisen</h2>
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-tertiary)' }}><X size={20} /></button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin" style={{ color: 'var(--accent)' }} /></div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>Firma *</label>
                <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={inputStyle}>
                  <option value="">Firma ausw\u00E4hlen...</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>Plan *</label>
                <select value={planId} onChange={e => setPlanId(e.target.value)} style={inputStyle}>
                  <option value="">Plan ausw\u00E4hlen...</option>
                  {activePlans.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} \u2013 {p.monthly_price.toLocaleString('de-DE', { minimumFractionDigits: 2 })} \u20AC/Monat
                    </option>
                  ))}
                </select>
              </div>
              {selectedPlan && (
                <div className="p-3 rounded-xl text-sm" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <p style={{ color: 'var(--text-primary)' }}><strong>{selectedPlan.name}</strong></p>
                  <p style={{ color: 'var(--text-secondary)' }}>{selectedPlan.included_cars} Fahrzeuge, {selectedPlan.drivers_per_car_limit} Fahrer/Auto</p>
                  <p style={{ color: 'var(--accent)' }} className="font-semibold">{selectedPlan.monthly_price.toLocaleString('de-DE', { minimumFractionDigits: 2 })} \u20AC/Monat</p>
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>Abrechnungstag</label>
                <input type="number" min="1" max="28" value={billingDay} onChange={e => setBillingDay(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>Notiz (optional)</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} style={{ ...inputStyle, minHeight: '3rem', resize: 'vertical' }} placeholder="Optionale Notiz..." />
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t" style={{ borderColor: 'var(--border)' }}>
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl text-sm font-medium" style={{ color: 'var(--text-primary)', border: '1px solid var(--border)' }}>Abbrechen</button>
          <button
            onClick={handleSubmit}
            disabled={saving || !companyId || !planId}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'var(--accent)', opacity: saving || !companyId || !planId ? 0.6 : 1 }}
          >
            <Plus size={16} /> {saving ? 'Wird gespeichert...' : 'Zuweisen'}
          </button>
        </div>
      </div>
    </div>
  );
}
