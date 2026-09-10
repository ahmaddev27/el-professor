import React, { useState, useEffect } from 'react';
import { Plus, Search, Trash2, CreditCard as Edit2, X, StickyNote, Calendar, ChevronLeft, ChevronRight, Download, Loader2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import ConfirmationModal from '../components/ConfirmationModal';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { format } from 'date-fns';
import { getWeeksOfMonth, getWeekNumberForDate } from '../utils/weekCalculations';
import { useSuperAdmin } from '../contexts/SuperAdminContext';

interface Driver {
  id: string;
  name: string;
}

type NotePlanningBehavior = 'neutral' | 'exclude_from_plan' | 'must_include_in_plan';

interface Note {
  id: string;
  driver_id: string;
  note_date: string;
  note_text: string;
  created_at: string;
  updated_at?: string;
  created_by?: string;
  note_type?: string;
  note_planning_behavior?: NotePlanningBehavior;
  is_full_day?: boolean;
  start_time?: string | null;
  end_time?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  drivers?: { name: string };
}

const NOTE_TYPES = [
  { value: 'general',   label: 'Allgemeine Notiz',       behavior: 'neutral'              as NotePlanningBehavior },
  { value: 'sick',      label: 'Krank',                  behavior: 'exclude_from_plan'    as NotePlanningBehavior },
  { value: 'vacation',  label: 'Urlaub',                 behavior: 'exclude_from_plan'    as NotePlanningBehavior },
  { value: 'off',       label: 'Frei / Nicht verfügbar', behavior: 'exclude_from_plan'    as NotePlanningBehavior },
  { value: 'blitzer',   label: 'Blitzer',                behavior: 'must_include_in_plan' as NotePlanningBehavior },
  { value: 'accident',  label: 'Unfall',                 behavior: 'must_include_in_plan' as NotePlanningBehavior },
  { value: 'kontrolle', label: 'Kontrolle',              behavior: 'must_include_in_plan' as NotePlanningBehavior },
  { value: 'breakdown', label: 'Panne',                  behavior: 'must_include_in_plan' as NotePlanningBehavior },
  { value: 'wait',      label: 'Wartezeit',              behavior: 'must_include_in_plan' as NotePlanningBehavior },
  { value: 'other',     label: 'Sonstiges',              behavior: 'neutral'              as NotePlanningBehavior },
];

const PLANNING_BEHAVIOR_LABELS: Record<NotePlanningBehavior, string> = {
  neutral:              'Keine Auswirkung',
  exclude_from_plan:    'Von Planung ausschließen',
  must_include_in_plan: 'Muss im Plan enthalten sein',
};

// Types that typically span multiple days (suggest date range UI)
const RANGE_NOTE_TYPES = new Set(['sick', 'vacation', 'off']);

type FilterMode = 'all' | 'date' | 'week' | 'month';

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  padding: '0.5rem 0.75rem',
  outline: 'none',
};

interface FormData {
  driver_id: string;
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
  driver_id:              '',
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

function noteDisplayLabel(note: Note): string {
  if (note.note_text.trim()) return note.note_text;
  const nt = NOTE_TYPES.find(t => t.value === note.note_type);
  return nt?.label ?? 'Notiz';
}

function noteDateLabel(note: Note): string {
  const sd = note.start_date;
  const ed = note.end_date;
  if (sd && ed && sd !== ed) {
    return `${format(new Date(sd), 'dd.MM.yyyy')} – ${format(new Date(ed), 'dd.MM.yyyy')}`;
  }
  const base = sd ? format(new Date(sd), 'dd.MM.yyyy') : format(new Date(note.note_date), 'dd.MM.yyyy');
  if (note.is_full_day) return `${base} (Ganzer Tag)`;
  if (note.start_time) return `${base} · ${note.start_time}${note.end_time ? '–'+note.end_time : ''}`;
  return base;
}

export function NotesPage() {
  const [notes, setNotes]           = useState<Note[]>([]);
  const [drivers, setDrivers]       = useState<Driver[]>([]);
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
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; noteId: string }>({ open: false, noteId: '' });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const [formData, setFormData] = useState<FormData>(DEFAULT_FORM);

  useEffect(() => {
    const w = getWeeksOfMonth(selectedMonth);
    setWeeks(w);
  }, [selectedMonth]);

  useEffect(() => {
    setSelectedDriver('');
    setNotes([]);
    setDrivers([]);
    if (companyId) loadData();
  }, [companyId]);

  const loadData = async () => {
    try {
      setLoading(true);
      await Promise.all([loadNotes(), loadDrivers()]);
    } catch (error: any) {
      showToast('error', error.message || 'Fehler beim Laden der Daten');
    } finally {
      setLoading(false);
    }
  };

  const loadNotes = async () => {
    const { data, error } = await supabase
      .from('driver_notes')
      .select('*, drivers(name)')
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.driver_id) {
      showToast('error', 'Bitte Fahrer auswählen');
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Nicht authentifiziert');

      // Resolve the canonical note_date (used for legacy queries)
      const canonicalDate = formData.use_date_range
        ? new Date(formData.start_date + 'T00:00:00').toISOString()
        : new Date(formData.note_date).toISOString();

      const startDate = formData.use_date_range ? formData.start_date : formData.start_date;
      const endDate   = formData.use_date_range ? formData.end_date   : formData.start_date;

      const noteData = {
        driver_id:              formData.driver_id,
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
      };

      if (editingNote) {
        const { error } = await supabase
          .from('driver_notes')
          .update(noteData)
          .eq('id', editingNote.id)
          .eq('company_id', companyId);
        if (error) throw error;
        showToast('success', 'Notiz erfolgreich aktualisiert');
      } else {
        const { error } = await supabase
          .from('driver_notes')
          .insert([noteData]);
        if (error) throw error;
        showToast('success', 'Notiz erfolgreich hinzugefügt');
      }

      handleCloseModal();
      loadNotes();
    } catch (error: any) {
      showToast('error', error.message || 'Fehler beim Speichern');
    }
  };

  const handleEdit = (note: Note) => {
    setEditingNote(note);
    const sd = note.start_date ?? format(new Date(note.note_date), 'yyyy-MM-dd');
    const ed = note.end_date   ?? sd;
    setFormData({
      driver_id:              note.driver_id,
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
    });
    setShowModal(true);
  };

  const handleDelete = (id: string) => {
    setDeleteConfirm({ open: true, noteId: id });
  };

  const confirmDeleteNote = async () => {
    const id = deleteConfirm.noteId;
    setDeleteConfirm({ open: false, noteId: '' });
    try {
      const { error } = await supabase
        .from('driver_notes')
        .delete()
        .eq('id', id)
        .eq('company_id', companyId);
      if (error) throw error;
      showToast('success', 'Notiz erfolgreich gelöscht');
      loadNotes();
    } catch (error: any) {
      showToast('error', error.message || 'Fehler beim Löschen');
    }
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingNote(null);
    setFormData(DEFAULT_FORM);
  };

  const handleMonthChange = (dir: 'prev' | 'next') => {
    const d = new Date(selectedMonth);
    d.setMonth(d.getMonth() + (dir === 'next' ? 1 : -1));
    setSelectedMonth(d);
  };

  // When note type changes, auto-enable date range for long absence types
  const handleNoteTypeChange = (value: string) => {
    const nt = NOTE_TYPES.find(n => n.value === value);
    setFormData(prev => ({
      ...prev,
      note_type: value,
      note_planning_behavior: nt?.behavior ?? 'neutral',
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
        NOTE_TYPES.find(t => t.value === type)?.label ?? (type ?? '');
      const behaviorLabel = (b?: NotePlanningBehavior) =>
        b ? PLANNING_BEHAVIOR_LABELS[b] ?? b : '';
      const fmtDate = (d?: string | null) => {
        if (!d) return '';
        try { return format(new Date(d), 'dd.MM.yyyy'); } catch { return d; }
      };
      const fmtDateTime = (d?: string) => {
        if (!d) return '';
        try { return format(new Date(d), 'dd.MM.yyyy HH:mm'); } catch { return d; }
      };
      const yesNo = (v?: boolean | null) => v ? 'Ja' : 'Nein';

      // Sheet 1: Notizen
      const notizRows = toExport.map(note => ({
        'Fahrer': getDriverName(note),
        'Notiz-Typ': noteTypeLabel(note.note_type),
        'Planungsverhalten': behaviorLabel(note.note_planning_behavior),
        'Notizdatum': fmtDate(note.note_date),
        'Startdatum': fmtDate(note.start_date),
        'Enddatum': fmtDate(note.end_date),
        'Ganztägig': yesNo(note.is_full_day),
        'Startzeit': note.start_time ?? '',
        'Endzeit': note.end_time ?? '',
        'Notiztext': note.note_text,
        'Erstellt am': fmtDateTime(note.created_at),
        'Aktualisiert am': fmtDateTime(note.updated_at),
        'Erstellt von': note.created_by ?? '',
      }));

      // Sheet 2: Zusammenfassung
      const driverIds = new Set(toExport.map(n => n.driver_id));
      const countBehavior = (b: NotePlanningBehavior) => toExport.filter(n => n.note_planning_behavior === b).length;
      const countType = (t: string) => toExport.filter(n => n.note_type === t).length;
      const summaryRows = [
        { 'Kennzahl': 'Exportdatum', 'Wert': fmtDateTime(new Date().toISOString()) },
        { 'Kennzahl': 'Anzahl Notizen gesamt', 'Wert': toExport.length },
        { 'Kennzahl': 'Anzahl Fahrer mit Notizen', 'Wert': driverIds.size },
        { 'Kennzahl': 'Anzahl Von Planung ausschließen', 'Wert': countBehavior('exclude_from_plan') },
        { 'Kennzahl': 'Anzahl Neutral', 'Wert': countBehavior('neutral') },
        { 'Kennzahl': 'Anzahl Muss im Plan enthalten sein', 'Wert': countBehavior('must_include_in_plan') },
        { 'Kennzahl': 'Anzahl Krank', 'Wert': countType('sick') },
        { 'Kennzahl': 'Anzahl Urlaub', 'Wert': countType('vacation') },
        { 'Kennzahl': 'Anzahl Frei / Nicht verfügbar', 'Wert': countType('off') },
        { 'Kennzahl': 'Anzahl Sonstiges', 'Wert': countType('other') },
      ];

      // Sheet 3: Planungsrelevant
      const planRows = toExport
        .filter(n => n.note_planning_behavior === 'exclude_from_plan')
        .map(note => {
          const sd = fmtDate(note.start_date);
          const ed = fmtDate(note.end_date);
          const timeStr = note.is_full_day ? '' : [note.start_time, note.end_time].filter(Boolean).join('–');
          return {
            'Fahrer': getDriverName(note),
            'Typ': noteTypeLabel(note.note_type),
            'Von': sd,
            'Bis': ed,
            'Zeit': timeStr,
            'Ganztägig': yesNo(note.is_full_day),
            'Notiztext': note.note_text,
            'Wirkung': 'Ausschluss von der Planung',
          };
        });

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(notizRows), 'Notizen');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Zusammenfassung');
      if (planRows.length > 0) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(planRows), 'Planungsrelevant');
      }

      const today = format(new Date(), 'yyyy-MM-dd');
      XLSX.writeFile(wb, `Notizen_${today}.xlsx`);
    } catch (e) {
      console.error('Notizen export error:', e);
      setExportError('Notizen konnten nicht exportiert werden.');
    } finally {
      setExporting(false);
    }
  };

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
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Notizen</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
            Fahrer-Notizen verwalten und durchsuchen
          </p>
        </div>
        <div className="flex items-center gap-2">
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
              {exporting ? 'Export wird erstellt...' : 'Notizen exportieren'}
            </button>
            {exportError && (
              <span className="text-xs" style={{ color: 'var(--danger)' }}>{exportError}</span>
            )}
            {!exportError && filteredNotes.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                Exportiert die aktuell gefilterten Notizen.
              </span>
            )}
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg transition-colors"
            style={{ background: 'var(--accent)', color: 'white' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
          >
            <Plus className="w-5 h-5" />
            Neue Notiz
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-lg p-4 space-y-4" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5" style={{ color: 'var(--text-tertiary)' }} />
            <input
              type="text"
              placeholder="Notizen durchsuchen..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full"
              style={{ ...inputStyle, padding: '0.5rem 0.75rem 0.5rem 2.5rem' }}
            />
          </div>
          <select value={selectedDriver} onChange={(e) => setSelectedDriver(e.target.value)} style={inputStyle}>
            <option value="">Alle Fahrer</option>
            {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5" style={{ color: 'var(--text-tertiary)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Zeitfilter:</span>
            <div className="flex gap-2">
              {(['all','date','week','month'] as FilterMode[]).map(mode => (
                <button key={mode}
                  onClick={() => setFilterMode(mode)}
                  className="px-3 py-1 text-sm rounded-lg transition-colors"
                  style={filterMode === mode
                    ? { background: 'var(--accent)', color: 'white' }
                    : { background: 'var(--bg-muted)', color: 'var(--text-secondary)' }}
                >
                  {mode === 'all' ? 'Alle' : mode === 'date' ? 'Datum' : mode === 'week' ? 'Woche' : 'Monat'}
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
              >Heute</button>
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
              >Heute</button>
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
          <p className="mt-2" style={{ color: 'var(--text-tertiary)' }}>Laden...</p>
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="text-center py-12 rounded-lg" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <StickyNote className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-tertiary)' }} />
          <p style={{ color: 'var(--text-tertiary)' }}>
            {searchQuery || selectedDriver ? 'Keine Notizen gefunden' : 'Noch keine Notizen vorhanden'}
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
                        {NOTE_TYPES.find(t => t.value === note.note_type)?.label ?? note.note_type}
                      </span>
                    )}
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{noteDateLabel(note)}</p>
                  {note.note_planning_behavior && note.note_planning_behavior !== 'neutral' && (
                    <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium"
                      style={note.note_planning_behavior === 'exclude_from_plan'
                        ? { background: 'var(--danger-subtle)', color: 'var(--danger)' }
                        : { background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
                      {PLANNING_BEHAVIOR_LABELS[note.note_planning_behavior]}
                    </span>
                  )}
                </div>
                <div className="flex gap-2 ml-2 flex-shrink-0">
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
                </div>
              </div>
              {note.note_text ? (
                <p className="text-sm whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>
                  {note.note_text}
                </p>
              ) : (
                <p className="text-sm italic" style={{ color: 'var(--text-tertiary)' }}>
                  {NOTE_TYPES.find(t => t.value === note.note_type)?.label ?? 'Notiz'}
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
                {editingNote ? 'Notiz bearbeiten' : 'Neue Notiz'}
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
                  Fahrer *
                </label>
                <select value={formData.driver_id}
                  onChange={e => setFormData(p => ({ ...p, driver_id: e.target.value }))}
                  className="w-full" style={inputStyle} required>
                  <option value="">Fahrer auswählen</option>
                  {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>

              {/* Note type + planning behavior */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                    Notiztyp
                  </label>
                  <select value={formData.note_type} onChange={e => handleNoteTypeChange(e.target.value)}
                    className="w-full" style={inputStyle}>
                    {NOTE_TYPES.map(nt => <option key={nt.value} value={nt.value}>{nt.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                    Planungsverhalten
                  </label>
                  <select value={formData.note_planning_behavior}
                    onChange={e => setFormData(p => ({ ...p, note_planning_behavior: e.target.value as NotePlanningBehavior }))}
                    className="w-full" style={inputStyle}>
                    <option value="neutral">Keine Auswirkung</option>
                    <option value="exclude_from_plan">Von Planung ausschließen</option>
                    <option value="must_include_in_plan">Muss im Plan enthalten sein</option>
                  </select>
                </div>
              </div>

              {/* Date range toggle */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={formData.use_date_range}
                    onChange={e => setFormData(p => ({ ...p, use_date_range: e.target.checked }))}
                    className="w-4 h-4" />
                  Zeitraum (mehrere Tage)
                </label>

                {formData.use_date_range ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>Startdatum *</label>
                      <input type="date" value={formData.start_date}
                        onChange={e => setFormData(p => ({ ...p, start_date: e.target.value }))}
                        className="w-full" style={inputStyle} required />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>Enddatum *</label>
                      <input type="date" value={formData.end_date}
                        onChange={e => setFormData(p => ({ ...p, end_date: e.target.value }))}
                        min={formData.start_date}
                        className="w-full" style={inputStyle} required />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>Datum *</label>
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
                    Ganzer Tag
                  </label>
                  {!formData.is_full_day && (
                    <div className="flex items-center gap-2 flex-1">
                      <div className="flex-1">
                        <label className="block text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>Von</label>
                        <input type="time" value={formData.start_time}
                          onChange={e => setFormData(p => ({ ...p, start_time: e.target.value }))}
                          style={inputStyle} className="w-full" />
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>Bis</label>
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
                    Ganzer Tag (gilt für jeden Tag im Zeitraum)
                  </label>
                </div>
              )}

              {/* Description — optional */}
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                  Beschreibung <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span>
                </label>
                <textarea
                  value={formData.note_text}
                  onChange={e => setFormData(p => ({ ...p, note_text: e.target.value }))}
                  rows={4}
                  className="w-full resize-none"
                  style={inputStyle}
                  placeholder="Beschreibung eingeben (optional)..."
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={handleCloseModal}
                  className="flex-1 px-4 py-2 rounded-lg transition-colors"
                  style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  Abbrechen
                </button>
                <button type="submit"
                  className="flex-1 px-4 py-2 rounded-lg transition-colors"
                  style={{ background: 'var(--accent)', color: 'white' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}>
                  {editingNote ? 'Aktualisieren' : 'Hinzufügen'}
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
        title="Notiz löschen"
        message="Sind Sie sicher, dass Sie diese Notiz löschen möchten?"
        type="confirm"
        confirmText="Löschen"
        cancelText="Abbrechen"
      />
    </div>
  );
}
