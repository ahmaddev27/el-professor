import { describe, expect, it, vi } from 'vitest';
// Type-only: erased at build time, so it does not load the module under test
// ahead of the vi.mock calls below.
import type { ApplyGateInput, StundennachweisRunRef } from './MonatsplanungAssignmentPreview';

/**
 * The two decisions the Monatsplanung assignment screen makes that are worth
 * pinning, both extracted out of the render so they can be checked without one.
 *
 * 1. THE APPLY GATE. The `driver_notes` read used to discard its `error`
 *    (`.then(({ data }) => …)`). `exclude_from_plan` is a HARD phase-3
 *    constraint — CLAUDE.md lists `note_constraint` among the reasons no manual
 *    exception may bypass — so a refused or unreachable read left the map empty,
 *    `validateDriverNotesForPlanStep` found nothing to violate, and the screen
 *    said "Fahrer-Notizen geprüft: OK — keine Fahrten in ausgeschlossenen
 *    Fahrer-Zeiträumen" and let the plan be applied. Zero violations because the
 *    check ran and zero violations because it never ran were the same value.
 *
 * 2. THE RUN REFERENCE. The object handed to the Stundennachweis preview omitted
 *    `import_id` (a standing TS2741), and the preview's corrected-Fahrtenbuch
 *    button is `disabled={… || !run.import_id}` — so that download was
 *    unreachable from this screen for every user, always. Forwarding the id
 *    alone is not enough: the `'original'` export mode has to reproduce the
 *    imported sheet's headers byte for byte, and with no `source_columns_json`
 *    it falls back to the union of `raw_data_json` keys and the sheet name
 *    `Sheet1`.
 *
 * Both tests carry a negative control that embeds the OLD behaviour literally,
 * so a regression is caught rather than reasoned about.
 *
 * The component is imported for its pure exports only; its React graph and the
 * two modal children are stubbed so nothing in it has to render.
 */

vi.mock('../lib/supabase', () => ({
  supabase: { from: () => ({}) },
  AUTH_STORAGE_KEY: 'x',
  isSupabaseConfigured: false,
  authRedirect: { type: '', error: '', errorFamily: '', errorCode: '' },
}));
vi.mock('xlsx', () => ({ utils: {}, writeFile: () => {}, read: () => ({}) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({ t: (key: string) => key, tPlural: (keys: { one: string; other: string }) => keys.other }),
}));
vi.mock('./MonatsplanungStundennachweisPreview', () => ({ default: () => null }));
vi.mock('./FinalizePlanningModal', () => ({ default: () => null }));

const {
  buildStundennachweisRunRef,
  evaluateApplyGate,
  importHeadersUsable,
} = await import('./MonatsplanungAssignmentPreview');

// ── The apply gate ─────────────────────────────────────────────────────────

const clear: ApplyGateInput = {
  phase3Ok: true,
  phase4Ok: true,
  hasOpenBlocks: false,
  hasValidationViolations: false,
  hasQualityBlockers: false,
  notesLoadFailed: false,
  hasNoteViolations: false,
  hasImportId: true,
  alreadyApplied: false,
};

/**
 * NEGATIVE CONTROL — the gate exactly as it stood before this change, copied
 * from the expression at the "Plan anwenden" button, including the order its
 * reason chain reported. It has no `notesLoadFailed` term, which is the whole
 * defect: on a failed notes read it answers `true`.
 */
function legacyGate(i: ApplyGateInput): { canApply: boolean; blockedBy: string | null } {
  const canApply =
    i.phase3Ok && i.phase4Ok && !i.hasOpenBlocks && !i.hasValidationViolations
    && !i.hasQualityBlockers && !i.hasNoteViolations && i.hasImportId && !i.alreadyApplied;
  const blockedBy = !i.phase3Ok ? 'not_complete'
    : !i.phase4Ok ? 'needs_change_set'
    : i.hasOpenBlocks ? 'open_blocks'
    : i.hasValidationViolations ? 'validation'
    : i.hasQualityBlockers ? 'quality'
    : i.hasNoteViolations ? 'notes'
    : !i.hasImportId ? 'no_import_id'
    : i.alreadyApplied ? 'already_applied'
    : null;
  return { canApply, blockedBy };
}

describe('evaluateApplyGate', () => {
  it('lets a clean plan through', () => {
    expect(evaluateApplyGate(clear)).toEqual({ canApply: true, blockedBy: null });
  });

  it('refuses the apply when the driver_notes read failed, although nothing was violated', () => {
    const failed = { ...clear, notesLoadFailed: true, hasNoteViolations: false };
    expect(evaluateApplyGate(failed)).toEqual({ canApply: false, blockedBy: 'notes_unavailable' });

    // The negative control: this is the case the old gate waved through.
    expect(legacyGate(failed).canApply).toBe(true);
    expect(legacyGate(failed).blockedBy).toBeNull();
  });

  it('reports the unavailable read ahead of a violation count that cannot exist', () => {
    // A failed read produces an empty map, so hasNoteViolations is false by
    // construction. Should both ever be set, the read is the honest reason.
    const both = { ...clear, notesLoadFailed: true, hasNoteViolations: true };
    expect(evaluateApplyGate(both).blockedBy).toBe('notes_unavailable');
  });

  it('keeps the precedence the screen has always shown', () => {
    const cases: Array<[Partial<ApplyGateInput>, string]> = [
      [{ phase3Ok: false, phase4Ok: false, hasOpenBlocks: true }, 'not_complete'],
      [{ phase4Ok: false, hasOpenBlocks: true }, 'needs_change_set'],
      [{ hasOpenBlocks: true, hasValidationViolations: true }, 'open_blocks'],
      [{ hasValidationViolations: true, hasQualityBlockers: true }, 'validation'],
      [{ hasQualityBlockers: true, hasNoteViolations: true }, 'quality'],
      [{ hasNoteViolations: true, hasImportId: false }, 'notes'],
      [{ hasImportId: false, alreadyApplied: true }, 'no_import_id'],
      [{ alreadyApplied: true }, 'already_applied'],
    ];
    for (const [over, expected] of cases) {
      const gate = evaluateApplyGate({ ...clear, ...over });
      expect(gate.blockedBy, JSON.stringify(over)).toBe(expected);
      expect(gate.canApply).toBe(false);
    }
  });

  it('changes nothing else: it agrees with the old gate on every input where the notes read succeeded', () => {
    // 2^8 = 256 combinations of the other eight terms. The extraction out of
    // the button's inline expression must be a copy, not a rewrite.
    const keys = [
      'phase3Ok', 'phase4Ok', 'hasOpenBlocks', 'hasValidationViolations',
      'hasQualityBlockers', 'hasNoteViolations', 'hasImportId', 'alreadyApplied',
    ] as const;
    let compared = 0;
    for (let bits = 0; bits < 1 << keys.length; bits++) {
      const flags: Record<string, boolean> = { notesLoadFailed: false };
      keys.forEach((key, index) => { flags[key] = ((bits >> index) & 1) === 1; });
      const input = flags as unknown as ApplyGateInput;
      const mine = evaluateApplyGate(input);
      const old = legacyGate(input);
      expect(mine.canApply, JSON.stringify(input)).toBe(old.canApply);
      expect(mine.blockedBy, JSON.stringify(input)).toBe(old.blockedBy);
      compared++;
    }
    expect(compared).toBe(256);
  });
});

// ── The run reference ──────────────────────────────────────────────────────

const appliedRun = {
  id: 'run-1',
  company_id: 'company-1',
  month: 8,
  year: 2026,
  import_id: 'import-1',
  status: 'applied',
  applied_at: '2026-09-01T10:00:00.000Z',
  applied_by: 'user-1',
  apply_summary_json: null,
  settings_json: { vehicle_switch_buffer_minutes: 20, one_vehicle_per_driver_day: true },
  summary_json: null,
  file_name: '2026-08-01_2026-08-31_Fahrtenbuch.xlsx',
  source_columns_json: ['Datum der Fahrt', 'Fahrer', 'Fahrpreis'],
  source_sheet_name: 'Fahrten',
  imported_at: '',
};

const meta = { source_sheet_name: 'Fahrten', source_columns_json: ['Datum der Fahrt', 'Fahrer', 'Fahrpreis'] };

/**
 * NEGATIVE CONTROL — the literal that used to be written inline at the call
 * site. Seven fields, no `import_id`, no source metadata.
 */
const legacyRunRef = (run: typeof appliedRun) => ({
  id: run.id,
  company_id: run.company_id,
  month: run.month,
  year: run.year,
  status: run.status,
  file_name: run.file_name,
  applied_at: run.applied_at,
});

/** The preview's own gate on its corrected-Fahrtenbuch button, verbatim. */
const downloadDisabled = (ref: Partial<StundennachweisRunRef>) => !ref.import_id;

describe('buildStundennachweisRunRef', () => {
  it('forwards the import and the imported sheet, so the corrected Fahrtenbuch can be built', () => {
    const ref = buildStundennachweisRunRef(appliedRun, meta);
    expect(ref.import_id).toBe('import-1');
    expect(ref.source_sheet_name).toBe('Fahrten');
    expect(ref.source_columns_json).toEqual(['Datum der Fahrt', 'Fahrer', 'Fahrpreis']);
    expect(downloadDisabled(ref)).toBe(false);

    // The negative control: the old literal had no import_id at all, which is
    // why the button was disabled every time.
    expect('import_id' in legacyRunRef(appliedRun)).toBe(false);
    expect(downloadDisabled(legacyRunRef(appliedRun))).toBe(true);
  });

  it('carries the seven fields the old literal carried, unchanged', () => {
    const ref = buildStundennachweisRunRef(appliedRun, meta);
    expect(ref).toMatchObject(legacyRunRef(appliedRun));
  });

  it('withholds the import id when the header row was not read', () => {
    // Not a convenience: with no headers the export falls back to the union of
    // raw_data_json keys and the sheet name Sheet1, which is a different
    // document from the one that was imported. A disabled button is the honest
    // answer for a statutory ride log.
    const ref = buildStundennachweisRunRef(appliedRun, null);
    expect(ref.import_id).toBeNull();
    expect(ref.source_columns_json).toBeNull();
    expect(ref.source_sheet_name).toBeNull();
    expect(downloadDisabled(ref)).toBe(true);
  });

  it('treats an empty or blank header row as no header row', () => {
    for (const columns of [[], [''], ['', '']]) {
      const ref = buildStundennachweisRunRef(appliedRun, { source_sheet_name: 'Fahrten', source_columns_json: columns });
      expect(ref.import_id, JSON.stringify(columns)).toBeNull();
    }
  });

  it('accepts a header row whose sheet name is missing — only the headers are load-bearing', () => {
    const ref = buildStundennachweisRunRef(appliedRun, { source_sheet_name: null, source_columns_json: ['Datum der Fahrt'] });
    expect(ref.import_id).toBe('import-1');
    expect(ref.source_sheet_name).toBeNull();
  });
});

describe('importHeadersUsable', () => {
  it('answers for every shape the column list comes back as', () => {
    expect(importHeadersUsable(null)).toBe(false);
    expect(importHeadersUsable({ source_sheet_name: 'S', source_columns_json: null })).toBe(false);
    expect(importHeadersUsable({ source_sheet_name: 'S', source_columns_json: [] })).toBe(false);
    expect(importHeadersUsable({ source_sheet_name: 'S', source_columns_json: [''] })).toBe(false);
    expect(importHeadersUsable({ source_sheet_name: 'S', source_columns_json: ['Datum der Fahrt'] })).toBe(true);
  });
});
