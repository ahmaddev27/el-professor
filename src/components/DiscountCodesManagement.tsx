import React, { useEffect, useState, useCallback } from 'react';
import { Plus, CreditCard as Edit2, Trash2, ToggleLeft, ToggleRight, Tag, ChevronDown, ChevronUp, Users, Building2, Calendar, Hash, Percent, Euro, Check, X, AlertTriangle } from 'lucide-react';
import ConfirmationModal from './ConfirmationModal';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { fmt as fmtPrice } from '../utils/pricing';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface DiscountCode {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  usage_mode: 'once' | 'monthly';
  audience_type: 'single' | 'multiple';
  max_redemptions: number | null;
  used_count: number;
  valid_from: string | null;
  valid_until: string | null;
  active: boolean;
  applies_to_plan: 'basic' | 'advanced' | 'premium' | 'all';
  applies_to_billing_cycle: 'monthly' | 'yearly' | 'all';
  min_cars: number | null;
  max_cars: number | null;
  assigned_company_id: string | null;
  created_at: string;
  updated_at: string;
}

interface Redemption {
  id: string;
  company_id: string;
  plan: string;
  billing_cycle: string;
  car_limit: number;
  original_price: number;
  discount_amount: number;
  final_price: number;
  usage_mode: string;
  redeemed_at: string;
  company_name?: string;
}

interface Company { id: string; name: string; }

const emptyForm = (): Omit<DiscountCode, 'id' | 'used_count' | 'created_at' | 'updated_at'> => ({
  code: '',
  description: null,
  discount_type: 'percentage',
  discount_value: 10,
  usage_mode: 'once',
  audience_type: 'multiple',
  max_redemptions: null,
  valid_from: null,
  valid_until: null,
  active: true,
  applies_to_plan: 'all',
  applies_to_billing_cycle: 'all',
  min_cars: null,
  max_cars: null,
  assigned_company_id: null,
});

// ─── Modal ─────────────────────────────────────────────────────────────────────

interface ModalProps {
  dc: DiscountCode | null;
  companies: Company[];
  onClose: () => void;
  onSaved: () => void;
}

const DiscountCodeModal: React.FC<ModalProps> = ({ dc, companies, onClose, onSaved }) => {
  const { showToast } = useToast();
  const [form, setForm] = useState(dc ? {
    code: dc.code,
    description: dc.description ?? '',
    discount_type: dc.discount_type,
    discount_value: dc.discount_value,
    usage_mode: dc.usage_mode,
    audience_type: dc.audience_type,
    max_redemptions: dc.max_redemptions ?? '',
    valid_from: dc.valid_from ? dc.valid_from.slice(0, 10) : '',
    valid_until: dc.valid_until ? dc.valid_until.slice(0, 10) : '',
    active: dc.active,
    applies_to_plan: dc.applies_to_plan,
    applies_to_billing_cycle: dc.applies_to_billing_cycle,
    min_cars: dc.min_cars ?? '',
    max_cars: dc.max_cars ?? '',
    assigned_company_id: dc.assigned_company_id ?? '',
  } : {
    code: '',
    description: '',
    discount_type: 'percentage' as const,
    discount_value: 10,
    usage_mode: 'once' as const,
    audience_type: 'multiple' as const,
    max_redemptions: '' as string | number,
    valid_from: '',
    valid_until: '',
    active: true,
    applies_to_plan: 'all' as const,
    applies_to_billing_cycle: 'all' as const,
    min_cars: '' as string | number,
    max_cars: '' as string | number,
    assigned_company_id: '',
  });
  const [saving, setSaving] = useState(false);

  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.code.trim()) { showToast('Bitte Code eingeben.', 'error'); return; }
    if (form.discount_value <= 0) { showToast('Rabattwert muss > 0 sein.', 'error'); return; }
    if (form.discount_type === 'percentage' && form.discount_value > 100) {
      showToast('Prozentwert darf max. 100 sein.', 'error'); return;
    }
    setSaving(true);
    const payload = {
      code: form.code.trim().toUpperCase(),
      description: form.description || null,
      discount_type: form.discount_type,
      discount_value: Number(form.discount_value),
      usage_mode: form.usage_mode,
      audience_type: form.audience_type,
      max_redemptions: form.max_redemptions !== '' ? Number(form.max_redemptions) : null,
      valid_from: form.valid_from || null,
      valid_until: form.valid_until || null,
      active: form.active,
      applies_to_plan: form.applies_to_plan,
      applies_to_billing_cycle: form.applies_to_billing_cycle,
      min_cars: form.min_cars !== '' ? Number(form.min_cars) : null,
      max_cars: form.max_cars !== '' ? Number(form.max_cars) : null,
      assigned_company_id: form.assigned_company_id || null,
    };
    const { error } = dc
      ? await supabase.from('discount_codes').update(payload).eq('id', dc.id)
      : await supabase.from('discount_codes').insert(payload);
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(dc ? 'Rabattcode aktualisiert.' : 'Rabattcode erstellt.', 'success');
    onSaved();
    onClose();
  };

  const inputCls = 'w-full px-3 py-2 rounded-lg border text-sm transition-all outline-none focus:ring-2';
  const fieldStyle = { background: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-primary)' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <h2 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>
            {dc ? 'Rabattcode bearbeiten' : 'Neuer Rabattcode'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:opacity-70 transition-opacity" style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {/* Code + Description */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Code *</label>
              <input className={inputCls} style={fieldStyle} value={form.code} onChange={e => set('code', e.target.value.toUpperCase())} placeholder="WELCOME10" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Beschreibung</label>
              <input className={inputCls} style={fieldStyle} value={form.description ?? ''} onChange={e => set('description', e.target.value)} placeholder="Optionale Beschreibung" />
            </div>
          </div>

          {/* Discount type + value */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Rabattart</label>
              <select className={inputCls} style={fieldStyle} value={form.discount_type} onChange={e => set('discount_type', e.target.value)}>
                <option value="percentage">Prozent (%)</option>
                <option value="fixed">Festbetrag (€)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Rabattwert {form.discount_type === 'percentage' ? '(%)' : '(€)'}
              </label>
              <input type="number" min={0} max={form.discount_type === 'percentage' ? 100 : undefined} step="0.01"
                className={inputCls} style={fieldStyle}
                value={form.discount_value}
                onChange={e => set('discount_value', parseFloat(e.target.value) || 0)} />
            </div>
          </div>

          {/* Usage mode + Audience type */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Nutzung</label>
              <select className={inputCls} style={fieldStyle} value={form.usage_mode} onChange={e => set('usage_mode', e.target.value)}>
                <option value="once">Einmalig</option>
                <option value="monthly">Monatlich wiederkehrend</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Zielgruppe</label>
              <select className={inputCls} style={fieldStyle} value={form.audience_type} onChange={e => set('audience_type', e.target.value)}>
                <option value="multiple">Mehrere Firmen</option>
                <option value="single">Eine Firma</option>
              </select>
            </div>
          </div>

          {/* Assigned company (single) + max redemptions (multiple) */}
          {form.audience_type === 'single' && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Zugewiesene Firma (optional)</label>
              <select className={inputCls} style={fieldStyle} value={form.assigned_company_id ?? ''} onChange={e => set('assigned_company_id', e.target.value)}>
                <option value="">— Erste einlösende Firma —</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          {form.audience_type === 'multiple' && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Maximale Nutzungen (leer = unbegrenzt)</label>
              <input type="number" min={1} className={inputCls} style={fieldStyle}
                value={form.max_redemptions} onChange={e => set('max_redemptions', e.target.value)} placeholder="z.B. 100" />
            </div>
          )}

          {/* Validity dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Gültig von</label>
              <input type="date" className={inputCls} style={fieldStyle} value={form.valid_from ?? ''} onChange={e => set('valid_from', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Gültig bis</label>
              <input type="date" className={inputCls} style={fieldStyle} value={form.valid_until ?? ''} onChange={e => set('valid_until', e.target.value)} />
            </div>
          </div>

          {/* Plan + billing cycle filters */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Gültig für Tarif</label>
              <select className={inputCls} style={fieldStyle} value={form.applies_to_plan} onChange={e => set('applies_to_plan', e.target.value)}>
                <option value="all">Alle Tarife</option>
                <option value="basic">Basic</option>
                <option value="advanced">Advanced</option>
                <option value="premium">Premium</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Gültig für Abrechnung</label>
              <select className={inputCls} style={fieldStyle} value={form.applies_to_billing_cycle} onChange={e => set('applies_to_billing_cycle', e.target.value)}>
                <option value="all">Monatlich & Jährlich</option>
                <option value="monthly">Nur monatlich</option>
                <option value="yearly">Nur jährlich</option>
              </select>
            </div>
          </div>

          {/* Car limits */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Mindestanzahl Fahrzeuge</label>
              <input type="number" min={1} className={inputCls} style={fieldStyle}
                value={form.min_cars} onChange={e => set('min_cars', e.target.value)} placeholder="—" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Maximale Anzahl Fahrzeuge</label>
              <input type="number" min={1} className={inputCls} style={fieldStyle}
                value={form.max_cars} onChange={e => set('max_cars', e.target.value)} placeholder="—" />
            </div>
          </div>

          {/* Active toggle */}
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <div
              className="relative w-11 h-6 rounded-full transition-colors"
              style={{ background: form.active ? 'var(--success)' : 'var(--bg-muted)' }}
              onClick={() => set('active', !form.active)}
            >
              <div className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform" style={{ transform: form.active ? 'translateX(20px)' : 'translateX(0)' }} />
            </div>
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Aktiv</span>
          </label>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t" style={{ borderColor: 'var(--border)' }}>
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-70" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
            Abbrechen
          </button>
          <button onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-50" style={{ background: 'var(--accent)' }}>
            {saving ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Redemptions popover ──────────────────────────────────────────────────────

const RedemptionsPanel: React.FC<{ codeId: string }> = ({ codeId }) => {
  const [rows, setRows] = useState<Redemption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('discount_code_redemptions')
        .select('*, companies(name)')
        .eq('discount_code_id', codeId)
        .order('redeemed_at', { ascending: false })
        .limit(50);
      setRows((data ?? []).map((r: any) => ({ ...r, company_name: r.companies?.name })));
      setLoading(false);
    })();
  }, [codeId]);

  if (loading) return <p className="text-xs text-center py-3" style={{ color: 'var(--text-tertiary)' }}>Laden…</p>;
  if (!rows.length) return <p className="text-xs text-center py-3" style={{ color: 'var(--text-tertiary)' }}>Noch keine Einlösungen.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr style={{ color: 'var(--text-tertiary)' }}>
            <th className="text-left py-1.5 pr-3 font-semibold">Firma</th>
            <th className="text-left py-1.5 pr-3 font-semibold">Tarif</th>
            <th className="text-right py-1.5 pr-3 font-semibold">Original</th>
            <th className="text-right py-1.5 pr-3 font-semibold">Rabatt</th>
            <th className="text-right py-1.5 font-semibold">Endpreis</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
              <td className="py-1.5 pr-3" style={{ color: 'var(--text-primary)' }}>{r.company_name ?? r.company_id.slice(0, 8)}</td>
              <td className="py-1.5 pr-3 capitalize" style={{ color: 'var(--text-secondary)' }}>{r.plan}</td>
              <td className="py-1.5 pr-3 text-right" style={{ color: 'var(--text-secondary)' }}>{fmtPrice(r.original_price)} €</td>
              <td className="py-1.5 pr-3 text-right" style={{ color: 'var(--success)' }}>-{fmtPrice(r.discount_amount)} €</td>
              <td className="py-1.5 text-right font-semibold" style={{ color: 'var(--text-primary)' }}>{fmtPrice(r.final_price)} €</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const DiscountCodesManagement: React.FC = () => {
  const { showToast } = useToast();
  const [codes, setCodes] = useState<DiscountCode[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalDc, setModalDc] = useState<DiscountCode | 'new' | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; dc: DiscountCode | null }>({ open: false, dc: null });

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: codesData }, { data: companiesData }] = await Promise.all([
      supabase.from('discount_codes').select('*').order('created_at', { ascending: false }),
      supabase.from('companies').select('id, name').order('name'),
    ]);
    setCodes(codesData ?? []);
    setCompanies(companiesData ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (dc: DiscountCode) => {
    const { error } = await supabase.from('discount_codes').update({ active: !dc.active }).eq('id', dc.id);
    if (error) { showToast(error.message, 'error'); return; }
    setCodes(prev => prev.map(c => c.id === dc.id ? { ...c, active: !c.active } : c));
  };

  const handleDelete = (dc: DiscountCode) => {
    setDeleteConfirm({ open: true, dc });
  };

  const confirmDelete = async () => {
    const dc = deleteConfirm.dc;
    setDeleteConfirm({ open: false, dc: null });
    if (!dc) return;
    const { error } = await supabase.from('discount_codes').delete().eq('id', dc.id);
    if (error) { showToast(error.message, 'error'); return; }
    setCodes(prev => prev.filter(c => c.id !== dc.id));
    showToast('Rabattcode gelöscht.', 'success');
  };

  const formatDate = (iso: string | null) => iso ? format(new Date(iso), 'dd.MM.yy', { locale: de }) : '—';

  const discountLabel = (dc: DiscountCode) =>
    dc.discount_type === 'percentage'
      ? `${dc.discount_value}%`
      : `${fmtPrice(dc.discount_value)} €`;

  const usageModeLabel = (mode: string) => mode === 'once' ? 'Einmalig' : 'Monatlich';
  const audienceLabel = (type: string) => type === 'single' ? 'Eine Firma' : 'Mehrere Firmen';

  const planLabel = (v: string) => ({ all: 'Alle', basic: 'Basic', advanced: 'Advanced', premium: 'Premium' }[v] ?? v);
  const cycleLabel = (v: string) => ({ all: 'Alle', monthly: 'Monatlich', yearly: 'Jährlich' }[v] ?? v);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl p-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4"
        style={{ background: 'linear-gradient(135deg, #0f2640 0%, #071524 100%)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center gap-3">
          <div className="rounded-lg p-2.5" style={{ background: 'rgba(6,182,212,0.15)' }}>
            <Tag className="text-cyan-400" size={28} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Rabattcodes</h1>
            <p className="text-sm" style={{ color: 'rgba(255,255,255,0.45)' }}>
              {codes.length} Code{codes.length !== 1 ? 's' : ''} · {codes.filter(c => c.active).length} aktiv
            </p>
          </div>
        </div>
        <button
          onClick={() => setModalDc('new')}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm text-white transition-all hover:shadow-lg hover:-translate-y-0.5"
          style={{ background: 'var(--accent)' }}
        >
          <Plus size={16} />
          Neuer Rabattcode
        </button>
      </div>

      {/* Table */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)', border: '1px solid var(--border)' }}>
        {loading ? (
          <div className="py-16 text-center" style={{ color: 'var(--text-tertiary)' }}>Laden…</div>
        ) : codes.length === 0 ? (
          <div className="py-16 text-center">
            <Tag size={40} className="mx-auto mb-3 opacity-20" style={{ color: 'var(--text-tertiary)' }} />
            <p style={{ color: 'var(--text-tertiary)' }}>Noch keine Rabattcodes erstellt.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead style={{ background: 'var(--bg-subtle)' }}>
                <tr>
                  {['Code', 'Rabattart', 'Wert', 'Nutzung', 'Zielgruppe', 'Gültigkeit', 'Nutzungen', 'Aktiv', 'Aktionen'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {codes.map(dc => (
                  <React.Fragment key={dc.id}>
                    <tr style={{ borderBottom: '1px solid var(--border)' }} className="transition-colors hover:bg-[var(--bg-subtle)]">
                      <td className="px-4 py-3">
                        <div className="font-mono font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{dc.code}</div>
                        {dc.description && <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{dc.description}</div>}
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {dc.applies_to_plan !== 'all' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}>{planLabel(dc.applies_to_plan)}</span>
                          )}
                          {dc.applies_to_billing_cycle !== 'all' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>{cycleLabel(dc.applies_to_billing_cycle)}</span>
                          )}
                          {(dc.min_cars || dc.max_cars) && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{ background: 'var(--bg-muted)', color: 'var(--text-tertiary)' }}>
                              {dc.min_cars ?? '1'}–{dc.max_cars ?? '∞'} Fz.
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-1 rounded-full"
                          style={dc.discount_type === 'percentage'
                            ? { background: 'rgba(6,182,212,0.1)', color: '#22d3ee' }
                            : { background: 'rgba(251,191,36,0.1)', color: '#fbbf24' }}>
                          {dc.discount_type === 'percentage' ? <Percent size={10} /> : <Euro size={10} />}
                          {dc.discount_type === 'percentage' ? 'Prozent' : 'Festbetrag'}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{discountLabel(dc)}</td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{usageModeLabel(dc.usage_mode)}</td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <div>{audienceLabel(dc.audience_type)}</div>
                        {dc.max_redemptions && <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>max. {dc.max_redemptions}</div>}
                      </td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <div>{formatDate(dc.valid_from)} – {formatDate(dc.valid_until)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setExpanded(expanded === dc.id ? null : dc.id)}
                          className="inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-1 rounded-full transition-colors hover:opacity-80"
                          style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}
                        >
                          <Hash size={10} />
                          {dc.used_count}
                          {expanded === dc.id ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => toggleActive(dc)} className="transition-opacity hover:opacity-70">
                          {dc.active
                            ? <ToggleRight size={24} style={{ color: 'var(--success)' }} />
                            : <ToggleLeft size={24} style={{ color: 'var(--text-tertiary)' }} />}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setModalDc(dc)}
                            className="p-1.5 rounded-lg transition-opacity hover:opacity-70"
                            style={{ color: 'var(--accent)' }}
                            title="Bearbeiten"
                          >
                            <Edit2 size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(dc)}
                            className="p-1.5 rounded-lg transition-opacity hover:opacity-70"
                            style={{ color: 'var(--danger)' }}
                            title="Löschen"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded === dc.id && (
                      <tr>
                        <td colSpan={9} className="px-6 py-4" style={{ background: 'var(--bg-subtle)' }}>
                          <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>Einlösungen</p>
                          <RedemptionsPanel codeId={dc.id} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal */}
      {modalDc && (
        <DiscountCodeModal
          dc={modalDc === 'new' ? null : modalDc}
          companies={companies}
          onClose={() => setModalDc(null)}
          onSaved={load}
        />
      )}
      <ConfirmationModal
        isOpen={deleteConfirm.open}
        onClose={() => setDeleteConfirm({ open: false, dc: null })}
        onConfirm={confirmDelete}
        title="Rabattcode löschen"
        message={`Rabattcode "${deleteConfirm.dc?.code ?? ''}" wirklich löschen?`}
        type="confirm"
        confirmText="Löschen"
        cancelText="Abbrechen"
      />
    </div>
  );
};

export default DiscountCodesManagement;
