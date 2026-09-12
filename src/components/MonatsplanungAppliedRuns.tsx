import { useCallback, useEffect, useMemo, useState, Component, type ReactNode, type ErrorInfo } from 'react';
import {
  Archive,
  CalendarClock,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  X,
  AlertTriangle,
  AlertCircle,
  Hash,
  Clock,
  Sparkles,
  Trash2,
} from 'lucide-react';
import MonatsplanungStundennachweisPreview from './MonatsplanungStundennachweisPreview';
import FinalizePlanningModal from './FinalizePlanningModal';
import {
  fetchAppliedRuns,
  exportAppliedRunXlsx,
  validateAppliedRun,
  type AppliedRunSummary,
  type ExportValidation,
  type ExportMode,
} from '../utils/monatsplanungXlsxExport';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

/** A class component cannot call the hook, so the resolver arrives as a prop. */
type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

interface ErrorBoundaryProps { children: ReactNode; onBack: () => void; t: Translate }

class StundennachweisErrorBoundary extends Component<
  ErrorBoundaryProps,
  { error: Error | null }
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[StundennachweisPreview]', error, info); }
  render() {
    const { t } = this.props;
    if (this.state.error) {
      return (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.7)' }}>
          <div className="rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} style={{ color: '#f87171' }} />
              <h3 className="text-base font-semibold" style={{ color: '#f87171' }}>{t('mp.runs.previewCrashTitle')}</h3>
            </div>
            <p className="text-xs rounded px-3 py-2.5 font-mono break-all" style={{ background: 'rgba(248,113,113,0.08)', color: '#fca5a5', border: '1px solid rgba(248,113,113,0.2)' }}>
              {this.state.error.message}
            </p>
            <div className="flex gap-2 pt-1">
              <button onClick={this.props.onBack} className="flex-1 px-3 py-2 rounded text-sm font-medium" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                {t('common.back')}
              </button>
              <button onClick={() => { this.setState({ error: null }); }} className="flex-1 px-3 py-2 rounded text-sm font-medium" style={{ background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.3)' }}>
                {t('mp.runs.reload')}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface Props {
  companyId: string;
  reloadToken?: number;
  /** If set, the run with this ID had a transfer applied after finalization → mark stale. */
  staleRunId?: string;
}

interface PurgeResult {
  deleted_count: number;
  skipped_count: number;
  skipped: { id: string; reason: string; detail: string }[];
}

interface FinalizationRecord {
  id: string;
  planning_run_id: string;
  finalized_at: string;
  trip_count: number;
  driver_count: number;
  is_stale: boolean;
  stale_reason: string | null;
}

// Month names are TranslationKeys: this list is module-level and t() is a hook
// value. Every consumer resolves it.
const MONTH_KEYS: TranslationKey[] = [
  'doc.month.january', 'doc.month.february', 'doc.month.march', 'doc.month.april',
  'doc.month.may', 'doc.month.june', 'doc.month.july', 'doc.month.august',
  'doc.month.september', 'doc.month.october', 'doc.month.november', 'doc.month.december',
];

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function readNumberFromJson(obj: Record<string, unknown> | null, key: string): number | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === 'number' ? v : null;
}

function readBoolFromJson(obj: Record<string, unknown> | null, key: string): boolean | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === 'boolean' ? v : null;
}

export default function MonatsplanungAppliedRuns({ companyId, reloadToken, staleRunId }: Props) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [runs, setRuns] = useState<AppliedRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [activeRun, setActiveRun] = useState<AppliedRunSummary | null>(null);
  const [validation, setValidation] = useState<ExportValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string>('');
  const [exportMode, setExportMode] = useState<ExportMode>('original');
  const [stundenRun, setStundenRun] = useState<AppliedRunSummary | null>(null);
  const [finalizeRun, setFinalizeRun] = useState<AppliedRunSummary | null>(null);
  // Map of planning_run_id → latest finalization record
  const [finalizations, setFinalizations] = useState<Map<string, FinalizationRecord>>(new Map());
  // Set when a transfer is applied inside the Stundennachweis preview → triggers stale marking
  const [transferStaleRunId, setTransferStaleRunId] = useState<string | undefined>(undefined);

  // Delete single run state
  const [deleteTarget, setDeleteTarget] = useState<AppliedRunSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleteSuccess, setDeleteSuccess] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await fetchAppliedRuns(companyId);
      // Only show active (applied) runs; replaced/archived are hidden from normal view.
      setRuns(list.filter(r => r.status === 'applied'));

      // Load finalization records for this company
      const { data: finData } = await supabase
        .from('planning_finalizations')
        .select('id, planning_run_id, finalized_at, trip_count, driver_count, is_stale, stale_reason')
        .eq('company_id', companyId)
        .order('finalized_at', { ascending: false });

      const finMap = new Map<string, FinalizationRecord>();
      for (const f of (finData ?? []) as FinalizationRecord[]) {
        if (!finMap.has(f.planning_run_id)) finMap.set(f.planning_run_id, f);
      }
      setFinalizations(finMap);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mp.unknownError'));
    } finally {
      setLoading(false);
    }
  }, [companyId, t]);

  useEffect(() => { void reload(); }, [reload, reloadToken]);

  // When a staleRunId is signalled (transfer applied after finalization), mark it stale in DB
  // Note: confirmApply already writes to planning_finalizations directly. This effect just reloads.
  useEffect(() => {
    const runId = staleRunId ?? transferStaleRunId;
    if (!runId) return;
    void reload();
  }, [staleRunId, transferStaleRunId, reload]);

  const openRun = async (run: AppliedRunSummary) => {
    setActiveRun(run);
    setValidation(null);
    setExportError('');
    setExportMode('original');
    setValidating(true);
    try {
      const { validation } = await validateAppliedRun(run);
      setValidation(validation);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : t('mp.runs.validationFailed'));
    } finally {
      setValidating(false);
    }
  };

  const closeRun = () => {
    if (exporting) return;
    setActiveRun(null);
    setValidation(null);
    setExportError('');
  };

  const handleExport = async (run: AppliedRunSummary) => {
    setExporting(true);
    setExportError('');
    try {
      const result = await exportAppliedRunXlsx(run, exportMode);
      setValidation(result.validation);
      if (result.blocked) setExportError(result.blocked.reason);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : t('mp.runs.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  const handleFinalized = useCallback(async (_finalizationId: string) => {
    await reload();
  }, [reload]);

  const handleDeleteRun = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    setDeleteSuccess('');
    try {
      // Never DELETE the row directly. company_planning_runs cascades to
      // planning_finalizations, monthly_planning_manual_exceptions,
      // planning_run_adjustments (Ausgleichsstunden) and
      // company_planning_run_blocks, and sets fahrtenbuch_trips
      // .assignment_planning_run_id to NULL — so a raw delete silently destroys
      // the finalization record and the exception audit of a closed payroll
      // month while leaving the trips assigned but unattributable.
      //
      // delete_or_archive_monthly_planning_run archives instead whenever trips
      // still reference the run, and only deletes when nothing does.
      const { data, error } = await supabase.rpc('delete_or_archive_monthly_planning_run', {
        p_run_id: deleteTarget.id,
      });
      if (error) {
        console.error('Delete planning run error:', error);
        setDeleteError(t('mp.runs.deleteFailedDetail', { error: error.message }));
        return;
      }

      const action = (data as { action?: string; referenced_trips?: number } | null)?.action;
      const referenced = (data as { referenced_trips?: number } | null)?.referenced_trips ?? 0;

      if (action === 'archived') {
        setDeleteSuccess(t('mp.runs.archivedInstead', { count: referenced }));
      } else {
        setDeleteSuccess(t('mp.runs.deleted'));
      }

      // Either way the run leaves the applied list; reload so an archived run
      // shows its real status rather than a stale local guess.
      setDeleteTarget(null);
      await reload();
    } catch (e) {
      console.error('Delete planning run exception:', e);
      setDeleteError(t('mp.runs.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Archive size={16} /> {t('mp.runs.title')}
          </h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {t('mp.runs.subtitle')}
          </p>
        </div>
      </div>

      {deleteSuccess && (
        <div className="px-3 py-2 rounded-lg text-sm mb-3 flex items-center gap-2" style={{ background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }}>
          <CheckCircle2 size={14} /> {deleteSuccess}
        </div>
      )}

      {error && (
        <div className="px-3 py-2 rounded-lg text-sm mb-3" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
          {error}
        </div>
      )}

      {!loading && runs.length === 0 && !error && (
        <div className="px-3 py-6 text-center text-sm rounded-lg" style={{ background: 'var(--bg-subtle)', color: 'var(--text-tertiary)' }}>
          {t('mp.runs.none')}
        </div>
      )}

      {runs.length > 0 && (
        <RunGroups
          runs={runs}
          finalizations={finalizations}
          onOpen={run => void openRun(run)}
          onStundennachweis={run => setStundenRun(run)}
          onFinalize={run => setFinalizeRun(run)}
          onDelete={run => { setDeleteError(''); setDeleteSuccess(''); setDeleteTarget(run); }}
        />
      )}

      {activeRun && (
        <RunDetailModal
          run={activeRun}
          finalization={finalizations.get(activeRun.id) ?? null}
          validation={validation}
          validating={validating}
          exporting={exporting}
          exportError={exportError}
          exportMode={exportMode}
          onModeChange={setExportMode}
          onClose={closeRun}
          onExport={() => void handleExport(activeRun)}
          onStundennachweis={() => setStundenRun(activeRun)}
          onFinalize={() => { closeRun(); setFinalizeRun(activeRun); }}
        />
      )}

      {stundenRun && (() => {
        if (!stundenRun.id || !stundenRun.company_id) {
          return (
            <div className="fixed inset-0 z-[55] flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.7)' }}>
              <div className="rounded-xl shadow-2xl w-full max-w-md p-6 space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2">
                  <AlertTriangle size={18} style={{ color: '#fcd34d' }} />
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('mp.runs.previewUnavailableTitle')}</h3>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('mp.runs.previewUnavailableBody')}
                  {!stundenRun.id && ` ${t('mp.runs.missingRunId')}`}
                  {!stundenRun.company_id && ` ${t('mp.runs.missingCompanyId')}`}
                </p>
                <button onClick={() => setStundenRun(null)} className="w-full px-3 py-2 rounded text-sm font-medium" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                  {t('common.back')}
                </button>
              </div>
            </div>
          );
        }
        return (
          <StundennachweisErrorBoundary onBack={() => setStundenRun(null)} t={t}>
            <MonatsplanungStundennachweisPreview
              run={{
                id: stundenRun.id,
                company_id: stundenRun.company_id,
                month: stundenRun.month,
                year: stundenRun.year,
                status: stundenRun.status,
                file_name: stundenRun.file_name,
                applied_at: stundenRun.applied_at,
                import_id: stundenRun.import_id,
                source_sheet_name: stundenRun.source_sheet_name,
                source_columns_json: stundenRun.source_columns_json,
              }}
              onClose={() => setStundenRun(null)}
              onTransferApplied={runId => { setTransferStaleRunId(runId); }}
            />
          </StundennachweisErrorBoundary>
        );
      })()}

      {finalizeRun && (
        <FinalizePlanningModal
          run={finalizeRun}
          companyId={companyId}
          userId={user?.id}
          onClose={() => setFinalizeRun(null)}
          onFinalized={handleFinalized}
        />
      )}

      {deleteTarget && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={{ background: 'rgba(15, 23, 42, 0.7)' }}
          onClick={() => { if (!deleting) setDeleteTarget(null); }}
        >
          <div
            className="rounded-xl shadow-2xl w-full max-w-md"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: '#991b1b' }}>
                <Trash2 size={16} /> {t('mp.runs.deleteTitle')}
              </h3>
              <button onClick={() => { if (!deleting) setDeleteTarget(null); }} className="p-1 rounded" style={{ color: 'var(--text-tertiary)' }}>
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {t('mp.runs.deleteBody')}
              </p>
              <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                <span className="font-semibold">{t(MONTH_KEYS[deleteTarget.month - 1])} {deleteTarget.year}</span>
                {deleteTarget.file_name ? ` · ${deleteTarget.file_name}` : ''}
              </div>
              {deleteError && (
                <div className="text-xs px-3 py-2 rounded-lg" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                  {deleteError}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
              <button
                onClick={() => { if (!deleting) setDeleteTarget(null); }}
                disabled={deleting}
                className="px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => void handleDeleteRun()}
                disabled={deleting}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: '#b91c1c', color: '#fff' }}
              >
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {deleting ? t('common.deleting') : t('mp.runs.deleteConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RunGroups({ runs, finalizations, onOpen, onStundennachweis, onFinalize, onDelete }: {
  runs: AppliedRunSummary[];
  finalizations: Map<string, FinalizationRecord>;
  onOpen: (run: AppliedRunSummary) => void;
  onStundennachweis: (run: AppliedRunSummary) => void;
  onFinalize: (run: AppliedRunSummary) => void;
  onDelete: (run: AppliedRunSummary) => void;
}) {
  const { t } = useTranslation();
  // Group by year-month, sort newest first
  const grouped = useMemo(() => {
    const map = new Map<string, AppliedRunSummary[]>();
    for (const run of runs) {
      const key = `${run.year}-${String(run.month).padStart(2, '0')}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(run);
    }
    return [...map.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([, group]) => group);
  }, [runs]);

  return (
    <div className="space-y-5">
      {grouped.map(group => {
        const { month, year } = group[0];
        return (
          <div key={`${year}-${month}`}>
            <div
              className="text-xs font-semibold uppercase tracking-widest mb-2 pb-1.5 border-b"
              style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border)' }}
            >
              {t(MONTH_KEYS[month - 1])} {year}
            </div>
            <div className="space-y-2">
              {group.map(run => (
                <RunRow
                  key={run.id}
                  run={run}
                  finalization={finalizations.get(run.id) ?? null}
                  onOpen={() => onOpen(run)}
                  onStundennachweis={() => onStundennachweis(run)}
                  onFinalize={() => onFinalize(run)}
                  onDelete={() => onDelete(run)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RunRow({ run, finalization, onOpen, onStundennachweis, onFinalize, onDelete }: {
  run: AppliedRunSummary;
  finalization: FinalizationRecord | null;
  onOpen: () => void;
  onStundennachweis: () => void;
  onFinalize: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const apply = run.apply_summary_json ?? null;
  const summary = run.summary_json ?? null;
  const updated = readNumberFromJson(apply, 'updated_trips');
  const assignedBlocks = readNumberFromJson(summary, 'assigned_blocks_count');
  const dienst = readNumberFromJson(apply, 'dienstzeit_exceptions_count');
  const tag = readNumberFromJson(apply, 'tageslimit_exceptions_count');

  const isArchived = run.status === 'archived';
  const isReplaced = run.status === 'replaced';

  const hasExceptions = (dienst ?? 0) > 0 || (tag ?? 0) > 0;

  return (
    <div
      className="w-full text-left rounded-lg transition-all hover:shadow-sm cursor-pointer"
      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
    >
      {/* Main row */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Left: file info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              <FileSpreadsheet size={13} className="inline mr-1.5 opacity-60" />
              {run.file_name || '—'}
            </span>
            {!isReplaced && !isArchived && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
                style={{ background: 'rgba(34,197,94,0.08)', color: '#15803d' }}
              >
                <CheckCircle2 size={9} /> {t('mp.runs.statusActive')}
              </span>
            )}
            {finalization && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
                style={finalization.is_stale
                  ? { background: 'rgba(234,179,8,0.12)', color: '#92400e', border: '1px solid rgba(234,179,8,0.35)' }
                  : { background: 'rgba(34,197,94,0.1)', color: '#15803d', border: '1px solid rgba(34,197,94,0.3)' }
                }
                title={finalization.is_stale ? (finalization.stale_reason ?? t('mp.runs.outdated')) : t('mp.runs.finalized')}
              >
                {finalization.is_stale ? <AlertCircle size={9} /> : <CheckCircle2 size={9} />}
                {finalization.is_stale ? t('mp.runs.notCurrent') : t('mp.runs.finalized')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <span><Clock size={10} className="inline mr-1" />{fmtDateTime(run.applied_at)}</span>
            {updated != null && <span>{t('mp.trips')}: <strong>{updated}</strong></span>}
            {assignedBlocks != null && <span>{t('mp.blocks')}: <strong>{assignedBlocks}</strong></span>}
            {hasExceptions && (
              <span style={{ color: '#d97706' }}>
                <AlertTriangle size={10} className="inline mr-1" />
                {dienst! > 0 ? `${dienst} ${t('mp.workingTime')}` : ''}{dienst! > 0 && tag! > 0 ? ' · ' : ''}{tag! > 0 ? `${tag} ${t('mp.dailyLimit')}` : ''}
              </span>
            )}
          </div>
        </div>

        {/* Right: action buttons */}
        <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
          {run.status === 'applied' && (
            <button
              onClick={onStundennachweis}
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-semibold transition-colors hover:brightness-110"
              style={{ background: 'rgba(59,130,246,0.12)', color: '#2563eb', border: '1px solid rgba(59,130,246,0.35)' }}
              title={t('mp.runs.previewTooltip')}
            >
              <CalendarClock size={12} /> {t('common.preview')}
            </button>
          )}
          {run.status === 'applied' && (
            <button
              onClick={onFinalize}
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-semibold transition-colors hover:brightness-110"
              style={finalization?.is_stale
                ? { background: 'rgba(234,179,8,0.15)', color: '#b45309', border: '1px solid rgba(245,158,11,0.4)' }
                : finalization
                  ? { background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }
                  : { background: 'rgba(245,158,11,0.12)', color: '#b45309', border: '1px solid rgba(245,158,11,0.4)' }
              }
              title={t('mp.runs.createFinalDocs')}
            >
              <Sparkles size={12} />
              {finalization?.is_stale ? t('mp.runs.refinalize') : finalization ? t('mp.runs.finalizeAgain') : t('mp.runs.finalize')}
            </button>
          )}
          <button
            onClick={onDelete}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-semibold transition-colors hover:brightness-110"
            style={{ background: 'rgba(185,28,28,0.07)', color: '#991b1b', border: '1px solid rgba(185,28,28,0.22)' }}
            title={t('mp.runs.deletePlan')}
          >
            <Trash2 size={12} /> {t('mp.runs.deletePlan')}
          </button>
        </div>
      </div>

      {/* Stale warning strip */}
      {finalization?.is_stale && (
        <div
          className="px-4 py-2 rounded-b-lg text-[11px] flex items-center gap-1.5"
          style={{ background: 'rgba(234,179,8,0.08)', borderTop: '1px solid rgba(234,179,8,0.25)', color: '#92400e' }}
        >
          <AlertCircle size={11} />
          {t('mp.runs.staleStrip', { reason: finalization.stale_reason ?? t('mp.runs.staleDefaultReason') })}
        </div>
      )}
    </div>
  );
}

function RunDetailModal({
  run,
  finalization,
  validation,
  validating,
  exporting,
  exportError,
  exportMode,
  onModeChange,
  onClose,
  onExport,
  onStundennachweis,
  onFinalize,
}: {
  run: AppliedRunSummary;
  finalization: FinalizationRecord | null;
  validation: ExportValidation | null;
  validating: boolean;
  exporting: boolean;
  exportError: string;
  exportMode: ExportMode;
  onModeChange: (m: ExportMode) => void;
  onClose: () => void;
  onExport: () => void;
  onStundennachweis: () => void;
  onFinalize: () => void;
}) {
  const { t } = useTranslation();
  const [showTechnical, setShowTechnical] = useState(false);

  const apply = run.apply_summary_json ?? null;
  const settings = run.settings_json ?? null;
  const summary = run.summary_json ?? null;
  const expectedAssigned = readNumberFromJson(apply, 'updated_trips');
  const blockSep = readNumberFromJson(settings, 'block_separator_minutes');
  const minBlock = readNumberFromJson(settings, 'min_block_duration_minutes');
  const maxBlock = readNumberFromJson(settings, 'max_block_duration_minutes');
  const oneVehiclePerDay = readBoolFromJson(settings, 'one_vehicle_per_driver_day')
    ?? readBoolFromJson(summary, 'one_vehicle_per_driver_day')
    ?? readBoolFromJson(apply, 'one_vehicle_per_driver_day');
  const vehicleBlocks = readNumberFromJson(summary, 'vehicle_blocks_count');
  const assignedBlocks = readNumberFromJson(summary, 'assigned_blocks_count');
  const manualExc = readNumberFromJson(apply, 'manual_exceptions_saved');
  const dienst = readNumberFromJson(apply, 'dienstzeit_exceptions_count');
  const tag = readNumberFromJson(apply, 'tageslimit_exceptions_count');

  const canExport = useMemo(() => !!validation && validation.ok, [validation]);

  // Only show mismatches that are user-actionable (not internal diagnostics)
  const actionableWarnings = useMemo(() => {
    if (!validation?.mismatches) return [];
    return validation.mismatches.filter(m => {
      const lower = m.toLowerCase();
      // Hide purely internal structural messages
      if (lower.includes('planning_run_id') && lower.includes('uuid')) return false;
      if (lower.includes('block_id') && lower.includes('uuid')) return false;
      return true;
    });
  }, [validation]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15, 23, 42, 0.6)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div className="min-w-0">
            <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Archive size={16} /> {t(MONTH_KEYS[run.month - 1])} {run.year}
            </h3>
            <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-tertiary)' }}>
              {run.file_name || '—'}
            </div>
          </div>
          <button onClick={onClose} disabled={exporting} className="p-1 rounded" style={{ color: 'var(--text-tertiary)' }}>
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 overflow-y-auto">

          {/* Finalization status banner */}
          {finalization && (
            <div
              className="px-3 py-2.5 rounded-lg text-xs flex items-start gap-2"
              style={finalization.is_stale
                ? { background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.4)', color: '#92400e' }
                : { background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', color: '#15803d' }
              }
            >
              {finalization.is_stale
                ? <AlertCircle size={13} className="shrink-0 mt-0.5" />
                : <CheckCircle2 size={13} className="shrink-0 mt-0.5" />
              }
              <div>
                {finalization.is_stale
                  ? <><strong>{t('mp.runs.staleBannerLabel')}</strong> {finalization.stale_reason ?? t('mp.runs.staleBannerDefaultReason')}
                      {' '}{t('mp.runs.staleBannerAction')}</>
                  : <><strong>{t('mp.runs.finalized')}</strong> — {new Date(finalization.finalized_at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}
                      {' · '}{t('mp.runs.finalizedCounts', { trips: finalization.trip_count, drivers: finalization.driver_count })}</>
                }
              </div>
            </div>
          )}

          {!finalization && run.status === 'applied' && (
            <div className="px-3 py-2 rounded-lg text-xs flex items-center gap-2"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', color: '#92400e' }}>
              <AlertTriangle size={12} className="shrink-0" />
              {t('mp.runs.notFinalizedHint')}
            </div>
          )}

          {/* Main info — user-relevant fields */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Row label={t('mp.runs.monthYear')} value={`${t(MONTH_KEYS[run.month - 1])} ${run.year}`} />
            <Row label={t('common.status')} value={run.status === 'applied' ? t('mp.runs.statusActive') : run.status === 'replaced' ? t('mp.runs.statusReplaced') : run.status === 'archived' ? t('mp.runs.statusArchived') : run.status} />
            <Row label={t('mp.appliedAt')} value={fmtDateTime(run.applied_at)} />
            <Row label={t('mp.runs.fileName')} value={<span className="text-xs truncate block" title={run.file_name}>{run.file_name || '—'}</span>} />
            <Row label={t('mp.assignedTrips')} value={expectedAssigned ?? '—'} />
            <Row label={t('mp.assignedBlocks')} value={assignedBlocks ?? '—'} />
            <Row label={t('mp.manualExceptions')} value={manualExc ?? 0} />
            <Row label={t('mp.workingTimeExceptions')} value={dienst ?? 0} />
            <Row label={t('mp.dailyLimitExceptions')} value={tag ?? 0} />
            <Row label={t('mp.oneVehiclePerDriverDay')} value={oneVehiclePerDay == null ? '—' : oneVehiclePerDay ? t('common.yes') : t('common.no')} />
          </dl>

          {/* Technical details (collapsed) */}
          <div>
            <button
              className="text-xs flex items-center gap-1.5 py-1 transition-colors hover:opacity-80"
              style={{ color: 'var(--text-tertiary)' }}
              onClick={() => setShowTechnical(v => !v)}
            >
              <Hash size={11} />
              {showTechnical ? t('mp.runs.hideTechnical') : t('mp.runs.showTechnical')}
              <span className="ml-0.5">{showTechnical ? '▲' : '▼'}</span>
            </button>
            {showTechnical && (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm mt-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <Row label={t('mp.planningRunId')} value={<span className="font-mono text-xs break-all">{run.id}</span>} />
                <Row label={t('mp.runs.importedAt')} value={fmtDateTime(run.imported_at)} />
                <Row label={t('mp.appliedBy')} value={<span className="font-mono text-xs">{run.applied_by ?? '—'}</span>} />
                <Row label={t('mp.planner.blockSeparator')} value={blockSep != null ? `${blockSep} ${t('mp.minShortNoDot')}` : '—'} />
                <Row label={t('mp.planner.minBlockDuration')} value={minBlock != null ? `${minBlock} ${t('mp.minShortNoDot')}${minBlock === 0 ? ` ${t('mp.runs.offSuffix')}` : ''}` : '—'} />
                <Row label={t('mp.planner.maxBlockDuration')} value={maxBlock != null ? `${maxBlock} ${t('mp.minShortNoDot')}` : '—'} />
                <Row label={t('mp.runs.vehicleBlocksTotal')} value={vehicleBlocks ?? '—'} />
              </dl>
            )}
          </div>

          {validating && (
            <div className="px-3 py-2 rounded-lg text-sm flex items-center gap-2" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
              <Loader2 size={14} className="animate-spin" /> {t('mp.runs.validating')}
            </div>
          )}

          {validation && (
            <div
              className="px-3 py-3 rounded-lg text-xs space-y-1"
              style={{
                background: validation.ok ? '#ecfdf5' : '#fef3c7',
                color: validation.ok ? '#065f46' : '#92400e',
                border: `1px solid ${validation.ok ? '#a7f3d0' : '#fde68a'}`,
              }}
            >
              <div className="font-semibold inline-flex items-center gap-1">
                {validation.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                {validation.ok ? t('mp.runs.exportReady') : t('mp.runs.deviationsDetected')}
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                <div>{t('mp.totalTrips')}: <strong>{validation.total_rows}</strong></div>
                <div>{t('mp.completed')}: <strong>{validation.abgeschlossen_total}</strong></div>
                <div>{t('mp.runs.withAssignment')}: <strong>{validation.abgeschlossen_with_assignment}</strong></div>
                <div>{t('mp.canceled')}: <strong>{validation.storniert_total}</strong></div>
                <div>{t('mp.manualExceptions')}: <strong>{validation.exceptions_in_run}</strong></div>
                <div>{t('mp.runs.driverColumn')}: <strong>{validation.driver_column ?? '—'}</strong></div>
              </div>
              {actionableWarnings.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {actionableWarnings.map((m, i) => <li key={i}>{m}</li>)}
                </ul>
              )}
            </div>
          )}

          <div className="rounded-lg px-3 py-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{t('mp.runs.exportFormat')}</div>
            <div className="flex flex-col gap-1.5 text-sm">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="export-mode"
                  value="original"
                  checked={exportMode === 'original'}
                  onChange={() => onModeChange('original')}
                  className="mt-1"
                  disabled={exporting}
                />
                <span>
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('mp.runs.modeOriginal')}</span>
                  <span className="block text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('mp.runs.modeOriginalDesc')}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="export-mode"
                  value="audit"
                  checked={exportMode === 'audit'}
                  onChange={() => onModeChange('audit')}
                  className="mt-1"
                  disabled={exporting}
                />
                <span>
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('mp.runs.modeAudit')}</span>
                  <span className="block text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('mp.runs.modeAuditDesc')}
                  </span>
                </span>
              </label>
            </div>
          </div>

          {exportError && (
            <div className="px-3 py-2 rounded-lg text-sm" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {exportError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {run.status === 'applied' && (
              <button
                onClick={onStundennachweis}
                disabled={exporting}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
                style={{ background: 'rgba(59,130,246,0.15)', color: '#1d4ed8', border: '1px solid rgba(59,130,246,0.45)' }}
                title={t('mp.runs.previewTooltip')}
              >
                <CalendarClock size={13} /> {t('mp.stundennachweisPreview')}
              </button>
            )}
            {run.status === 'applied' && (
              <button
                onClick={onFinalize}
                disabled={exporting}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold disabled:opacity-50 transition-all hover:brightness-110"
                style={{ background: finalization?.is_stale ? 'rgba(234,179,8,0.2)' : 'rgba(245,158,11,0.2)', color: '#b45309', border: '1px solid rgba(245,158,11,0.5)' }}
                title={t('mp.runs.createFinalDocsTooltip')}
              >
                <Sparkles size={13} />
                {finalization?.is_stale ? t('mp.runs.recreateFinalDocs') : finalization ? t('mp.runs.finalizeAgain') : t('mp.runs.createFinalDocs')}
              </button>
            )}
            <button
              onClick={onClose}
              disabled={exporting}
              className="px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              {t('common.close')}
            </button>
            <button
              onClick={onExport}
              disabled={exporting || validating || !canExport}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              title={t('mp.runs.rawExportTooltip')}
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {exporting ? t('mp.runs.exporting') : t('mp.runs.rawExport')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wider font-semibold" style={{ color: 'var(--text-tertiary)' }}>{label}</dt>
      <dd className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</dd>
    </>
  );
}