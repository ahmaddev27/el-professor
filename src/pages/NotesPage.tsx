import React, { useState, useEffect } from 'react';
import { Plus, Search, Trash2, CreditCard as Edit2, X, StickyNote, Calendar, ChevronLeft, ChevronRight, Download, DownloadCloud, Loader2, Paperclip } from 'lucide-react';
import { Alert, Badge, Button } from '../components/ui';
import { usePartnerCatchUp } from '../hooks/usePartnerCatchUp';
import ConfirmationModal from '../components/ConfirmationModal';
import type { ExportOptions } from '../utils/excelExport';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { format } from 'date-fns';
import { getWeeksOfMonth, getWeekNumberForDate } from '../utils/weekCalculations';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { deleteChecked, updateChecked } from '../lib/writeOutcome';
import type { TranslationKey } from '../i18n';
import {
  INCIDENT_NOTE_TYPES, noteBehaviorFor, noteBehaviorIsFree, notePairAllowed, noteVehicleMissing, noteVehicleRequired,
  type NotePlanningBehavior,
} from '../utils/noteRules';
import {
  EMPTY_PROVENANCE_FORM, PROVENANCE_PROBLEM_KEYS, entrySourceOf, eventDetailsApply, provenanceErrorKey,
  provenanceFormOf, provenancePayload, reviewedFieldsChanged, verificationOf,
  type NoteProvenance, type ProvenanceFormValues, type ReviewedFormValues,
} from '../utils/noteProvenance';
import {
  attachEvidence, decideNote, detachEvidence, openEvidence, removeEvidenceFile,
  type EvidenceClient, type ReviewDecision,
} from '../lib/driverNoteProvenance';
import { NoteProvenanceFields } from '../components/notes/NoteProvenanceFields';
import { NoteReviewPanel } from '../components/notes/NoteReviewPanel';

interface Driver {
  id: string;
  name: string;
}

/**
 * A company car, as this screen needs it: the plate it is known by and whether
 * it is still in the fleet. `cars` carries no model or type column, so the plate
 * is the whole description — the owner's choice when told (28.09.2026).
 */
interface Car {
  id: string;
  kennzeichen: string;
  status: string;
}

interface Note extends NoteProvenance {
  id: string;
  driver_id: string;
  note_date: string;
  note_text: string;
  created_at: string;
  updated_at?: string;
  created_by?: string;
  /**
   * The driver's name when the note came from the driver app (20261013100000);
   * `created_by` is NULL then, because a driver has no user account.
   */
  submitted_by_name?: string | null;
  note_type?: string;
  note_planning_behavior?: NotePlanningBehavior;
  is_full_day?: boolean;
  start_time?: string | null;
  end_time?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  /**
   * Optional: which car the incident happened on, so a Blitzer photo or a
   * Bußgeldbescheid addressed to a plate can be tied back to the Fahrtenbuch.
   * A key into `cars`, never free text — `B-XX 1234` and `B-XX-1234` would
   * otherwise become two vehicles. It records; nothing looks anything up with
   * it, and no planning code ever sees it (see `loadNotes`).
   */
  car_id?: string | null;
  drivers?: { name: string };
  cars?: { kennzeichen: string } | null;
}

/** One entry of the car picker: the id that is stored, and what it reads as. */
interface CarOption {
  id: string;
  label: string;
}

/**
 * The cars the picker offers for a note.
 *
 * Every car of the company, in the order they were loaded (by plate), including
 * the retired ones — an incident note records something that already happened,
 * and a ticket arriving for a car the fleet has since sold is exactly the case
 * this field exists for. A retired car is therefore labelled, not hidden.
 *
 * `selected` is the note being edited. Its car is normally in `cars` already;
 * the extra entry exists for the one case where it is not — the car list failed
 * to load — because a `<select>` whose value matches no option falls back to the
 * first one, and saving the form would then silently drop the note's car.
 *
 * Takes its inactive label as a function: this is module scope, where t() is not
 * a value, the same way `noteDisplayLabel` below does it.
 *
 * Pure, and deliberately not exported: no page in this repository exports a
 * helper, and doing so turns off React Fast Refresh for the whole file
 * (`react-refresh/only-export-components`). Moving it to `src/utils/` with a
 * vitest file of its own is the right home for it, and is a change of its own.
 */
function carPickerOptions(
  cars: Car[],
  selected: { id: string; plate: string | null } | null,
  labelInactive: (plate: string) => string,
): CarOption[] {
  const options = cars.map(car => ({
    id: car.id,
    label: car.status === 'active' ? car.kennzeichen : labelInactive(car.kennzeichen),
  }));

  if (selected && selected.id && !cars.some(car => car.id === selected.id)) {
    options.push({ id: selected.id, label: selected.plate ?? selected.id });
  }

  return options;
}

// `label` holds a TranslationKey: this list is module-level and t() is a
// hook value. Every consumer resolves it. The effect each type carries is not
// here: utils/noteRules.ts holds it once, for this screen, the CHECK in the
// database and the tests that keep them equal.
const NOTE_TYPES = [
  { value: 'general',   label: 'notes.type.general' as TranslationKey },
  { value: 'sick',      label: 'notes.type.sick' as TranslationKey },
  { value: 'vacation',  label: 'notes.type.vacation' as TranslationKey },
  { value: 'off',       label: 'notes.type.unavailable' as TranslationKey },
  { value: 'blitzer',   label: 'notes.type.speedCamera' as TranslationKey },
  { value: 'accident',  label: 'notes.type.accident' as TranslationKey },
  { value: 'kontrolle', label: 'notes.type.inspection' as TranslationKey },
  { value: 'breakdown', label: 'notes.type.breakdown' as TranslationKey },
  { value: 'wait',      label: 'notes.type.waiting' as TranslationKey },
  { value: 'other',     label: 'notes.type.other' as TranslationKey },
];

const PLANNING_BEHAVIOR_LABELS: Record<NotePlanningBehavior, TranslationKey> = {
  neutral: 'notes.effect.none',
  exclude_from_plan: 'notes.effect.exclude',
  must_include_in_plan: 'notes.effect.require',
};

// Types that typically span multiple days (suggest date range UI)
const RANGE_NOTE_TYPES = new Set(['sick', 'vacation', 'off']);

type FilterMode = 'all' | 'date' | 'week' | 'month';

const EVIDENCE_PROBLEM_KEYS: Record<'empty' | 'size' | 'type' | 'upload', TranslationKey> = {
  empty: 'notes.prov.err.evidenceEmpty',
  size: 'notes.prov.err.evidenceSize',
  type: 'notes.prov.err.evidenceType',
  upload: 'notes.prov.err.evidenceUpload',
};

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  padding: '0.5rem 0.75rem',
  outline: 'none',
};

interface FormData extends ProvenanceFormValues {
  driver_id: string;
  car_id: string;             // '' means no car: the field is optional
  note_date: string;          // datetime-local — kept for backward compat / must_include times
  start_date: string;         // date only (YYYY-MM-DD)
  end_date: string;           // date only (YYYY-MM-DD)
  use_date_range: boolean;
  note_text: string;
  note_type: string;
  note_planning_behavior: NotePlanningBehavior;
  is_full_day: boolean;
  start_time: string;
  end_time: string;
}

const DEFAULT_FORM: FormData = {
  ...EMPTY_PROVENANCE_FORM,
  driver_id:              '',
  car_id:                 '',
  note_date:              format(new Date(), "yyyy-MM-dd'T'HH:mm"),
  start_date:             format(new Date(), 'yyyy-MM-dd'),
  end_date:               format(new Date(), 'yyyy-MM-dd'),
  use_date_range:         false,
  note_text:              '',
  note_type:              'general',
  note_planning_behavior: 'neutral',
  is_full_day:            false,
  start_time:             '',
  end_time:               '',
};

/**
 * What a review covers, as the form holds it. The database takes a decision back
 * when saving changes any of these (utils/noteProvenance.ts, REVIEWED_COLUMNS);
 * this is only the warning, shown before the save.
 */
function reviewedOf(form: FormData): ReviewedFormValues {
  return {
    driver_id: form.driver_id,
    car_id: form.car_id,
    note_type: form.note_type,
    is_full_day: form.is_full_day,
    start_date: form.start_date,
    end_date: form.use_date_range ? form.end_date : form.start_date,
    start_time: form.is_full_day ? '' : form.start_time,
    end_time: form.is_full_day ? '' : form.end_time,
    occurred_at: form.occurred_at,
    reported_at: form.reported_at,
    latitude: form.latitude,
    longitude: form.longitude,
    location_accuracy_m: form.location_accuracy_m,
    note_text: form.note_text.trim(),
  };
}

/** `dd.MM.yyyy HH:mm` of a stored moment, or '' when it cannot be read. */
function momentLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : format(date, 'dd.MM.yyyy HH:mm');
}

// Takes the translator explicitly: this is module scope, where t() is not a
// value. Currently unreferenced, kept because it encodes the label rule.
function noteDisplayLabel(note: Note, t: (k: TranslationKey) => string): string {
  if (note.note_text.trim()) return note.note_text;
  const nt = NOTE_TYPES.find(nt => nt.value === note.note_type);
  return nt ? t(nt.label) : t('notes.one');
}

function noteDateLabel(note: Note, t: (k: TranslationKey, vars?: Record<string, string | number>) => string): string {
  const sd = note.start_date;
  const ed = note.end_date;
  if (sd && ed && sd !== ed) {
    return `${format(new Date(sd), 'dd.MM.yyyy')} – ${format(new Date(ed), 'dd.MM.yyyy')}`;
  }
  const base = sd ? format(new Date(sd), 'dd.MM.yyyy') : format(new Date(note.note_date), 'dd.MM.yyyy');
  if (note.is_full_day) return t('notes.fullDaySuffix', { date: base });
  if (note.start_time) return `${base} · ${note.start_time}${note.end_time ? '–'+note.end_time : ''}`;
  return base;
}

export function NotesPage() {
  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  const [notes, setNotes]           = useState<Note[]>([]);
  const [drivers, setDrivers]       = useState<Driver[]>([]);
  const [cars, setCars]             = useState<Car[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showModal, setShowModal]   = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDriver, setSelectedDriver] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [selectedDate, setSelectedDate]   = useState(format(new Date(), 'yyyy-MM-dd'));
  const [selectedMonth, setSelectedMonth] = useState(new Date());
  const [selectedWeek, setSelectedWeek]   = useState(getWeekNumberForDate(new Date()));
  const [weeks, setWeeks] = useState<any[]>([]);
  const { showToast } = useToast();
  // `driver_notes` is gated by the Notizen page right; a refused UPDATE or DELETE
  // is silent (lib/writeOutcome.ts), so the buttons ask the same question.
  const mayEdit = useCompanyScope().can('notes', 'edit');
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  // The fleet the catch-up asks. Null means "nothing to fetch from", which is
  // also what a failed read leaves — and then the button is not drawn, which is
  // the honest outcome either way.
  const [partnerConnection, setPartnerConnection] = useState<{ partner: string; fleet: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; noteId: string }>({ open: false, noteId: '' });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const [formData, setFormData] = useState<FormData>(DEFAULT_FORM);
  // What the dialog showed when a saved note was opened. An edit sends only the
  // provenance fields that differ from it, and the review panel's warning
  // compares against it. Null for a new note.
  const [initialProvenance, setInitialProvenance] = useState<ProvenanceFormValues | null>(null);
  const [initialReviewed, setInitialReviewed] = useState<ReviewedFormValues | null>(null);
  // Account id to the name shown beside a note's author, reviewer and history.
  const [people, setPeople] = useState<Map<string, string>>(new Map());
  const [provBusy, setProvBusy] = useState(false);
  // Notes from the driver app are notes the moment they arrive (owner,
  // 13.10.2026), so there is no inbox. What can still be waiting is one whose
  // driver nobody has linked yet: it is recorded and becomes a note when the
  // link is confirmed. null means "not known" - a failed read must not be drawn
  // as 0, which would claim nothing is waiting.
  const [waitingForLink, setWaitingForLink] = useState<number | null>(null);
  // The catch-up is the one recovery for a ring that never arrived. It ingests
  // notes and Belege together, and it survives the inbox for that reason.
  const { catchUp, fetching, available: canCatchUp } = usePartnerCatchUp(partnerConnection);

  useEffect(() => {
    const w = getWeeksOfMonth(selectedMonth);
    setWeeks(w);
  }, [selectedMonth]);

  useEffect(() => {
    setSelectedDriver('');
    setNotes([]);
    setDrivers([]);
    setCars([]);
    if (companyId) loadData();
  }, [companyId]);

  useEffect(() => {
    if (!companyId) {
      setPartnerConnection(null);
      return;
    }
    void (async () => {
      const { data } = await supabase
        .from('partner_connections')
        .select('partner, external_company_id')
        .eq('company_id', companyId)
        .neq('status', 'revoked')
        .limit(1)
        .maybeSingle();
      const fleet = (data?.external_company_id as string | null)?.trim() ?? '';
      // A connection recorded before the partner answered with an identity has
      // no fleet id, and there is nothing to fetch by — so it is not one.
      setPartnerConnection(data?.partner && fleet !== ''
        ? { partner: data.partner as string, fleet }
        : null);
    })();
  }, [companyId]);

  // A review or a document changes the stored note while its dialog is open;
  // show what is stored. The list entry is the same object the dialog opened
  // with until a reload replaces it, so a dialog nobody touched is left alone.
  useEffect(() => {
    if (!editingNote) return;
    const stored = notes.find(note => note.id === editingNote.id);
    if (stored && stored !== editingNote) setEditingNote(stored);
  }, [notes]);

  const loadWaitingForLink = async () => {
    if (!companyId) {
      setWaitingForLink(null);
      return;
    }
    const { count, error } = await supabase
      .from('partner_note_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'pending');
    setWaitingForLink(error ? null : count ?? 0);
  };

  // Names for the accounts a note names. A failed read leaves them unnamed, which
  // the panel shows as unknown: a missing name is not worth failing the screen for.
  const loadPeople = async () => {
    const { data } = await supabase
      .from('user_profiles')
      .select('user_id, full_name, email')
      .eq('company_id', companyId);
    setPeople(new Map((data ?? []).map((row: { user_id: string; full_name: string | null; email: string | null }) =>
      [row.user_id, row.full_name || row.email || ''] as const)));
  };

  const loadData = async () => {
    try {
      setLoading(true);
      await Promise.all([loadNotes(), loadDrivers(), loadCars(), loadWaitingForLink(), loadPeople()]);
    } catch (error: any) {
      showToast('error', error.message || t('salaries.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const loadNotes = async () => {
    // The plate travels with the note, the way `drivers(name)` already does, so it
    // is shown from the note's own row and does not depend on the separate car
    // list below. The embed names its foreign key rather than the table alone:
    // PostgREST answers 300 for an embed it finds more than one path for, and that
    // would fail the whole list rather than one field. The constraint is created in
    // 20260928120000.
    //
    // This is the only query in the product that reads `car_id`. Every consumer
    // that feeds the planning engine names its columns explicitly
    // (MonatsplanungAssignmentPreview, MonatsplanungStundennachweisPreview,
    // StundennachweisPage, HistoricalWorkingHoursWizard), so no engine input can
    // carry the car.
    const { data, error } = await supabase
      .from('driver_notes')
      .select('*, drivers(name), cars!driver_notes_car_id_fkey(kennzeichen)')
      .eq('company_id', companyId)
      .order('note_date', { ascending: false });
    if (error) throw error;
    setNotes((data || []) as Note[]);
  };

  const loadDrivers = async () => {
    const { data, error } = await supabase
      .from('drivers')
      .select('id, name')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .order('name');
    if (error) throw error;
    setDrivers(data || []);
  };

  // Every car of the company, retired ones included: see carPickerOptions.
  const loadCars = async () => {
    const { data, error } = await supabase
      .from('cars')
      .select('id, kennzeichen, status')
      .eq('company_id', companyId)
      .order('kennzeichen');
    if (error) throw error;
    setCars(data || []);
  };

  // The five incident types must name a vehicle (utils/noteRules.ts). A note
  // saved before that rule, edited without changing its type, keeps its gap.
  const keepsLegacyVehicleGap =
    editingNote !== null && !editingNote.car_id && editingNote.note_type === formData.note_type;
  const vehicleRequired =
    noteVehicleRequired(formData.note_type) && !keepsLegacyVehicleGap;

  // Eight of the ten types fix their own planning effect, and the database
  // refuses a note that says otherwise (driver_notes_behavior_follows_type).
  // `general` and `other` are the operator's own categories. The field is
  // locked only while it already holds what the type says, so a note saved
  // before the rule, whose effect disagrees, can still be corrected here.
  const behaviorLocked =
    !noteBehaviorIsFree(formData.note_type)
    && notePairAllowed(formData.note_type, formData.note_planning_behavior);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.driver_id) {
      showToast('error', t('notes.selectDriver'));
      return;
    }

    if (noteVehicleMissing(formData.note_type, formData.car_id, keepsLegacyVehicleGap)) {
      showToast('error', t('notes.vehicleRequired'));
      return;
    }

    if (!notePairAllowed(formData.note_type, formData.note_planning_behavior)) {
      showToast('error', t('notes.behaviorMismatch'));
      return;
    }

    // A new note sends what was filled in; an edit sends what was changed.
    const provenance = provenancePayload(formData, editingNote ? initialProvenance : null);
    if (!provenance.ok) {
      showToast('error', t(PROVENANCE_PROBLEM_KEYS[provenance.problem]));
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t('common.notAuthenticated'));

      // Resolve the canonical note_date (used for legacy queries)
      const canonicalDate = formData.use_date_range
        ? new Date(formData.start_date + 'T00:00:00').toISOString()
        : new Date(formData.note_date).toISOString();

      const startDate = formData.use_date_range ? formData.start_date : formData.start_date;
      const endDate   = formData.use_date_range ? formData.end_date   : formData.start_date;

      const noteData = {
        driver_id:              formData.driver_id,
        // Optional by design: '' is stored as NULL, not as an empty string, so
        // "no car" stays one value and the foreign key has nothing to resolve.
        car_id:                 formData.car_id || null,
        note_date:              canonicalDate,
        note_text:              formData.note_text.trim(),
        created_by:             user.id,
        company_id:             companyId,
        note_type:              formData.note_type,
        note_planning_behavior: formData.note_planning_behavior,
        is_full_day:            formData.is_full_day,
        start_time:             (!formData.is_full_day && formData.start_time) ? formData.start_time : null,
        end_time:               (!formData.is_full_day && formData.end_time)   ? formData.end_time   : null,
        start_date:             startDate || null,
        end_date:               endDate   || null,
        ...provenance.payload,
      };

      if (editingNote) {
        const outcome = await updateChecked(supabase, 'driver_notes', noteData, q =>
          q.eq('id', editingNote.id).eq('company_id', companyId));
        if (outcome !== 'done') {
          showToast('error', t(outcome === 'refused' ? 'common.writeRefused' : 'common.writeAlreadyGone'));
          if (outcome === 'gone') { handleCloseModal(); loadNotes(); }
          return;
        }
        showToast('success', t('notes.updated'));
      } else {
        const { error } = await supabase
          .from('driver_notes')
          .insert([noteData]);
        if (error) throw error;
        showToast('success', t('notes.added'));
      }

      handleCloseModal();
      loadNotes();
    } catch (error: any) {
      const friendly = provenanceErrorKey(error);
      showToast('error', friendly ? t(friendly) : error.message || t('settings.saveFailed'));
    }
  };

  const handleEdit = (note: Note) => {
    setEditingNote(note);
    const sd = note.start_date ?? format(new Date(note.note_date), 'yyyy-MM-dd');
    const ed = note.end_date   ?? sd;
    const opened: FormData = {
      ...provenanceFormOf(note),
      driver_id:              note.driver_id,
      car_id:                 note.car_id ?? '',
      note_date:              format(new Date(note.note_date), "yyyy-MM-dd'T'HH:mm"),
      start_date:             sd,
      end_date:               ed,
      use_date_range:         sd !== ed,
      note_text:              note.note_text,
      note_type:              note.note_type ?? 'general',
      note_planning_behavior: note.note_planning_behavior ?? 'neutral',
      is_full_day:            note.is_full_day ?? false,
      start_time:             note.start_time ?? '',
      end_time:               note.end_time   ?? '',
    };
    setFormData(opened);
    setInitialProvenance(provenanceFormOf(note));
    setInitialReviewed(reviewedOf(opened));
    setShowModal(true);
  };

  const handleDelete = (id: string) => {
    setDeleteConfirm({ open: true, noteId: id });
  };

  const confirmDeleteNote = async () => {
    const id = deleteConfirm.noteId;
    const evidence = notes.find(note => note.id === id)?.evidence_path;
    setDeleteConfirm({ open: false, noteId: '' });
    try {
      const outcome = await deleteChecked(supabase, 'driver_notes', q =>
        q.eq('id', id).eq('company_id', companyId));
      if (outcome === 'refused') {
        showToast('error', t('common.writeRefused'));
        return;
      }
      if (outcome === 'gone') showToast('error', t('common.writeAlreadyGone'));
      else {
        showToast('success', t('notes.deleted'));
        // The note is gone; a document nobody points at is a personal document nobody can reach.
        if (evidence) void removeEvidenceFile(supabase as unknown as EvidenceClient, evidence);
      }
      loadNotes();
    } catch (error: any) {
      showToast('error', error.message || t('common.errorDelete'));
    }
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingNote(null);
    setFormData(DEFAULT_FORM);
    setInitialProvenance(null);
    setInitialReviewed(null);
  };

  // ── What a saved note says about itself (lib/driverNoteProvenance.ts) ──────
  // The database stamps the reviewer and the time and ignores the request's
  // word on them; these only ask. Each write is checked, because a role without
  // the Notizen right meets a policy that hides the row and answers 200.
  const nameOf = (userId: string | null | undefined): string =>
    (userId && people.get(userId)) || t('notes.prov.unknownPerson');

  const runProvenanceWrite = async (write: () => Promise<'done' | 'refused' | 'gone' | 'reason_missing'>) => {
    setProvBusy(true);
    try {
      const outcome = await write();
      if (outcome === 'reason_missing') showToast('error', t('notes.prov.err.rejectReason'));
      else if (outcome === 'refused') showToast('error', t('common.writeRefused'));
      else if (outcome === 'gone') { showToast('error', t('common.writeAlreadyGone')); handleCloseModal(); }
      else showToast('success', t('notes.prov.saved'));
      await loadNotes();
    } catch (error: any) {
      const friendly = provenanceErrorKey(error);
      showToast('error', friendly ? t(friendly) : error.message || t('settings.saveFailed'));
    } finally {
      setProvBusy(false);
    }
  };

  const handleDecide = (decision: ReviewDecision) => {
    if (!editingNote || !companyId) return;
    void runProvenanceWrite(() => decideNote(supabase, companyId, editingNote.id, decision));
  };

  const handleAttach = async (file: File) => {
    if (!editingNote || !companyId) return;
    setProvBusy(true);
    try {
      const result = await attachEvidence(supabase as unknown as EvidenceClient, {
        companyId, noteId: editingNote.id, file,
      });
      if (result.ok) showToast('success', t('notes.prov.evidence.added'));
      else if (result.problem === 'refused') showToast('error', t('common.writeRefused'));
      else if (result.problem === 'gone') { showToast('error', t('common.writeAlreadyGone')); handleCloseModal(); }
      else showToast('error', t(EVIDENCE_PROBLEM_KEYS[result.problem]));
      await loadNotes();
    } catch (error: any) {
      showToast('error', error.message || t('notes.prov.err.evidenceUpload'));
    } finally {
      setProvBusy(false);
    }
  };

  const handleOpenEvidence = async () => {
    const path = editingNote?.evidence_path;
    if (!path) return;
    const opened = await openEvidence(supabase as unknown as EvidenceClient, path);
    if (!opened) showToast('error', t('notes.prov.err.evidenceOpen'));
  };

  const handleRemoveEvidence = () => {
    const path = editingNote?.evidence_path;
    if (!editingNote || !companyId || !path) return;
    void runProvenanceWrite(() =>
      detachEvidence(supabase as unknown as EvidenceClient, companyId, editingNote.id, path));
  };

  const handleMonthChange = (dir: 'prev' | 'next') => {
    const d = new Date(selectedMonth);
    d.setMonth(d.getMonth() + (dir === 'next' ? 1 : -1));
    setSelectedMonth(d);
  };

  // When note type changes, auto-enable date range for long absence types
  const handleNoteTypeChange = (value: string) => {
    setFormData(prev => ({
      ...prev,
      note_type: value,
      note_planning_behavior: noteBehaviorFor(value) ?? 'neutral',
      use_date_range: RANGE_NOTE_TYPES.has(value) ? true : prev.use_date_range,
    }));
  };

  const handleExportXlsx = async () => {
    setExporting(true);
    setExportError('');
    try {
      const toExport = filteredNotes;
      const driverNameById = new Map(drivers.map(d => [d.id, d.name]));
      const getDriverName = (note: Note) =>
        note.drivers?.name ?? driverNameById.get(note.driver_id) ?? note.driver_id;

      const noteTypeLabel = (type?: string) =>
        ((k => k ? t(k) : (type ?? ''))(NOTE_TYPES.find(nt => nt.value === type)?.label));
      const behaviorLabel = (b?: NotePlanningBehavior) =>
        b ? (PLANNING_BEHAVIOR_LABELS[b] ? t(PLANNING_BEHAVIOR_LABELS[b]) : b) : '';
      const fmtDate = (d?: string | null) => {
        if (!d) return '';
        try { return format(new Date(d), 'dd.MM.yyyy'); } catch { return d; }
      };
      const fmtDateTime = (d?: string) => {
        if (!d) return '';
        try { return format(new Date(d), 'dd.MM.yyyy HH:mm'); } catch { return d; }
      };
      const yesNo = (v?: boolean | null) => v ? t('common.yes') : t('common.no');

      // ── Sheet 1: every note ───────────────────────────────────────────
      // The plate is on this sheet and on no other: it is what a Bußgeldbescheid
      // names, so a record the office cannot get out of the screen would not be a
      // record. Sheet 3 lists planning exclusions, where a car means nothing.
      // This dump carries no statutory form, so its headers follow the UI
      // language like every other label here (CLAUDE.md, "Language").
      const noteSheet: ExportOptions = {
        filename: 'notizen',
        sheetTitle: t('notes.title'),
        moduleName: t('notes.title'),
        columns: [
          { key: 'driver',    label: t('common.driver'),            width: 24 },
          { key: 'vehicle',   label: t('ta.col.vehicle'),           width: 14 },
          { key: 'type',      label: t('notes.noteType'),           width: 18 },
          { key: 'behaviour', label: t('notes.planningBehaviour'),  width: 22 },
          { key: 'noteDate',  label: t('notes.noteDate'),           width: 13 },
          { key: 'startDate', label: t('notes.startDate'),          width: 13 },
          { key: 'endDate',   label: t('notes.endDate'),            width: 13 },
          { key: 'allDay',    label: t('notes.allDay'),             width: 11, align: 'center' },
          { key: 'startTime', label: t('notes.startTime'),          width: 11, align: 'center' },
          { key: 'endTime',   label: t('notes.endTime'),            width: 11, align: 'center' },
          { key: 'text',      label: t('notes.text'),               width: 44 },
          { key: 'createdAt', label: t('notes.createdAt'),          width: 18 },
          { key: 'updatedAt', label: t('notes.updatedAt'),          width: 18 },
          { key: 'createdBy', label: t('notes.createdBy'),          width: 20 },
          { key: 'occurredAt', label: t('notes.prov.occurredAt'),       width: 18 },
          { key: 'reportedAt', label: t('notes.prov.reportedAt'),       width: 18 },
          { key: 'receivedAt', label: t('notes.prov.col.received'),     width: 18 },
          { key: 'source',     label: t('notes.prov.col.source'),       width: 22 },
          { key: 'review',     label: t('notes.prov.col.review'),       width: 14 },
          { key: 'evidence',   label: t('notes.prov.col.evidence'),     width: 10, align: 'center' },
        ],
        rows: toExport.map(note => ({
          driver: getDriverName(note),
          vehicle: note.cars?.kennzeichen ?? '',
          type: noteTypeLabel(note.note_type),
          behaviour: behaviorLabel(note.note_planning_behavior),
          noteDate: fmtDate(note.note_date),
          startDate: fmtDate(note.start_date),
          endDate: fmtDate(note.end_date),
          allDay: yesNo(note.is_full_day),
          startTime: note.start_time ?? '',
          endTime: note.end_time ?? '',
          text: note.note_text,
          createdAt: fmtDateTime(note.created_at),
          updatedAt: fmtDateTime(note.updated_at),
          // A note from the driver app has no user; its author is the driver.
          createdBy: note.submitted_by_name ?? note.created_by ?? '',
          occurredAt: fmtDateTime(note.occurred_at ?? undefined),
          reportedAt: fmtDateTime(note.reported_at ?? undefined),
          receivedAt: fmtDateTime(note.received_at ?? undefined),
          source: t(`notes.prov.source.${entrySourceOf(note)}`),
          review: t(`notes.prov.status.${verificationOf(note)}`),
          evidence: yesNo(Boolean(note.evidence_path)),
        })),
      };

      // ── Sheet 2: the counts ───────────────────────────────────────────
      // One integer column, so Excel can sum and sort them. The old sheet put a
      // timestamp in the same column as the counts, which made every one of them
      // text; the export date is in each sheet's own meta row anyway.
      const driverIds = new Set(toExport.map(n => n.driver_id));
      const countBehavior = (b: NotePlanningBehavior) =>
        toExport.filter(n => n.note_planning_behavior === b).length;
      const countType = (type: string) =>
        toExport.filter(n => n.note_type === type).length;

      const summarySheet: ExportOptions = {
        filename: 'notizen',
        sheetTitle: t('notes.title'),
        moduleName: t('common.summary'),
        columns: [
          { key: 'metric', label: t('notes.metric'),  width: 30 },
          { key: 'value',  label: t('common.value'),  width: 14, align: 'right', type: 'integer' },
        ],
        rows: [
          { metric: t('notes.countTotal'),       value: toExport.length },
          { metric: t('notes.countDrivers'),     value: driverIds.size },
          { metric: t('notes.countExcluded'),    value: countBehavior('exclude_from_plan') },
          { metric: t('notes.countNeutral'),     value: countBehavior('neutral') },
          { metric: t('notes.countRequired'),    value: countBehavior('must_include_in_plan') },
          { metric: t('notes.countSick'),        value: countType('sick') },
          { metric: t('notes.countVacation'),    value: countType('vacation') },
          { metric: t('notes.countUnavailable'), value: countType('off') },
          { metric: t('notes.countOther'),       value: countType('other') },
        ],
      };

      // ── Sheet 3: the notes the planner excludes, when there are any ───
      const excluded = toExport.filter(n => n.note_planning_behavior === 'exclude_from_plan');
      const planSheet: ExportOptions = {
        filename: 'notizen',
        sheetTitle: t('notes.title'),
        moduleName: t('notes.planningRelevant'),
        columns: [
          { key: 'driver', label: t('common.driver'),  width: 24 },
          { key: 'type',   label: 'Typ',               width: 18 },
          { key: 'from',   label: 'Von',               width: 13 },
          { key: 'to',     label: 'Bis',               width: 13 },
          { key: 'time',   label: t('common.time'),    width: 14, align: 'center' },
          { key: 'allDay', label: t('notes.allDay'),   width: 11, align: 'center' },
          { key: 'text',   label: t('notes.text'),     width: 44 },
          { key: 'effect', label: t('notes.effect'),   width: 20 },
        ],
        rows: excluded.map(note => ({
          driver: getDriverName(note),
          type: noteTypeLabel(note.note_type),
          from: fmtDate(note.start_date),
          to: fmtDate(note.end_date),
          time: note.is_full_day
            ? ''
            : [note.start_time, note.end_time].filter(Boolean).join('–'),
          allDay: yesNo(note.is_full_day),
          text: note.note_text,
          effect: t('notes.exclusion'),
        })),
      };

      const today = format(new Date(), 'yyyy-MM-dd');
      exportPicker.sheets(
        'notes',
        `Notizen_${today}.xlsx`,
        // The exclusions sheet is dropped when it would be empty, as it always
        // was: an empty sheet in a workbook reads as "nothing is excluded", which
        // is a claim, and the summary already carries the count.
        planSheet.rows.length > 0
          ? [noteSheet, summarySheet, planSheet]
          : [noteSheet, summarySheet],
      );
    } catch (e) {
      console.error('Notizen export error:', e);
      setExportError(t('notes.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  /*
    The picker's entries. The note being edited is passed in so its own car stays
    selectable when the fleet has retired it, or when the car list failed to load
    — a `<select>` whose value matches no option silently falls back to the first,
    which here would drop the car on the next save.

    `gq.driver.inactive` is '{name} (inaktiv)' / '{name} (inactive)' in both
    dictionaries and is reused as-is because src/i18n belongs to another change;
    a `notes.carInactive` of its own would read better and is worth adding.
  */
  const editingCarId = editingNote?.car_id ?? '';
  const carOptions = carPickerOptions(
    cars,
    editingCarId ? { id: editingCarId, plate: editingNote?.cars?.kennzeichen ?? null } : null,
    plate => t('gq.driver.inactive', { name: plate }),
  );

  const filteredNotes = notes.filter(note => {
    const matchesSearch =
      note.note_text.toLowerCase().includes(searchQuery.toLowerCase()) ||
      note.drivers?.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesDriver = !selectedDriver || note.driver_id === selectedDriver;

    let matchesDate = true;
    if (filterMode === 'date') {
      const sd = note.start_date ?? format(new Date(note.note_date), 'yyyy-MM-dd');
      const ed = note.end_date   ?? sd;
      matchesDate = selectedDate >= sd && selectedDate <= ed;
    } else if (filterMode === 'week') {
      const noteWeek = getWeekNumberForDate(new Date(note.note_date));
      const noteYear = new Date(note.note_date).getFullYear();
      matchesDate = noteWeek === selectedWeek && noteYear === selectedMonth.getFullYear();
    } else if (filterMode === 'month') {
      const noteMonth = new Date(note.note_date).getMonth();
      const noteYear  = new Date(note.note_date).getFullYear();
      matchesDate = noteMonth === selectedMonth.getMonth() && noteYear === selectedMonth.getFullYear();
    }

    return matchesSearch && matchesDriver && matchesDate;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('notes.title')}</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {t('notes.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCatchUp && (
            <Button
              variant="secondary"
              onClick={() => { void (async () => { if (await catchUp()) await loadData(); })(); }}
              disabled={fetching}
              loading={fetching}
              title={t('partner.catchup.hint')}
            >
              <DownloadCloud aria-hidden />
              {t('partner.catchup.action')}
            </Button>
          )}
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={() => void handleExportXlsx()}
              disabled={exporting || filteredNotes.length === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              onMouseEnter={e => { if (!exporting) e.currentTarget.style.background = 'var(--bg-subtle)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
            >
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {exporting ? t('notes.exporting') : t('notes.export')}
            </button>
            {exportError && (
              <span className="text-xs" style={{ color: 'var(--danger)' }}>{exportError}</span>
            )}
            {!exportError && filteredNotes.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('notes.exportHint')}
              </span>
            )}
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg transition-colors"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
          >
            <Plus className="w-5 h-5" />{t('notes.new')}</button>
        </div>
      </div>

      {waitingForLink !== null && waitingForLink > 0 && (
        <Alert tone="caution" title={t('notes.waitingForLink.title', { count: String(waitingForLink) })}>
          {t('notes.waitingForLink.body')}
        </Alert>
      )}

      {/* Filters */}
      <div className="rounded-lg p-4 space-y-4" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" style={{ color: 'var(--text-tertiary)' }} />
            <input
              type="text"
              placeholder={t('notes.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full"
              style={{ ...inputStyle, padding: '0.5rem 0.75rem 0.5rem 2.5rem' }}
            />
          </div>
          <select value={selectedDriver} onChange={(e) => setSelectedDriver(e.target.value)} style={inputStyle}>
            <option value="">{t('common.allDrivers')}</option>
            {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5" style={{ color: 'var(--text-tertiary)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('notes.timeFilter')}</span>
            <div className="flex gap-2">
              {(['all','date','week','month'] as FilterMode[]).map(mode => (
                <button key={mode}
                  onClick={() => setFilterMode(mode)}
                  className="px-3 py-1 text-sm rounded-lg transition-colors"
                  style={filterMode === mode
                    ? { background: 'var(--accent)', color: 'var(--text-inverse)' }
                    : { background: 'var(--bg-muted)', color: 'var(--text-secondary)' }}
                >
                  {mode === 'all' ? t('common.all') : mode === 'date' ? t('common.date') : mode === 'week' ? t('common.week') : t('common.month')}
                </button>
              ))}
            </div>
          </div>

          {filterMode === 'date' && (
            <div className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-subtle)' }}>
              <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} style={inputStyle} />
              <button onClick={() => setSelectedDate(format(new Date(), 'yyyy-MM-dd'))}
                className="px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              >{t('common.today')}</button>
            </div>
          )}

          {(filterMode === 'week' || filterMode === 'month') && (
            <div className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-subtle)' }}>
              <button onClick={() => handleMonthChange('prev')} className="p-2 rounded-lg"
                style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}
              ><ChevronLeft className="w-4 h-4" /></button>
              <div className="text-center min-w-[140px]">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {selectedMonth.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}
                </div>
              </div>
              <button onClick={() => handleMonthChange('next')} className="p-2 rounded-lg"
                style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}
              ><ChevronRight className="w-4 h-4" /></button>
              <button
                onClick={() => { setSelectedMonth(new Date()); setSelectedWeek(getWeekNumberForDate(new Date())); }}
                className="px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              >{t('common.today')}</button>
              {filterMode === 'week' && (
                <select value={selectedWeek} onChange={e => setSelectedWeek(Number(e.target.value))} style={inputStyle}>
                  {weeks.map(w => <option key={w.weekNumber} value={w.weekNumber}>{w.label}</option>)}
                </select>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Notes list */}
      {loading ? (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
          <p className="mt-2" style={{ color: 'var(--text-tertiary)' }}>{t('werkstatt.loading')}</p>
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="text-center py-12 rounded-lg" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <StickyNote className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-tertiary)' }} />
          <p style={{ color: 'var(--text-tertiary)' }}>
            {searchQuery || selectedDriver ? t('notes.noneFound') : t('notes.noneYet')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredNotes.map(note => (
            <div key={note.id} className="rounded-lg p-4 hover:shadow-md transition-shadow"
              style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <h3 className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {note.drivers?.name}
                    </h3>
                    {note.note_type && note.note_type !== 'general' && (
                      <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: 'var(--bg-muted)', color: 'var(--text-tertiary)' }}>
                        {(k => k ? t(k) : note.note_type)(NOTE_TYPES.find(nt => nt.value === note.note_type)?.label)}
                      </span>
                    )}
                    {/*
                      The plate, when the note names a car. The classes carry the
                      legacy variables instead of an inline style object because
                      this screen is not converted yet and the style ratchet is at
                      its baseline (PlatformTeamPage does the same).
                      Shown from the note's own joined row, so a plate is never
                      guessed: no car, or a plate that did not load, shows nothing.
                    */}
                    {note.submitted_by_name && (
                      <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-[var(--bg-muted)] text-[var(--text-secondary)]">
                        {t('notes.fromApp')}
                      </span>
                    )}
                    {note.cars?.kennzeichen && (
                      <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-[var(--bg-muted)] text-[var(--text-secondary)]">
                        {note.cars.kennzeichen}
                      </span>
                    )}
                    {/* A reviewed or rejected note says so. An unreviewed incident says so too:
                        "a Blitzer somebody typed" must not read as one a document backs. */}
                    {verificationOf(note) === 'verified' && (
                      <Badge tone="positive">{t('notes.prov.status.verified')}</Badge>
                    )}
                    {verificationOf(note) === 'rejected' && (
                      <Badge tone="critical">{t('notes.prov.status.rejected')}</Badge>
                    )}
                    {verificationOf(note) === 'unverified'
                      && (INCIDENT_NOTE_TYPES as readonly string[]).includes(note.note_type ?? '') && (
                      <Badge>{t('notes.prov.status.unverified')}</Badge>
                    )}
                    {note.evidence_path && (
                      <Badge tone="brand"><Paperclip aria-hidden />{t('notes.prov.chip.evidence')}</Badge>
                    )}
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{noteDateLabel(note, t)}</p>
                  {note.occurred_at && (
                    <p className="text-xs text-[var(--text-tertiary)]">
                      {t('notes.prov.occurredLine', { date: momentLabel(note.occurred_at) })}
                    </p>
                  )}
                  {note.note_planning_behavior && note.note_planning_behavior !== 'neutral' && (
                    <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium"
                      style={note.note_planning_behavior === 'exclude_from_plan'
                        ? { background: 'var(--danger-subtle)', color: 'var(--danger)' }
                        : { background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
                      {t(PLANNING_BEHAVIOR_LABELS[note.note_planning_behavior])}
                    </span>
                  )}
                </div>
                {mayEdit && <div className="flex gap-2 ml-2 flex-shrink-0">
                  <button onClick={() => handleEdit(note)} className="p-1 rounded" style={{ color: 'var(--accent-text)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}>
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(note.id)} className="p-1 rounded" style={{ color: 'var(--danger)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--danger-subtle)')}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>}
              </div>
              {note.note_text ? (
                <p className="text-sm whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>
                  {note.note_text}
                </p>
              ) : (
                <p className="text-sm italic" style={{ color: 'var(--text-tertiary)' }}>
                  {(k => k ? t(k) : t('notes.one'))(NOTE_TYPES.find(nt => nt.value === note.note_type)?.label)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Modal */}

      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-lg)' }}>
            <div className="flex items-center justify-between p-6" style={{ borderBottom: '1px solid var(--border)' }}>
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                {editingNote ? t('notes.edit') : t('notes.new')}
              </h2>
              <button onClick={handleCloseModal} style={{ color: 'var(--text-tertiary)' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}>
                <X className="w-6 h-6" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {/* Driver */}
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                  {t('notes.driverRequired')}
                </label>
                <select value={formData.driver_id}
                  onChange={e => setFormData(p => ({ ...p, driver_id: e.target.value }))}
                  className="w-full" style={inputStyle} required>
                  <option value="">{t('notes.pickDriver')}</option>
                  {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>

              {/* Note type + planning behavior */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                    {t('notes.noteTypeLabel')}
                  </label>
                  <select value={formData.note_type} onChange={e => handleNoteTypeChange(e.target.value)}
                    className="w-full" style={inputStyle}>
                    {NOTE_TYPES.map(nt => <option key={nt.value} value={nt.value}>{t(nt.label)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('notes.planningBehaviour')}</label>
                  <select value={formData.note_planning_behavior}
                    onChange={e => setFormData(p => ({ ...p, note_planning_behavior: e.target.value as NotePlanningBehavior }))}
                    disabled={behaviorLocked}
                    aria-describedby={behaviorLocked ? 'note-behavior-hint' : undefined}
                    className="w-full disabled:cursor-not-allowed disabled:opacity-60" style={inputStyle}>
                    <option value="neutral">{t('notes.effect.none')}</option>
                    <option value="exclude_from_plan">{t('notes.effect.exclude')}</option>
                    <option value="must_include_in_plan">{t('notes.effect.require')}</option>
                  </select>
                </div>
                {/* Its own full-width row: inside the second column the sentence
                    would wrap into a tall strip on a phone. */}
                {behaviorLocked && (
                  <p id="note-behavior-hint" className="col-span-2 text-xs text-[var(--text-tertiary)]">
                    {t('notes.behaviorFixed')}
                  </p>
                )}
              </div>

              {/*
                Car — optional. It records which vehicle an incident happened on,
                so a ticket addressed to a plate can be tied back to the
                Fahrtenbuch. A picker over the company's own cars, never free
                text, so the stored value is a key and not two spellings of one
                plate. The plain `<select>` matches the four already on this
                screen — it is not converted to the design system, and its inline
                styles sit exactly at the ratchet's baseline, so the legacy look is
                carried in classes here. Never the Radix `Select`, whose
                `onValueChange` would rewrite this handler.
              */}
              <div>
                <label htmlFor="note-car" className="block text-sm font-medium mb-2 text-[var(--text-secondary)]">
                  {t('ta.col.vehicle')}{' '}
                  {vehicleRequired
                    ? <span aria-hidden className="text-[var(--danger)]">*</span>
                    : <span className="font-normal text-[var(--text-tertiary)]">{t('notes.descriptionOptional')}</span>}
                </label>
                <select
                  id="note-car"
                  required={vehicleRequired}
                  value={formData.car_id}
                  onChange={e => setFormData(p => ({ ...p, car_id: e.target.value }))}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
                >
                  <option value="">{t('imp.optionNoCar')}</option>
                  {carOptions.map(option => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </div>

              {/* Date range toggle */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={formData.use_date_range}
                    onChange={e => setFormData(p => ({ ...p, use_date_range: e.target.checked }))}
                    className="w-4 h-4" />
                  {t('notes.dateRange')}
                </label>

                {formData.use_date_range ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('notes.startDateReq')}</label>
                      <input type="date" value={formData.start_date}
                        onChange={e => setFormData(p => ({ ...p, start_date: e.target.value }))}
                        className="w-full" style={inputStyle} required />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('notes.endDateReq')}</label>
                      <input type="date" value={formData.end_date}
                        onChange={e => setFormData(p => ({ ...p, end_date: e.target.value }))}
                        min={formData.start_date}
                        className="w-full" style={inputStyle} required />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('notes.dateReq')}</label>
                    <input type="date" value={formData.start_date}
                      onChange={e => setFormData(p => ({ ...p, start_date: e.target.value, end_date: e.target.value, note_date: e.target.value + 'T' + (formData.note_date.split('T')[1] || '00:00') }))}
                      className="w-full" style={inputStyle} required />
                  </div>
                )}
              </div>

              {/* Full day + time (only for single-day or must_include) */}
              {!formData.use_date_range && (
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 cursor-pointer text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={formData.is_full_day}
                      onChange={e => setFormData(p => ({ ...p, is_full_day: e.target.checked, start_time: '', end_time: '' }))}
                      className="w-4 h-4" />
                    {t('notes.fullDay')}
                  </label>
                  {!formData.is_full_day && (
                    <div className="flex items-center gap-2 flex-1">
                      <div className="flex-1">
                        <label className="block text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('notes.from')}</label>
                        <input type="time" value={formData.start_time}
                          onChange={e => setFormData(p => ({ ...p, start_time: e.target.value }))}
                          style={inputStyle} className="w-full" />
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('notes.to')}</label>
                        <input type="time" value={formData.end_time}
                          onChange={e => setFormData(p => ({ ...p, end_time: e.target.value }))}
                          style={inputStyle} className="w-full" />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* For date-range exclude notes: full day applies to each day in range */}
              {formData.use_date_range && formData.note_planning_behavior === 'exclude_from_plan' && (
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 cursor-pointer text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={formData.is_full_day}
                      onChange={e => setFormData(p => ({ ...p, is_full_day: e.target.checked }))}
                      className="w-4 h-4" />
                    {t('notes.fullDayEachDay')}
                  </label>
                </div>
              )}

              {/* Description — optional */}
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                  {t('common.description')} <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>{t('notes.descriptionOptional')}</span>
                </label>
                <textarea
                  value={formData.note_text}
                  onChange={e => setFormData(p => ({ ...p, note_text: e.target.value }))}
                  rows={4}
                  className="w-full resize-none"
                  style={inputStyle}
                  placeholder={t('notes.descPlaceholder')}
                />
              </div>

              {eventDetailsApply(formData.note_type) && (
                <NoteProvenanceFields
                  values={formData}
                  onChange={patch => setFormData(p => ({ ...p, ...patch }))}
                />
              )}

              {editingNote ? (
                <NoteReviewPanel
                  provenance={editingNote}
                  authorName={editingNote.submitted_by_name ?? nameOf(editingNote.created_by)}
                  nameOf={nameOf}
                  mayEdit={mayEdit}
                  evidenceOffered={eventDetailsApply(formData.note_type)}
                  busy={provBusy}
                  willReset={initialReviewed !== null && reviewedFieldsChanged(initialReviewed, reviewedOf(formData))}
                  onDecide={handleDecide}
                  onAttach={file => void handleAttach(file)}
                  onOpenEvidence={() => void handleOpenEvidence()}
                  onRemoveEvidence={handleRemoveEvidence}
                />
              ) : (
                <p className="text-xs text-[var(--text-tertiary)]">{t('notes.prov.saveFirst')}</p>
              )}

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={handleCloseModal}
                  className="flex-1 px-4 py-2 rounded-lg transition-colors"
                  style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>{t('common.cancel')}</button>
                <button type="submit"
                  className="flex-1 px-4 py-2 rounded-lg transition-colors"
                  style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}>
                  {editingNote ? t('common.update') : t('common.add')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <ConfirmationModal
        isOpen={deleteConfirm.open}
        onClose={() => setDeleteConfirm({ open: false, noteId: '' })}
        onConfirm={confirmDeleteNote}
        title={t('notes.deleteTitle')}
        message={t('notes.deleteConfirm')}
        type="confirm"
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
      />
    </div>
  );
}
