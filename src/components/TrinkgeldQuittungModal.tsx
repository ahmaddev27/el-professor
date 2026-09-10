import React, { useState, useEffect, useCallback } from 'react';
import { X, FileText, ChevronRight, ArrowLeft, Download, RefreshCw } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { format } from 'date-fns';
import { supabase } from '../lib/supabase';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import type { CompanySettings } from '../types/settings';
import { getBusinessMonthRange } from '../utils/weekCalculations';
import { useSuperAdmin } from '../contexts/SuperAdminContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Driver {
  id: string;
  name: string;
  gender: 'male' | 'female' | null;
}

interface QuittungData {
  driverName:  string;
  driverGender: 'male' | 'female' | null;
  companyName: string;
  month:       number;
  year:        number;
  amount:      number;
  city:        string;
  docDate:     string;
  signatory:   string;
}

function salutationFor(gender: 'male' | 'female' | null): string {
  if (gender === 'male')   return 'Herr ';
  if (gender === 'female') return 'Frau ';
  return '';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function fmtAmount(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─── German number-to-words (0 – 999 999) ────────────────────────────────────
// Used to render the Trinkgeld amount in words inside the receipt.

const DE_ONES = [
  'null', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun',
  'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn',
  'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn',
];
const DE_TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

function deUnder100(n: number): string {
  if (n < 20) return DE_ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  if (o === 0) return DE_TENS[t];
  return `${DE_ONES[o]}und${DE_TENS[t]}`;
}

function deUnder1000(n: number): string {
  if (n < 100) return deUnder100(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  const hp = `${DE_ONES[h]}hundert`;
  return r === 0 ? hp : `${hp}${deUnder100(r)}`;
}

function deInt(n: number): string {
  if (n === 0) return 'null';
  if (n < 1000) return deUnder1000(n);
  const k = Math.floor(n / 1000);
  const r = n % 1000;
  const kp = k === 1 ? 'eintausend' : `${deUnder1000(k)}tausend`;
  return r === 0 ? kp : `${kp}${deUnder1000(r)}`;
}

/** Converts e.g. 198.34 → "Einhundertachtundneunzig Euro und vierunddreißig Cent". */
function amountInWords(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const totalCents = Math.round(Math.abs(safe) * 100);
  const euros = Math.floor(totalCents / 100);
  const cents = totalCents % 100;
  const euroWords = deInt(euros);
  const centWords = deInt(cents);
  const capitalised = euroWords.charAt(0).toUpperCase() + euroWords.slice(1);
  return `${capitalised} Euro und ${centWords} Cent`;
}

function monthLabel(m: number, y: number): string {
  return `${String(m).padStart(2, '0')}.${y}`;
}

/** First day of the month following the given month/year */
function firstDayNextMonth(month: number, year: number): string {
  const d = new Date(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1);
  return format(d, 'dd.MM.yyyy');
}

// ─── Input style ─────────────────────────────────────────────────────────────

const IS: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  padding: '0.625rem 0.875rem',
  outline: 'none',
  width: '100%',
};

// ─── Shared A4 document component ────────────────────────────────────────────
// Single source of truth for both the screen preview and the PDF export.

interface A4DocProps {
  data: QuittungData;
  settings: CompanySettings | null;
  /** When true, renders at true 794px A4 width for html2canvas capture */
  forExport?: boolean;
}

const A4Document: React.FC<A4DocProps> = ({ data, settings, forExport = false }) => {
  const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

  // Build company address line from settings
  const streetLine = [
    settings?.street,
    settings?.house_number,
  ].filter(Boolean).join(' ');

  const cityLine = [
    settings?.postal_code,
    settings?.city,
  ].filter(Boolean).join(' ');

  const addressLines = [streetLine, cityLine].filter(Boolean);

  const labelStyle: React.CSSProperties = {
    fontSize: '9px',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: '3px',
  };

  const sheet: React.CSSProperties = {
    fontFamily: FONT,
    background: '#ffffff',
    color: '#1a1a1a',
    width: forExport ? '794px' : '100%',
    minHeight: forExport ? '1123px' : undefined,
    aspectRatio: forExport ? undefined : '210 / 297',
    padding: '48px 56px 48px',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
  };

  return (
    <div style={sheet}>

      {/* ── 1. Header: company name + address ── */}
      <div style={{ marginBottom: '32px' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, color: '#111', lineHeight: 1.2 }}>
          {settings?.legal_company_name || settings?.company_name || data.companyName}
        </div>
        {addressLines.map((line, i) => (
          <div key={i} style={{ fontSize: '11px', color: '#444', lineHeight: 1.6, marginTop: i === 0 ? '3px' : '0' }}>
            {line}
          </div>
        ))}
      </div>

      {/* Header rule */}
      <div style={{ borderTop: '1.5px solid #222', marginBottom: '32px' }} />

      {/* ── 2. Document title — centered ── */}
      <div style={{ textAlign: 'center', marginBottom: '36px' }}>
        <div style={{ fontSize: '26px', fontWeight: 800, color: '#111', letterSpacing: '-0.02em', lineHeight: 1.1 }}>
          Quittung
        </div>
        <div style={{ fontSize: '13px', color: '#555', marginTop: '6px' }}>
          Über das Trinkgeld in bar
        </div>
      </div>

      {/* ── 3. Parties ── */}
      <div style={{ marginBottom: '22px', fontSize: '11px', lineHeight: 1.7 }}>
        <div style={{ color: '#888', marginBottom: '6px' }}>Zwischen</div>

        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontWeight: 700, fontSize: '13px', color: '#111' }}>
            {salutationFor(data.driverGender)}{data.driverName}
          </div>
          <div style={{ color: '#888', fontSize: '10px' }}>(nachfolgend Arbeitnehmer genannt)</div>
        </div>

        <div style={{ color: '#888', marginBottom: '6px' }}>und</div>

        <div>
          <div style={{ fontWeight: 700, fontSize: '13px', color: '#111' }}>
            der Firma {data.companyName}
          </div>
          <div style={{ color: '#888', fontSize: '10px' }}>(nachfolgend Arbeitgeber genannt)</div>
        </div>
      </div>

      {/* Rule */}
      <div style={{ borderTop: '1px solid #ddd', marginBottom: '20px' }} />

      {/* ── Confirmation paragraph ── */}
      <div style={{ fontSize: '11.5px', lineHeight: 1.75, color: '#333', marginBottom: '20px' }}>
        Der Arbeitnehmer bestätigt hiermit, das Trinkgeld für den Monat{' '}
        <strong style={{ color: '#111' }}>{monthLabel(data.month, data.year)}</strong> in Höhe von{' '}
        <strong style={{ color: '#111' }}>{fmtAmount(data.amount)} EUR</strong>{' '}
        <span style={{ color: '#555', fontStyle: 'italic' }}>
          (in Worten: {amountInWords(data.amount)})
        </span>{' '}
        in bar vom Arbeitgeber erhalten zu haben. Mit seiner Unterschrift bestätigt der
        Arbeitnehmer den vollständigen Erhalt des oben genannten Betrages.
      </div>

      {/* ── Amount / Month box ── */}
      <div style={{
        display: 'flex',
        background: '#f5f5f5',
        border: '1px solid #e0e0e0',
        borderRadius: '8px',
        overflow: 'hidden',
        marginBottom: '28px',
      }}>
        <div style={{ flex: 1, padding: '14px 20px', borderRight: '1px solid #e0e0e0' }}>
          <div style={labelStyle}>Betrag (EUR)</div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#111', letterSpacing: '-0.01em' }}>
            {fmtAmount(data.amount)} EUR
          </div>
        </div>
        <div style={{ flex: 1, padding: '14px 20px' }}>
          <div style={labelStyle}>Monat</div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#111', letterSpacing: '-0.01em' }}>
            {monthLabel(data.month, data.year)}
          </div>
        </div>
      </div>

      {/* Spacer pushes signature to bottom */}
      <div style={{ flex: 1 }} />

      {/* ── 4. Bottom: Ort/Datum + signatures ── */}
      <div style={{ fontSize: '11px', color: '#555', marginBottom: '36px' }}>
        <div style={{ color: '#999', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>
          Ort, Datum
        </div>
        <div style={{ fontWeight: 600, fontSize: '12px', color: '#111' }}>
          {data.city}, den {data.docDate}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '40px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ borderTop: '1px solid #555', paddingTop: '6px' }}>
            <div style={{ fontSize: '9.5px', color: '#888' }}>Arbeitnehmer</div>
            <div style={{ fontSize: '10px', color: '#444', marginTop: '2px' }}>{data.driverName}</div>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ borderTop: '1px solid #555', paddingTop: '6px' }}>
            <div style={{ fontSize: '9.5px', color: '#888' }}>Arbeitgeber</div>
            <div style={{ fontSize: '10px', color: '#444', marginTop: '2px' }}>{data.signatory}</div>
          </div>
        </div>
      </div>

    </div>
  );
};

// ─── PDF export via html2canvas ───────────────────────────────────────────────

async function exportQuittungPDF(
  data: QuittungData,
  settings: CompanySettings | null,
): Promise<void> {
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-9999px;top:0;width:794px;';
  document.body.appendChild(container);

  const root = document.createElement('div');
  container.appendChild(root);

  const { createRoot } = await import('react-dom/client');
  const reactRoot = createRoot(root);

  await new Promise<void>(resolve => {
    reactRoot.render(
      React.createElement(A4Document, { data, settings, forExport: true })
    );
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  const canvas = await html2canvas(root.firstElementChild as HTMLElement, {
    scale: 2,
    useCORS: true,
    allowTaint: false,
    backgroundColor: '#ffffff',
    width: 794,
    windowWidth: 794,
  });

  reactRoot.unmount();
  document.body.removeChild(container);

  const imgData = canvas.toDataURL('image/jpeg', 0.97);
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  pdf.addImage(imgData, 'JPEG', 0, 0, 210, 297);

  const filename = `Trinkgeld_Quittung_${data.driverName.replace(/\s+/g, '_')}_${monthLabel(data.month, data.year).replace('.', '-')}`;
  pdf.save(`${filename}.pdf`);
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

type Step = 'select' | 'preview';

const TrinkgeldQuittungModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { settings } = useCompanySettings();
  const { effectiveCompanyId: companyId } = useSuperAdmin();

  const [drivers,   setDrivers]   = useState<Driver[]>([]);
  const [driverId,  setDriverId]  = useState('');
  const [month,     setMonth]     = useState(new Date().getMonth() + 1);
  const [year,      setYear]      = useState(new Date().getFullYear());
  const [step,      setStep]      = useState<Step>('select');
  const [loading,   setLoading]   = useState(false);
  const [exporting, setExporting] = useState(false);

  const [amount,    setAmount]    = useState('');
  const [city,      setCity]      = useState('');
  const [docDate,   setDocDate]   = useState('');
  const [signatory, setSignatory] = useState('');

  const years = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i);

  // Auto-update docDate when month/year changes: always first day of next month
  useEffect(() => {
    setDocDate(firstDayNextMonth(month, year));
  }, [month, year]);

  useEffect(() => {
    if (!isOpen || !companyId) return;
    supabase
      .from('drivers')
      .select('id, name, gender')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .order('name')
      .then(({ data }) => {
        const list = (data ?? []).map(d => ({
          id: d.id,
          name: d.name,
          gender: (d.gender ?? null) as 'male' | 'female' | null,
        }));
        setDrivers(list);
      });
  }, [isOpen, companyId]);

  useEffect(() => {
    if (!isOpen) {
      setStep('select');
      setDriverId('');
      setAmount('');
    }
  }, [isOpen]);

  const prefillFromSettings = useCallback(() => {
    // City comes from company settings (default_signature_city, then city)
    setCity(settings?.default_signature_city || settings?.city || '');
    // Date is always first day of the month after the selected month
    setDocDate(firstDayNextMonth(month, year));
    setSignatory(settings?.company_name || '');
  }, [settings, month, year]);

  const fetchTrinkgeldTotal = useCallback(async (driverName: string, m: number, y: number): Promise<number> => {
    const { start, end } = getBusinessMonthRange(m - 1, y);
    const from = format(start, 'yyyy-MM-dd');
    const to   = format(end,   'yyyy-MM-dd');

    const { data, error } = await supabase
      .from('income')
      .select('amount')
      .eq('company_id', companyId)
      .eq('driver_name', driverName)
      .eq('type', 'trinkgeld')
      .gte('date', from)
      .lte('date', to);

    if (error) throw error;
    return (data ?? []).reduce((s, r) => s + Number(r.amount), 0);
  }, [companyId]);

  const handleGenerate = async () => {
    if (!driverId) return;
    setLoading(true);
    try {
      const driver = drivers.find(d => d.id === driverId);
      if (!driver) return;
      const total = await fetchTrinkgeldTotal(driver.name, month, year);
      setAmount(fmtAmount(total).replace('.', ','));
      prefillFromSettings();
      setStep('preview');
    } finally {
      setLoading(false);
    }
  };

  // While in the preview step, refresh the amount whenever driver/month/year change.
  const handlePreviewDriverChange = async (newDriverId: string) => {
    setDriverId(newDriverId);
    const driver = drivers.find(d => d.id === newDriverId);
    if (!driver) return;
    try {
      const total = await fetchTrinkgeldTotal(driver.name, month, year);
      setAmount(fmtAmount(total).replace('.', ','));
    } catch (err) {
      console.error('Failed to load Trinkgeld for driver:', err);
    }
  };

  const handlePreviewMonthChange = async (newMonth: number, newYear: number) => {
    setMonth(newMonth);
    setYear(newYear);
    setDocDate(firstDayNextMonth(newMonth, newYear));
    const driver = drivers.find(d => d.id === driverId);
    if (!driver) return;
    try {
      const total = await fetchTrinkgeldTotal(driver.name, newMonth, newYear);
      setAmount(fmtAmount(total).replace('.', ','));
    } catch (err) {
      console.error('Failed to load Trinkgeld for month:', err);
    }
  };

  const handleExport = async () => {
    const driver = drivers.find(d => d.id === driverId);
    if (!driver) return;
    const parsedAmount = parseFloat(amount.replace(',', '.'));
    if (isNaN(parsedAmount)) return;

    setExporting(true);
    try {
      await exportQuittungPDF(
        {
          driverName:   driver.name,
          driverGender: driver.gender ?? null,
          companyName:  settings?.company_name || signatory,
          month,
          year,
          amount:       parsedAmount,
          city:         city || settings?.city || 'Ort',
          docDate:      docDate || firstDayNextMonth(month, year),
          signatory:    signatory || settings?.company_name || '',
        },
        settings,
      );
    } finally {
      setExporting(false);
    }
  };

  if (!isOpen) return null;

  const selectedDriver = drivers.find(d => d.id === driverId);

  const previewData: QuittungData | null = selectedDriver
    ? {
        driverName:   selectedDriver.name,
        driverGender: selectedDriver.gender ?? null,
        companyName:  settings?.company_name || signatory,
        month,
        year,
        amount:       parseFloat(amount.replace(',', '.')) || 0,
        city:         city || settings?.city || 'Ort',
        docDate:      docDate || firstDayNextMonth(month, year),
        signatory:    signatory || settings?.company_name || '',
      }
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full flex flex-col"
        style={{
          maxWidth: step === 'preview' ? '960px' : '560px',
          background: 'var(--bg-surface)',
          boxShadow: 'var(--shadow-xl)',
          border: '1px solid var(--border)',
          borderRadius: '1rem',
          maxHeight: '94vh',
          transition: 'max-width 0.25s ease',
        }}
      >
        {/* Modal header */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: '1px solid var(--border)', flexShrink: 0 }}
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg p-2" style={{ background: 'var(--accent-subtle)' }}>
              <FileText size={18} style={{ color: 'var(--accent-text)' }} />
            </div>
            <div>
              <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
                Trinkgeld Quittung
              </h2>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {step === 'select' ? 'Fahrer und Zeitraum wählen' : 'Vorschau und Export'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:opacity-70 transition-opacity">
            <X size={18} style={{ color: 'var(--text-tertiary)' }} />
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* ── Step 1: select ── */}
          {step === 'select' && (
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Fahrer *
                </label>
                <select value={driverId} onChange={e => setDriverId(e.target.value)} style={IS}>
                  <option value="">Fahrer auswählen …</option>
                  {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Monat *
                  </label>
                  <select value={month} onChange={e => setMonth(Number(e.target.value))} style={IS}>
                    {MONTH_NAMES_DE.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Jahr *
                  </label>
                  <select value={year} onChange={e => setYear(Number(e.target.value))} style={IS}>
                    {years.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
              </div>

              <div
                className="rounded-lg p-4 text-sm"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
              >
                <p style={{ color: 'var(--text-secondary)' }}>
                  Das System summiert automatisch alle Trinkgeld-Einnahmen des gewählten Fahrers
                  für den ausgewählten Monat. Andere Einnahmetypen werden nicht berücksichtigt.
                </p>
              </div>
            </div>
          )}

          {/* ── Step 2: preview ── */}
          {step === 'preview' && previewData && (
            <div style={{ display: 'flex', height: '100%' }}>
              {/* Left: A4 preview */}
              <div style={{
                flex: '1 1 0',
                overflowY: 'auto',
                padding: '24px',
                background: 'var(--bg-muted)',
                borderRight: '1px solid var(--border)',
              }}>
                <div style={{
                  background: '#fff',
                  boxShadow: '0 4px 32px rgba(0,0,0,0.18)',
                  borderRadius: '4px',
                  overflow: 'hidden',
                  aspectRatio: '210 / 297',
                  width: '100%',
                }}>
                  <A4Document data={previewData} settings={settings} />
                </div>
              </div>

              {/* Right: editable fields */}
              <div style={{
                width: '280px',
                flexShrink: 0,
                overflowY: 'auto',
                padding: '24px 20px',
              }}>
                <p className="text-xs font-semibold uppercase tracking-wide mb-4" style={{ color: 'var(--text-tertiary)' }}>
                  Felder anpassen
                </p>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                      Fahrer
                    </label>
                    <select
                      value={driverId}
                      onChange={e => handlePreviewDriverChange(e.target.value)}
                      style={IS}
                    >
                      {drivers.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                      Monat
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={month}
                        onChange={e => handlePreviewMonthChange(Number(e.target.value), year)}
                        style={IS}
                      >
                        {MONTH_NAMES_DE.map((m, i) => (
                          <option key={i + 1} value={i + 1}>{m}</option>
                        ))}
                      </select>
                      <select
                        value={year}
                        onChange={e => handlePreviewMonthChange(month, Number(e.target.value))}
                        style={IS}
                      >
                        {years.map(y => (
                          <option key={y} value={y}>{y}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                      Betrag (EUR)
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      style={IS}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                      Dokumentdatum
                    </label>
                    <input
                      type="text"
                      placeholder="dd.MM.yyyy"
                      value={docDate}
                      onChange={e => setDocDate(e.target.value)}
                      style={IS}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                      Ort
                    </label>
                    <input
                      type="text"
                      value={city}
                      onChange={e => setCity(e.target.value)}
                      style={IS}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                      Arbeitgeber (Unterschrift)
                    </label>
                    <input
                      type="text"
                      value={signatory}
                      onChange={e => setSignatory(e.target.value)}
                      style={IS}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal footer */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderTop: '1px solid var(--border)', flexShrink: 0 }}
        >
          {step === 'select' ? (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
              >
                Abbrechen
              </button>
              <button
                onClick={handleGenerate}
                disabled={!driverId || loading}
                className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all"
                style={driverId
                  ? { background: 'var(--accent)', color: 'white' }
                  : { background: 'var(--bg-muted)', color: 'var(--text-tertiary)', cursor: 'not-allowed' }}
              >
                {loading
                  ? <><RefreshCw size={14} className="animate-spin" /> Lädt …</>
                  : <>Vorschau generieren <ChevronRight size={14} /></>}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep('select')}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
              >
                <ArrowLeft size={14} /> Zurück
              </button>
              <button
                onClick={handleExport}
                disabled={exporting}
                className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                <Download size={14} />
                {exporting ? 'Exportiert …' : 'Als PDF exportieren'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default TrinkgeldQuittungModal;
