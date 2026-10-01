import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  FileText,
  Info,
  RotateCw,
  Users,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  cn,
  formatEuroCents,
  formatNumber,
  type DataTableColumn,
} from '../components/ui';
import { supabase } from '../lib/supabase';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import MonatsplanungDriverPool, { type PlanningDriver } from '../components/MonatsplanungDriverPool';
import MonthlyPlanDocumentsStep from '../components/MonthlyPlanDocumentsStep';
import { DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES } from '../utils/monatsplanungPhase3';
import {
  assignBlocks,
  buildAvailability,
  buildBlocks,
  validatePlan,
  type AssignResult,
  type AvailabilityResult,
  type PlanBlock,
  type PlanDriverInput,
  type PlanNote,
  type PlanTripInput,
  type PlanViolation,
  type RejectedTrip,
  type ValidationResult,
  type VehicleOverlap,
} from '../utils/monthlyPlan';
import {
  buildPlanSummaryRows,
  groupWarnings,
  notesQueryFromDate,
  plannableMonths,
  type PlanImportRow,
  type PlanRowStatus,
  type PlanSummaryRow,
} from '../utils/monthlyPlanScreens';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { storedPlanFromGenerated } from '../utils/monthlyPlanDocuments';
import {
  savePlanAndConfirm,
  type ConfirmResult,
  type MonthlyPlanConfirmReason,
} from '../utils/monthlyPlanPersistence';

/**
 * One sentence per refusal, because each one tells the operator something
 * different about what to do next: a role that may not edit Dokumente, a company
 * whose state forbids it, a plan whose data moved under it, a rule it breaks.
 * Collapsing them into "saving failed" would throw away the only part that is
 * actionable. `plan_exists` is absent on purpose — it is a choice, not an error,
 * and it is rendered as one.
 */
const SAVE_REASON_KEYS: Partial<Record<MonthlyPlanConfirmReason, TranslationKey>> = {
  unauthenticated:        'mplan.save.reason.unauthenticated',
  no_company:             'mplan.save.reason.noCompany',
  not_authorized:         'mplan.save.reason.notAuthorized',
  invalid_payload:        'mplan.save.reason.invalidPayload',
  monthly_plan_rows_lost: 'mplan.save.reason.rowsLost',
  network:                'mplan.save.reason.network',
  plan_not_found:         'mplan.save.reason.planNotFound',
  not_a_draft:            'mplan.save.reason.notADraft',
  plan_empty:             'mplan.save.reason.planEmpty',
  driver_not_in_plan:     'mplan.save.reason.driverNotInPlan',
  driver_overlap:         'mplan.save.reason.driverOverlap',
  vehicle_switch_gap:     'mplan.save.reason.switchGap',
  no_usable_range:        'mplan.save.reason.noUsableRange',
  exceeds_hours_cap:      'mplan.save.reason.exceedsCap',
};

/**
 * The monthly plan, as the four screens §1 asks for (acceptance criteria 1–4,
 * 13, 14).
 *
 * ## The rule this file preserves, and it is the only one it has
 *
 * **It decides nothing about planning.** Every block boundary, every constraint,
 * every hours figure, every status and every finding comes from
 * `src/utils/monthlyPlan/` — the five engine modules of §15 — and everything the
 * screen derives from them is in `src/utils/monthlyPlanScreens.ts`, which is
 * tested without a renderer. A screen that recomputes a figure is how a screen
 * and a document come to disagree about the same month, which is the whole
 * reason the engine is a separate, pure layer.
 *
 * Two consequences worth stating, because they are easy to undo:
 *
 *   - **The plan works from salaries, not hours** (owner's decision,
 *     01.10.2026). Neither `drivers.target_monthly_hours` nor
 *     `drivers.max_monthly_hours` is read: a driver's range is
 *     `min_salary / hourly_rate` to `max_salary / hourly_rate` and nothing
 *     narrows it. `PlanDriverInput` has no field for either, so this file cannot
 *     pass one even by accident, and there is deliberately no `Monatsziel`
 *     column and no explicit-cap marker.
 *   - **Nothing here writes `fahrtenbuch_trips`.** This plans a month as a
 *     proposal; §2's "create a planning representation and leave the original
 *     data alone" is satisfied by never issuing a write at all. The rides are
 *     read once, mapped into the engine's `PlanTripInput`, and that is the end
 *     of it.
 *
 * ## Why four screens and not `CompanyPlannerPage`'s five sections
 *
 * `CompanyPlannerPage`'s `new_month` mode is five progressive sections on one
 * scrolling page with no step navigation. It keeps working, untouched, for its
 * own pipeline (phases 1/3/4, a different block rule and a different owner
 * model). This is the requirement's own shape, and it closes three specific
 * gaps: the month list is built from the imports that exist rather than from a
 * static grid of twelve months times three years; the switch duration sits with
 * the drivers, where §1 puts it, instead of with the month; and the driver
 * selection has a confirm button instead of being a live set that re-plans on
 * every click.
 *
 * ## A figure from a read that failed is never shown
 *
 * Four reads feed a plan: the imports, the rides, the planning notes, and the
 * two driver columns the pool does not map. Each has its own failure flag, and
 * **a plan is not generated at all while any of them is set** — including the
 * two that would only change the outcome quietly rather than visibly:
 *
 *   - the notes, because a plan built without them can put a driver marked sick
 *     on a block, and a summary with no warning would be a claim that it did not;
 *   - `planning_priority` and `can_cover_other_drivers`, because they are the
 *     engine's tie-break and its coverage preference, so a plan built without
 *     them is a different plan with nothing on screen saying so.
 *
 * Once a plan exists it is entirely in memory, so nothing on screens 3 and 4
 * depends on a further read.
 */

/** 1–12, resolved by the caller: this list is module-level and `t` is a hook. */
const MONTH_KEYS: TranslationKey[] = [
  'doc.month.january', 'doc.month.february', 'doc.month.march', 'doc.month.april',
  'doc.month.may', 'doc.month.june', 'doc.month.july', 'doc.month.august',
  'doc.month.september', 'doc.month.october', 'doc.month.november', 'doc.month.december',
];

/** PostgREST caps a request at 1000 rows, so every list read is a batch loop. */
const BATCH_SIZE = 1000;

const STEP_KEYS: TranslationKey[] = ['mplan.step1', 'mplan.step2', 'mplan.step3', 'mplan.step4'];

/** How many violations are listed before the rest are only counted. */
const VIOLATIONS_SHOWN = 10;

/**
 * §1's statuses plus `no_range`, which the requirement's six do not cover: a
 * driver whose rate or salary bounds are unusable has an unknown position, and
 * showing that as "below target" would invite somebody to hand them hours to fix
 * a number that was never computed (§14 wants the configuration error visible).
 */
const STATUS_KEYS: Record<PlanRowStatus, TranslationKey> = {
  in_range: 'mplan.status.inRange',
  below: 'mplan.status.below',
  above_cap: 'mplan.status.aboveCap',
  has_conflict: 'mplan.status.hasConflict',
  owner: 'mp.pool.owner',
  no_hours: 'mplan.status.noHours',
  no_range: 'mplan.status.noRange',
};

type StatusTone = 'neutral' | 'brand' | 'positive' | 'caution' | 'critical';

const STATUS_TONES: Record<PlanRowStatus, StatusTone> = {
  in_range: 'positive',
  below: 'caution',
  above_cap: 'critical',
  has_conflict: 'critical',
  owner: 'brand',
  no_hours: 'caution',
  no_range: 'caution',
};

/**
 * Every hard rule `validate.ts` can report broken. The rule gets a label; its
 * `detail` is printed beside it untranslated, because the engine writes that in
 * English with no message key and a violation is an engine-defect surface — the
 * assigner cannot produce one, so the block and driver ids in it are what
 * somebody would diagnose from. Translating the label without the detail is the
 * honest half: the operator learns which rule broke, and the detail stays exact.
 */
const VIOLATION_KEYS: Record<PlanViolation['rule'], TranslationKey> = {
  block_assigned_twice: 'mplan.violation.blockAssignedTwice',
  unknown_block: 'mplan.violation.unknownBlock',
  driver_not_in_pool: 'mplan.violation.driverNotInPool',
  driver_overlap: 'mplan.violation.driverOverlap',
  exceeds_hours_cap: 'mplan.violation.exceedsHoursCap',
  assigned_inside_exclusion: 'mplan.violation.assignedInsideExclusion',
  vehicle_switch_gap: 'mplan.violation.vehicleSwitchGap',
  pin_ignored: 'mplan.violation.pinIgnored',
};

/** Every warning kind `validate.ts` can produce. A kind with no label is a bug. */
const WARNING_KEYS: Record<string, TranslationKey> = {
  unassigned_block: 'mplan.warn.unassignedBlock',
  unmet_mandatory_note: 'mplan.warn.unmetMandatoryNote',
  note_conflict: 'mplan.warn.noteConflict',
  contested_block: 'mplan.warn.contestedBlock',
  pin_conflict: 'mplan.warn.pinConflict',
  rejected_trip: 'mplan.warn.rejectedTrip',
  source_overlap: 'mplan.warn.sourceOverlap',
};

/** The rides the engine reads, and the original driver kept for the suggestion. */
interface PlanTripRow {
  id: string;
  car_id: string | null;
  car_identifier: string | null;
  start_at: string | null;
  end_at: string | null;
  trip_date: string;
  start_time: string | null;
  end_time: string | null;
  is_canceled: boolean | null;
  original_driver_name: string | null;
  original_driver_id: string | null;
}

/** The two planning columns `mapDriverRow` in the pool does not carry. */
interface DriverPlanExtras {
  id: string;
  planning_priority: number | null;
  can_cover_other_drivers: boolean | null;
}

/**
 * Everything one generated plan holds. Replaced whole, never patched.
 *
 * `drivers` is §13's snapshot — "save a snapshot of the driver values used in the
 * plan so later edits to the driver profile do not change an old plan's meaning".
 * Here it is a snapshot in memory, which is what makes "regenerate" honest: it
 * re-runs the assigner against the very salary, rate and cap the summary on
 * screen was computed from, not against whatever the drivers table says now. The
 * save step turns it into a stored snapshot.
 */
interface GeneratedPlan {
  blocks: PlanBlock[];
  availability: AvailabilityResult;
  result: AssignResult;
  validation: ValidationResult;
  drivers: PlanDriverInput[];
  rejected: RejectedTrip[];
  overlaps: VehicleOverlap[];
  canceledCount: number;
  /** Rides read from the import, before anything was rejected or cancelled. */
  tripCount: number;
  switchMinutes: number;
  seed: number;
}

/**
 * Reads every row of a query in 1000-row batches.
 *
 * The caller awaits the query itself and hands back the plain answer, so no
 * PostgREST builder type crosses this boundary. A batch that comes back with an
 * error, or with no data at all, **throws** — the caller's catch then sets that
 * read's own failure flag. Treating a failed batch as "the end of the list"
 * would return a silently truncated month, which is the worst outcome here:
 * every figure downstream would be plausible and wrong.
 */
async function fetchAll<Row>(
  page: (from: number, to: number) => Promise<{ data: unknown[] | null; error: unknown }>,
): Promise<Row[]> {
  const all: Row[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await page(offset, offset + BATCH_SIZE - 1);
    if (error || !data) throw error ?? new Error('read returned no rows');
    all.push(...(data as Row[]));
    if (data.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return all;
}

/** Decimal hours, German, two places. Never fed back into arithmetic. */
function hoursText(value: number | null | undefined): string {
  return value == null ? '—' : formatNumber(value, 2);
}

/** A signed deviation, with the sign spelled out when there is a surplus. */
function deviationText(value: number | null | undefined): string {
  if (value == null) return '—';
  const text = formatNumber(value, 2);
  return value > 0 ? `+${text}` : text;
}

export default function MonthlyPlanPage() {
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { can } = useCompanyScope();
  const { t } = useTranslation();

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  /*
   * Saving, which until now did not happen at all.
   *
   * `20260930100000` shipped the four tables, both RPCs, the partial unique
   * index that enforces one confirmed plan per month and an advisory lock — and
   * nothing called them. So this screen said *Planung fertig* over a
   * `monthly_plans` table holding zero rows, §10's planned Fahrtenbuch could
   * never be built (it reads the import's original rows through a saved plan's
   * id), and the one-plan-per-month rule applied to nothing.
   *
   * `saveState` is `null` until the operator confirms. A refusal keeps the draft
   * id so the replace choice acts on **that** draft rather than writing a second
   * one, and `pendingReplace` is what the §9 dialog is waiting on.
   */
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<(ConfirmResult & { planId?: string }) | null>(null);
  const [pendingReplace, setPendingReplace] = useState<string | null>(null);
  /**
   * The id the database gave this plan, which the documents need.
   *
   * `storedPlanFromGenerated` always answers `id: null` and `status: 'draft'`,
   * and rightly: it projects a plan that exists only in memory and cannot invent
   * an id. But without carrying the id back, the documents step would receive a
   * saved plan still claiming to be unsaved, and **§10's Fahrtenbuch would go on
   * refusing** — it builds from the import's original rows reached through a
   * saved plan's id, so `null` there is the same refusal as never having saved.
   * The browser walk on staging was written to catch exactly this, and did.
   */
  const [savedPlanId, setSavedPlanId] = useState<string | null>(null);

  /**
   * The company's own name for the payroll summary's letterhead.
   *
   * `legal_company_name` first: that document goes to a Steuerberater, who needs
   * the registered name rather than the trading one. The plan itself carries no
   * name — the §13 snapshot is about drivers — so this is the one figure on
   * those documents that does not come from it, and it is passed in rather than
   * fetched inside a builder, which reads the stored plan and nothing else.
   */
  const { settings: companySettings } = useCompanySettings();
  const companyName =
    companySettings?.legal_company_name?.trim() || companySettings?.company_name?.trim() || undefined;
  const [plan, setPlan] = useState<GeneratedPlan | null>(null);

  // ── Screen 1: the imports, and the months they make plannable ─────────────
  const [importRows, setImportRows] = useState<PlanImportRow[] | null>(null);
  const [importsLoading, setImportsLoading] = useState(false);
  const [importsFailed, setImportsFailed] = useState(false);
  const [monthKey, setMonthKey] = useState('');
  const [importId, setImportId] = useState('');

  useEffect(() => {
    if (!companyId) {
      setImportRows(null);
      return;
    }
    let cancelled = false;
    setImportsLoading(true);
    setImportsFailed(false);
    (async () => {
      try {
        const { data, error } = await supabase
          .from('fahrtenbuch_imports')
          .select('id, month, year, file_name, imported_at, row_count, status')
          .eq('company_id', companyId)
          .order('imported_at', { ascending: false });
        // postgrest-js reports a refusal and an unreachable database the same
        // way, as `{ data: null, error }`, so this one branch covers both.
        if (error || !data) throw error ?? new Error('no rows');
        if (!cancelled) setImportRows(data as PlanImportRow[]);
      } catch {
        if (!cancelled) {
          // An empty list would read as "no month can be planned", which is a
          // claim. The failure is shown instead and no month is offered.
          setImportRows(null);
          setImportsFailed(true);
        }
      } finally {
        if (!cancelled) setImportsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const plannable = useMemo(
    () => (importRows ? plannableMonths(importRows) : null),
    [importRows],
  );

  const selectedMonth = useMemo(
    () => plannable?.months.find(m => m.key === monthKey) ?? null,
    [plannable, monthKey],
  );

  // The newest month and its newest import, and only while the operator has not
  // chosen: a choice that is still valid is never overwritten.
  useEffect(() => {
    if (!plannable || plannable.months.length === 0) return;
    if (plannable.months.some(m => m.key === monthKey)) return;
    setMonthKey(plannable.months[0].key);
  }, [plannable, monthKey]);

  useEffect(() => {
    if (!selectedMonth) return;
    if (selectedMonth.imports.some(i => i.id === importId)) return;
    setImportId(selectedMonth.imports[0].id);
  }, [selectedMonth, importId]);

  const monthLabel = useCallback(
    (year: number, month: number) => `${t(MONTH_KEYS[month - 1])} ${year}`,
    [t],
  );

  const selectedImport = useMemo(
    () => selectedMonth?.imports.find(i => i.id === importId) ?? null,
    [selectedMonth, importId],
  );

  // ── Screen 1 → 2: the rides of the chosen import ──────────────────────────
  const [trips, setTrips] = useState<PlanTripRow[] | null>(null);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [tripsFailed, setTripsFailed] = useState(false);

  const loadTrips = async () => {
    if (!companyId || !importId) return;
    setTripsLoading(true);
    setTripsFailed(false);
    setTrips(null);
    setPlan(null);
    try {
      const rows = await fetchAll<PlanTripRow>(async (from, to) =>
        await supabase
          .from('fahrtenbuch_trips')
          .select(
            'id, car_id, car_identifier, start_at, end_at, trip_date, start_time, end_time, is_canceled, original_driver_name, original_driver_id',
          )
          .eq('company_id', companyId)
          .eq('import_id', importId)
          .order('id', { ascending: true })
          .range(from, to),
      );
      setTrips(rows);
      setStep(2);
    } catch {
      // No rides means no plan, and the screen says which read failed rather
      // than moving on to a driver list that could plan nothing.
      setTripsFailed(true);
    } finally {
      setTripsLoading(false);
    }
  };

  // §1: the drivers already in the Fahrtenbuch are pre-selected as a suggestion.
  // The pool does the matching itself, by id or normalised name; this only hands
  // it what the file says.
  const originalDriverNames = useMemo(
    () => [...new Set((trips ?? []).map(r => r.original_driver_name ?? '').filter(Boolean))],
    [trips],
  );
  const originalDriverIds = useMemo(
    () => [...new Set((trips ?? []).map(r => r.original_driver_id ?? '').filter(Boolean))],
    [trips],
  );

  // ── Screen 2: the drivers, and the switch duration §1 puts beside them ────
  const [selectedDriverIds, setSelectedDriverIds] = useState<Set<string>>(new Set());
  const [poolDrivers, setPoolDrivers] = useState<PlanningDriver[]>([]);
  const [switchText, setSwitchText] = useState(String(DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES));

  // 0 is a legal switch duration and means "split at every gap" (§3 asks for the
  // shortest blocks), so it is not read as "unset".
  const switchMinutes = useMemo(() => {
    const text = switchText.trim();
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : null;
  }, [switchText]);

  const [generating, setGenerating] = useState(false);
  const [notesFailed, setNotesFailed] = useState(false);
  const [extrasFailed, setExtrasFailed] = useState(false);

  // Any change to the inputs a plan was built from invalidates it, so screen 3
  // can never show a summary of a selection or a switch duration other than the
  // one screen 2 currently holds.
  useEffect(() => {
    setPlan(null);
  }, [selectedDriverIds, switchMinutes]);

  const generate = async (seed: number) => {
    if (!companyId || !trips || !selectedMonth) return;
    setGenerating(true);
    setNotesFailed(false);
    setExtrasFailed(false);
    try {
      const monthFirstDay = `${selectedMonth.year}-${String(selectedMonth.month).padStart(2, '0')}-01`;
      // One day before the earliest ride in the import — see
      // `notesQueryFromDate`, which is where that bound is derived and tested.
      const notesFrom = notesQueryFromDate(
        trips.map(r => r.trip_date),
        monthFirstDay,
      );

      // Both note behaviours, which is the gap §6 names: the existing pipeline
      // filters `exclude_from_plan` server-side, so a mandatory inclusion never
      // reaches it and the contradiction between the two cannot be observed.
      // `car_id` has been on the table since 20260928120000 and narrows a
      // mandatory claim to one vehicle's blocks.
      //
      // The date bound is one-sided on purpose: a note whose `end_date` is set
      // ends its window there (`noteExclusionIntervals`: `endDate = end_date ??
      // startDate`), so one that ended before the first day a block can touch
      // cannot overlap this month. A note with no `end_date` is fetched whatever
      // its dates say and left for the engine. Too wide only costs rows; too
      // narrow drops a constraint silently, which is the wrong direction to be
      // wrong in. `buildAvailability` decides by window overlap, on instants.
      let notes: PlanNote[];
      try {
        notes = await fetchAll<PlanNote>(async (from, to) =>
          await supabase
            .from('driver_notes')
            .select(
              'id, driver_id, note_type, note_text, note_planning_behavior, is_full_day, start_date, end_date, note_date, start_time, end_time, car_id',
            )
            .eq('company_id', companyId)
            .neq('note_planning_behavior', 'neutral')
            .or(`end_date.is.null,end_date.gte.${notesFrom}`)
            .order('id', { ascending: true })
            .range(from, to),
        );
      } catch {
        setNotesFailed(true);
        return;
      }

      // The pool's `mapDriverRow` does not carry these two, and the pool is
      // reused unchanged (§1), so they are read here rather than by widening it.
      let extras: DriverPlanExtras[];
      try {
        extras = await fetchAll<DriverPlanExtras>(async (from, to) =>
          await supabase
            .from('drivers')
            .select('id, planning_priority, can_cover_other_drivers')
            .eq('company_id', companyId)
            .order('id', { ascending: true })
            .range(from, to),
        );
      } catch {
        setExtrasFailed(true);
        return;
      }
      const extraById = new Map(extras.map(e => [e.id, e]));

      const engineTrips: PlanTripInput[] = trips.map(r => ({
        id: r.id,
        vehicleId: r.car_id,
        vehicleIdentifier: r.car_identifier,
        startAt: r.start_at,
        endAt: r.end_at,
        tripDate: r.trip_date,
        startTime: r.start_time,
        endTime: r.end_time,
        isCanceled: r.is_canceled ?? false,
        originalDriverName: r.original_driver_name,
        originalDriverId: r.original_driver_id,
      }));

      const engineDrivers: PlanDriverInput[] = poolDrivers
        .filter(d => selectedDriverIds.has(d.id))
        .map(d => {
          const extra = extraById.get(d.id);
          return {
            id: d.id,
            name: d.name,
            isOwner: d.employment_type === 'company_owner',
            minSalary: d.planning_min_salary,
            maxSalary: d.planning_max_salary,
            hourlyRate: d.planning_hourly_rate,
            planningPriority: extra?.planning_priority ?? null,
            canCoverOtherDrivers: extra?.can_cover_other_drivers ?? null,
          };
        });

      const minutes = switchMinutes ?? 0;
      const built = buildBlocks(engineTrips, { switchMinutes: minutes });
      const availability = buildAvailability(notes, built.blocks, selectedDriverIds);
      const result = assignBlocks(built.blocks, engineDrivers, availability, {
        switchMinutes: minutes,
        seed,
      });
      const validation = validatePlan({
        blocks: built.blocks,
        drivers: engineDrivers,
        availability,
        result,
        switchMinutes: minutes,
        rejectedTrips: built.rejected,
        sourceOverlaps: built.overlaps,
      });

      setPlan({
        blocks: built.blocks,
        availability,
        result,
        validation,
        drivers: engineDrivers,
        rejected: built.rejected,
        overlaps: built.overlaps,
        canceledCount: built.canceledCount,
        tripCount: trips.length,
        switchMinutes: minutes,
        seed,
      });
      setStep(3);
    } finally {
      setGenerating(false);
    }
  };

  /**
   * §1's regenerate: same month, same drivers, same switch duration, same rules.
   * Nothing is re-read and the blocks and the availability are reused, so the
   * only thing that moves is the seed — which `assign.ts` lets reach the
   * tie-break between candidates that already passed every hard rule, and
   * nothing else (§7 rule 9, criterion 14).
   */
  const regenerate = () => {
    if (!plan) return;
    // A regenerated plan is a different assignment, so the saved plan's id no
    // longer describes what is on screen. Clearing it sends the documents back
    // to reading an unsaved draft until the operator confirms again — without
    // this they would be built from one assignment and labelled with another's
    // id, and §10's Fahrtenbuch would silently overlay the wrong drivers.
    setSavedPlanId(null);
    setSaveState(null);
    setPendingReplace(null);
    const seed = plan.seed + 1;
    const result = assignBlocks(plan.blocks, plan.drivers, plan.availability, {
      switchMinutes: plan.switchMinutes,
      seed,
    });
    const validation = validatePlan({
      blocks: plan.blocks,
      drivers: plan.drivers,
      availability: plan.availability,
      result,
      switchMinutes: plan.switchMinutes,
      rejectedTrips: plan.rejected,
      sourceOverlaps: plan.overlaps,
    });
    setPlan({ ...plan, result, validation, seed });
  };

  const summaryRows = useMemo(
    () => (plan ? buildPlanSummaryRows(plan.result, plan.validation) : []),
    [plan],
  );
  const warningGroups = useMemo(() => (plan ? groupWarnings(plan.validation) : []), [plan]);

  const mayConfirm = can('documents', 'edit');
  const confirmable = plan?.validation.confirmable === true && mayConfirm;

  const pricedRows = useMemo(
    () => summaryRows.filter(r => r.estimatedSalaryCents != null),
    [summaryRows],
  );

  // ── Screen 3 → 4: the plan in the shape the three documents read ──────────
  //
  // §12 and criterion 22: every total in every document comes from one plan. The
  // projection is column for column the four tables of
  // `20260930100000_monthly_plan.sql`, so when §9's save and confirm step is
  // wired this screen reads those rows back and hands the **same object** to the
  // same builders — the documents do not change. Handing them the engine's
  // `PlanBlock[]` instead would have to be rewritten then, and a rewritten
  // document contract is how one document comes to have two builders, which is
  // the defect the existing Stundennachweis pipeline already has.
  //
  // `PlanBlockTrip` carries the original driver's name but not the id, so the id
  // cannot be recovered from the blocks; §2 asks for it to be kept, so it comes
  // from the rides this plan was built from. `loadTrips` clears the plan, and any
  // change to the selection or the switch duration clears it too, so `trips` and
  // `plan` can never describe two different months.
  const originalDriverIdByTrip = useMemo(
    // `as const` makes each entry a tuple; without it `.map` infers
    // `(string | null)[]` and the Map constructor does not accept it.
    () => new Map((trips ?? []).map(r => [r.id, r.original_driver_id] as const)),
    [trips],
  );

  const storedPlan = useMemo(() => {
    if (!plan || !selectedMonth || !companyId) return null;
    const projected = storedPlanFromGenerated({
      companyId,
      year: selectedMonth.year,
      month: selectedMonth.month,
      importId: importId || null,
      switchMinutes: plan.switchMinutes,
      generation: plan.seed,
      blocks: plan.blocks,
      drivers: plan.drivers,
      result: plan.result,
      warnings: plan.validation.warnings,
      selectedDriverIds,
      originalDriverIdByTrip,
    });
    // Saved and confirmed, or not yet — and the documents must be told which.
    // A plan with no id is a true draft and every document should see it as one.
    return savedPlanId
      ? { ...projected, id: savedPlanId, status: 'confirmed' as const }
      : projected;
  }, [plan, selectedMonth, companyId, importId, selectedDriverIds, originalDriverIdByTrip,
      savedPlanId]);

  /**
   * Writes the plan and confirms it, then moves to the documents.
   *
   * Two RPC calls and not one, because they are two transactions by design: the
   * save takes the month's advisory lock, writes and releases it, and the
   * confirm takes it again to re-derive §7's rules against the **stored** rows
   * rather than against whatever this page still holds. That second check is the
   * one the confirm button's own comment says still has to happen.
   *
   * The screen does not advance on a refusal. `plan_exists` is the one refusal
   * with a choice behind it (§9's "replace the month's plan?"), so it opens that
   * dialog instead of reporting an error.
   */
  const saveAndConfirm = useCallback(async (replace: boolean) => {
    if (!storedPlan) return;
    setSaving(true);
    setPendingReplace(null);
    try {
      const result = await savePlanAndConfirm(supabase, storedPlan, { replace });
      setSaveState(result);
      if (result.ok) {
        setSavedPlanId(result.planId);
        setStep(4);
      } else if (result.reason === 'plan_exists' && result.planId) {
        setPendingReplace(result.planId);
      }
    } finally {
      setSaving(false);
    }
  }, [storedPlan]);

  /**
   * Every read a plan depends on. The four are already the condition for a plan
   * existing at all, so on screen 4 they are false by construction — passing them
   * anyway is what keeps the rule ("a figure whose load failed is not shown and
   * not exported") true if a later slice loads anything else here.
   */
  const anyReadFailed = importsFailed || tripsFailed || notesFailed || extrasFailed;

  // ── Presentation ──────────────────────────────────────────────────────────

  const columns: DataTableColumn<PlanSummaryRow>[] = useMemo(
    () => [
      {
        id: 'driver',
        header: t('mplan.col.driver'),
        value: row => row.driverName,
        sortable: true,
        cell: row => (
          <div className="min-w-0">
            <span className="block truncate font-medium text-fg">{row.driverName}</span>
            {row.isOwner ? (
              <span className="text-[12px] text-fg-muted">{t('mp.pool.owner')}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'assigned',
        header: t('mplan.col.assignedHours'),
        kind: 'number',
        value: row => row.assignedMinutes,
        sortable: true,
        cell: row => (
          <span className="block tabular-nums">
            {hoursText(row.assignedMinutes / 60)}
            {/* Below `sm` the deviation column is hidden rather than squeezed out
                of nine columns on a 375 px phone, so its figure moves here — the
                repo's rule for a narrow DataTable is to move a column into
                another cell, never to drop it. */}
            <span className="block text-[12px] font-normal text-fg-muted sm:hidden">
              {t('mplan.col.deviation')}: {deviationText(row.deviationHours)}
            </span>
          </span>
        ),
      },
      {
        id: 'min',
        header: t('mplan.col.minTarget'),
        kind: 'number',
        hideBelow: 'md',
        value: row => row.minHours,
        cell: row => <span className="tabular-nums">{hoursText(row.minHours)}</span>,
      },
      {
        id: 'max',
        header: t('mplan.col.maxTarget'),
        kind: 'number',
        hideBelow: 'md',
        value: row => row.effectiveMaxHours,
        // The cap has one source now, so there is nothing to mark: it is always
        // `max_salary / hourly_rate` (owner's decision, 01.10.2026 — the plan
        // works from salaries, not hours).
        cell: row => <span className="tabular-nums">{hoursText(row.effectiveMaxHours)}</span>,
      },
      {
        id: 'deviation',
        header: t('mplan.col.deviation'),
        kind: 'number',
        hideBelow: 'sm',
        value: row => row.deviationHours,
        sortable: true,
        cell: row => (
          <span
            className={cn(
              'tabular-nums',
              row.deviationHours != null && row.deviationHours < 0 && 'text-caution',
              row.deviationHours != null && row.deviationHours > 0 && 'text-critical',
            )}
          >
            {deviationText(row.deviationHours)}
          </span>
        ),
      },
      {
        id: 'salary',
        header: t('mplan.col.estimatedSalary'),
        kind: 'currency',
        hideBelow: 'lg',
        value: row => row.estimatedSalaryCents,
        cell: row => (
          <span className="tabular-nums">
            {/* No estimate rather than 0,00 €: an unusable hourly rate is a
                configuration error, and a zero would read as "costs nothing". */}
            {row.estimatedSalaryCents == null ? '—' : formatEuroCents(row.estimatedSalaryCents)}
          </span>
        ),
      },
      {
        id: 'blocks',
        header: t('mplan.col.blocks'),
        kind: 'number',
        hideBelow: 'sm',
        value: row => row.blockCount,
      },
      {
        id: 'trips',
        header: t('mplan.col.trips'),
        kind: 'number',
        hideBelow: 'lg',
        value: row => row.tripCount,
      },
      {
        id: 'status',
        header: t('mplan.col.status'),
        value: row => t(STATUS_KEYS[row.status]),
        cell: row => (
          <div className="flex flex-col items-start gap-1">
            <Badge tone={STATUS_TONES[row.status]} className="inline-flex items-center gap-1">
              {row.status === 'has_conflict' || row.status === 'above_cap' ? (
                <AlertTriangle aria-hidden className="size-3" />
              ) : null}
              {t(STATUS_KEYS[row.status])}
            </Badge>
            {row.status === 'no_range' ? (
              <span className="text-[12px] text-fg-muted">{t('mplan.status.noRangeHint')}</span>
            ) : null}
            {row.conflicts.length > 0 ? (
              <span className="text-[12px] text-fg-muted">
                {t('mplan.summary.conflictCount', { count: row.conflicts.length })}
              </span>
            ) : null}
          </div>
        ),
      },
    ],
    [t],
  );

  // Column 0 of the totals row is DataTable's own "Summe" label, so it carries
  // no figure of ours. Only the drivers who could be priced are summed; the
  // caveat under the table says so when that is not all of them.
  const totals = useMemo(() => {
    const assignedMinutes = summaryRows.reduce((sum, r) => sum + r.assignedMinutes, 0);
    return {
      assigned: hoursText(assignedMinutes / 60),
      blocks: formatNumber(summaryRows.reduce((sum, r) => sum + r.blockCount, 0)),
      trips: formatNumber(summaryRows.reduce((sum, r) => sum + r.tripCount, 0)),
      salary: formatEuroCents(pricedRows.reduce((sum, r) => sum + (r.estimatedSalaryCents ?? 0), 0)),
    };
  }, [summaryRows, pricedRows]);

  if (!companyId) {
    return (
      <div className="font-ui">
        <PageHeader title={t('mplan.title')} description={t('mplan.subtitle')} />
        <Alert tone="critical">{t('mplan.noCompany')}</Alert>
      </div>
    );
  }

  return (
    <div className="font-ui">
      <PageHeader
        title={t('mplan.title')}
        description={t('mplan.subtitle')}
        actions={
          plan && step >= 3 ? (
            <Badge tone="neutral">{t('mplan.summary.variant', { seed: plan.seed + 1 })}</Badge>
          ) : null
        }
      >
        <ol className="flex flex-wrap items-center gap-2" aria-label={t('mplan.stepsLabel')}>
          {STEP_KEYS.map((key, index) => {
            const number = index + 1;
            const current = number === step;
            return (
              <li key={key}>
                <span
                  aria-current={current ? 'step' : undefined}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px]',
                    current
                      ? 'border-brand bg-brand-soft font-semibold text-brand-text'
                      : number < step
                        ? 'border-line bg-sunken text-fg'
                        : 'border-line bg-raised text-fg-subtle',
                  )}
                >
                  <span className="tabular-nums">{number}</span>
                  {t(key)}
                </span>
              </li>
            );
          })}
        </ol>
      </PageHeader>

      {/* ── Screen 1: the month ──────────────────────────────────────────── */}
      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarDays aria-hidden className="size-4 text-fg-muted" />
              {t('mplan.month.title')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {importsFailed ? (
              <Alert tone="critical" title={t('mplan.month.loadFailedTitle')}>
                {t('mplan.month.loadFailed')}
              </Alert>
            ) : null}

            {importsLoading ? (
              <p className="text-sm text-fg-muted">{t('mplan.month.loading')}</p>
            ) : null}

            {plannable && plannable.months.length === 0 ? (
              <EmptyState
                icon={FileText}
                title={t('mplan.month.none')}
                description={t('mplan.month.noneHint')}
              />
            ) : null}

            {plannable && plannable.months.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('mplan.month.label')} hint={t('mplan.month.hint')}>
                  <NativeSelect
                    value={monthKey}
                    onChange={event => {
                      setMonthKey(event.target.value);
                      // A different month is a different workload, so nothing
                      // built from the old one may survive the change.
                      setImportId('');
                      setTrips(null);
                      setPlan(null);
                    }}
                  >
                    {plannable.months.map(m => (
                      <option key={m.key} value={m.key}>
                        {t('mplan.month.option', {
                          month: monthLabel(m.year, m.month),
                          imports: m.imports.length,
                          trips: m.rowCount,
                        })}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>

                {selectedMonth && selectedMonth.imports.length > 1 ? (
                  <Field label={t('mplan.import.label')} hint={t('mplan.import.hint')}>
                    <NativeSelect
                      value={importId}
                      onChange={event => {
                        setImportId(event.target.value);
                        setTrips(null);
                        setPlan(null);
                      }}
                    >
                      {selectedMonth.imports.map(i => (
                        <option key={i.id} value={i.id}>
                          {t('mplan.import.option', { file: i.fileName, trips: i.rowCount })}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                ) : selectedImport ? (
                  // Not a `Field`: it always renders a <label htmlFor>, and this
                  // month has one import, so there is no control for the label to
                  // point at. Same typography, no dangling `for`.
                  <div className="grid content-start gap-1.5">
                    <p className="text-[13px] font-medium text-fg-muted">{t('mplan.import.label')}</p>
                    <p className="text-sm text-fg">
                      {t('mplan.import.option', {
                        file: selectedImport.fileName,
                        trips: selectedImport.rowCount,
                      })}
                    </p>
                    <p className="text-xs text-fg-subtle">{t('mplan.import.hint')}</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {plannable && plannable.unreadable.length > 0 ? (
              <Alert tone="caution">
                {t('mplan.month.unreadable', { count: plannable.unreadable.length })}
              </Alert>
            ) : null}
            {plannable && plannable.archived.length > 0 ? (
              <Alert tone="neutral" role="note">
                {t('mplan.month.archived', { count: plannable.archived.length })}
              </Alert>
            ) : null}

            {tripsFailed ? (
              <Alert tone="critical" title={t('mplan.trips.loadFailedTitle')}>
                {t('mplan.trips.loadFailed')}
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void loadTrips()} disabled={!importId || tripsLoading}>
                {tripsLoading ? t('mplan.trips.loading') : t('mplan.continue')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Screen 2: the drivers, the switch duration, the confirm ──────────
          The pool stays mounted from here on, hidden when this is not the current
          step: it sets the suggested selection in an effect the first time its
          drivers load, so unmounting and remounting it would silently undo the
          operator's own selection on every return to this step. */}
      {step >= 2 && trips ? (
        <div className={cn('space-y-6', step !== 2 && 'hidden')}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users aria-hidden className="size-4 text-fg-muted" />
                {t('mplan.drivers.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {selectedMonth ? (
                <p className="text-sm text-fg-muted">
                  {t('mplan.drivers.forMonth', {
                    month: monthLabel(selectedMonth.year, selectedMonth.month),
                    trips: trips.length,
                  })}
                </p>
              ) : null}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label={t('mplan.switch.label')}
                  hint={t('mplan.switch.hint')}
                  error={switchMinutes == null ? t('mplan.switch.invalid') : undefined}
                >
                  <Input
                    type="number"
                    min={0}
                    step={5}
                    inputMode="numeric"
                    value={switchText}
                    onChange={event => setSwitchText(event.target.value)}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>

          <MonatsplanungDriverPool
            companyId={companyId}
            originalDriverNames={originalDriverNames}
            originalDriverIds={originalDriverIds}
            selectedIds={selectedDriverIds}
            onSelectedChange={setSelectedDriverIds}
            onDriversLoaded={setPoolDrivers}
          />

          {selectedDriverIds.size === 0 ? (
            <Alert tone="caution">{t('mplan.drivers.noneSelected')}</Alert>
          ) : null}
          {notesFailed ? (
            <Alert tone="critical" title={t('mplan.notes.loadFailedTitle')}>
              {t('mplan.notes.loadFailed')}
            </Alert>
          ) : null}
          {extrasFailed ? (
            <Alert tone="critical" title={t('mplan.extras.loadFailedTitle')}>
              {t('mplan.extras.loadFailed')}
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setStep(1);
                setPlan(null);
              }}
            >
              {t('mplan.back')}
            </Button>
            <Button
              onClick={() => void generate(0)}
              disabled={generating || selectedDriverIds.size === 0 || switchMinutes == null}
            >
              {generating ? t('mplan.generating') : t('mplan.drivers.confirm')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* ── Screen 3: one row per driver, the findings, and the two buttons ── */}
      {step === 3 && plan ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('mplan.summary.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-sm text-fg-muted">
                {t('mplan.summary.source', {
                  trips: plan.tripCount,
                  blocks: plan.blocks.length,
                  minutes: plan.switchMinutes,
                })}
              </p>
              <p className="text-sm text-fg-muted">
                {t('mplan.summary.tripCounts', {
                  canceled: plan.canceledCount,
                  rejected: plan.rejected.length,
                })}
              </p>
            </CardContent>
          </Card>

          {plan.validation.violations.length > 0 ? (
            <Alert tone="critical" title={t('mplan.violations.title')}>
              <ul className="list-disc space-y-1 pl-5">
                {plan.validation.violations.slice(0, VIOLATIONS_SHOWN).map((v, index) => (
                  <li key={`${v.rule}-${v.blockId ?? ''}-${v.driverId ?? ''}-${index}`}>
                    <span className="font-medium">{t(VIOLATION_KEYS[v.rule])}</span>
                    {/* The engine's own words, untranslated and exact. */}
                    <span className="text-[13px]"> — {v.detail}</span>
                  </li>
                ))}
              </ul>
              {plan.validation.violations.length > VIOLATIONS_SHOWN ? (
                <p className="mt-1">
                  {t('mplan.violations.more', {
                    count: plan.validation.violations.length - VIOLATIONS_SHOWN,
                  })}
                </p>
              ) : null}
            </Alert>
          ) : null}

          <DataTable
            columns={columns}
            rows={summaryRows}
            getRowId={row => row.driverId}
            caption={t('mplan.summary.caption')}
            initialSort={{ columnId: 'driver', direction: 'asc' }}
            totals={totals}
            emptyState={<EmptyState icon={Users} title={t('mplan.summary.noDrivers')} />}
          />

          {summaryRows.length > 0 && pricedRows.length < summaryRows.length ? (
            <Alert tone="caution">
              {t('mplan.summary.partialSalary', {
                priced: pricedRows.length,
                total: summaryRows.length,
              })}
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Info aria-hidden className="size-4 text-fg-muted" />
                {t('mplan.warnings.title')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {warningGroups.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-positive">
                  <CheckCircle2 aria-hidden className="size-4" />
                  {t('mplan.warnings.none')}
                </p>
              ) : (
                <ul className="space-y-3">
                  {warningGroups.map(group => (
                    <li key={group.kind}>
                      <p className="text-sm font-medium text-fg">
                        {t('mplan.warn.withCount', {
                          label: WARNING_KEYS[group.kind] ? t(WARNING_KEYS[group.kind]) : group.kind,
                          count: group.count,
                        })}
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-fg-muted">
                        {group.samples.map((sample, index) => (
                          <li key={`${group.kind}-${index}`}>{sample}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {!plan.validation.confirmable ? (
            <Alert tone="critical">
              {t('mplan.summary.blocked', { count: plan.validation.violations.length })}
            </Alert>
          ) : null}
          {plan.validation.confirmable && !mayConfirm ? (
            <Alert tone="caution">{t('mplan.summary.noWriteRight')}</Alert>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setStep(2)}>
              {t('mplan.back')}
            </Button>
            <Button variant="secondary" onClick={regenerate}>
              <RotateCw aria-hidden className="size-4" />
              {t('mplan.summary.regenerate')}
            </Button>
            {/* Criterion 15's gate. It reads `validatePlan`'s answer, which is
                the second, independent check: it re-derives every hard rule from
                the blocks and the notes and trusts nothing the assigner wrote.
                Running it again on click would return the same value by
                construction — the inputs are immutable and in memory — so the
                button reads the answer rather than recomputing it. What still
                has to happen at the save step is the *other* re-check: that the
                month's data has not moved in the database since this plan was
                built, and that only one plan stays active for the month (§9). */}
            <Button onClick={() => void saveAndConfirm(false)} disabled={!confirmable || saving}>
              {saving ? t('mplan.summary.saving') : t('mplan.summary.confirm')}
            </Button>
          </div>

          {/* §9's choice, and the only refusal that has one. The draft is
              already written, so replacing acts on it rather than saving a
              second draft the save would then discard — which would read as a
              button that does nothing. */}
          {pendingReplace ? (
            <Alert tone="caution" title={t('mplan.save.planExistsTitle')} className="mt-3">
              <p>{t('mplan.save.planExistsBody')}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void saveAndConfirm(true)} disabled={saving}>
                  {t('mplan.save.replace')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPendingReplace(null)}
                        disabled={saving}>
                  {t('mplan.save.keep')}
                </Button>
              </div>
            </Alert>
          ) : null}

          {/* Every other refusal is named, never summarised as "failed": the
              reason codes are the database's own and each one tells the operator
              something different about what to do next. */}
          {saveState && !saveState.ok && saveState.reason !== 'plan_exists' ? (
            <Alert tone="critical" title={t('mplan.save.failedTitle')} className="mt-3">
              <p>{t(SAVE_REASON_KEYS[saveState.reason] ?? 'mplan.save.reason.network')}</p>
              {saveState.detail ? (
                <p className="mt-1 text-[13px] opacity-80">{saveState.detail}</p>
              ) : null}
            </Alert>
          ) : null}
          <p className="mt-2 text-[13px] text-fg-muted">{t('mplan.summary.regenerateHint')}</p>
        </div>
      ) : null}

      {/* ── Screen 4: the documents ──────────────────────── */}
      {/* Everything here is drawn by the three document builders from
          `storedPlan`, which is the stored plan column for column. The step
          component holds no planning rule and formats no figure — its own header
          says why that is the point, and `monthlyPlanDocuments.ts` is the
          contract it renders. */}
      {step === 4 && storedPlan ? (
        <MonthlyPlanDocumentsStep
          plan={storedPlan}
          companyName={companyName}
          confirmable={plan?.validation.confirmable === true}
          loadFailed={anyReadFailed}
          onBack={() => setStep(3)}
        />
      ) : null}
    </div>
  );
}
