import React, { useState } from 'react';
import { X, Plus, Save, CreditCard, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';

interface Plan {
  id: string;
  name: string;
  monthly_price: number;
  included_cars: number;
  drivers_per_car_limit: number;
  features_json: Record<string, any>;
  is_active: boolean;
}

interface Props {
  plans: Plan[];
  onClose: () => void;
  onSaved: () => void;
}

const emptyPlan = { name: '', monthly_price: '', included_cars: '', drivers_per_car_limit: '4' };

export default function PlanManagementModal({ plans, onClose, onSaved }: Props) {
  const { showToast } = useToast();
  const [form, setForm] = useState(emptyPlan);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.625rem 0.75rem',
    borderRadius: '0.75rem',
    fontSize: '0.875rem',
    background: 'var(--bg-subtle)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
  };

  const handleSave = async () => {
    if (!form.name || !form.monthly_price || !form.included_cars) {
      showToast('error', 'Bitte alle Pflichtfelder ausf\u00FCllen');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        monthly_price: parseFloat(form.monthly_price.replace(',', '.')),
        included_cars: parseInt(form.included_cars),
        drivers_per_car_limit: parseInt(form.drivers_per_car_limit) || 4,
      };

      if (editId) {
        const { error } = await supabase.from('subscription_plans').update(payload).eq('id', editId);
        if (error) throw error;
        showToast('success', 'Plan aktualisiert');
      } else {
        const { error } = await supabase.from('subscription_plans').insert(payload);
        if (error) throw error;
        showToast('success', 'Plan erstellt');
      }

      setForm(emptyPlan);
      setEditId(null);
      onSaved();
    } catch (err: any) {
      showToast('error', 'Fehler: ' + (err.message || 'Unbekannt'));
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (plan: Plan) => {
    setEditId(plan.id);
    setForm({
      name: plan.name,
      monthly_price: plan.monthly_price.toString(),
      included_cars: plan.included_cars.toString(),
      drivers_per_car_limit: plan.drivers_per_car_limit.toString(),
    });
  };

  const handleToggleActive = async (plan: Plan) => {
    const { error } = await supabase.from('subscription_plans').update({ is_active: !plan.is_active }).eq('id', plan.id);
    if (error) {
      showToast('error', 'Fehler: ' + error.message);
    } else {
      showToast('success', plan.is_active ? 'Plan deaktiviert' : 'Plan aktiviert');
      onSaved();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between p-5 border-b sticky top-0 z-10" style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(6,182,212,0.12)' }}>
              <CreditCard size={20} style={{ color: 'var(--accent)' }} />
            </div>
            <h2 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>Pl\u00E4ne verwalten</h2>
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-tertiary)' }}><X size={20} /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* Existing plans */}
          {plans.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Vorhandene Pl\u00E4ne</h3>
              {plans.map(plan => (
                <div key={plan.id} className="flex items-center justify-between p-3 rounded-xl" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', opacity: plan.is_active ? 1 : 0.5 }}>
                  <div>
                    <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{plan.name}</p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {plan.monthly_price.toLocaleString('de-DE', { minimumFractionDigits: 2 })} \u20AC/Monat &middot; {plan.included_cars} Fahrzeuge &middot; {plan.drivers_per_car_limit} Fahrer/Auto
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => handleEdit(plan)}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium"
                      style={{ color: 'var(--accent)', border: '1px solid var(--border)' }}
                    >
                      Bearbeiten
                    </button>
                    <button
                      onClick={() => handleToggleActive(plan)}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium"
                      style={{ color: plan.is_active ? 'var(--danger)' : 'var(--success)', border: '1px solid var(--border)' }}
                    >
                      {plan.is_active ? 'Deaktivieren' : 'Aktivieren'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add/Edit form */}
          <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
              {editId ? 'Plan bearbeiten' : 'Neuen Plan erstellen'}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>Name *</label>
                <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="z.B. Basic" />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>Preis/Monat (\u20AC) *</label>
                <input style={inputStyle} value={form.monthly_price} onChange={e => setForm(f => ({ ...f, monthly_price: e.target.value }))} placeholder="200" />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>Inkl. Fahrzeuge *</label>
                <input style={inputStyle} type="number" min="1" value={form.included_cars} onChange={e => setForm(f => ({ ...f, included_cars: e.target.value }))} placeholder="5" />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>Fahrer pro Fahrzeug</label>
                <input style={inputStyle} type="number" min="1" max="10" value={form.drivers_per_car_limit} onChange={e => setForm(f => ({ ...f, drivers_per_car_limit: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white"
                style={{ background: 'var(--accent)', opacity: saving ? 0.6 : 1 }}
              >
                <Save size={14} /> {editId ? 'Aktualisieren' : 'Erstellen'}
              </button>
              {editId && (
                <button
                  onClick={() => { setEditId(null); setForm(emptyPlan); }}
                  className="px-4 py-2 rounded-xl text-sm font-medium"
                  style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  Abbrechen
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
