import React, { useState, useEffect, useRef } from 'react';
import { Calendar, FileText, TrendingUp, TrendingDown, DollarSign, X, User, Receipt as ReceiptIcon, Share2, Download, Copy } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTheme } from '../contexts/ThemeContext';
import { format } from 'date-fns';
import { getWeeksOfMonth, getBusinessMonthRange, getBusinessWeeksForMonth } from '../utils/weekCalculations';
import html2canvas from 'html2canvas';
import { useTranslation } from '../contexts/LanguageContext';

interface WeeklyAbrechnung {
  year: number;
  month: number;
  week_number: number;
  driver_name: string;
  anzahl_belege: number;
  ausgegebene_bargeld: number;
  bargeld: number;
  bar_zuruck: number;
}

interface MonthlyAbrechnung {
  year: number;
  month: number;
  driver_name: string;
  anzahl_belege: number;
  ausgegebene_bargeld: number;
  bargeld: number;
  bar_zuruck: number;
  week_count: number;
}

interface DetailedAbrechnungData {
  driverName: string;
  weekNumber: number;
  weekStartDate: string;
  weekEndDate: string;
  totalCash: number;
  anzahlBelege: number;
  sumBelege: number;
  difference: number;
  tankenBrutto: number;
  umsatzNetto: number;
}

type ViewMode = 'weekly' | 'monthly';

// Stays German: this array also builds the filename of the exported Abrechnung
// image (`abrechnung-<fahrer>-<monat>-<jahr>.png`). A filename that shifted with
// the UI language would give the same period two different names across users.
const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
];

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  padding: '0.5rem 0.75rem',
  outline: 'none',
};

export function AbrechnungPage() {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>('weekly');
  const [weeklyData, setWeeklyData] = useState<WeeklyAbrechnung[]>([]);
  const [monthlyData, setMonthlyData] = useState<MonthlyAbrechnung[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedDriver, setSelectedDriver] = useState<string>('all');
  const [selectedWeek, setSelectedWeek] = useState<number | 'all'>('all');
  const [detailModalData, setDetailModalData] = useState<DetailedAbrechnungData | null>(null);
  const [drivers, setDrivers] = useState<string[]>([]);
  const [availableWeeks, setAvailableWeeks] = useState<number[]>([]);
  const { showToast } = useToast();
  const { isDark } = useTheme();
  const shareableCardRef = useRef<HTMLDivElement>(null);
  const [isSharing, setIsSharing] = useState(false);

  useEffect(() => {
    if (viewMode === 'weekly') {
      loadWeeklyData();
    } else if (viewMode === 'monthly') {
      loadMonthlyData();
    }
  }, [selectedYear, selectedMonth, viewMode]);

  const loadWeeklyData = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase.rpc('get_weekly_abrechnung', {
        p_year: selectedYear,
        p_month: selectedMonth
      });

      if (error) throw error;
      setWeeklyData(data || []);

      const uniqueDrivers = Array.from(new Set(data?.map((d: WeeklyAbrechnung) => d.driver_name) || []));
      setDrivers(uniqueDrivers as string[]);

      const uniqueWeeks = Array.from(new Set(data?.map((d: WeeklyAbrechnung) => d.week_number) || []));
      setAvailableWeeks((uniqueWeeks as number[]).sort((a, b) => a - b));
    } catch (error: any) {
      showToast('error', t('abr.loadFailed'), error.message);
    } finally {
      setLoading(false);
    }
  };

  const loadMonthlyData = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase.rpc('get_monthly_abrechnung', {
        p_year: selectedYear,
        p_month: selectedMonth
      });

      if (error) throw error;
      setMonthlyData(data || []);

      const uniqueDrivers = Array.from(new Set(data?.map((d: MonthlyAbrechnung) => d.driver_name) || []));
      setDrivers(uniqueDrivers as string[]);
    } catch (error: any) {
      showToast('error', t('abr.loadFailed'), error.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchTankenAndUmsatz = async (
    driverName: string,
    startIso: string,
    endIso: string,
  ): Promise<{ tankenBrutto: number; umsatzNetto: number }> => {
    const [receiptsRes, incomeRes] = await Promise.all([
      supabase
        .from('receipts')
        .select('expense, description')
        .eq('driver_name', driverName)
        .gte('date', startIso)
        .lte('date', endIso),
      supabase
        .from('income')
        .select('amount, type')
        .eq('driver_name', driverName)
        .gte('date', startIso)
        .lte('date', endIso)
        .in('type', ['umsatz', 'aktionen']),
    ]);

    const tankenBrutto = (receiptsRes.data ?? [])
      .filter(r => /^tanken$/i.test((r.description ?? '').trim()))
      .reduce((sum: number, r: { expense: number }) => sum + Number(r.expense), 0);

    // Umsatz basis = Netto-Fahrpreis (type=umsatz) + Aktionen (type=aktionen) only
    const umsatzNetto = (incomeRes.data ?? [])
      .reduce((sum: number, r: { amount: number }) => sum + Number(r.amount), 0);

    return { tankenBrutto, umsatzNetto };
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR'
    }).format(amount);
  };

  const formatPercent = (value: number) =>
    value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %';

  const calcTankenquote = (tankenBrutto: number, umsatzNetto: number): number | null => {
    if (!umsatzNetto || umsatzNetto <= 0) return null;
    return (tankenBrutto / umsatzNetto) * 100;
  };

  // Tankenquote card — rendered in both visible modal and off-screen share card
  const renderTankenquoteCard = (data: DetailedAbrechnungData) => {
    const quote = calcTankenquote(data.tankenBrutto, data.umsatzNetto);
    return (
      <div style={{
        background: isDark ? 'rgba(234,88,12,0.07)' : '#fff9f5',
        border: isDark ? '1px solid rgba(234,88,12,0.25)' : '1px solid #fed7aa',
        borderRadius: 12, padding: '14px 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: isDark ? '#fb923c' : '#c2410c' }}>
          Tankenquote
        </span>
        <span style={{ fontSize: 18, fontWeight: 900, color: isDark ? '#fb923c' : '#c2410c', letterSpacing: '-0.01em' }}>
          {quote !== null ? formatPercent(quote) : '—'}
        </span>
      </div>
    );
  };

  const getWeekLabel = (weekNumber: number) => {
    return `Woche ${weekNumber}`;
  };

  const handleRowClick = async (item: WeeklyAbrechnung) => {
    try {
      const weeks = getBusinessWeeksForMonth(selectedMonth - 1, selectedYear);
      const weekInfo = weeks.find(w => w.weekNumber === item.week_number);

      if (!weekInfo) {
        showToast('error', t('abr.weekNotFound'));
        return;
      }

      const startIso = format(weekInfo.firstDay, 'yyyy-MM-dd');
      const endIso = format(weekInfo.lastDay, 'yyyy-MM-dd');
      const { tankenBrutto, umsatzNetto } = await fetchTankenAndUmsatz(item.driver_name, startIso, endIso);

      const detailData: DetailedAbrechnungData = {
        driverName: item.driver_name,
        weekNumber: item.week_number,
        weekStartDate: format(weekInfo.firstDay, 'dd.MM.yyyy'),
        weekEndDate: format(weekInfo.lastDay, 'dd.MM.yyyy'),
        totalCash: Number(item.bargeld),
        anzahlBelege: item.anzahl_belege,
        sumBelege: Number(item.ausgegebene_bargeld),
        difference: Number(item.bar_zuruck),
        tankenBrutto,
        umsatzNetto,
      };

      setDetailModalData(detailData);
    } catch (error: any) {
      showToast('error', t('abr.detailsFailed'), error.message);
    }
  };

  const handleMonthlyRowClick = async (item: MonthlyAbrechnung) => {
    try {
      const { start, end } = getBusinessMonthRange(selectedMonth - 1, selectedYear);

      const startIso = format(start, 'yyyy-MM-dd');
      const endIso = format(end, 'yyyy-MM-dd');
      const { tankenBrutto, umsatzNetto } = await fetchTankenAndUmsatz(item.driver_name, startIso, endIso);

      const detailData: DetailedAbrechnungData = {
        driverName: item.driver_name,
        weekNumber: 0,
        weekStartDate: format(start, 'dd.MM.yyyy'),
        weekEndDate: format(end, 'dd.MM.yyyy'),
        totalCash: Number(item.bargeld),
        anzahlBelege: item.anzahl_belege,
        sumBelege: Number(item.ausgegebene_bargeld),
        difference: Number(item.bar_zuruck),
        tankenBrutto,
        umsatzNetto,
      };

      setDetailModalData(detailData);
    } catch (error: any) {
      showToast('error', t('abr.detailsFailed'), error.message);
    }
  };

  const getFilteredData = () => {
    let filtered = [...weeklyData];

    if (selectedDriver !== 'all') {
      filtered = filtered.filter(item => item.driver_name === selectedDriver);
    }

    if (selectedWeek !== 'all') {
      filtered = filtered.filter(item => item.week_number === selectedWeek);
    }

    return filtered;
  };

  const groupByWeek = () => {
    const filtered = getFilteredData();
    const grouped: { [key: number]: WeeklyAbrechnung[] } = {};
    filtered.forEach(item => {
      if (!grouped[item.week_number]) {
        grouped[item.week_number] = [];
      }
      grouped[item.week_number].push(item);
    });
    return grouped;
  };

  const calculateWeekTotals = (weekData: WeeklyAbrechnung[]) => {
    return weekData.reduce((acc, item) => ({
      anzahl_belege: acc.anzahl_belege + item.anzahl_belege,
      ausgegebene_bargeld: acc.ausgegebene_bargeld + Number(item.ausgegebene_bargeld),
      bargeld: acc.bargeld + Number(item.bargeld),
      bar_zuruck: acc.bar_zuruck + Number(item.bar_zuruck)
    }), { anzahl_belege: 0, ausgegebene_bargeld: 0, bargeld: 0, bar_zuruck: 0 });
  };

  // Reusable function to generate settlement image blob
  const generateSettlementImageBlob = async (): Promise<{ blob: Blob; fileName: string } | null> => {
    if (!detailModalData) {
      showToast('error', 'Fehler', t('abr.noData'));
      return null;
    }

    if (!shareableCardRef.current) {
      showToast('error', 'Fehler', t('abr.noContentArea'));
      return null;
    }

    try {
      // Wait for fonts and images to load
      await document.fonts.ready;
      await new Promise(resolve => setTimeout(resolve, 300));

      const element = shareableCardRef.current;

      // Defensive check before accessing properties
      if (!element) {
        showToast('error', 'Fehler', t('abr.elementUnavailable'));
        return null;
      }

      const canvas = await html2canvas(element, {
        backgroundColor: isDark ? '#0d1117' : '#ffffff',
        scale: 3,
        useCORS: true,
        logging: false,
        windowWidth: element.scrollWidth || element.offsetWidth,
        windowHeight: element.scrollHeight || element.offsetHeight,
      });

      // Convert canvas to blob
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to create blob'));
          }
        }, 'image/png', 1.0);
      });

      // Generate clean filename
      const driverNameClean = detailModalData.driverName.toLowerCase().replace(/\s+/g, '-');
      const periodLabel = detailModalData.weekNumber === 0
        ? `${MONTH_NAMES[selectedMonth - 1].toLowerCase()}-${selectedYear}`
        : `woche-${detailModalData.weekNumber}`;
      const fileName = `abrechnung-${driverNameClean}-${periodLabel}.png`;

      return { blob, fileName };
    } catch (error: any) {
      showToast('error', t('abr.imageFailed'), error.message || t('overview.error.unknown'));
      console.error('Image generation error:', error);
      return null;
    }
  };

  // Copy image to clipboard
  const handleCopyImage = async () => {
    if (!detailModalData || isSharing) return;

    try {
      setIsSharing(true);
      showToast('info', t('abr.creatingImage'));

      const imageData = await generateSettlementImageBlob();
      if (!imageData) return;

      const { blob } = imageData;

      // Check if Clipboard API is supported
      if (!navigator.clipboard || !navigator.clipboard.write) {
        showToast('error', t('abr.notSupported'), t('abr.copyNotSupported'));
        return;
      }

      // Try to copy image to clipboard
      try {
        const clipboardItem = new ClipboardItem({
          'image/png': blob
        });

        await navigator.clipboard.write([clipboardItem]);
        showToast('success', t('abr.copiedToClipboard'));
      } catch (clipError: any) {
        console.error('Clipboard error:', clipError);
        showToast('error', t('abr.copyFailed'), t('abr.copyNotSupported'));
      }
    } catch (error: any) {
      showToast('error', t('abr.copyFailed'), error.message || t('overview.error.unknown'));
      console.error('Copy error:', error);
    } finally {
      setIsSharing(false);
    }
  };

  // Share to WhatsApp with clipboard copy
  const handleShareToWhatsApp = async () => {
    if (!detailModalData || isSharing) return;

    try {
      setIsSharing(true);
      showToast('info', t('abr.creatingImage'));

      const imageData = await generateSettlementImageBlob();
      if (!imageData) return;

      const { blob } = imageData;

      let imageCopied = false;

      // Try to copy image to clipboard first
      if (navigator.clipboard && navigator.clipboard.write) {
        try {
          const clipboardItem = new ClipboardItem({
            'image/png': blob
          });

          await navigator.clipboard.write([clipboardItem]);
          imageCopied = true;
        } catch (clipError) {
          console.warn('Clipboard copy failed:', clipError);
        }
      }

      // Open WhatsApp Web
      try {
        const whatsappUrl = 'https://web.whatsapp.com/';
        window.open(whatsappUrl, '_blank');
      } catch (openError) {
        console.error('Failed to open WhatsApp:', openError);
        showToast('error', 'Fehler', t('abr.whatsappFailed'));
        return;
      }

      // Show appropriate message
      if (imageCopied) {
        showToast('success', t('abr.copiedPasteHint'));
      } else {
        showToast('warning', t('abr.copyUnsupported'), t('abr.copyUnsupportedBody'));
      }
    } catch (error: any) {
      showToast('error', t('abr.shareFailed'), error.message || t('overview.error.unknown'));
      console.error('Share to WhatsApp error:', error);
    } finally {
      setIsSharing(false);
    }
  };

  // Download image locally
  const handleDownloadImage = async () => {
    if (!detailModalData || isSharing) return;

    try {
      setIsSharing(true);
      showToast('info', t('abr.creatingImage'));

      const imageData = await generateSettlementImageBlob();
      if (!imageData) return;

      const { blob, fileName } = imageData;

      // Download the image
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      showToast('success', t('abr.downloaded'));
    } catch (error: any) {
      showToast('error', t('abr.downloadFailed'), error.message || t('overview.error.unknown'));
      console.error('Download error:', error);
    } finally {
      setIsSharing(false);
    }
  };

  const renderWeeklyView = () => {
    if (loading) {
      return (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
          <p className="mt-2" style={{ color: 'var(--text-tertiary)' }}>{t('werkstatt.loading')}</p>
        </div>
      );
    }

    if (weeklyData.length === 0) {
      return (
        <div className="text-center py-12">
          <FileText className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-tertiary)' }} />
          <p style={{ color: 'var(--text-tertiary)' }}>Keine Daten für {MONTH_NAMES[selectedMonth - 1]} {selectedYear}</p>
        </div>
      );
    }

    const groupedData = groupByWeek();
    const weekNumbers = Object.keys(groupedData).map(Number).sort((a, b) => b - a);

    return (
      <div className="space-y-6">
        {weekNumbers.map(weekNumber => {
          const weekData = groupedData[weekNumber];
          const totals = calculateWeekTotals(weekData);

          return (
            <div key={weekNumber} className="rounded-lg overflow-hidden" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="px-6 py-4" style={{ background: 'linear-gradient(to right, var(--accent), var(--accent-hover))' }}>
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Calendar className="w-5 h-5" />
                  {getWeekLabel(weekNumber)} - {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
                </h3>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')}</th>
                      <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('abr.belegCount')}</th>
                      <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                        Ausgegebene Bargeld
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                        Bargeld
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                        Bar Zurück
                      </th>
                    </tr>
                  </thead>
                  <tbody style={{ borderTop: '1px solid var(--border)' }}>
                    {weekData.map((item, idx) => (
                      <tr
                        key={idx}
                        onClick={() => handleRowClick(item)}
                        className="transition-colors cursor-pointer"
                        style={{ borderBottom: '1px solid var(--border)' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                        onMouseLeave={e => (e.currentTarget.style.background = '')}
                      >
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {item.driver_name}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right" style={{ color: 'var(--text-secondary)' }}>
                          {item.anzahl_belege}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right" style={{ color: 'var(--text-secondary)' }}>
                          {formatCurrency(Number(item.ausgegebene_bargeld))}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right" style={{ color: 'var(--text-secondary)' }}>
                          {formatCurrency(Number(item.bargeld))}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                          <span className="inline-flex items-center gap-1 font-medium" style={{ color: Number(item.bar_zuruck) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                            {Number(item.bar_zuruck) >= 0 ? (
                              <TrendingUp className="w-4 h-4" />
                            ) : (
                              <TrendingDown className="w-4 h-4" />
                            )}
                            {formatCurrency(Number(item.bar_zuruck))}
                          </span>
                        </td>
                      </tr>
                    ))}
                    <tr className="font-semibold" style={{ background: 'var(--accent-subtle)' }}>
                      <td className="px-6 py-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                        Gesamt
                      </td>
                      <td className="px-6 py-4 text-sm text-right" style={{ color: 'var(--text-primary)' }}>
                        {totals.anzahl_belege}
                      </td>
                      <td className="px-6 py-4 text-sm text-right" style={{ color: 'var(--text-primary)' }}>
                        {formatCurrency(totals.ausgegebene_bargeld)}
                      </td>
                      <td className="px-6 py-4 text-sm text-right" style={{ color: 'var(--text-primary)' }}>
                        {formatCurrency(totals.bargeld)}
                      </td>
                      <td className="px-6 py-4 text-sm text-right">
                        <span className="inline-flex items-center gap-1" style={{ color: totals.bar_zuruck >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                          {totals.bar_zuruck >= 0 ? (
                            <TrendingUp className="w-4 h-4" />
                          ) : (
                            <TrendingDown className="w-4 h-4" />
                          )}
                          {formatCurrency(totals.bar_zuruck)}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const getFilteredMonthlyData = () => {
    let filtered = [...monthlyData];

    if (selectedDriver !== 'all') {
      filtered = filtered.filter(item => item.driver_name === selectedDriver);
    }

    return filtered;
  };

  const calculateMonthlyTotals = (data: MonthlyAbrechnung[]) => {
    return data.reduce((acc, item) => ({
      anzahl_belege: acc.anzahl_belege + item.anzahl_belege,
      ausgegebene_bargeld: acc.ausgegebene_bargeld + Number(item.ausgegebene_bargeld),
      bargeld: acc.bargeld + Number(item.bargeld),
      bar_zuruck: acc.bar_zuruck + Number(item.bar_zuruck)
    }), { anzahl_belege: 0, ausgegebene_bargeld: 0, bargeld: 0, bar_zuruck: 0 });
  };

  const renderMonthlyView = () => {
    if (loading) {
      return (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
          <p className="mt-2" style={{ color: 'var(--text-tertiary)' }}>{t('werkstatt.loading')}</p>
        </div>
      );
    }

    if (monthlyData.length === 0) {
      return (
        <div className="text-center py-12">
          <FileText className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-tertiary)' }} />
          <p style={{ color: 'var(--text-tertiary)' }}>Keine Daten für {MONTH_NAMES[selectedMonth - 1]} {selectedYear}</p>
        </div>
      );
    }

    const filteredData = getFilteredMonthlyData();
    const totals = calculateMonthlyTotals(filteredData);

    return (
      <div className="rounded-lg overflow-hidden" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
        <div className="px-6 py-4" style={{ background: 'linear-gradient(to right, var(--accent), var(--accent-hover))' }}>
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Calendar className="w-5 h-5" />
            {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
          </h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')}</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('abr.belegCount')}</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                  Ausgegebene Bargeld
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                  Bargeld
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                  Bar Zurück
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredData.map((item, idx) => (
                <tr
                  key={idx}
                  onClick={() => handleMonthlyRowClick(item)}
                  className="transition-colors cursor-pointer"
                  style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                >
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    <div>
                      {item.driver_name}
                      <span className="ml-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        ({item.week_count} {item.week_count === 1 ? t('common.week') : t('common.weeks')})
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right" style={{ color: 'var(--text-secondary)' }}>
                    {item.anzahl_belege}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right" style={{ color: 'var(--text-secondary)' }}>
                    {formatCurrency(Number(item.ausgegebene_bargeld))}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right" style={{ color: 'var(--text-secondary)' }}>
                    {formatCurrency(Number(item.bargeld))}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                    <span className="inline-flex items-center gap-1 font-medium" style={{ color: Number(item.bar_zuruck) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                      {Number(item.bar_zuruck) >= 0 ? (
                        <TrendingUp className="w-4 h-4" />
                      ) : (
                        <TrendingDown className="w-4 h-4" />
                      )}
                      {formatCurrency(Number(item.bar_zuruck))}
                    </span>
                  </td>
                </tr>
              ))}
              <tr className="font-semibold" style={{ background: 'var(--accent-subtle)' }}>
                <td className="px-6 py-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                  Gesamt
                </td>
                <td className="px-6 py-4 text-sm text-right" style={{ color: 'var(--text-primary)' }}>
                  {totals.anzahl_belege}
                </td>
                <td className="px-6 py-4 text-sm text-right" style={{ color: 'var(--text-primary)' }}>
                  {formatCurrency(totals.ausgegebene_bargeld)}
                </td>
                <td className="px-6 py-4 text-sm text-right" style={{ color: 'var(--text-primary)' }}>
                  {formatCurrency(totals.bargeld)}
                </td>
                <td className="px-6 py-4 text-sm text-right">
                  <span className="inline-flex items-center gap-1" style={{ color: totals.bar_zuruck >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {totals.bar_zuruck >= 0 ? (
                      <TrendingUp className="w-4 h-4" />
                    ) : (
                      <TrendingDown className="w-4 h-4" />
                    )}
                    {formatCurrency(totals.bar_zuruck)}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Abrechnung</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
            Wöchentliche und monatliche Abrechnungen verwalten
          </p>
        </div>
      </div>

      <div className="rounded-lg p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={() => setViewMode('weekly')}
              className="px-4 py-2 rounded-lg font-medium transition-colors"
              style={viewMode === 'weekly'
                ? { background: 'var(--accent)', color: 'var(--text-inverse)' }
                : { background: 'var(--bg-muted)', color: 'var(--text-secondary)' }
              }
            >
              Wöchentlich
            </button>
            <button
              onClick={() => setViewMode('monthly')}
              className="px-4 py-2 rounded-lg font-medium transition-colors"
              style={viewMode === 'monthly'
                ? { background: 'var(--accent)', color: 'var(--text-inverse)' }
                : { background: 'var(--bg-muted)', color: 'var(--text-secondary)' }
              }
            >
              Monatlich
            </button>
          </div>

          <div className="flex gap-3">
            <select
              value={selectedDriver}
              onChange={(e) => setSelectedDriver(e.target.value)}
              style={inputStyle}
            >
              <option value="all">{t('common.allDrivers')}</option>
              {drivers.map(driver => (
                <option key={driver} value={driver}>
                  {driver}
                </option>
              ))}
            </select>
            {viewMode === 'weekly' && (
              <select
                value={selectedWeek}
                onChange={(e) => setSelectedWeek(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                style={inputStyle}
              >
                <option value="all">{t('abr.allWeeks')}</option>
                {availableWeeks.map(week => (
                  <option key={week} value={week}>
                    Woche {week}
                  </option>
                ))}
              </select>
            )}
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(Number(e.target.value))}
              style={inputStyle}
            >
              {MONTH_NAMES.map((month, idx) => (
                <option key={idx} value={idx + 1}>
                  {month}
                </option>
              ))}
            </select>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              style={inputStyle}
            >
              {[2024, 2025, 2026, 2027].map(year => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {viewMode === 'weekly' ? renderWeeklyView() : renderMonthlyView()}

      {/* ── Off-screen shareable card — mirrors the visible modal, fully theme-aware ── */}
      {detailModalData && (
        <div
          ref={shareableCardRef}
          style={{
            position: 'fixed', left: '-9999px', top: 0, zIndex: -1,
            background: isDark ? '#0d1117' : '#ffffff',
            width: 600,
            pointerEvents: 'none',
          }}
        >
          <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Fahrer + Woche/Monat row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {/* Fahrer card */}
              <div style={{
                background: isDark ? 'rgba(37,99,235,0.08)' : '#f0f7ff',
                border: isDark ? '1px solid rgba(37,99,235,0.22)' : '1px solid #bfdbfe',
                borderRadius: 12, padding: '14px 16px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 7,
                    background: isDark ? 'rgba(37,99,235,0.15)' : '#dbeafe',
                    border: isDark ? '1px solid rgba(59,130,246,0.3)' : '1px solid #93c5fd',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <User style={{ width: 14, height: 14, color: isDark ? '#60a5fa' : '#2563eb' }} />
                  </div>
                  <p style={{ fontSize: 11, fontWeight: 600, color: isDark ? '#93c5fd' : '#1e40af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t('common.driver')}</p>
                </div>
                <p style={{ fontSize: 17, fontWeight: 800, color: isDark ? '#f1f5f9' : '#0f172a' }}>{detailModalData.driverName}</p>
              </div>

              {/* Woche / Monat card */}
              <div style={{
                background: isDark ? 'rgba(37,99,235,0.08)' : '#f0f7ff',
                border: isDark ? '1px solid rgba(37,99,235,0.22)' : '1px solid #bfdbfe',
                borderRadius: 12, padding: '14px 16px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 7,
                    background: isDark ? 'rgba(37,99,235,0.15)' : '#dbeafe',
                    border: isDark ? '1px solid rgba(59,130,246,0.3)' : '1px solid #93c5fd',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Calendar style={{ width: 14, height: 14, color: isDark ? '#60a5fa' : '#2563eb' }} />
                  </div>
                  <p style={{ fontSize: 11, fontWeight: 600, color: isDark ? '#93c5fd' : '#1e40af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {detailModalData.weekNumber === 0 ? t('common.month') : t('common.week')}
                  </p>
                </div>
                <p style={{ fontSize: 17, fontWeight: 800, color: isDark ? '#f1f5f9' : '#0f172a' }}>
                  {detailModalData.weekNumber === 0 ? `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}` : `Woche ${detailModalData.weekNumber}`}
                </p>
              </div>
            </div>

            {/* Zeitraum card */}
            <div style={{
              background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
              border: isDark ? '1px solid rgba(255,255,255,0.07)' : '1px solid #e2e8f0',
              borderRadius: 12, padding: '14px 16px',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 7,
                background: isDark ? 'rgba(234,88,12,0.12)' : '#fef9f0',
                border: isDark ? '1px solid rgba(234,88,12,0.25)' : '1px solid #fed7aa',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <Calendar style={{ width: 14, height: 14, color: isDark ? '#fb923c' : '#ea580c' }} />
              </div>
              <div>
                <p style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{t('common.period')}</p>
                <p style={{ fontSize: 15, fontWeight: 700, color: isDark ? '#e2e8f0' : '#0f172a' }}>
                  {detailModalData.weekStartDate} – {detailModalData.weekEndDate}
                </p>
              </div>
            </div>

            {/* Finanzübersicht */}
            <div style={{ borderTop: isDark ? '1px solid rgba(255,255,255,0.07)' : '1px solid #e2e8f0', paddingTop: 16 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#475569' : '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>{t('abr.financialOverview')}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                {/* Bargeld */}
                <div style={{
                  background: isDark ? 'rgba(22,163,74,0.08)' : '#f0fdf4',
                  border: isDark ? '1px solid rgba(22,163,74,0.25)' : '1px solid #bbf7d0',
                  borderRadius: 12, padding: '14px 16px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: 9,
                      background: isDark ? 'rgba(22,163,74,0.14)' : '#dcfce7',
                      border: isDark ? '1px solid rgba(74,222,128,0.25)' : '1px solid #86efac',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <DollarSign style={{ width: 18, height: 18, color: isDark ? '#4ade80' : '#16a34a' }} />
                    </div>
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 600, color: isDark ? '#4ade80' : '#15803d' }}>
                        Gesamt Bargeld ({detailModalData.weekNumber === 0 ? t('common.month') : t('abr.thisWeek')})
                      </p>
                      <p style={{ fontSize: 11, color: isDark ? '#166534' : '#86efac', marginTop: 1 }}>{t('bargeld.cashIncome')}</p>
                    </div>
                  </div>
                  <p style={{ fontSize: 22, fontWeight: 900, color: isDark ? '#4ade80' : '#15803d', letterSpacing: '-0.02em' }}>
                    {formatCurrency(detailModalData.totalCash)}
                  </p>
                </div>

                {/* Belege */}
                <div style={{
                  background: isDark ? 'rgba(220,38,38,0.07)' : '#fff7f7',
                  border: isDark ? '1px solid rgba(220,38,38,0.25)' : '1px solid #fecaca',
                  borderRadius: 12, padding: '14px 16px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: 9,
                      background: isDark ? 'rgba(220,38,38,0.13)' : '#fee2e2',
                      border: isDark ? '1px solid rgba(248,113,113,0.25)' : '1px solid #fca5a5',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <ReceiptIcon style={{ width: 18, height: 18, color: isDark ? '#f87171' : '#dc2626' }} />
                    </div>
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 600, color: isDark ? '#f87171' : '#b91c1c' }}>{t('abr.belegCount')}</p>
                      <p style={{ fontSize: 11, color: isDark ? '#991b1b' : '#f87171', marginTop: 1 }}>{detailModalData.anzahlBelege} Belege</p>
                    </div>
                  </div>
                  <p style={{ fontSize: 22, fontWeight: 900, color: isDark ? '#f87171' : '#b91c1c', letterSpacing: '-0.02em' }}>
                    {formatCurrency(detailModalData.sumBelege)}
                  </p>
                </div>

                {/* Differenz */}
                {(() => {
                  const pos = detailModalData.difference >= 0;
                  return (
                    <div style={{
                      background: isDark
                        ? pos ? 'rgba(2,132,199,0.08)' : 'rgba(217,119,6,0.08)'
                        : pos ? '#f0f9ff' : '#fffbeb',
                      border: isDark
                        ? `1px solid ${pos ? 'rgba(2,132,199,0.28)' : 'rgba(217,119,6,0.28)'}`
                        : `1px solid ${pos ? '#bae6fd' : '#fde68a'}`,
                      borderRadius: 12, padding: '14px 16px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{
                          width: 36, height: 36, borderRadius: 9,
                          background: isDark
                            ? pos ? 'rgba(2,132,199,0.15)' : 'rgba(217,119,6,0.15)'
                            : pos ? '#e0f2fe' : '#fef3c7',
                          border: isDark
                            ? `1px solid ${pos ? 'rgba(56,189,248,0.3)' : 'rgba(251,191,36,0.3)'}`
                            : `1px solid ${pos ? '#7dd3fc' : '#fcd34d'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {pos
                            ? <TrendingUp style={{ width: 18, height: 18, color: isDark ? '#38bdf8' : '#0284c7' }} />
                            : <TrendingDown style={{ width: 18, height: 18, color: isDark ? '#fbbf24' : '#d97706' }} />
                          }
                        </div>
                        <div>
                          <p style={{ fontSize: 13, fontWeight: 600, color: isDark ? (pos ? '#38bdf8' : '#fbbf24') : (pos ? '#0369a1' : '#b45309') }}>
                            Differenz (Bargeld – Belege)
                          </p>
                          <p style={{ fontSize: 11, color: isDark ? (pos ? '#0c4a6e' : '#78350f') : (pos ? '#38bdf8' : '#fbbf24'), marginTop: 1 }}>
                            Der Betrag den Sie abgeben müssen
                          </p>
                        </div>
                      </div>
                      <p style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.02em', color: isDark ? (pos ? '#38bdf8' : '#fbbf24') : (pos ? '#0369a1' : '#b45309') }}>
                        {formatCurrency(detailModalData.difference)}
                      </p>
                    </div>
                  );
                })()}

                {renderTankenquoteCard(detailModalData)}

              </div>
            </div>
          </div>
        </div>
      )}

      {detailModalData && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 50,
          background: isDark ? 'rgba(0,0,0,0.72)' : 'rgba(15,23,42,0.45)',
          backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '16px',
        }}>
          <div style={{
            background: isDark ? '#0d1117' : '#ffffff',
            border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
            borderRadius: '18px',
            boxShadow: isDark
              ? '0 32px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(6,182,212,0.07)'
              : '0 12px 48px rgba(15,23,42,0.12), 0 2px 8px rgba(15,23,42,0.06)',
            maxWidth: '640px',
            width: '100%',
            maxHeight: '90vh',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}>

            {/* ── Header ── */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '18px 22px',
              borderBottom: isDark ? '1px solid rgba(255,255,255,0.06)' : '1px solid #e4e8f0',
              background: isDark
                ? 'linear-gradient(135deg, #0f1a2e 0%, #0a1220 100%)'
                : '#f8f9fc',
              borderRadius: '18px 18px 0 0',
              flexShrink: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  background: isDark ? 'rgba(6,182,212,0.12)' : '#eff6ff',
                  border: isDark ? '1px solid rgba(6,182,212,0.22)' : '1px solid #bfdbfe',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <FileText style={{ width: 17, height: 17, color: isDark ? '#06b6d4' : '#2563eb' }} />
                </div>
                <div>
                  <h2 style={{ fontSize: 15, fontWeight: 700, color: isDark ? '#f1f5f9' : '#111827', lineHeight: 1.2 }}>
                    Detaillierte Abrechnung
                  </h2>
                  <p style={{ fontSize: 11, color: isDark ? 'rgba(255,255,255,0.32)' : '#6b7280', marginTop: 1 }}>
                    {detailModalData.driverName} · {detailModalData.weekNumber === 0
                      ? `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`
                      : `Woche ${detailModalData.weekNumber}`}
                  </p>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {[
                  { icon: <Share2 style={{ width: 15, height: 15 }} />, onClick: handleShareToWhatsApp, title: t('abr.shareAsImage') },
                  { icon: <Copy style={{ width: 15, height: 15 }} />, onClick: handleCopyImage, title: t('abr.copyImage') },
                  { icon: <Download style={{ width: 15, height: 15 }} />, onClick: handleDownloadImage, title: t('common.download') },
                ].map((btn, i) => (
                  <button
                    key={i}
                    onClick={btn.onClick}
                    disabled={isSharing}
                    title={btn.title}
                    style={{
                      background: isDark ? 'rgba(255,255,255,0.05)' : '#ffffff',
                      border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e4e8f0',
                      borderRadius: 8,
                      padding: '7px 8px',
                      color: isDark ? 'rgba(255,255,255,0.55)' : '#6b7280',
                      cursor: isSharing ? 'not-allowed' : 'pointer',
                      opacity: isSharing ? 0.4 : 1,
                      transition: 'all 0.18s',
                      display: 'flex', alignItems: 'center',
                    }}
                    onMouseEnter={e => {
                      if (!isSharing) {
                        if (isDark) {
                          (e.currentTarget as HTMLElement).style.background = 'rgba(6,182,212,0.12)';
                          (e.currentTarget as HTMLElement).style.borderColor = 'rgba(6,182,212,0.25)';
                          (e.currentTarget as HTMLElement).style.color = '#06b6d4';
                        } else {
                          (e.currentTarget as HTMLElement).style.background = '#eff6ff';
                          (e.currentTarget as HTMLElement).style.borderColor = '#bfdbfe';
                          (e.currentTarget as HTMLElement).style.color = '#2563eb';
                        }
                      }
                    }}
                    onMouseLeave={e => {
                      if (isDark) {
                        (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)';
                        (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.55)';
                      } else {
                        (e.currentTarget as HTMLElement).style.background = '#ffffff';
                        (e.currentTarget as HTMLElement).style.borderColor = '#e4e8f0';
                        (e.currentTarget as HTMLElement).style.color = '#6b7280';
                      }
                    }}
                  >
                    {btn.icon}
                  </button>
                ))}
                <button
                  onClick={() => setDetailModalData(null)}
                  style={{
                    background: isDark ? 'rgba(255,255,255,0.04)' : '#ffffff',
                    border: isDark ? '1px solid rgba(255,255,255,0.07)' : '1px solid #e4e8f0',
                    borderRadius: 8,
                    padding: '7px 8px',
                    color: isDark ? 'rgba(255,255,255,0.4)' : '#9ca3af',
                    cursor: 'pointer',
                    marginLeft: 4,
                    transition: 'all 0.18s',
                    display: 'flex', alignItems: 'center',
                  }}
                  onMouseEnter={e => {
                    if (isDark) {
                      (e.currentTarget as HTMLElement).style.background = 'rgba(239,68,68,0.1)';
                      (e.currentTarget as HTMLElement).style.borderColor = 'rgba(239,68,68,0.2)';
                      (e.currentTarget as HTMLElement).style.color = '#f87171';
                    } else {
                      (e.currentTarget as HTMLElement).style.background = '#fef2f2';
                      (e.currentTarget as HTMLElement).style.borderColor = '#fecaca';
                      (e.currentTarget as HTMLElement).style.color = '#dc2626';
                    }
                  }}
                  onMouseLeave={e => {
                    if (isDark) {
                      (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)';
                      (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.07)';
                      (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.4)';
                    } else {
                      (e.currentTarget as HTMLElement).style.background = '#ffffff';
                      (e.currentTarget as HTMLElement).style.borderColor = '#e4e8f0';
                      (e.currentTarget as HTMLElement).style.color = '#9ca3af';
                    }
                  }}
                >
                  <X style={{ width: 15, height: 15 }} />
                </button>
              </div>
            </div>

            {/* ── Themed visible content ── */}
            <div style={{ background: isDark ? '#0d1117' : '#ffffff', flex: 1 }}>
              <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

                {/* Info cards row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {/* Fahrer card */}
                  <div style={{
                    background: isDark ? 'rgba(37,99,235,0.08)' : '#f0f7ff',
                    border: isDark ? '1px solid rgba(37,99,235,0.22)' : '1px solid #bfdbfe',
                    borderRadius: 12, padding: '14px 16px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: 7,
                        background: isDark ? 'rgba(37,99,235,0.15)' : '#dbeafe',
                        border: isDark ? '1px solid rgba(59,130,246,0.3)' : '1px solid #93c5fd',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <User style={{ width: 14, height: 14, color: isDark ? '#60a5fa' : '#2563eb' }} />
                      </div>
                      <p style={{ fontSize: 11, fontWeight: 600, color: isDark ? '#93c5fd' : '#1e40af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t('common.driver')}</p>
                    </div>
                    <p style={{ fontSize: 17, fontWeight: 800, color: isDark ? '#f1f5f9' : '#0f172a' }}>{detailModalData.driverName}</p>
                  </div>

                  {/* Woche / Monat card */}
                  <div style={{
                    background: isDark ? 'rgba(37,99,235,0.08)' : '#f0f7ff',
                    border: isDark ? '1px solid rgba(37,99,235,0.22)' : '1px solid #bfdbfe',
                    borderRadius: 12, padding: '14px 16px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: 7,
                        background: isDark ? 'rgba(37,99,235,0.15)' : '#dbeafe',
                        border: isDark ? '1px solid rgba(59,130,246,0.3)' : '1px solid #93c5fd',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Calendar style={{ width: 14, height: 14, color: isDark ? '#60a5fa' : '#2563eb' }} />
                      </div>
                      <p style={{ fontSize: 11, fontWeight: 600, color: isDark ? '#93c5fd' : '#1e40af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {detailModalData.weekNumber === 0 ? t('common.month') : t('common.week')}
                      </p>
                    </div>
                    <p style={{ fontSize: 17, fontWeight: 800, color: isDark ? '#f1f5f9' : '#0f172a' }}>
                      {detailModalData.weekNumber === 0
                        ? `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`
                        : `Woche ${detailModalData.weekNumber}`}
                    </p>
                  </div>
                </div>

                {/* Zeitraum card */}
                <div style={{
                  background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                  border: isDark ? '1px solid rgba(255,255,255,0.07)' : '1px solid #e2e8f0',
                  borderRadius: 12, padding: '14px 16px',
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 7,
                    background: isDark ? 'rgba(234,88,12,0.12)' : '#fef9f0',
                    border: isDark ? '1px solid rgba(234,88,12,0.25)' : '1px solid #fed7aa',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <Calendar style={{ width: 14, height: 14, color: isDark ? '#fb923c' : '#ea580c' }} />
                  </div>
                  <div>
                    <p style={{ fontSize: 11, fontWeight: 600, color: isDark ? '#64748b' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{t('common.period')}</p>
                    <p style={{ fontSize: 15, fontWeight: 700, color: isDark ? '#e2e8f0' : '#0f172a' }}>
                      {detailModalData.weekStartDate} – {detailModalData.weekEndDate}
                    </p>
                  </div>
                </div>

                {/* Divider + Finanzübersicht */}
                <div style={{ borderTop: isDark ? '1px solid rgba(255,255,255,0.07)' : '1px solid #e2e8f0', paddingTop: 16 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#475569' : '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>{t('abr.financialOverview')}</p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                    {/* Bargeld */}
                    <div style={{
                      background: isDark ? 'rgba(22,163,74,0.08)' : '#f0fdf4',
                      border: isDark ? '1px solid rgba(22,163,74,0.25)' : '1px solid #bbf7d0',
                      borderRadius: 12, padding: '14px 16px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{
                          width: 36, height: 36, borderRadius: 9,
                          background: isDark ? 'rgba(22,163,74,0.14)' : '#dcfce7',
                          border: isDark ? '1px solid rgba(74,222,128,0.25)' : '1px solid #86efac',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <DollarSign style={{ width: 18, height: 18, color: isDark ? '#4ade80' : '#16a34a' }} />
                        </div>
                        <div>
                          <p style={{ fontSize: 13, fontWeight: 600, color: isDark ? '#4ade80' : '#15803d' }}>
                            Gesamt Bargeld ({detailModalData.weekNumber === 0 ? t('common.month') : t('abr.thisWeek')})
                          </p>
                          <p style={{ fontSize: 11, color: isDark ? '#166534' : '#86efac', marginTop: 1 }}>{t('bargeld.cashIncome')}</p>
                        </div>
                      </div>
                      <p style={{ fontSize: 22, fontWeight: 900, color: isDark ? '#4ade80' : '#15803d', letterSpacing: '-0.02em' }}>
                        {formatCurrency(detailModalData.totalCash)}
                      </p>
                    </div>

                    {/* Belege */}
                    <div style={{
                      background: isDark ? 'rgba(220,38,38,0.07)' : '#fff7f7',
                      border: isDark ? '1px solid rgba(220,38,38,0.25)' : '1px solid #fecaca',
                      borderRadius: 12, padding: '14px 16px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{
                          width: 36, height: 36, borderRadius: 9,
                          background: isDark ? 'rgba(220,38,38,0.13)' : '#fee2e2',
                          border: isDark ? '1px solid rgba(248,113,113,0.25)' : '1px solid #fca5a5',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <ReceiptIcon style={{ width: 18, height: 18, color: isDark ? '#f87171' : '#dc2626' }} />
                        </div>
                        <div>
                          <p style={{ fontSize: 13, fontWeight: 600, color: isDark ? '#f87171' : '#b91c1c' }}>{t('abr.belegCount')}</p>
                          <p style={{ fontSize: 11, color: isDark ? '#991b1b' : '#f87171', marginTop: 1 }}>{detailModalData.anzahlBelege} Belege</p>
                        </div>
                      </div>
                      <p style={{ fontSize: 22, fontWeight: 900, color: isDark ? '#f87171' : '#b91c1c', letterSpacing: '-0.02em' }}>
                        {formatCurrency(detailModalData.sumBelege)}
                      </p>
                    </div>

                    {/* Differenz */}
                    {(() => {
                      const pos = detailModalData.difference >= 0;
                      return (
                        <div style={{
                          background: isDark
                            ? pos ? 'rgba(2,132,199,0.08)' : 'rgba(217,119,6,0.08)'
                            : pos ? '#f0f9ff' : '#fffbeb',
                          border: isDark
                            ? `1px solid ${pos ? 'rgba(2,132,199,0.28)' : 'rgba(217,119,6,0.28)'}`
                            : `1px solid ${pos ? '#bae6fd' : '#fde68a'}`,
                          borderRadius: 12, padding: '14px 16px',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{
                              width: 36, height: 36, borderRadius: 9,
                              background: isDark
                                ? pos ? 'rgba(2,132,199,0.15)' : 'rgba(217,119,6,0.15)'
                                : pos ? '#e0f2fe' : '#fef3c7',
                              border: isDark
                                ? `1px solid ${pos ? 'rgba(56,189,248,0.3)' : 'rgba(251,191,36,0.3)'}`
                                : `1px solid ${pos ? '#7dd3fc' : '#fcd34d'}`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              {pos
                                ? <TrendingUp style={{ width: 18, height: 18, color: isDark ? '#38bdf8' : '#0284c7' }} />
                                : <TrendingDown style={{ width: 18, height: 18, color: isDark ? '#fbbf24' : '#d97706' }} />
                              }
                            </div>
                            <div>
                              <p style={{ fontSize: 13, fontWeight: 600, color: isDark ? (pos ? '#38bdf8' : '#fbbf24') : (pos ? '#0369a1' : '#b45309') }}>
                                Differenz (Bargeld – Belege)
                              </p>
                              <p style={{ fontSize: 11, color: isDark ? (pos ? '#0c4a6e' : '#78350f') : (pos ? '#38bdf8' : '#fbbf24'), marginTop: 1 }}>
                                Der Betrag den Sie abgeben müssen
                              </p>
                            </div>
                          </div>
                          <p style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.02em', color: isDark ? (pos ? '#38bdf8' : '#fbbf24') : (pos ? '#0369a1' : '#b45309') }}>
                            {formatCurrency(detailModalData.difference)}
                          </p>
                        </div>
                      );
                    })()}

                    {renderTankenquoteCard(detailModalData)}

                  </div>
                </div>

              </div>
            </div>

            {/* ── Footer actions ── */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '16px 22px',
              borderTop: isDark ? '1px solid rgba(255,255,255,0.06)' : '1px solid #e4e8f0',
              background: isDark ? '#0a0f1a' : '#f8f9fc',
              borderRadius: '0 0 18px 18px',
              flexShrink: 0,
            }}>
              <button
                onClick={handleShareToWhatsApp}
                disabled={isSharing}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                  background: isDark ? 'rgba(16,185,129,0.12)' : '#f0fdf4',
                  border: isDark ? '1px solid rgba(16,185,129,0.22)' : '1px solid #bbf7d0',
                  color: isDark ? '#34d399' : '#15803d',
                  cursor: isSharing ? 'not-allowed' : 'pointer',
                  opacity: isSharing ? 0.5 : 1, transition: 'all 0.18s',
                }}
                onMouseEnter={e => {
                  if (!isSharing) {
                    if (isDark) { (e.currentTarget as HTMLElement).style.background = 'rgba(16,185,129,0.2)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(52,211,153,0.4)'; }
                    else { (e.currentTarget as HTMLElement).style.background = '#dcfce7'; (e.currentTarget as HTMLElement).style.borderColor = '#86efac'; }
                  }
                }}
                onMouseLeave={e => {
                  if (isDark) { (e.currentTarget as HTMLElement).style.background = 'rgba(16,185,129,0.12)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(16,185,129,0.22)'; }
                  else { (e.currentTarget as HTMLElement).style.background = '#f0fdf4'; (e.currentTarget as HTMLElement).style.borderColor = '#bbf7d0'; }
                }}
              >
                <Share2 style={{ width: 15, height: 15 }} />
                {isSharing ? t('abr.creatingImage') : t('common.share')}
              </button>
              <button
                onClick={handleCopyImage}
                disabled={isSharing}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                  background: isDark ? 'rgba(6,182,212,0.1)' : '#eff6ff',
                  border: isDark ? '1px solid rgba(6,182,212,0.2)' : '1px solid #bfdbfe',
                  color: isDark ? '#22d3ee' : '#1d4ed8',
                  cursor: isSharing ? 'not-allowed' : 'pointer',
                  opacity: isSharing ? 0.5 : 1, transition: 'all 0.18s',
                }}
                onMouseEnter={e => {
                  if (!isSharing) {
                    if (isDark) { (e.currentTarget as HTMLElement).style.background = 'rgba(6,182,212,0.18)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(6,182,212,0.35)'; }
                    else { (e.currentTarget as HTMLElement).style.background = '#dbeafe'; (e.currentTarget as HTMLElement).style.borderColor = '#93c5fd'; }
                  }
                }}
                onMouseLeave={e => {
                  if (isDark) { (e.currentTarget as HTMLElement).style.background = 'rgba(6,182,212,0.1)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(6,182,212,0.2)'; }
                  else { (e.currentTarget as HTMLElement).style.background = '#eff6ff'; (e.currentTarget as HTMLElement).style.borderColor = '#bfdbfe'; }
                }}
              >
                <Copy style={{ width: 15, height: 15 }} />
                {isSharing ? t('abr.creatingImage') : t('common.copy')}
              </button>
              <button
                onClick={handleDownloadImage}
                disabled={isSharing}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                  background: isDark ? 'rgba(6,182,212,0.1)' : '#eff6ff',
                  border: isDark ? '1px solid rgba(6,182,212,0.2)' : '1px solid #bfdbfe',
                  color: isDark ? '#22d3ee' : '#1d4ed8',
                  cursor: isSharing ? 'not-allowed' : 'pointer',
                  opacity: isSharing ? 0.5 : 1, transition: 'all 0.18s',
                }}
                onMouseEnter={e => {
                  if (!isSharing) {
                    if (isDark) { (e.currentTarget as HTMLElement).style.background = 'rgba(6,182,212,0.18)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(6,182,212,0.35)'; }
                    else { (e.currentTarget as HTMLElement).style.background = '#dbeafe'; (e.currentTarget as HTMLElement).style.borderColor = '#93c5fd'; }
                  }
                }}
                onMouseLeave={e => {
                  if (isDark) { (e.currentTarget as HTMLElement).style.background = 'rgba(6,182,212,0.1)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(6,182,212,0.2)'; }
                  else { (e.currentTarget as HTMLElement).style.background = '#eff6ff'; (e.currentTarget as HTMLElement).style.borderColor = '#bfdbfe'; }
                }}
              >
                <Download style={{ width: 15, height: 15 }} />
                {isSharing ? t('abr.creatingImage') : t('common.download')}
              </button>
              <button
                onClick={() => setDetailModalData(null)}
                style={{
                  padding: '10px 16px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                  background: isDark ? 'rgba(255,255,255,0.05)' : '#ffffff',
                  border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e4e8f0',
                  color: isDark ? 'rgba(255,255,255,0.45)' : '#6b7280',
                  cursor: 'pointer', transition: 'all 0.18s',
                }}
                onMouseEnter={e => {
                  if (isDark) { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.09)'; (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.75)'; }
                  else { (e.currentTarget as HTMLElement).style.background = '#eef1f7'; (e.currentTarget as HTMLElement).style.color = '#111827'; }
                }}
                onMouseLeave={e => {
                  if (isDark) { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.45)'; }
                  else { (e.currentTarget as HTMLElement).style.background = '#ffffff'; (e.currentTarget as HTMLElement).style.color = '#6b7280'; }
                }}
              >
                Schließen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
