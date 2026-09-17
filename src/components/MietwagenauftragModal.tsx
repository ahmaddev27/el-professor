import React, { useState, useEffect, useCallback } from 'react';
import { X, Download, Car, FileText } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { format } from 'date-fns';
import { supabase } from '../lib/supabase';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import type { CompanySettings } from '../types/settings';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Driver {
  id: string;
  name: string;
}

interface Car {
  id: string;
  kennzeichen: string;
}

interface MietwagenData {
  auftragNr: string;
  datumAuftragseingang: string;
  uhrzeitAuftragseingang: string;
  fahrtbeginnDatum: string;
  fahrtbeginnUhrzeit: string;
  angenommenDurch: string;
  artDesAuftrags: string;
  fahrerName: string;
  kennzeichen: string;
  fahrgast: string;
  telefon: string;
  anzahlFahrgaeste: string;
  abholadresse: string;
  zieladresse: string;
  zwischenziele: string;
  zahlungsart: string;
  betrag: string;
  bemerkungen: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateAuftragNr(): string {
  const now = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `MA-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function todayStr() {
  return format(new Date(), 'yyyy-MM-dd');
}

function nowTimeStr() {
  return format(new Date(), 'HH:mm');
}

// ─── A4 Document Component ────────────────────────────────────────────────────

const A4Document: React.FC<{
  data: MietwagenData;
  settings: CompanySettings | null;
  forExport?: boolean;
}> = ({ data, settings, forExport }) => {
  const w = forExport ? 794 : '100%';
  const companyAddr = [
    settings?.street && settings?.house_number
      ? `${settings.street} ${settings.house_number}`
      : settings?.street || '',
    settings?.postal_code && settings?.city
      ? `${settings.postal_code} ${settings.city}`
      : settings?.city || '',
  ].filter(Boolean).join(', ');

  const labelStyle: React.CSSProperties = {
    fontSize: 9,
    color: '#6b7280',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    marginBottom: 2,
  };
  const valueStyle: React.CSSProperties = {
    fontSize: 11,
    color: '#111827',
    fontWeight: 500,
  };
  const cellStyle: React.CSSProperties = {
    padding: '6px 10px',
    borderBottom: '1px solid #e5e7eb',
  };
  const headerCell: React.CSSProperties = {
    ...cellStyle,
    background: '#f3f4f6',
    fontWeight: 700,
    fontSize: 10,
    color: '#374151',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.03em',
  };

  return (
    <div
      style={{
        width: w,
        minHeight: forExport ? 1123 : undefined,
        background: '#ffffff',
        fontFamily: 'Arial, Helvetica, sans-serif',
        padding: '28px 36px',
        boxSizing: 'border-box',
        color: '#111827',
        fontSize: 11,
      }}
    >
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        {/* Logo */}
        <div style={{ width: 140, minHeight: 50, display: 'flex', alignItems: 'center' }}>
          {settings?.logo_url ? (
            <img
              src={settings.logo_url}
              alt="Logo"
              style={{ maxWidth: 130, maxHeight: 60, objectFit: 'contain' }}
              crossOrigin="anonymous"
            />
          ) : (
            <div style={{
              width: 130, height: 50, background: '#f3f4f6', borderRadius: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, color: '#9ca3af', border: '1px dashed #d1d5db',
            }}>
              Kein Logo
            </div>
          )}
        </div>
        {/* Company details */}
        <div style={{ textAlign: 'right', maxWidth: 280 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
            {settings?.company_name || 'Unternehmen'}
          </div>
          {settings?.legal_company_name && (
            <div style={{ fontSize: 10, color: '#6b7280' }}>{settings.legal_company_name}</div>
          )}
          {companyAddr && (
            <div style={{ fontSize: 10, color: '#374151', marginTop: 2 }}>{companyAddr}</div>
          )}
          {settings?.phone && (
            <div style={{ fontSize: 10, color: '#374151' }}>Tel: {settings.phone}</div>
          )}
          {settings?.email && (
            <div style={{ fontSize: 10, color: '#374151' }}>{settings.email}</div>
          )}
          {settings?.vat_id && (
            <div style={{ fontSize: 9, color: '#6b7280', marginTop: 2 }}>USt-IdNr: {settings.vat_id}</div>
          )}
        </div>
      </div>

      {/* ── Divider ── */}
      <div style={{ height: 2, background: '#111827', marginBottom: 12 }} />

      {/* ── Title ── */}
      <div style={{ textAlign: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '0.06em', color: '#111827' }}>
          MIETWAGENAUFTRAG / FAHRTENNACHWEIS
        </div>
        <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>
          Personenbeförderung — Nachweis des Auftragseingangs am Betriebssitz
        </div>
      </div>

      {/* ── Section: Auftragsdaten ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10, border: '1px solid #e5e7eb' }}>
        <thead>
          <tr>
            <td colSpan={4} style={{ ...headerCell, background: '#1f2937', color: '#ffffff' }}>
              Auftragsdaten
            </td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, width: '25%' }}>
              <div style={labelStyle}>Auftrags-Nr.</div>
              <div style={valueStyle}>{data.auftragNr}</div>
            </td>
            <td style={{ ...cellStyle, width: '25%' }}>
              <div style={labelStyle}>Datum Auftragseingang</div>
              <div style={valueStyle}>{data.datumAuftragseingang}</div>
            </td>
            <td style={{ ...cellStyle, width: '25%' }}>
              <div style={labelStyle}>Uhrzeit</div>
              <div style={valueStyle}>{data.uhrzeitAuftragseingang} Uhr</div>
            </td>
            <td style={{ ...cellStyle, width: '25%' }}>
              <div style={labelStyle}>Angenommen durch</div>
              <div style={valueStyle}>{data.angenommenDurch || '—'}</div>
            </td>
          </tr>
          <tr>
            <td style={{ ...cellStyle }} colSpan={2}>
              <div style={labelStyle}>Art des Auftrags</div>
              <div style={valueStyle}>{data.artDesAuftrags}</div>
            </td>
            <td style={{ ...cellStyle }} colSpan={2}>
              <div style={labelStyle}>Fahrtbeginn (Datum / Uhrzeit)</div>
              <div style={valueStyle}>{data.fahrtbeginnDatum} / {data.fahrtbeginnUhrzeit} Uhr</div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── Section: Fahrer & Fahrzeug ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10, border: '1px solid #e5e7eb' }}>
        <thead>
          <tr>
            <td colSpan={3} style={{ ...headerCell, background: '#374151', color: '#ffffff' }}>
              Fahrer &amp; Fahrzeug
            </td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, width: '40%' }}>
              <div style={labelStyle}>Fahrer</div>
              <div style={valueStyle}>{data.fahrerName || '—'}</div>
            </td>
            <td style={{ ...cellStyle, width: '30%' }}>
              <div style={labelStyle}>Kennzeichen</div>
              <div style={valueStyle}>{data.kennzeichen || '—'}</div>
            </td>
            <td style={{ ...cellStyle, width: '30%' }}>
              <div style={labelStyle}>Fahrzeugbeschreibung</div>
              <div style={valueStyle}>Mietfahrzeug</div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── Section: Fahrgast ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10, border: '1px solid #e5e7eb' }}>
        <thead>
          <tr>
            <td colSpan={3} style={{ ...headerCell, background: '#374151', color: '#ffffff' }}>
              Fahrgast / Auftraggeber
            </td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, width: '45%' }}>
              <div style={labelStyle}>Fahrgast / Auftraggeber</div>
              <div style={valueStyle}>{data.fahrgast || '—'}</div>
            </td>
            <td style={{ ...cellStyle, width: '30%' }}>
              <div style={labelStyle}>Telefon</div>
              <div style={valueStyle}>{data.telefon || '—'}</div>
            </td>
            <td style={{ ...cellStyle, width: '25%' }}>
              <div style={labelStyle}>Anzahl Fahrgäste</div>
              <div style={valueStyle}>{data.anzahlFahrgaeste || '1'}</div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── Section: Route ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10, border: '1px solid #e5e7eb' }}>
        <thead>
          <tr>
            <td colSpan={2} style={{ ...headerCell, background: '#374151', color: '#ffffff' }}>
              Fahrtstrecke
            </td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, width: '50%' }}>
              <div style={labelStyle}>Abholadresse</div>
              <div style={valueStyle}>{data.abholadresse || '—'}</div>
            </td>
            <td style={{ ...cellStyle, width: '50%' }}>
              <div style={labelStyle}>Zieladresse</div>
              <div style={valueStyle}>{data.zieladresse || '—'}</div>
            </td>
          </tr>
          {data.zwischenziele && (
            <tr>
              <td style={cellStyle} colSpan={2}>
                <div style={labelStyle}>Zwischenziel(e)</div>
                <div style={valueStyle}>{data.zwischenziele}</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* ── Section: Zahlung ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10, border: '1px solid #e5e7eb' }}>
        <thead>
          <tr>
            <td colSpan={3} style={{ ...headerCell, background: '#374151', color: '#ffffff' }}>
              Zahlungsart / Entgelt
            </td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, width: '40%' }}>
              <div style={labelStyle}>Zahlungsart</div>
              <div style={valueStyle}>{data.zahlungsart}</div>
            </td>
            <td style={{ ...cellStyle, width: '30%' }}>
              <div style={labelStyle}>Betrag / Entgelt</div>
              <div style={{ ...valueStyle, fontSize: 13, fontWeight: 700 }}>
                {data.betrag ? `${data.betrag} €` : '—'}
              </div>
            </td>
            <td style={{ ...cellStyle, width: '30%' }}>
              <div style={labelStyle}>Bemerkungen</div>
              <div style={valueStyle}>{data.bemerkungen || '—'}</div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── Erklärung ── */}
      <div style={{
        border: '1px solid #d1d5db',
        borderLeft: '3px solid #374151',
        borderRadius: 4,
        padding: '8px 12px',
        background: '#f9fafb',
        marginBottom: 14,
      }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#374151', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>
          Erklärung
        </div>
        <div style={{ fontSize: 9.5, color: '#374151', lineHeight: 1.5 }}>
          Die Fahrt wird als Personenbeförderung im Mietwagenverkehr ausgeführt. Zweck, Ziel und Ablauf
          der Fahrt werden durch den Auftraggeber/Fahrgast bestimmt. Dieses Formular dient als interner
          Nachweis des Auftragseingangs und der Durchführung der Fahrt.
        </div>
        <div style={{ fontSize: 9, color: '#6b7280', marginTop: 4, fontStyle: 'italic' }}>
          Die Aufzeichnung ist betriebsintern für 1 Jahr aufzubewahren.
        </div>
      </div>

      {/* ── Signatures ── */}
      <div style={{ display: 'flex', gap: 20, marginBottom: 16, marginTop: 6 }}>
        {[
          'Unternehmen / Disposition',
          'Fahrer',
          'Fahrgast / Auftraggeber',
        ].map((label) => (
          <div key={label} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            {/* signing space */}
            <div style={{ height: 36 }} />
            {/* single signature line */}
            <div style={{ borderTop: '1.5px solid #374151' }} />
            {/* role label */}
            <div style={{ fontSize: 9, fontWeight: 600, color: '#374151', textAlign: 'center', marginTop: 4 }}>
              {label}
            </div>
            {/* sub-label */}
            <div style={{ fontSize: 8, color: '#9ca3af', textAlign: 'center', marginTop: 2 }}>
              Unterschrift / Datum
            </div>
          </div>
        ))}
      </div>

      {/* ── Footer ── */}
      <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 8, display: 'flex', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 8, color: '#9ca3af' }}>
          {settings?.company_name || 'Unternehmen'} — Mietwagenauftrag / Fahrtennachweis
        </div>
        <div style={{ fontSize: 8, color: '#9ca3af' }}>
          Auftrags-Nr.: {data.auftragNr}
        </div>
      </div>
    </div>
  );
};

// ─── PDF Export ───────────────────────────────────────────────────────────────

async function exportPDF(data: MietwagenData, settings: CompanySettings | null): Promise<void> {
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-9999px;top:0;width:794px;background:#fff;';
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
  const safeNr = data.auftragNr.replace(/[^a-zA-Z0-9-_]/g, '_');
  pdf.save(`Mietwagenauftrag_${safeNr}.pdf`);
}

// ─── Input style ──────────────────────────────────────────────────────────────

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

// ─── Main Component ───────────────────────────────────────────────────────────

const MietwagenauftragModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { settings } = useCompanySettings();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { t } = useTranslation();

  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [cars, setCars] = useState<Car[]>([]);
  const [exporting, setExporting] = useState(false);
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [selectedCarId, setSelectedCarId] = useState('');

  // Document content, not UI labels: every value here is printed on the
  // Mietwagenauftrag, so the German defaults stay German in both languages.
  const [data, setData] = useState<MietwagenData>(() => ({
    auftragNr: generateAuftragNr(),
    datumAuftragseingang: todayStr(),
    uhrzeitAuftragseingang: nowTimeStr(),
    fahrtbeginnDatum: todayStr(),
    fahrtbeginnUhrzeit: nowTimeStr(),
    angenommenDurch: '',
    artDesAuftrags: 'Personenbeförderung im Mietwagenverkehr',
    fahrerName: '',
    kennzeichen: '',
    fahrgast: '',
    telefon: '',
    anzahlFahrgaeste: '1',
    abholadresse: '',
    zieladresse: '',
    zwischenziele: '',
    zahlungsart: 'Bargeld',
    betrag: '',
    bemerkungen: '',
  }));

  // Load company drivers and cars (scoped to current company)
  useEffect(() => {
    if (!isOpen || !companyId) return;
    supabase
      .from('drivers')
      .select('id, name')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .order('name')
      .then(({ data: d }) => setDrivers(d || []));

    supabase
      .from('cars')
      .select('id, kennzeichen')
      .eq('company_id', companyId)
      .order('kennzeichen')
      .then(({ data: c }) => setCars(c || []));
  }, [isOpen, companyId]);

  // Pre-fill Angenommen durch from company settings
  useEffect(() => {
    if (settings?.company_name && !data.angenommenDurch) {
      setData(d => ({ ...d, angenommenDurch: settings.company_name }));
    }
  }, [settings]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      // Same document defaults as the initial state above — German by design.
      setData({
        auftragNr: generateAuftragNr(),
        datumAuftragseingang: todayStr(),
        uhrzeitAuftragseingang: nowTimeStr(),
        fahrtbeginnDatum: todayStr(),
        fahrtbeginnUhrzeit: nowTimeStr(),
        angenommenDurch: settings?.company_name || '',
        artDesAuftrags: 'Personenbeförderung im Mietwagenverkehr',
        fahrerName: '',
        kennzeichen: '',
        fahrgast: '',
        telefon: '',
        anzahlFahrgaeste: '1',
        abholadresse: '',
        zieladresse: '',
        zwischenziele: '',
        zahlungsart: 'Bargeld',
        betrag: '',
        bemerkungen: '',
      });
      setSelectedDriverId('');
      setSelectedCarId('');
    }
  }, [isOpen]);

  const handleDriverChange = useCallback((driverId: string) => {
    setSelectedDriverId(driverId);
    const driver = drivers.find(d => d.id === driverId);
    setData(prev => ({ ...prev, fahrerName: driver?.name || '' }));
  }, [drivers]);

  const handleCarChange = useCallback((carId: string) => {
    setSelectedCarId(carId);
    const car = cars.find(c => c.id === carId);
    setData(prev => ({ ...prev, kennzeichen: car?.kennzeichen || '' }));
  }, [cars]);

  const set = useCallback((field: keyof MietwagenData) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    setData(prev => ({ ...prev, [field]: e.target.value }));
  }, []);

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportPDF(data, settings);
    } catch (err) {
      console.error('PDF export failed:', err);
    } finally {
      setExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black bg-opacity-60 overflow-y-auto py-6 px-4">
      <div
        className="w-full max-w-6xl rounded-xl flex flex-col"
        style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-lg)' }}
      >
        {/* ── Modal header ── */}
        <div
          className="flex items-center justify-between px-6 py-4 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-3">
            <div style={{ background: 'var(--accent-subtle)', borderRadius: '0.5rem', padding: '0.5rem' }}>
              <Car style={{ color: 'var(--accent-text)' }} className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('a4.mwTitle')}
              </h2>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('a4.mwSubtitle')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* ── Two-column layout: form + preview ── */}
        <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-hidden">

          {/* ── Left: Form ── */}
          <div
            className="w-full lg:w-96 shrink-0 overflow-y-auto p-5 space-y-5"
            style={{ borderRight: '1px solid var(--border)' }}
          >
            {/* Auftragsdaten */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
                {t('a4.mwSectionOrder')}
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldOrderNo')}</label>
                  <input style={inputStyle} value={data.auftragNr} onChange={set('auftragNr')} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldReceivedDate')}</label>
                    <input type="date" style={inputStyle} value={data.datumAuftragseingang} onChange={set('datumAuftragseingang')} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldTime')}</label>
                    <input type="time" style={inputStyle} value={data.uhrzeitAuftragseingang} onChange={set('uhrzeitAuftragseingang')} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldTripStartDate')}</label>
                    <input type="date" style={inputStyle} value={data.fahrtbeginnDatum} onChange={set('fahrtbeginnDatum')} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldTripStartTime')}</label>
                    <input type="time" style={inputStyle} value={data.fahrtbeginnUhrzeit} onChange={set('fahrtbeginnUhrzeit')} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldAcceptedBy')}</label>
                  <input style={inputStyle} value={data.angenommenDurch} onChange={set('angenommenDurch')} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldOrderType')}</label>
                  <input style={inputStyle} value={data.artDesAuftrags} onChange={set('artDesAuftrags')} />
                </div>
              </div>
            </section>

            {/* Fahrer & Fahrzeug */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
                {t('a4.mwSectionDriverVehicle')}
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')}</label>
                  <select style={{ ...inputStyle, appearance: 'none' }} value={selectedDriverId} onChange={e => handleDriverChange(e.target.value)}>
                    <option value="">{t('a4.mwSelectDriver')}</option>
                    {drivers.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldVehiclePlate')}</label>
                  <select style={{ ...inputStyle, appearance: 'none' }} value={selectedCarId} onChange={e => handleCarChange(e.target.value)}>
                    <option value="">{t('a4.mwSelectVehicle')}</option>
                    {cars.map(c => (
                      <option key={c.id} value={c.id}>{c.kennzeichen}</option>
                    ))}
                  </select>
                  {data.kennzeichen && (
                    <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>{t('a4.mwPlateHint', { plate: data.kennzeichen })}</p>
                  )}
                </div>
              </div>
            </section>

            {/* Fahrgast */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
                {t('a4.mwSectionPassenger')}
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldName')}</label>
                  <input style={inputStyle} value={data.fahrgast} onChange={set('fahrgast')} placeholder={t('a4.mwSectionPassenger')} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldPhone')}</label>
                    <input style={inputStyle} value={data.telefon} onChange={set('telefon')} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldPassengerCount')}</label>
                    <input type="number" min="1" style={inputStyle} value={data.anzahlFahrgaeste} onChange={set('anzahlFahrgaeste')} />
                  </div>
                </div>
              </div>
            </section>

            {/* Route */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
                {t('a4.mwSectionRoute')}
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldPickup')}</label>
                  <input style={inputStyle} value={data.abholadresse} onChange={set('abholadresse')} placeholder={t('a4.mwAddressPlaceholder')} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldDestination')}</label>
                  <input style={inputStyle} value={data.zieladresse} onChange={set('zieladresse')} placeholder={t('a4.mwAddressPlaceholder')} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldStopovers')}</label>
                  <input style={inputStyle} value={data.zwischenziele} onChange={set('zwischenziele')} placeholder={t('a4.mwOptional')} />
                </div>
              </div>
            </section>

            {/* Zahlung */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
                {t('a4.mwSectionPayment')}
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldPaymentMethod')}</label>
                  {/* The option is also the value, and that value is printed verbatim on the
                      Mietwagenauftrag — so these stay German in both languages. */}
                  <select style={{ ...inputStyle, appearance: 'none' }} value={data.zahlungsart} onChange={set('zahlungsart')}>
                    {['Bargeld', 'Karte', 'Überweisung', 'Rechnung', 'Sonstiges'].map(z => (
                      <option key={z} value={z}>{z}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldFare')}</label>
                  <input type="number" min="0" step="0.01" style={inputStyle} value={data.betrag} onChange={set('betrag')} placeholder="0,00" />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('a4.mwFieldRemarks')}</label>
                  <select style={{ ...inputStyle, appearance: 'none' }} value={data.bemerkungen} onChange={set('bemerkungen')}>
                    <option value="">{t('a4.mwRemarkNone')}</option>
                    {/* Printed verbatim on the Mietwagenauftrag — German in both languages. */}
                    {['Auslandsfahrt', 'Flughafenfahrt', 'Wartezeit', 'Sonderfahrt', 'Sonstiges'].map(b => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
              </div>
            </section>
          </div>

          {/* ── Right: Preview ── */}
          <div className="flex-1 overflow-y-auto p-5" style={{ background: 'var(--bg-subtle)' }}>
            <div
              className="mx-auto shadow-lg"
              style={{
                maxWidth: 794,
                background: '#fff',
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <A4Document data={data} settings={settings} />
            </div>
          </div>
        </div>

        {/* ── Footer actions ── */}
        <div
          className="flex items-center justify-end gap-3 px-6 py-4 shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg transition-colors text-sm"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {t('common.close')}
          </button>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-opacity"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)', opacity: exporting ? 0.7 : 1 }}
            onMouseEnter={e => { if (!exporting) e.currentTarget.style.background = 'var(--accent-hover)'; }}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
          >
            <Download className="w-4 h-4" />
            {exporting ? t('a4.mwExporting') : t('a4.mwExportPdf')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MietwagenauftragModal;
