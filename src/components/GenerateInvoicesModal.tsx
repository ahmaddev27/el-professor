import React, { useState } from 'react';
import { X, FileText, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

interface CompanySub {
  id: string;
  company_id: string;
  plan_id: string;
  status: string;
  billing_day: number;
  monthly_price: number;
  companies: { name: string } | null;
  subscription_plans: { name: string } | null;
}

interface Props {
  subscriptions: CompanySub[];
  onClose: () => void;
  onGenerated: () => void;
}

const MONTHS_DE = [
  'Januar', 'Februar', 'M\u00E4rz', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export default function GenerateInvoicesModal({ subscriptions, onClose, onGenerated }: Props) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<{ created: number; skipped: number; errors: string[] } | null>(null);

  const activeSubs = subscriptions.filter(s => s.status === 'active');

  const handleGenerate = async () => {
    if (!user) return;
    setGenerating(true);
    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    try {
      // Check existing invoices for this month
      const { data: existing } = await supabase
        .from('subscription_invoices')
        .select('company_id')
        .eq('invoice_month', month)
        .eq('invoice_year', year);

      const existingSet = new Set((existing || []).map(e => e.company_id));

      for (const sub of activeSubs) {
        if (existingSet.has(sub.company_id)) {
          skipped.push((sub.companies as any)?.name || sub.company_id.slice(0, 8));
          continue;
        }

        // Generate invoice number via RPC
        const { data: invNum } = await supabase.rpc('generate_invoice_number', { p_year: year });
        if (!invNum) {
          errors.push(`Rechnungsnummer f\u00FCr ${(sub.companies as any)?.name} konnte nicht generiert werden`);
          continue;
        }

        const dueDate = new Date(year, month - 1, Math.min(sub.billing_day, 28));

        const { error: insertErr } = await supabase
          .from('subscription_invoices')
          .insert({
            company_id: sub.company_id,
            subscription_id: sub.id,
            invoice_month: month,
            invoice_year: year,
            invoice_number: invNum,
            amount: sub.monthly_price,
            status: 'open',
            payment_method: 'cash',
            due_date: dueDate.toISOString().split('T')[0],
          });

        if (insertErr) {
          if (insertErr.code === '23505') {
            skipped.push((sub.companies as any)?.name || sub.company_id.slice(0, 8));
          } else {
            errors.push(`${(sub.companies as any)?.name}: ${insertErr.message}`);
          }
        } else {
          created.push((sub.companies as any)?.name || sub.company_id.slice(0, 8));
        }
      }

      setResults({ created: created.length, skipped: skipped.length, errors });
      if (created.length > 0) {
        showToast('success', `${created.length} Rechnung(en) erstellt`);
        onGenerated();
      }
    } catch (err: any) {
      showToast('error', 'Fehler: ' + (err.message || 'Unbekannt'));
    } finally {
      setGenerating(false);
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
              <FileText size={20} style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>Monatsrechnungen generieren</h2>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{activeSubs.length} aktive Abonnements</p>
            </div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-tertiary)' }}><X size={20} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>Monat</label>
              <select value={month} onChange={e => setMonth(+e.target.value)} style={inputStyle}>
                {MONTHS_DE.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>Jahr</label>
              <input type="number" value={year} onChange={e => setYear(+e.target.value)} style={inputStyle} min={2024} max={2099} />
            </div>
          </div>

          <div className="p-3 rounded-xl text-sm" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
            F\u00FCr {activeSubs.length} aktive Abonnements werden Rechnungen f\u00FCr <strong>{MONTHS_DE[month - 1]} {year}</strong> erstellt. Bereits vorhandene werden \u00FCbersprungen.
          </div>

          {results && (
            <div className="p-3 rounded-xl text-sm space-y-1" style={{
              background: results.errors.length > 0 ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
              border: `1px solid ${results.errors.length > 0 ? 'var(--danger)' : 'var(--success)'}`,
            }}>
              <p style={{ color: 'var(--success)' }}>{results.created} Rechnung(en) erstellt</p>
              {results.skipped > 0 && <p style={{ color: 'var(--text-tertiary)' }}>{results.skipped} \u00FCbersprungen (existiert bereits)</p>}
              {results.errors.map((e, i) => <p key={i} style={{ color: 'var(--danger)' }}>{e}</p>)}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t" style={{ borderColor: 'var(--border)' }}>
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl text-sm font-medium" style={{ color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
            Schlie\u00DFen
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating || activeSubs.length === 0}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'var(--accent)', opacity: generating || activeSubs.length === 0 ? 0.6 : 1 }}
          >
            {generating ? <><Loader2 size={16} className="animate-spin" /> Generiere...</> : <><FileText size={16} /> Generieren</>}
          </button>
        </div>
      </div>
    </div>
  );
}
