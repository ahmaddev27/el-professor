import { SimulatedNotice } from '../components/simulatedRides/SimulatedBadge';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download, FileSearch, Info, RotateCcw } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useAuth } from '../contexts/AuthContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { useAppAddressLocator } from '../hooks/useAppAddressLocator';
import { useTravelEstimator } from '../hooks/useTravelEstimator';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import { analysisTripFromRow, analyzeTrips } from '../utils/tripAnalysis';
import type { AnalysisTrip, TripAnalysisResult, TripRowForAnalysis } from '../utils/tripAnalysis/types';
import {
  confirmBudget,
  loadBudgets,
  loadCompanyDrivers,
  loadImports,
  loadSavedStundennachweise,
  loadSettings,
  loadTripRows,
  saveBaseLocation,
  saveReserve,
  saveSettings,
  type ImportSummary,
} from '../lib/tripAnalysisClient';
import { shiftsFromSavedStundennachweise, type SavedStundennachweisRecord } from '../lib/tripAnalysisShifts';
import {
  budgetInputs,
  driverTableRows,
  effectiveSettings,
  fareTotals,
  unlinkedDrivers,
  type BudgetRow,
  type CompanyDriver,
  type SettingsRow,
} from '../lib/tripAnalysisView';
import { downloadTripAnalysisReport } from '../utils/tripAnalysisReport';
import { TripAnalysisOverview } from '../components/tripAnalysis/TripAnalysisOverview';
import { TripAnalysisIssues } from '../components/tripAnalysis/TripAnalysisIssues';
import { TripAnalysisSettingsCard } from '../components/tripAnalysis/TripAnalysisSettingsCard';
import { TripAnalysisDriverView } from '../components/tripAnalysis/TripAnalysisDriverView';
import { ReturnCheckPanel } from '../components/tripAnalysis/returnCheck/ReturnCheckPanel';
import { EMPTY_BASE_FORM, baseFormFromSaved, savedBaseFrom, type BaseForm } from '../utils/returnCheckScreens';
import { TripEvidenceSheet, type TripEvidence } from '../components/tripAnalysis/TripEvidenceSheet';

/**
 * Fahrtenanalyse — the screen that explains a month of imported rides.
 *
 * ## The boundary, which is the whole point of this screen
 *
 * It **shows and explains**. There is no control here that assigns a trip to
 * another driver, changes a trip's date, time, price or currency, distributes
 * work to the owner, or fits hours to a salary target. Every trip it displays
 * is the row the import wrote, handed to the engine (`src/utils/tripAnalysis`)
 * and handed back untouched. The only three writes on this page are the
 * company's two analysis settings and, per driver and month, the reserve and
 * the explicit budget confirmation — none of which touches `fahrtenbuch_trips`.
 *
 * ## What it reads, and in what clock
 *
 * A ride's real start is `start_at` (slice A, migration 20260922100000), not
 * `trip_date` — which the Uber export dates a day early for a ride beginning
 * just after midnight. The engine's adapter reads the new columns where they
 * exist and derives the times from the old ones where they do not, so a month
 * imported before slice A still analyses. The recorded working time is the
 * saved Stundennachweis, converted to absolute Europe/Berlin intervals
 * (`lib/tripAnalysisShifts.ts`); there is no other working-time record.
 *
 * ## A failed read is never a zero
 *
 * Every load goes through one `loadFailed` state. While it is set the screen
 * shows the failure and nothing else — no counts, no table, no export — because
 * an empty month and a month whose read failed look identical and only one of
 * them is a claim about the company's data.
 */

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthParts(key: string): { year: number; month: number } | null {
  const match = MONTH_PATTERN.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year, month } : null;
}

export default function TripAnalysisPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { isAdmin } = useAuth();
  const scope = useCompanyScope();

  // `is_company_admin()` in the database: a company administrator, or a
  // platform account inside a support session. A read-only context writes
  // nothing, and the refusal trigger says so again on the server.
  const canEdit = !scope.readOnly && (isAdmin || scope.kind === 'support');

  const [monthKey, setMonthKey] = useState(currentMonthKey);
  const [importId, setImportId] = useState<string | null>(null);
  const [tab, setTab] = useState('overview');
  // The Rückkehrpflicht tab's Betriebssitz lives here: an inactive tab is unmounted, and the operator's entry must survive that.
  const [returnBase, setReturnBase] = useState<BaseForm>(EMPTY_BASE_FORM);
  const patchReturnBase = useCallback((patch: Partial<BaseForm>) => setReturnBase(current => ({ ...current, ...patch })), []);
  // Another company is another Betriebssitz: nothing typed for the previous one may carry over.
  useEffect(() => {
    setReturnBase(EMPTY_BASE_FORM);
  }, [companyId]);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<TripEvidence | null>(null);
  const [useTestDefault, setUseTestDefault] = useState(false);

  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [drivers, setDrivers] = useState<CompanyDriver[]>([]);
  const [settingsRow, setSettingsRow] = useState<SettingsRow | null>(null);
  const [tripRows, setTripRows] = useState<TripRowForAnalysis[]>([]);
  const [savedRecords, setSavedRecords] = useState<SavedStundennachweisRecord[]>([]);
  const [budgetRows, setBudgetRows] = useState<BudgetRow[]>([]);

  const [loadingCompany, setLoadingCompany] = useState(true);
  const [loadingMonth, setLoadingMonth] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * One counter per load, not one shared by both, so only the newest request of
   * *that* load may install its answer and a fast month change cannot be
   * overwritten.
   *
   * With a single counter the two effects cancelled each other whenever they ran
   * in the same commit — a retry (`reloadKey`), or a change of company while an
   * `importId` was still set. The company effect took a number, the month effect
   * then took the next one, and the company effect's own `finally` is guarded by
   * `request === requestRef.current`, so it never cleared `loadingCompany`. The
   * retry had already cleared `loadFailed`, which is the branch that carries the
   * retry button, so the screen fell through to the skeleton and stayed there
   * with nothing to press: only a page reload got out of it.
   */
  const companyRequestRef = useRef(0);
  const monthRequestRef = useRef(0);

  // Memoised so the effects below can name it: a fresh object each render
  // would re-run every load on every keystroke.
  const period = useMemo(() => monthParts(monthKey), [monthKey]);

  // ── The company's own rows: imports, drivers, settings ─────────────────────
  useEffect(() => {
    if (!companyId) {
      setLoadingCompany(false);
      return;
    }
    const request = ++companyRequestRef.current;
    setLoadingCompany(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const [importList, driverList, settings] = await Promise.all([
          loadImports(companyId),
          loadCompanyDrivers(companyId),
          loadSettings(companyId),
        ]);
        if (request !== companyRequestRef.current) return;
        setImports(importList);
        setDrivers(driverList);
        setSettingsRow(settings);
      } catch (error) {
        console.error('Fahrtenanalyse: loading the company failed', error);
        if (request !== companyRequestRef.current) return;
        setLoadFailed(true);
      } finally {
        if (request === companyRequestRef.current) setLoadingCompany(false);
      }
    })();
  }, [companyId, reloadKey]);

  const monthImports = useMemo(
    () => (period ? imports.filter(row => row.year === period.year && row.month === period.month) : []),
    [imports, period],
  );

  /**
   * The month opens on the newest Fahrtenbuch, not on today, and only until
   * somebody picks one: a fleet analyses the month it has just imported, and
   * the current month usually has no file yet. Once the month has been chosen
   * by hand the screen never moves it again, so a reload of the imports cannot
   * pull the reader off the month they are reading.
   */
  const monthChosen = useRef(false);
  useEffect(() => {
    if (monthChosen.current || imports.length === 0 || monthImports.length > 0) return;
    const newest = imports[0];
    setMonthKey(`${newest.year}-${String(newest.month).padStart(2, '0')}`);
  }, [imports, monthImports.length]);

  const chooseMonth = useCallback((value: string) => {
    monthChosen.current = true;
    setMonthKey(value);
  }, []);

  // The newest import of the chosen month, unless the chosen one is still in it.
  useEffect(() => {
    setImportId(previous => (previous && monthImports.some(row => row.id === previous) ? previous : monthImports[0]?.id ?? null));
  }, [monthImports]);

  // ── The month: trips, Stundennachweise, budgets ────────────────────────────
  useEffect(() => {
    if (!companyId || !period || !importId) {
      setTripRows([]);
      setSavedRecords([]);
      setBudgetRows([]);
      return;
    }
    const request = ++monthRequestRef.current;
    setLoadingMonth(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const [trips, saved, budgets] = await Promise.all([
          loadTripRows(companyId, importId),
          loadSavedStundennachweise(companyId, period.year, period.month),
          loadBudgets(companyId, period.year, period.month),
        ]);
        if (request !== monthRequestRef.current) return;
        setTripRows(trips);
        setSavedRecords(saved);
        setBudgetRows(budgets);
      } catch (error) {
        console.error('Fahrtenanalyse: loading the month failed', error);
        if (request !== monthRequestRef.current) return;
        // The rows on screen belong to the month before this one; keeping them
        // under the new month's name would be the worse of the two lies.
        setTripRows([]);
        setSavedRecords([]);
        setBudgetRows([]);
        setLoadFailed(true);
      } finally {
        if (request === monthRequestRef.current) setLoadingMonth(false);
      }
    })();
  }, [companyId, importId, period, reloadKey]);

  // ── The analysis ───────────────────────────────────────────────────────────
  const analysisTrips: AnalysisTrip[] = useMemo(() => tripRows.map(analysisTripFromRow), [tripRows]);
  const conversion = useMemo(() => shiftsFromSavedStundennachweise(savedRecords), [savedRecords]);
  const effective = useMemo(() => effectiveSettings(settingsRow, useTestDefault), [settingsRow, useTestDefault]);
  const savedReturnBase = useMemo(() => savedBaseFrom(settingsRow), [settingsRow]);
  // The saved base opens the form, unless the operator has already typed one in this visit.
  useEffect(() => {
    if (savedReturnBase) setReturnBase(current => (current.edited ? current : baseFormFromSaved(savedReturnBase)));
  }, [savedReturnBase]);

  // Undefined until there is something to measure with: the engine then uses
  // noRoutingEstimator and every travel check stays unverifiable. That is the case
  // while the travel_estimator flag is off (lib/addressLocator.ts says what turning
  // it on needs and costs), and it is the case for every ride whose addresses cannot
  // be placed at house level.
  const addressLocator = useAppAddressLocator();
  const travelEstimator = useTravelEstimator(analysisTrips, effective.settings, { locator: addressLocator });

  const analysis = useMemo<{ result: TripAnalysisResult | null; failed: boolean }>(() => {
    if (!effective.settings || tripRows.length === 0) return { result: null, failed: false };
    try {
      return {
        result: analyzeTrips({
          trips: analysisTrips,
          shifts: conversion.shifts,
          settings: effective.settings,
          budgets: budgetInputs(drivers, budgetRows),
          travelEstimator,
        }),
        failed: false,
      };
    } catch (error) {
      console.error('Fahrtenanalyse: the analysis failed', error);
      return { result: null, failed: true };
    }
  }, [analysisTrips, conversion.shifts, effective.settings, drivers, budgetRows, tripRows.length, travelEstimator]);

  const result = analysis.result;

  const driverRows = useMemo(
    () => (result ? driverTableRows(result, drivers, budgetRows) : []),
    [result, drivers, budgetRows],
  );
  const unlinked = useMemo(() => unlinkedDrivers(analysisTrips, drivers), [analysisTrips, drivers]);
  const fares = useMemo(() => (result ? fareTotals(result) : []), [result]);
  const tripsById = useMemo(
    () => new Map((result?.trips ?? []).map(analyzed => [analyzed.trip.id, analyzed])),
    [result],
  );
  const driverNames = useMemo(() => new Map(driverRows.map(row => [row.driverId, row.name])), [driverRows]);

  // The first driver of the table, until one is chosen.
  useEffect(() => {
    setSelectedDriverId(previous =>
      previous && driverRows.some(row => row.driverId === previous) ? previous : driverRows[0]?.driverId ?? null,
    );
  }, [driverRows]);

  const openDriver = useCallback((driverId: string) => {
    setSelectedDriverId(driverId);
    setTab('driver');
  }, []);

  // ── The four writes ────────────────────────────────────────────────────────

  const handleSaveSettings = useCallback(
    async (values: { blockGapMinutes: number | null; travelMarginMinutes: number | null }) => {
      if (!companyId) return false;
      try {
        setSettingsRow(await saveSettings(companyId, values));
        showToast('success', t('ta.settings.saved'));
        return true;
      } catch (error) {
        console.error('Fahrtenanalyse: saving the settings failed', error);
        showToast('error', t('ta.settings.saveFailed'));
        return false;
      }
    },
    [companyId, showToast, t],
  );

  const handleSaveBase = useCallback(
    async (base: { lat: number; lon: number }, radiusKm: number) => {
      if (!companyId) return false;
      try {
        setSettingsRow(await saveBaseLocation(companyId, base, radiusKm));
        showToast('success', t('returncheck.base.saveSucceeded'));
        return true;
      } catch (error) {
        console.error('Fahrtenanalyse: saving the Betriebssitz failed', error);
        showToast('error', t('returncheck.base.saveFailed'));
        return false;
      }
    },
    [companyId, showToast, t],
  );

  const replaceBudget = useCallback((row: BudgetRow) => {
    setBudgetRows(rows => [...rows.filter(existing => existing.driver_id !== row.driver_id), row]);
  }, []);

  const handleSaveReserve = useCallback(
    async (driverId: string, hours: number | null) => {
      if (!companyId || !period) return false;
      try {
        replaceBudget(await saveReserve(companyId, driverId, period.year, period.month, hours));
        showToast('success', t('ta.budget.reserveSaved'));
        return true;
      } catch (error) {
        console.error('Fahrtenanalyse: saving the reserve failed', error);
        showToast('error', t('ta.budget.failed'));
        return false;
      }
    },
    [companyId, period, replaceBudget, showToast, t],
  );

  const handleConfirmBudget = useCallback(
    async (driverId: string) => {
      if (!companyId || !period) return false;
      const existing = budgetRows.find(row => row.driver_id === driverId);
      try {
        replaceBudget(await confirmBudget(companyId, driverId, period.year, period.month, existing));
        showToast('success', existing?.confirmed_at ? t('ta.budget.recomputed.toast') : t('ta.budget.confirmed.toast'));
        return true;
      } catch (error) {
        console.error('Fahrtenanalyse: confirming the budget failed', error);
        showToast('error', t('ta.budget.failed'));
        return false;
      }
    },
    [companyId, period, budgetRows, replaceBudget, showToast, t],
  );

  const selectedImport = monthImports.find(row => row.id === importId) ?? null;

  const fileLabel = (row: ImportSummary) =>
    t('ta.fileOption', {
      name: row.file_name,
      date: new Date(row.imported_at).toLocaleDateString('de-DE'),
      count: row.row_count,
    });

  const handleExport = useCallback(() => {
    if (!result || !period || !selectedImport) return;
    downloadTripAnalysisReport({
      t,
      result,
      settings: effective,
      driverRows,
      month: period.month,
      year: period.year,
      fileName: selectedImport.file_name,
      generatedAtMs: Date.now(),
      simulated: selectedImport.is_simulated === true,
    });
    showToast('success', t('ta.exported'));
  }, [result, period, selectedImport, effective, driverRows, showToast, t]);

  const loading = loadingCompany || loadingMonth;

  // ── What the body shows ────────────────────────────────────────────────────

  let body: ReactNode;
  if (loadFailed) {
    body = (
      <Alert
        tone="critical"
        title={t('ta.loadFailed')}
        action={
          <Button variant="secondary" size="sm" onClick={() => setReloadKey(key => key + 1)}>
            <RotateCcw aria-hidden />
            {t('ta.retry')}
          </Button>
        }
      >
        {t('ta.loadFailedBody')}
      </Alert>
    );
  } else if (loading) {
    body = (
      <div className="grid grid-cols-1 gap-4" aria-busy>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Card key={index} className="p-5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-7 w-32" />
            </Card>
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  } else if (monthImports.length === 0) {
    body = (
      <EmptyState
        icon={FileSearch}
        title={t('ta.noImports.title')}
        description={t('ta.noImports.body')}
        action={
          <Button variant="secondary" asChild>
            <Link to="/fahrtenbuch">{t('ta.noImports.action')}</Link>
          </Button>
        }
      />
    );
  } else if (!effective.settings) {
    // The settings card above already says what is missing and offers the
    // clearly labelled test value; nothing is computed until one of the two.
    body = <Alert tone="caution" title={t('ta.settings.missingTitle')}>{t('ta.settings.missingBody')}</Alert>;
  } else if (analysis.failed) {
    body = <Alert tone="critical" title={t('ta.analysisFailed')}>{t('ta.loadFailedBody')}</Alert>;
  } else if (!result) {
    body = <EmptyState icon={FileSearch} title={t('ta.drivers.empty')} />;
  } else {
    body = (
      <Tabs value={tab} onValueChange={setTab} className="grid grid-cols-1 gap-4">
        <TabsList aria-label={t('ta.title')}>
          <TabsTrigger value="overview">{t('ta.tab.overview')}</TabsTrigger>
          <TabsTrigger value="driver">{t('ta.tab.driver')}</TabsTrigger>
          <TabsTrigger value="issues">{t('ta.tab.issues')}</TabsTrigger>
          <TabsTrigger value="returncheck">{t('returncheck.tab')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <TripAnalysisOverview
            result={result}
            driverRows={driverRows}
            unlinked={unlinked}
            fares={fares}
            onShowTrips={setEvidence}
            onOpenDriver={openDriver}
          />
        </TabsContent>
        <TabsContent value="driver">
          <TripAnalysisDriverView
            result={result}
            shifts={conversion.shifts}
            driverRows={driverRows}
            drivers={drivers}
            budgetRows={budgetRows}
            selectedDriverId={selectedDriverId}
            onSelectDriver={setSelectedDriverId}
            canEdit={canEdit}
            onSaveReserve={handleSaveReserve}
            onConfirmBudget={handleConfirmBudget}
            onShowTrips={setEvidence}
          />
        </TabsContent>
        <TabsContent value="issues">
          <TripAnalysisIssues issues={result.issues} driverNames={driverNames} onShowTrips={setEvidence} />
        </TabsContent>
        <TabsContent value="returncheck">
          <ReturnCheckPanel
            tripRows={tripRows}
            blockGapMinutes={effective.settings.blockGapMinutes}
            baseForm={returnBase}
            onBaseForm={patchReturnBase}
            savedBase={savedReturnBase}
            canSave={canEdit}
            onSaveBase={handleSaveBase}
          />
        </TabsContent>
      </Tabs>
    );
  }

  return (
    <div className="font-ui">
      <PageHeader
        title={t('ta.title')}
        description={t('ta.description')}
        actions={
          <>
            <Input
              type="month"
              value={monthKey}
              onChange={event => chooseMonth(event.target.value)}
              aria-label={t('ta.month')}
              className="w-44"
            />
            <Button
              variant="secondary"
              onClick={handleExport}
              disabled={!result || loadFailed || loading}
              title={t('ta.exportHint')}
            >
              <Download aria-hidden />
              {t('ta.exportReportShort')}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4">
        <Alert tone="neutral" icon={Info} role="note">
          {t('ta.boundary')}
        </Alert>
        {scope.readOnly ? <Alert tone="caution">{t('ta.readOnly')}</Alert> : null}
        {selectedImport?.is_simulated ? <SimulatedNotice /> : null}

        {/* Which file the figures come from is part of the claim, so it is
            named whether or not there is a second one to choose from. */}
        {!loadFailed && selectedImport ? (
          monthImports.length > 1 ? (
            <Field label={t('ta.file')}>
              <NativeSelect
                value={importId ?? ''}
                onChange={event => setImportId(event.target.value || null)}
                containerClassName="max-w-xl"
              >
                {monthImports.map(row => (
                  <option key={row.id} value={row.id}>
                    {fileLabel(row)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : (
            <p className="text-sm text-fg-muted">
              <span className="font-medium text-fg">{t('ta.file')}: </span>
              {fileLabel(selectedImport)}
            </p>
          )
        ) : null}

        <TripAnalysisSettingsCard
          row={settingsRow}
          effective={effective}
          canEdit={canEdit}
          onSave={handleSaveSettings}
          onUseTestDefault={setUseTestDefault}
        />

        {!loadFailed && conversion.unreadable > 0 ? (
          <Alert tone="caution">{t('ta.shiftsUnreadable', { count: conversion.unreadable })}</Alert>
        ) : null}
        {!loadFailed && conversion.dstAdjusted > 0 ? (
          <Alert tone="neutral">{t('ta.shiftsDst', { count: conversion.dstAdjusted })}</Alert>
        ) : null}

        {body}
      </div>

      <TripEvidenceSheet evidence={evidence} tripsById={tripsById} onClose={() => setEvidence(null)} />
    </div>
  );
}
