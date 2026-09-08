import React, { useRef, useState } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  TrendingUp,
  User,
  Calendar,
  Banknote,
  Building2,
  Wallet,
  Coffee,
  CheckCircle,
  Clock,
  Briefcase,
  Download,
  Copy,
  Loader2,
  ArrowRightLeft,
} from 'lucide-react';
import html2canvas from 'html2canvas';

export interface DriverSalarySummaryProps {
  driverName: string;
  periodStart: string;
  periodEnd: string;
  totalRevenue: number;
  salaryRatio: number;
  driverPartAmount: number;
  tips: number;
  alreadyPaidSalary: number;
  remainingSalary: number;
  brutto: number | null;
  nettoBank: number | null;
  cashSalary: number | null;
  companyName?: string;
}

function fmtEur(n: number | null | undefined): string {
  if (n == null) return '–';
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function fmtMonat(dateStr: string): string {
  try {
    return format(new Date(dateStr), 'MMMM yyyy', { locale: de });
  } catch {
    return dateStr;
  }
}

function fmtDateRange(start: string, end: string): string {
  try {
    return `${format(new Date(start), 'dd.MM.yyyy')} – ${format(new Date(end), 'dd.MM.yyyy')}`;
  } catch {
    return `${start} – ${end}`;
  }
}

interface SummaryRowProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  value: string;
  valueColor?: string;
  rowBackground?: string;
  isLarge?: boolean;
  warningNote?: string;
}

const SummaryRow: React.FC<SummaryRowProps> = ({
  icon,
  title,
  subtitle,
  value,
  valueColor = '#fff',
  rowBackground = 'rgba(255,255,255,0.05)',
  isLarge = false,
  warningNote,
}) => (
  <div
    style={{
      background: rowBackground,
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: '0.75rem',
      padding: isLarge ? '1rem 1.125rem' : '0.75rem 1rem',
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '0.875rem',
    }}
  >
    {/* Icon + Text — left side */}
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', flex: '1 1 0', minWidth: 0 }}>
      {/* Icon box — fixed size, never shrinks */}
      <div
        style={{
          width: isLarge ? 38 : 34,
          height: isLarge ? 38 : 34,
          minWidth: isLarge ? 38 : 34,
          borderRadius: '0.5rem',
          background: 'rgba(255,255,255,0.07)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: '0.125rem',
        }}
      >
        {icon}
      </div>
      {/* Text block — fills remaining space, wraps naturally */}
      <div style={{ flex: '1 1 0', minWidth: 0 }}>
        <div
          style={{
            color: 'rgba(255,255,255,0.92)',
            fontWeight: 600,
            fontSize: isLarge ? '0.9375rem' : '0.875rem',
            lineHeight: 1.35,
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
          }}
        >
          {title}
        </div>
        <div
          style={{
            color: 'rgba(255,255,255,0.42)',
            fontSize: '0.75rem',
            marginTop: '0.1875rem',
            lineHeight: 1.35,
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
          }}
        >
          {subtitle}
        </div>
        {warningNote && (
          <div
            style={{
              color: '#fbbf24',
              fontSize: '0.6875rem',
              marginTop: '0.25rem',
              lineHeight: 1.3,
            }}
          >
            {warningNote}
          </div>
        )}
      </div>
    </div>

    {/* Amount — right side, never shrinks */}
    <div
      style={{
        color: valueColor,
        fontWeight: 700,
        fontSize: isLarge ? '1.1875rem' : '1rem',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        alignSelf: 'center',
        letterSpacing: '-0.01em',
        paddingLeft: '0.5rem',
      }}
    >
      {value}
    </div>
  </div>
);

const DriverSalarySummaryCard: React.FC<DriverSalarySummaryProps> = ({
  driverName,
  periodStart,
  periodEnd,
  totalRevenue,
  salaryRatio,
  driverPartAmount,
  tips,
  alreadyPaidSalary,
  // remainingSalary prop accepted but not used — card computes it internally
  brutto,
  nettoBank,
  cashSalary,
  companyName,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [copying, setCopying] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const monatLabel = fmtMonat(periodStart);
  const dateRange = fmtDateRange(periodStart, periodEnd);

  // Payroll split — only shown when at least brutto is entered
  const hasPayroll = brutto != null && brutto > 0;
  const bruttoVal = brutto ?? 0;
  const nettoBankVal = nettoBank ?? 0;
  const cashVal = cashSalary ?? 0;
  const totalNetPayout = nettoBankVal + cashVal;
  const cashIsNeg = cashVal < -0.01;

  // Restgehalt = Gesamt Netto Auszahlung - Bereits gezahltes Gehalt
  const restgehalt = totalNetPayout - alreadyPaidSalary;

  const exportCanvas = async (): Promise<HTMLCanvasElement | null> => {
    if (!cardRef.current) return null;
    return html2canvas(cardRef.current, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#0f1729',
      logging: false,
      // Ensure the full card is captured without clipping
      windowWidth: cardRef.current.scrollWidth,
      windowHeight: cardRef.current.scrollHeight,
    });
  };

  const handleCopy = async () => {
    setCopying(true);
    try {
      const canvas = await exportCanvas();
      if (!canvas) return;
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        } catch {
          // clipboard API may be unavailable in some browsers
        }
      }, 'image/png');
    } catch (err) {
      console.error('Copy failed:', err);
    } finally {
      setCopying(false);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const canvas = await exportCanvas();
      if (!canvas) return;
      const link = document.createElement('a');
      const safeName = driverName.replace(/[^a-zA-Z0-9äöüÄÖÜß]/g, '_');
      const safeMonth = monatLabel.replace(/\s+/g, '_').toLowerCase();
      link.download = `gehaltsuebersicht_${safeName}_${safeMonth}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) {
      console.error('Download failed:', err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Export buttons — outside ref, not exported */}
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={handleCopy}
          disabled={copying}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium"
          style={{
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
            cursor: copying ? 'not-allowed' : 'pointer',
            opacity: copying ? 0.7 : 1,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
        >
          {copying ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
          Als Bild kopieren
        </button>
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium"
          style={{
            background: 'var(--accent)',
            color: 'var(--accent-text)',
            border: 'none',
            cursor: downloading ? 'not-allowed' : 'pointer',
            opacity: downloading ? 0.7 : 1,
          }}
          onMouseEnter={e => { if (!downloading) e.currentTarget.style.background = 'var(--accent-hover)'; }}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
        >
          {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Als Bild herunterladen
        </button>
      </div>

      {/* ══════════════════════════════════════════
          CARD — exported as image
      ══════════════════════════════════════════ */}
      <div
        ref={cardRef}
        style={{
          background: 'linear-gradient(145deg, #0f1729 0%, #111827 55%, #0d1520 100%)',
          borderRadius: '1.125rem',
          padding: '1.625rem',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.06), 0 20px 56px rgba(0,0,0,0.55)',
          // No overflow hidden — allows text to breathe
        }}
      >
        {/* Company name */}
        {companyName && (
          <div
            style={{
              color: 'rgba(255,255,255,0.3)',
              fontSize: '0.625rem',
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              marginBottom: '1.125rem',
            }}
          >
            {companyName}
          </div>
        )}

        {/* Top meta: Fahrer + Monat */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '0.625rem',
            marginBottom: '0.625rem',
          }}
        >
          <div
            style={{
              background: 'rgba(99,179,237,0.09)',
              border: '1px solid rgba(99,179,237,0.17)',
              borderRadius: '0.75rem',
              padding: '0.75rem 1rem',
            }}
          >
            <div style={{ color: 'rgba(147,197,253,0.65)', fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '0.3125rem' }}>
              Fahrer
            </div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: '0.9375rem', lineHeight: 1.25, wordBreak: 'break-word' }}>
              {driverName}
            </div>
          </div>

          <div
            style={{
              background: 'rgba(129,140,248,0.09)',
              border: '1px solid rgba(129,140,248,0.17)',
              borderRadius: '0.75rem',
              padding: '0.75rem 1rem',
            }}
          >
            <div style={{ color: 'rgba(196,181,253,0.65)', fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '0.3125rem' }}>
              Monat
            </div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: '0.9375rem', lineHeight: 1.25 }}>
              {monatLabel}
            </div>
          </div>
        </div>

        {/* Zeitraum */}
        <div
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '0.75rem',
            padding: '0.625rem 1rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '1.375rem',
          }}
        >
          <Calendar size={13} color="rgba(255,255,255,0.3)" style={{ flexShrink: 0 }} />
          <span style={{ color: 'rgba(255,255,255,0.38)', fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0 }}>
            Zeitraum
          </span>
          <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: '0.8125rem', fontWeight: 500, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            {dateRange}
          </span>
        </div>

        {/* Section label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '1rem' }}>
          <div style={{ height: '1px', flex: 1, background: 'rgba(255,255,255,0.05)' }} />
          <span style={{ color: 'rgba(255,255,255,0.22)', fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Gehaltsübersicht
          </span>
          <div style={{ height: '1px', flex: 1, background: 'rgba(255,255,255,0.05)' }} />
        </div>

        {/* Summary rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4375rem' }}>

          {/* 1. Gesamtumsatz */}
          <SummaryRow
            icon={<TrendingUp size={16} color="#60a5fa" />}
            title="Gesamtumsatz"
            subtitle="Umsatz des Fahrers in diesem Monat"
            value={fmtEur(totalRevenue)}
            valueColor="#93c5fd"
            rowBackground="rgba(59,130,246,0.07)"
            isLarge
          />

          {/* 2. Fahreranteil */}
          <SummaryRow
            icon={<Briefcase size={16} color="#34d399" />}
            title="Fahreranteil"
            subtitle={`${(salaryRatio * 100).toFixed(0)} % Anteil vom Umsatz`}
            value={fmtEur(driverPartAmount)}
            valueColor="#6ee7b7"
            rowBackground="rgba(52,211,153,0.06)"
          />

          {/* 3. Trinkgeld */}
          <SummaryRow
            icon={<Coffee size={16} color="#f472b6" />}
            title="Trinkgeld"
            subtitle="Gesamtes Trinkgeld in diesem Monat"
            value={fmtEur(tips)}
            valueColor="#f9a8d4"
            rowBackground="rgba(244,114,182,0.06)"
          />

          {/* Divider before payroll block */}
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.04)', margin: '0.1875rem 0' }} />

          {/* 4. Brutto in Lohnabrechnung */}
          <SummaryRow
            icon={<Wallet size={16} color="#fb923c" />}
            title="Brutto in Lohnabrechnung"
            subtitle={hasPayroll ? 'Bruttobetrag laut Lohnabrechnung' : 'Noch nicht eingetragen'}
            value={hasPayroll ? fmtEur(bruttoVal) : '–'}
            valueColor={hasPayroll ? '#fdba74' : 'rgba(255,255,255,0.3)'}
            rowBackground="rgba(251,146,60,0.07)"
          />

          {/* 5. Netto / Bankgehalt */}
          <SummaryRow
            icon={<Building2 size={16} color="#22d3ee" />}
            title="Netto / Bankgehalt"
            subtitle="Nettoauszahlung per Bank"
            value={nettoBank != null ? fmtEur(nettoBankVal) : '–'}
            valueColor={nettoBank != null ? '#67e8f9' : 'rgba(255,255,255,0.3)'}
            rowBackground="rgba(34,211,238,0.06)"
          />

          {/* 6. Bargehalt */}
          <SummaryRow
            icon={<Banknote size={16} color={cashIsNeg ? '#f87171' : '#22d3ee'} />}
            title="Bargehalt"
            subtitle="Bar ausgezahlter Gehaltsanteil"
            value={cashSalary != null ? fmtEur(cashVal) : '–'}
            valueColor={cashSalary == null ? 'rgba(255,255,255,0.3)' : cashIsNeg ? '#fca5a5' : '#67e8f9'}
            rowBackground={cashIsNeg ? 'rgba(248,113,113,0.08)' : 'rgba(34,211,238,0.06)'}
            warningNote={cashIsNeg ? 'Bargehalt negativ — Brutto übersteigt berechnetes Gehalt' : undefined}
          />

          {/* 7. Gesamt Netto Auszahlung */}
          <SummaryRow
            icon={<ArrowRightLeft size={16} color={cashIsNeg ? '#fbbf24' : '#34d399'} />}
            title="Gesamt Netto Auszahlung"
            subtitle="Bankgehalt + Bargehalt"
            value={hasPayroll ? fmtEur(totalNetPayout) : '–'}
            valueColor={hasPayroll ? (cashIsNeg ? '#fde68a' : '#6ee7b7') : 'rgba(255,255,255,0.3)'}
            rowBackground={cashIsNeg ? 'rgba(251,191,36,0.07)' : 'rgba(52,211,153,0.07)'}
            isLarge
          />

          {/* Divider before payment status */}
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.04)', margin: '0.1875rem 0' }} />

          {/* 8. Bereits gezahltes Gehalt */}
          <SummaryRow
            icon={<CheckCircle size={16} color="#34d399" />}
            title="Bereits gezahltes Gehalt"
            subtitle="Schon ausgezahlter Betrag"
            value={fmtEur(alreadyPaidSalary)}
            valueColor="#6ee7b7"
            rowBackground="rgba(52,211,153,0.06)"
          />

          {/* 9. Restgehalt */}
          <SummaryRow
            icon={<Clock size={16} color={restgehalt > 0.01 ? '#fb923c' : '#34d399'} />}
            title="Restgehalt"
            subtitle="Noch auszuzahlender Betrag"
            value={fmtEur(restgehalt)}
            valueColor={restgehalt > 0.01 ? '#fdba74' : '#6ee7b7'}
            rowBackground={restgehalt > 0.01 ? 'rgba(251,146,60,0.07)' : 'rgba(52,211,153,0.06)'}
            isLarge
          />
        </div>

        {/* Footer disclaimer */}
        <div
          style={{
            marginTop: '1.375rem',
            paddingTop: '0.875rem',
            borderTop: '1px solid rgba(255,255,255,0.04)',
            color: 'rgba(255,255,255,0.18)',
            fontSize: '0.625rem',
            textAlign: 'center',
            lineHeight: 1.5,
            letterSpacing: '0.01em',
          }}
        >
          Diese Übersicht dient nur zur internen Prüfung · Kein offizieller Lohnzettel
        </div>
      </div>
    </div>
  );
};

export default DriverSalarySummaryCard;
 