/**
 * The one shape the monthly plan's three documents read, and the contract screen
 * 4 renders them through (§10, §11, §12; acceptance criteria 22 and 23).
 *
 * ## The rule this module preserves, and it is §12's own
 *
 * **Every total in every document comes from the same plan.** §12 says it in so
 * many words — "the totals must come from the same plan data used in the
 * Stundennachweis" — and criterion 22 is the acceptance test for it. So there is
 * exactly one object a document may read, `StoredMonthlyPlan`, and its fields are
 * **column for column** the four tables of `20260930100000_monthly_plan.sql`:
 * `monthly_plans`, `monthly_plan_drivers`, `monthly_plan_blocks` and
 * `monthly_plan_block_trips`. A document recomputes nothing, and the screen
 * formats nothing.
 *
 * That is not a preference. Today's product has **two** independent
 * Stundennachweis builders — `MonatsplanungStundennachweisPreview` and
 * `FinalizePlanningModal` — and they disagree: the modal's loses every holiday
 * hour (`isHol: false`, hard-coded), the 30-minute minimum and the midnight
 * split, and prints decimal hours where the other prints `HH:MM`. Inside one
 * component the toolbar total excludes the gap between merged shifts while the
 * PDF includes it, and 92.5 % of driver-days are compressed, so those two
 * disagree for nearly every driver. This module exists so the third pipeline
 * cannot acquire the same defect: a document that wants a figure takes it from
 * the stored plan or asks the builder that owns it.
 *
 * ## Why the shape is the table's and not the engine's
 *
 * Screen 4's plan is in memory today: the save and confirm step (§9,
 * `monthly_plan_save` / `monthly_plan_confirm`) is a slice of its own and is not
 * wired yet. `storedPlanFromGenerated` is the bridge, and the reason it projects
 * into the **table's** shape rather than handing the builders the engine's
 * `PlanBlock[]` is that the swap is then one function: when the save lands,
 * screen 4 reads the four tables back and passes the rows to the same builders,
 * unchanged. A contract written against the engine's types would have to be
 * rewritten — and a rewritten document contract is how two builders of one
 * document come to exist.
 *
 * ## This plans a month that has not happened
 *
 * The owner's decision, and it is why `PROPOSAL_NOTICE` and `PLANNING_MARKER`
 * are here rather than in each builder: every document carries the notice in its
 * header and the marker in its filename, and three copies of a sentence is three
 * chances for one of them to go missing. They are German in both UI languages,
 * like every other generated-document string (`src/i18n/index.ts`), and they are
 * deliberately **not** dictionary keys.
 *
 * Nothing here writes anything. `fahrtenbuch_trips` is append-only and
 * `saved_stundennachweise` is the statutory archive keyed per driver and month —
 * a proposal in it would overwrite a real record.
 */

import type {
  AssignResult,
  PlanBlock,
  PlanDriverInput,
  PlanWarning,
} from './monthlyPlan';

// ── The proposal, in one place ───────────────────────────────────────────────

/**
 * The line every one of the three documents carries in its header.
 *
 * German in both languages: it is document text, not a label, and it is the one
 * sentence that stops a proposal being read as a record of hours worked.
 */
export const PROPOSAL_NOTICE = 'PLANUNG / VORSCHAU — kein Arbeitszeitnachweis';

/** The marker every filename carries, so a proposal is never filed as a record. */
export const PLANNING_MARKER = 'PLANUNG';

/**
 * German month names for a **filename**, which is generated-document text and
 * follows the same rule as `MONTH_NAMES_DE` in `DocumentsPage` and
 * `StundennachweisPage`: a second consumer reads it, so it is an identifier and
 * stays German in both UI languages.
 */
export const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
] as const;

// ── The stored plan: the four tables, column for column ─────────────────────

/** `monthly_plans.status`. */
export type StoredPlanStatus = 'draft' | 'confirmed' | 'superseded';

/**
 * `monthly_plan_drivers` — §13's snapshot: "the driver values used in the plan,
 * so later edits to the driver profile do not change an old plan's meaning".
 *
 * `target_monthly_hours` is absent, here as in the table, and must stay absent:
 * §5 forbids this feature to use it as a target, a constraint, a sort key or a
 * displayed figure. The absence is structural — there is no field to fill.
 */
export interface StoredPlanDriver {
  driver_id: string;
  driver_name: string;
  selected: boolean;
  is_owner: boolean;
  planning_min_salary: number | null;
  planning_max_salary: number | null;
  planning_hourly_rate: number | null;
  planning_priority: number | null;
  /**
   * `drivers.planning_enabled`. The engine's `PlanDriverInput` has no field for
   * it, so `storedPlanFromGenerated` writes null and the database's
   * `monthly_plan_driver_guard` fills it from `public.drivers` when the plan is
   * saved. A document that needs it must read a saved plan.
   */
  planning_enabled: boolean | null;
  can_cover_other_drivers: boolean | null;
  /** `computeHoursRange`'s own problem words. Empty means the range is usable. */
  range_problems: readonly string[];
}

/** `monthly_plan_block_trips` — which rides a block holds, with their figures. */
export interface StoredPlanBlockTrip {
  trip_id: string;
  /** ISO 8601 instants, never clock text. */
  starts_at: string;
  ends_at: string;
  minutes: number;
  time_source: 'instants' | 'date_and_clock';
  original_driver_id: string | null;
  original_driver_name: string | null;
}

/** `monthly_plan_blocks`, with its rides nested as the screen reads them. */
export interface StoredPlanBlock {
  block_key: string;
  car_id: string | null;
  car_identifier: string | null;
  starts_at: string;
  ends_at: string;
  /** The block's wall-clock length. The figure the hours cap is enforced against. */
  span_minutes: number;
  /** The sum of the member rides' own minutes. Not the same number as the span. */
  ride_minutes: number;
  /** NULL is an unassigned block (§8), kept with a warning rather than dropped. */
  driver_id: string | null;
  driver_name: string | null;
  /**
   * Why this block went to this driver.
   *
   * The same six values as the CHECK on `monthly_plan_blocks.assignment_reason`
   * (`20261003100000`). The two lists are not generated from each other, so a
   * change that moves only one of them fails when an operator presses Save —
   * widen both in the same commit.
   *
   * `owner_fallback` and `owner_surplus` both end with the owner holding the
   * block and must stay distinguishable: the first means no regular driver passed
   * the hard rules, the second that one did and the plan chose the owner anyway
   * because every regular had already earned their minimum.
   */
  assignment_reason:
    | 'mandatory_note' | 'only_candidate' | 'best_fit' | 'seeded_tie'
    | 'owner_fallback' | 'owner_surplus'
    | null;
  assignment_note_id: string | null;
  trips: readonly StoredPlanBlockTrip[];
}

/** `monthly_plans` plus its children. The only object a document may read. */
export interface StoredMonthlyPlan {
  /** Null until the plan has been saved. */
  id: string | null;
  company_id: string;
  year: number;
  /** 1–12, as the column stores it. `MONTH_NAMES_DE` is 0-indexed; mind the `- 1`. */
  month: number;
  import_id: string | null;
  status: StoredPlanStatus;
  switch_minutes: number;
  /** The "Neu generieren" counter — the engine's seed. */
  generation: number;
  warnings: readonly PlanWarning[];
  drivers: readonly StoredPlanDriver[];
  blocks: readonly StoredPlanBlock[];
  /**
   * Whether any ride this plan was built from is simulated. REQUIRED: every
   * document the plan feeds carries it (hours and Lohnart figures come from ride
   * times, and a simulated ride's times are invented). The rides decide, not a
   * company flag.
   */
  simulated: boolean;
}

// ── The document contract ───────────────────────────────────────────────────

export type MonthlyPlanDocumentKind = 'stundennachweis' | 'fahrtenbuch' | 'payroll_summary';

/** One per-driver document of a document that has several (§10's Stundennachweis). */
export interface DocumentSubject {
  id: string;
  /** The builder's own label. The screen prints it and derives nothing from it. */
  label: string;
}

export interface DocumentPreviewColumn {
  /** The document's own header text, already in the document's language. */
  header: string;
  /** Right-aligned with tabular figures. The builder still formats the value. */
  numeric?: boolean;
}

export interface DocumentPreviewRow {
  id: string;
  /** Already formatted by the builder. The screen renders these as they are. */
  cells: readonly (string | null)[];
}

export interface DocumentPreviewSection {
  /** A heading above the table — a driver, a week, a vehicle. */
  caption?: string;
  columns: readonly DocumentPreviewColumn[];
  rows: readonly DocumentPreviewRow[];
  /** The section's own totals, formatted by the builder. One per column. */
  totals?: readonly (string | null)[];
}

/**
 * A document as screen 4 shows it.
 *
 * Every string is final: the builder formatted it from the stored plan, and the
 * screen neither parses nor re-renders a figure. A preview that handed over
 * numbers for the screen to format would be the third source of a total.
 */
export interface DocumentPreview {
  /** The document's header lines. `PROPOSAL_NOTICE` is expected to be among them. */
  header: readonly string[];
  sections: readonly DocumentPreviewSection[];
  footnotes?: readonly string[];
}

export interface MonthlyPlanFile {
  filename: string;
  blob: Blob;
}

export interface MonthlyPlanDocumentRequest {
  plan: StoredMonthlyPlan;
  /** One subject's document, or the whole document when absent. */
  subjectId?: string;
  /**
   * The instant the document says it was generated. Injected rather than read
   * from the clock inside a builder, so a preview and its download carry the
   * same date and a test can pin one.
   */
  generatedAt: Date;
  /**
   * The company's own name, for the documents that print a letterhead.
   *
   * A plan carries `company_id` and no name — the §13 snapshot is about drivers —
   * so the screen reads it from `CompanySettingsContext` and passes it here.
   * Absent, the payroll summary prints `Unternehmen: —`, which is what it did
   * for every plan until now: honest, and useless on a document that goes to a
   * Steuerberater.
   */
  companyName?: string;
}

/**
 * What screen 4 needs of each of the three document builders.
 *
 * **Declared here because none of the three modules existed when this screen was
 * written** — they are being built in parallel on
 * `feat/monthly-plan-doc-stundennachweis`, `…-fahrtenbuch` and `…-payroll`. The
 * screen holds them in `monthlyPlanDocumentBuilders.ts` and imports nothing from
 * them directly, so each one can be wired in a single line.
 */
export interface MonthlyPlanDocumentBuilder {
  kind: MonthlyPlanDocumentKind;
  /**
   * The per-subject documents this builder produces, or `undefined` for a single
   * document. The builder decides which drivers get a Stundennachweis; the screen
   * must not decide that, or the picker and the documents could disagree about
   * who is in the month.
   */
  subjects?(plan: StoredMonthlyPlan): DocumentSubject[];
  /**
   * Data the document needs that a stored plan does not carry, fetched once.
   *
   * Only the Fahrtenbuch has one, and the reason is §10's own: that document is
   * the *imported* sheet with the driver column overlaid, so it needs the
   * imported headers (`fahrtenbuch_imports.source_columns_json`) and every
   * original row (`fahrtenbuch_trips.raw_data_json`) — neither of which is part
   * of a plan, and neither of which may be reconstructed from one. `preview` is
   * synchronous by design (see `DocumentPreview`), so the read happens here and
   * its result is handed to both `preview` and `file` unchanged.
   *
   * A builder without this method needs nothing beyond the plan, and the screen
   * calls it with `loaded` left undefined.
   */
  load?(request: MonthlyPlanDocumentRequest): Promise<unknown>;
  preview(request: MonthlyPlanDocumentRequest, loaded?: unknown): DocumentPreview;
  file(request: MonthlyPlanDocumentRequest, loaded?: unknown): Promise<MonthlyPlanFile>;
}

export type MonthlyPlanDocumentBuilders =
  Partial<Record<MonthlyPlanDocumentKind, MonthlyPlanDocumentBuilder>>;

// ── The projection from the in-memory plan ──────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a vehicle key is a `cars.id` rather than a plate from the import.
 *
 * `buildBlocks` sets `PlanBlock.vehicleId` to `trip.vehicleId ?? trip.vehicleIdentifier`,
 * so one field holds either a `car_id` or a `car_identifier` and the distinction
 * the table needs — `monthly_plan_blocks` has both columns and a CHECK that one
 * of them is set — has to be recovered. A uuid test is the honest discriminator:
 * a German plate cannot take this shape.
 */
function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** An epoch instant as the column stores it. */
function instant(ms: number): string {
  return new Date(ms).toISOString();
}

export interface StoredPlanProjection {
  companyId: string;
  year: number;
  /** 1–12. */
  month: number;
  importId: string | null;
  switchMinutes: number;
  /** The engine's seed, stored as `generation`. */
  generation: number;
  blocks: readonly PlanBlock[];
  drivers: readonly PlanDriverInput[];
  result: AssignResult;
  warnings: readonly PlanWarning[];
  /**
   * Screen 2's checkbox set. A driver in the plan who is not in it is the owner
   * fallback of §7 rule 8, which the table's `unselected_is_owner` CHECK admits.
   */
  selectedDriverIds: ReadonlySet<string>;
  /** True when any ride the blocks were built from is simulated (`fahrtenbuch_trips.is_simulated`). */
  simulated: boolean;
  /**
   * `fahrtenbuch_trips.original_driver_id` by ride id. `PlanBlockTrip` carries
   * the original driver's **name** but not the id, so the id cannot be recovered
   * from the blocks alone; §2 asks for the original driver to be kept, so the
   * caller passes what it read. An absent entry stores null.
   */
  originalDriverIdByTrip?: ReadonlyMap<string, string | null>;
}

/**
 * Projects one generated plan into the shape the four tables store.
 *
 * **Copies; never recomputes.** Every minute figure is the engine's own —
 * `block.spanMinutes`, `block.rideMinutes`, `trip.minutes` — because a document
 * that re-derived one from the instants would round differently from the plan it
 * claims to print, and `monthly_plan_block_trips` copies the same three figures
 * for the same reason (its header: "a confirmed plan's totals cannot move").
 *
 * The `status` is `draft`: nothing is stored yet. Once §9's save and confirm step
 * is wired, screen 4 reads the rows back and this function is used only by the
 * save path — the builders do not change, which is the point of projecting into
 * the table's shape rather than the engine's.
 */
export function storedPlanFromGenerated(input: StoredPlanProjection): StoredMonthlyPlan {
  // `as const` on each entry: without it `.map` infers an array rather than a
  // tuple and the Map constructor refuses it.
  const assignmentByBlock = new Map(input.result.assignments.map(a => [a.blockId, a] as const));
  const rangeByDriver = new Map(input.result.driverStates.map(s => [s.driver.id, s.range] as const));

  const drivers: StoredPlanDriver[] = input.drivers.map(driver => ({
    driver_id: driver.id,
    driver_name: driver.name,
    selected: input.selectedDriverIds.has(driver.id),
    is_owner: driver.isOwner,
    planning_min_salary: driver.minSalary,
    planning_max_salary: driver.maxSalary,
    planning_hourly_rate: driver.hourlyRate,
    planning_priority: driver.planningPriority ?? null,
    // No field on PlanDriverInput; the database's guard fills it on save.
    planning_enabled: null,
    can_cover_other_drivers: driver.canCoverOtherDrivers ?? null,
    // The engine's own problem words, not a second judgement of the same figures.
    range_problems: rangeByDriver.get(driver.id)?.problems ?? [],
  }));

  const blocks: StoredPlanBlock[] = input.blocks.map(block => {
    const assignment = assignmentByBlock.get(block.id) ?? null;
    const keyIsUuid = isUuid(block.vehicleId);
    return {
      block_key: block.id,
      car_id: keyIsUuid ? block.vehicleId : null,
      car_identifier: block.vehicleIdentifier ?? (keyIsUuid ? null : block.vehicleId),
      starts_at: instant(block.startMs),
      ends_at: instant(block.endMs),
      span_minutes: block.spanMinutes,
      ride_minutes: block.rideMinutes,
      driver_id: assignment?.driverId ?? null,
      driver_name: assignment?.driverName ?? null,
      assignment_reason: assignment?.reason ?? null,
      // The table's CHECK allows a note id only for a mandatory pin, so it is
      // read from the assignment rather than carried for every reason.
      assignment_note_id:
        assignment && assignment.reason === 'mandatory_note' ? assignment.noteId ?? null : null,
      trips: block.trips.map(trip => ({
        trip_id: trip.tripId,
        starts_at: instant(trip.startMs),
        ends_at: instant(trip.endMs),
        minutes: trip.minutes,
        // 'unusable' never reaches a block: buildBlocks rejects such a ride, so
        // the stored domain has two values and not three.
        time_source: trip.timeSource === 'date_and_clock' ? ('date_and_clock' as const) : ('instants' as const),
        original_driver_id: input.originalDriverIdByTrip?.get(trip.tripId) ?? null,
        original_driver_name: trip.originalDriverName,
      })),
    };
  });

  return {
    id: null,
    company_id: input.companyId,
    year: input.year,
    month: input.month,
    import_id: input.importId,
    status: 'draft',
    switch_minutes: input.switchMinutes,
    generation: input.generation,
    warnings: input.warnings,
    drivers,
    blocks,
    simulated: input.simulated,
  };
}

// ── Filenames ───────────────────────────────────────────────────────────────

const FILE_STEMS: Record<MonthlyPlanDocumentKind, string> = {
  stundennachweis: 'Stundennachweis',
  fahrtenbuch: 'Fahrtenbuch',
  payroll_summary: 'Stundenuebersicht',
};

/**
 * A filename safe on every filesystem: letters, digits, dot and dash survive,
 * everything else becomes an underscore, and runs collapse.
 *
 * Umlauts are transliterated rather than stripped, so `Müller` is `Mueller` and
 * not `M_ller` — two drivers whose names differ only in an umlaut would
 * otherwise get the same filename and the second download would overwrite the
 * first.
 */
export function fileNamePart(text: string): string {
  return text
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The name of one document's file, with `_PLANUNG_` in it.
 *
 * The marker sits immediately after the document's own name, where it cannot be
 * mistaken for part of a driver's name and where it sorts beside the statutory
 * documents it must not be confused with. The rest follows the shape the product
 * already uses (`DocumentsPage`: `Stundennachweis_<Fahrer>_<Monat>_<Jahr>.pdf`),
 * with a German month name because a filename is document text.
 */
export function monthlyPlanFileName(
  kind: MonthlyPlanDocumentKind,
  plan: Pick<StoredMonthlyPlan, 'year' | 'month'>,
  extension: string,
  subjectLabel?: string,
): string {
  const month = MONTH_NAMES_DE[plan.month - 1] ?? String(plan.month);
  const parts = [FILE_STEMS[kind], PLANNING_MARKER];
  if (subjectLabel) {
    const subject = fileNamePart(subjectLabel);
    if (subject) parts.push(subject);
  }
  parts.push(month, String(plan.year));
  return `${parts.join('_')}.${extension.replace(/^\./, '')}`;
}

// ── When a document may be offered ──────────────────────────────────────────

/**
 * Why a document cannot be offered, or null when it can.
 *
 * `load_failed` is the repo's rule — "a figure whose load failed must not be
 * shown or exported" — and it covers the read that fills the plan, whether that
 * is the month's rides today or the four plan tables once §9's save is wired.
 * `plan_not_confirmable` is criterion 15: a plan with a broken hard rule is not
 * a document, and letting one out as a PDF would put it in front of an
 * accountant.
 */
export type DocumentBlockReason =
  | 'no_plan'
  | 'load_failed'
  | 'plan_not_confirmable'
  | 'builder_missing'
  | 'no_subject';

export interface DocumentAvailabilityInput {
  plan: StoredMonthlyPlan | null;
  /** Any read this plan depends on failed. */
  loadFailed: boolean;
  /** `validatePlan().confirmable`. */
  confirmable: boolean;
  builder: MonthlyPlanDocumentBuilder | undefined;
  /** The builder's own subjects, when it has any. */
  subjects: readonly DocumentSubject[] | null;
}

export function documentBlockReason(input: DocumentAvailabilityInput): DocumentBlockReason | null {
  // The order is the order of severity: a failed read is reported before a
  // missing builder, because a plan nobody could load says nothing about which
  // documents this build can produce.
  if (input.loadFailed) return 'load_failed';
  if (!input.plan) return 'no_plan';
  if (!input.confirmable) return 'plan_not_confirmable';
  if (!input.builder) return 'builder_missing';
  if (input.subjects !== null && input.subjects.length === 0) return 'no_subject';
  return null;
}
