import { useState, useEffect, useRef, type ReactNode } from 'react';
import {
  Calendar,
  CalendarRange,
  Copy,
  DollarSign,
  Download,
  FileText,
  Filter,
  Fuel,
  Receipt as ReceiptIcon,
  RotateCw,
  Share2,
  TrendingDown,
  TrendingUp,
  User,
  type LucideIcon,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTheme } from '../contexts/ThemeContext';
import { format } from 'date-fns';
import { getWeeksOfMonth, getBusinessMonthRange, getBusinessWeeksForMonth } from '../utils/weekCalculations';
import html2canvas from 'html2canvas';
import { useTranslation } from '../contexts/LanguageContext';
import {
  Alert,
  Button,
  Card,
  cn,
  DataTable,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  formatEuro,
  formatNumber,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  type DataTableColumn,
} from '../components/ui';

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

export function AbrechnungPage() {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>('weekly');
  const [weeklyData, setWeeklyData] = useState<WeeklyAbrechnung[]>([]);
  const [monthlyData, setMonthlyData] = useState<MonthlyAbrechnung[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
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
      setLoadFailed(false);
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
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const loadMonthlyData = async () => {
    try {
      setLoading(true);
      setLoadFailed(false);
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
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Tankenquote's two reads.
   *
   * The rule being preserved: Tankenquote counts only receipts whose Kategorie
   * is `Tanken` for that driver and period, over Netto-Fahrpreis plus
   * Aktionen, and only the percentage is shown. Neither term changes here.
   *
   * What changes is that a failed read no longer answers zero. `data` is null
   * on an error, so `?? []` turned a refusal into "this driver bought no
   * fuel": with the receipts read failed and the income read fine, the quote
   * computed as 0 / umsatz and the card printed **Tankenquote 0,00 %** — on
   * the card html2canvas renders and the driver is sent. CLAUDE.md: a figure
   * whose load failed is not shown.
   *
   * Throwing puts it on the failure path the two callers already have: their
   * catch shows `abr.detailsFailed` and never sets `detailModalData`, so no
   * card is drawn and no image can be exported from it. Deliberately *not*
   * `loadFailed` — that flag blanks the whole Abrechnung table, whose own RPC
   * read succeeded, and its retry button re-runs that RPC and not this.
   */
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

    if (receiptsRes.error) throw receiptsRes.error;
    if (incomeRes.error) throw incomeRes.error;

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
          {t('abr.tankenquote')}
        </span>
        <span style={{ fontSize: 18, fontWeight: 900, color: isDark ? '#fb923c' : '#c2410c', letterSpacing: '-0.01em' }}>
          {quote !== null ? formatPercent(quote) : '—'}
        </span>
      </div>
    );
  };

  const getWeekLabel = (weekNumber: number) => {
    return t('common.weekNumber', { number: weekNumber });
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
      // Nothing half-loaded stays on screen. Not a proven-reachable path — the
      // open modal covers the rows — but the invariant is cheaper to hold
      // unconditionally than to re-derive from the overlay's geometry.
      setDetailModalData(null);
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
      // Nothing half-loaded stays on screen. Not a proven-reachable path — the
      // open modal covers the rows — but the invariant is cheaper to hold
      // unconditionally than to re-derive from the overlay's geometry.
      setDetailModalData(null);
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
      showToast('error', t('common.error'), t('abr.noData'));
      return null;
    }

    if (!shareableCardRef.current) {
      showToast('error', t('common.error'), t('abr.noContentArea'));
      return null;
    }

    try {
      // Wait for fonts and images to load
      await document.fonts.ready;
      await new Promise(resolve => setTimeout(resolve, 300));

      const element = shareableCardRef.current;

      // Defensive check before accessing properties
      if (!element) {
        showToast('error', t('common.error'), t('abr.elementUnavailable'));
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
        showToast('error', t('common.error'), t('abr.whatsappFailed'));
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged, but for the five
  // `loadFailed` lines; everything below only draws it. The tables show the
  // RPC's rows and the sums calculateWeekTotals and calculateMonthlyTotals
  // return, formatted through utils/money.ts (formatEuro): this block adds no
  // arithmetic. Bar zurück is the RPC's bar_zuruck, cash collected minus cash
  // spent; positive means the driver owes the company.
  //
  // What stays as it was: the off-screen card below, which html2canvas turns
  // into the image a driver is sent. Its look is that picture, so it keeps its
  // own colours and renderTankenquoteCard above.

  // formatEuro refuses a value that is not a finite amount. A figure shows such
  // a value as it is rather than taking the screen down, as DataTable does.
  const euro = (amount: number) => (Number.isFinite(amount) ? formatEuro(amount) : String(amount));

  const barZurueck = (amount: number) => (
    <span className={cn('inline-flex items-center justify-end gap-1 font-semibold', amount >= 0 ? 'text-positive' : 'text-critical')}>
      {amount >= 0 ? <TrendingUp aria-hidden className="size-4" /> : <TrendingDown aria-hidden className="size-4" />}
      {euro(amount)}
    </span>
  );

  type AbrechnungTotals = { anzahl_belege: number; ausgegebene_bargeld: number; bargeld: number; bar_zuruck: number };

  function abrechnungColumns<Row extends WeeklyAbrechnung | MonthlyAbrechnung>(): DataTableColumn<Row>[] {
    return [
      {
        id: 'driver',
        header: t('common.driver'),
        value: item => item.driver_name,
        sortable: true,
        className: 'pr-2 sm:pr-4',
        cell: row => {
          // Widened to the union, where `in` narrows; a type parameter does not.
          const item: WeeklyAbrechnung | MonthlyAbrechnung = row;
          return 'week_count' in item ? (
            <span className="font-medium">
              {item.driver_name}
              <span className="ml-2 whitespace-nowrap text-xs font-normal text-fg-subtle">
                ({item.week_count} {item.week_count === 1 ? t('common.week') : t('common.weeks')})
              </span>
            </span>
          ) : (
            <span className="font-medium">{item.driver_name}</span>
          );
        },
      },
      { id: 'belege', header: t('abr.belegCount'), kind: 'number', value: item => item.anzahl_belege, hideBelow: 'md' },
      { id: 'spent', header: t('abr.col.spentCash'), kind: 'currency', value: item => Number(item.ausgegebene_bargeld), hideBelow: 'sm' },
      { id: 'cash', header: t('abr.col.cash'), kind: 'currency', value: item => Number(item.bargeld), hideBelow: 'sm' },
      {
        id: 'barZurueck',
        header: t('abr.col.barZurueck'),
        kind: 'currency',
        className: 'pl-2 pr-3 sm:px-4',
        value: item => Number(item.bar_zuruck),
        sortable: true,
        cell: item => barZurueck(Number(item.bar_zuruck)),
      },
    ];
  }

  const totalsRow = (totals: AbrechnungTotals) => ({
    driver: t('overview.common.gesamt'),
    belege: formatNumber(totals.anzahl_belege),
    spent: euro(totals.ausgegebene_bargeld),
    cash: euro(totals.bargeld),
    barZurueck: barZurueck(totals.bar_zuruck),
  });

  const detailsButton = (driverName: string, open: () => void) => (
    <Tooltip content={t('abr.details')}>
      <Button variant="ghost" size="icon-sm" aria-label={t('abr.detailsFor', { name: driverName })} onClick={open}>
        <FileText aria-hidden />
      </Button>
    </Tooltip>
  );

  const noMatches = <EmptyState size="sm" icon={Filter} title={t('abr.noMatches')} />;

  const renderWeeklyTables = () => {
    const groupedData = groupByWeek();
    const weekNumbers = Object.keys(groupedData).map(Number).sort((a, b) => b - a);

    if (weekNumbers.length === 0) return <Card>{noMatches}</Card>;

    return (
      <div className="grid grid-cols-1 gap-6">
        {weekNumbers.map(weekNumber => {
          const weekData = groupedData[weekNumber];
          const totals = calculateWeekTotals(weekData);

          return (
            <section key={weekNumber} aria-labelledby={`abr-week-${weekNumber}`} className="grid grid-cols-1 gap-2">
              <h2 id={`abr-week-${weekNumber}`} className="flex items-center gap-2 text-[15px] font-semibold text-fg">
                <Calendar aria-hidden className="size-4 text-fg-subtle" />
                {getWeekLabel(weekNumber)} - {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
              </h2>
              <DataTable
                caption={t('abr.weekCaption', { period: `${getWeekLabel(weekNumber)}, ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}` })}
                columns={abrechnungColumns<WeeklyAbrechnung>()}
                rows={weekData}
                getRowId={item => `${item.week_number}-${item.driver_name}`}
                rowActions={item => detailsButton(item.driver_name, () => handleRowClick(item))}
                rowActionsLabel={t('abr.details')}
                totals={totalsRow(totals)}
              />
            </section>
          );
        })}
      </div>
    );
  };

  const renderMonthlyTable = () => {
    const filteredData = getFilteredMonthlyData();
    const totals = calculateMonthlyTotals(filteredData);

    return (
      <section aria-labelledby="abr-month" className="grid grid-cols-1 gap-2">
        <h2 id="abr-month" className="flex items-center gap-2 text-[15px] font-semibold text-fg">
          <Calendar aria-hidden className="size-4 text-fg-subtle" />
          {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
        </h2>
        <DataTable
          caption={t('abr.monthCaption', { period: `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}` })}
          columns={abrechnungColumns<MonthlyAbrechnung>()}
          rows={filteredData}
          getRowId={item => item.driver_name}
          rowActions={item => detailsButton(item.driver_name, () => handleMonthlyRowClick(item))}
          rowActionsLabel={t('abr.details')}
          totals={totalsRow(totals)}
          emptyState={noMatches}
        />
      </section>
    );
  };

  const noData = (
    <Card>
      <EmptyState icon={FileText} title={t('abr.noDataFor', { period: `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}` })} />
    </Card>
  );

  const content = loading ? (
    <DataTable
      caption={t('abr.weekCaption', { period: `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}` })}
      columns={abrechnungColumns<WeeklyAbrechnung>()}
      rows={[]}
      getRowId={item => `${item.week_number}-${item.driver_name}`}
      loading
    />
  ) : loadFailed ? (
    // A failed load leaves the previous month's rows in state; showing them
    // under the month now selected would be a claim about that month.
    <Alert
      tone="critical"
      title={t('abr.loadFailed')}
      action={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => (viewMode === 'weekly' ? loadWeeklyData() : loadMonthlyData())}
        >
          <RotateCw aria-hidden />
          {t('ui.table.retry')}
        </Button>
      }
    >
      {t('abr.loadFailedBody')}
    </Alert>
  ) : viewMode === 'weekly' ? (
    weeklyData.length === 0 ? noData : renderWeeklyTables()
  ) : monthlyData.length === 0 ? (
    noData
  ) : (
    renderMonthlyTable()
  );

  /** One row of the detail's financial overview, in the tone the old card had. */
  const financeRow = (
    tone: 'positive' | 'critical' | 'brand' | 'caution' | 'neutral',
    icon: LucideIcon,
    label: ReactNode,
    hint: ReactNode,
    amount: ReactNode,
  ) => {
    const Icon = icon;
    const fill = {
      positive: 'border-positive/30 bg-positive-soft',
      critical: 'border-critical/30 bg-critical-soft',
      brand: 'border-brand/30 bg-brand-soft',
      caution: 'border-caution/30 bg-caution-soft',
      neutral: 'border-line bg-sunken',
    }[tone];
    const text = {
      positive: 'text-positive',
      critical: 'text-critical',
      brand: 'text-brand-text',
      caution: 'text-caution',
      neutral: 'text-fg',
    }[tone];
    return (
      <div className={cn('flex items-center justify-between gap-3 rounded-surface border px-4 py-3', fill)}>
        <div className="flex min-w-0 items-center gap-3">
          <Icon aria-hidden className={cn('size-5 shrink-0', text)} />
          <div className="min-w-0">
            <p className={cn('text-sm font-semibold', text)}>{label}</p>
            {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
          </div>
        </div>
        <p className={cn('shrink-0 text-xl font-semibold tabular-nums', text)}>{amount}</p>
      </div>
    );
  };

  return (
    <div className="font-ui">
      <PageHeader title={t('nav.abrechnung')} description={t('abr.subtitle')} />

      <div className="grid grid-cols-1 gap-6">
        <Card className="flex flex-col gap-4 p-4 lg:flex-row lg:items-end lg:justify-between">
          <Tabs value={viewMode} onValueChange={value => setViewMode(value as ViewMode)}>
            <TabsList variant="segmented" aria-label={t('abr.viewMode')}>
              <TabsTrigger value="weekly">{t('abr.weekly')}</TabsTrigger>
              <TabsTrigger value="monthly">{t('abr.monthly')}</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
            {/* After a failed load, the driver and week choices are still the
                previous month's: they would offer that month's people and
                weeks under this month's name. */}
            {!loadFailed && (
              <Field label={t('common.driver')} className="col-span-2 sm:w-52">
                <Select value={selectedDriver} onValueChange={setSelectedDriver}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('common.allDrivers')}</SelectItem>
                    {drivers.map(driver => (
                      <SelectItem key={driver} value={driver}>
                        {driver}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {viewMode === 'weekly' && !loadFailed && (
              <Field label={t('common.week')} className="col-span-2 sm:w-40">
                <Select
                  value={String(selectedWeek)}
                  onValueChange={value => setSelectedWeek(value === 'all' ? 'all' : Number(value))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('abr.allWeeks')}</SelectItem>
                    {availableWeeks.map(week => (
                      <SelectItem key={week} value={String(week)}>
                        {getWeekLabel(week)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field label={t('common.month')} className="sm:w-40">
              <Select value={String(selectedMonth)} onValueChange={value => setSelectedMonth(Number(value))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES.map((month, idx) => (
                    <SelectItem key={idx} value={String(idx + 1)}>
                      {month}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('abr.year')} className="sm:w-28">
              <Select value={String(selectedYear)} onValueChange={value => setSelectedYear(Number(value))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[2024, 2025, 2026, 2027].map(year => (
                    <SelectItem key={year} value={String(year)}>
                      {year}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </Card>

        {content}
      </div>

      {/* The off-screen card below is the legacy markup, kept byte for byte:
          html2canvas renders it into the PNG that is shared, copied or
          downloaded, so its look is the document a driver receives. The dialog
          after it is the screen's view of the same figures. */}
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
                  {detailModalData.weekNumber === 0 ? `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}` : getWeekLabel(detailModalData.weekNumber)}
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
                        {t('abr.totalCashLabel', { period: detailModalData.weekNumber === 0 ? t('common.month') : t('abr.thisWeek') })}
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
                      <p style={{ fontSize: 11, color: isDark ? '#991b1b' : '#f87171', marginTop: 1 }}>{t('abr.belegeCount', { count: detailModalData.anzahlBelege })}</p>
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
                            {t('abr.difference')}
                          </p>
                          <p style={{ fontSize: 11, color: isDark ? (pos ? '#0c4a6e' : '#78350f') : (pos ? '#38bdf8' : '#fbbf24'), marginTop: 1 }}>
                            {t('abr.differenceHint')}
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

      <Dialog open={detailModalData !== null} onOpenChange={next => { if (!next) setDetailModalData(null); }}>
        {detailModalData && (
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>{t('abr.detailTitle')}</DialogTitle>
              <DialogDescription>
                {detailModalData.driverName} · {detailModalData.weekNumber === 0
                  ? `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`
                  : getWeekLabel(detailModalData.weekNumber)}
              </DialogDescription>
            </DialogHeader>

            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-surface border border-line bg-sunken px-4 py-3">
                <dt className="flex items-center gap-2 text-xs font-medium text-fg-muted">
                  <User aria-hidden className="size-4" />
                  {t('common.driver')}
                </dt>
                <dd className="mt-1 font-semibold text-fg">{detailModalData.driverName}</dd>
              </div>
              <div className="rounded-surface border border-line bg-sunken px-4 py-3">
                <dt className="flex items-center gap-2 text-xs font-medium text-fg-muted">
                  <Calendar aria-hidden className="size-4" />
                  {detailModalData.weekNumber === 0 ? t('common.month') : t('common.week')}
                </dt>
                <dd className="mt-1 font-semibold text-fg">
                  {detailModalData.weekNumber === 0
                    ? `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`
                    : getWeekLabel(detailModalData.weekNumber)}
                </dd>
              </div>
              <div className="rounded-surface border border-line bg-sunken px-4 py-3 sm:col-span-2">
                <dt className="flex items-center gap-2 text-xs font-medium text-fg-muted">
                  <CalendarRange aria-hidden className="size-4" />
                  {t('common.period')}
                </dt>
                <dd className="mt-1 font-semibold tabular-nums text-fg">
                  {detailModalData.weekStartDate} – {detailModalData.weekEndDate}
                </dd>
              </div>
            </dl>

            <section aria-labelledby="abr-finance" className="grid grid-cols-1 gap-2">
              <h3 id="abr-finance" className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                {t('abr.financialOverview')}
              </h3>
              {financeRow(
                'positive',
                DollarSign,
                t('abr.totalCash', { period: detailModalData.weekNumber === 0 ? t('common.month') : t('abr.thisWeek') }),
                t('bargeld.cashIncome'),
                euro(detailModalData.totalCash),
              )}
              {financeRow(
                'critical',
                ReceiptIcon,
                t('abr.belegCount'),
                t('abr.belegeCount', { count: detailModalData.anzahlBelege }),
                euro(detailModalData.sumBelege),
              )}
              {(() => {
                const pos = detailModalData.difference >= 0;
                return financeRow(
                  pos ? 'brand' : 'caution',
                  pos ? TrendingUp : TrendingDown,
                  t('abr.difference'),
                  t('abr.differenceHint'),
                  euro(detailModalData.difference),
                );
              })()}
              {(() => {
                const quote = calcTankenquote(detailModalData.tankenBrutto, detailModalData.umsatzNetto);
                return financeRow(
                  'neutral',
                  Fuel,
                  t('abr.tankenquote'),
                  null,
                  quote !== null ? formatPercent(quote) : '—',
                );
              })()}
            </section>

            <DialogFooter className="sm:justify-between">
              <div className="grid grid-cols-1 gap-2 sm:flex">
                <Button variant="secondary" onClick={handleShareToWhatsApp} disabled={isSharing}>
                  <Share2 aria-hidden />
                  {isSharing ? t('abr.creatingImage') : t('common.share')}
                </Button>
                <Button variant="secondary" onClick={handleCopyImage} disabled={isSharing}>
                  <Copy aria-hidden />
                  {isSharing ? t('abr.creatingImage') : t('common.copy')}
                </Button>
                <Button variant="secondary" onClick={handleDownloadImage} disabled={isSharing}>
                  <Download aria-hidden />
                  {isSharing ? t('abr.creatingImage') : t('common.download')}
                </Button>
              </div>
              <DialogClose asChild>
                <Button variant="ghost">{t('common.close')}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
