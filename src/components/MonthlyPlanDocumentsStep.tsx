import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, FileText, Info } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  Field,
  NativeSelect,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type DataTableColumn,
} from './ui';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  documentBlockReason,
  monthlyPlanFileName,
  type DocumentBlockReason,
  type DocumentPreview,
  type DocumentPreviewRow,
  type DocumentPreviewSection,
  type DocumentSubject,
  type MonthlyPlanDocumentBuilder,
  type MonthlyPlanDocumentBuilders,
  type MonthlyPlanDocumentKind,
  type StoredMonthlyPlan,
} from '../utils/monthlyPlanDocuments';
import { MONTHLY_PLAN_DOCUMENT_BUILDERS } from '../utils/monthlyPlanDocumentBuilders';

/**
 * Screen 4 of the monthly plan: the three documents, previewed and downloaded
 * (§1's fourth screen, §10, §11, §12).
 *
 * ## The rule this component preserves
 *
 * **It produces no figure of its own.** Every number, every date and every label
 * inside a document comes from the builder that owns it, already formatted, and
 * this file renders the strings it is handed. §12 requires the three documents to
 * agree — "the totals must come from the same plan data used in the
 * Stundennachweis" — and the product already shows what happens when a screen
 * formats beside a document: `MonatsplanungStundennachweisPreview`'s toolbar
 * total excludes the gap between merged shifts while its own PDF includes it, so
 * the two disagree for the 92.5 % of driver-days that are compressed. A screen
 * that cannot compute cannot drift.
 *
 * Three consequences that are deliberate and easy to undo:
 *
 *   - **The driver picker shows a name and nothing else.** Which drivers get a
 *     Stundennachweis, and what each one's hours are, is the Stundennachweis
 *     builder's answer (`subjects()`), not a list this component derives from the
 *     plan's blocks. Putting hours in the picker would be a second source for the
 *     first figure on the document.
 *   - **The preview is capped, the file never is.** A month's Fahrtenbuch is
 *     thousands of rows and rendering all of them would hang the tab, so the
 *     preview shows the first `PREVIEW_ROW_LIMIT` of each section and says how
 *     many there are. The download calls the builder's `file()`, which knows
 *     nothing of the cap.
 *   - **A document is withheld, not emptied.** `documentBlockReason` decides, and
 *     an unavailable document says why — a failed read, a plan with a broken hard
 *     rule, a builder this build does not have. An empty table would be a claim
 *     that the month holds nothing.
 *
 * ## These are proposals
 *
 * The month has not happened. Each document carries `PLANUNG / VORSCHAU — kein
 * Arbeitszeitnachweis` in its header and `_PLANUNG_` in its filename (both in
 * `monthlyPlanDocuments.ts`, in one place), and this screen says so once rather
 * than contradicting them. Nothing here writes: not `fahrtenbuch_trips`, which is
 * append-only, and not `saved_stundennachweise`, which is the statutory archive
 * keyed per driver and month — a proposal in it would overwrite a real record.
 */

/** How many rows of one section the preview draws before it only counts them. */
const PREVIEW_ROW_LIMIT = 200;

/** The three documents, in the order §1 lists them. */
const DOCUMENT_KINDS: readonly MonthlyPlanDocumentKind[] = [
  'stundennachweis',
  'fahrtenbuch',
  'payroll_summary',
];

const TAB_KEYS: Record<MonthlyPlanDocumentKind, TranslationKey> = {
  stundennachweis: 'mplan.docs.tab.stundennachweis',
  fahrtenbuch: 'mplan.docs.tab.fahrtenbuch',
  payroll_summary: 'mplan.docs.tab.payroll',
};

const DESCRIPTION_KEYS: Record<MonthlyPlanDocumentKind, TranslationKey> = {
  stundennachweis: 'mplan.docs.stundennachweis',
  fahrtenbuch: 'mplan.docs.fahrtenbuch',
  payroll_summary: 'mplan.docs.payrollSummary',
};

const BLOCK_KEYS: Record<DocumentBlockReason, TranslationKey> = {
  no_plan: 'mplan.docs.blocked.noPlan',
  load_failed: 'mplan.docs.blocked.loadFailed',
  plan_not_confirmable: 'mplan.docs.blocked.notConfirmable',
  builder_missing: 'mplan.docs.blocked.builderMissing',
  no_subject: 'mplan.docs.blocked.noSubject',
};

/**
 * The extension each document's file carries, for the name the screen shows
 * beside the download button.
 *
 * It is **not** the name the file is saved under: that is the builder's own, from
 * `monthlyPlanFileName`, so a builder that produces a PDF where this expected a
 * workbook changes only the hint. Naming it here lets the button say what will
 * arrive without asking the builder to build the file first.
 */
const EXTENSION_HINT: Record<MonthlyPlanDocumentKind, string> = {
  stundennachweis: 'pdf',
  fahrtenbuch: 'xlsx',
  payroll_summary: 'xlsx',
};

/**
 * The repo's Blob-download shape, with the anchor attached to the document:
 * Firefox ignores a detached anchor's click (`styledWorkbookDownload.ts` says so
 * too, and `historicalWorkingHoursFahrtenbuchExport.ts` is the one that forgets).
 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** A preview row as `DataTable` reads it: the cells the builder already wrote. */
type PreviewRow = { id: string; cells: readonly (string | null)[] };

export interface MonthlyPlanDocumentsStepProps {
  /** The plan the documents are built from. The one source for every total. */
  plan: StoredMonthlyPlan;
  /** `validatePlan().confirmable` — criterion 15's gate, read, never recomputed. */
  confirmable: boolean;
  /** True when any read the plan depends on failed. Withholds every document. */
  loadFailed: boolean;
  onBack: () => void;
  /** Injected in tests and the harness; production uses the wiring table. */
  builders?: MonthlyPlanDocumentBuilders;
  /** Injected so a preview and its file carry the same date. */
  generatedAt?: Date;
}

export default function MonthlyPlanDocumentsStep({
  plan,
  confirmable,
  loadFailed,
  onBack,
  builders = MONTHLY_PLAN_DOCUMENT_BUILDERS,
  generatedAt,
}: MonthlyPlanDocumentsStepProps) {
  const { t } = useTranslation();

  // One instant for the whole step, so every preview and every file this visit
  // produces says it was generated at the same moment.
  const [fallbackGeneratedAt] = useState(() => new Date());
  const stamp = generatedAt ?? fallbackGeneratedAt;

  const [kind, setKind] = useState<MonthlyPlanDocumentKind>('stundennachweis');
  // Keyed by document kind. A plain record rather than a Partial<Record<…>>, so
  // a computed key and an `undefined` reset are both ordinary assignments.
  const [subjectByKind, setSubjectByKind] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Record<string, string | undefined>>({});

  const download = useCallback(
    async (
      builder: MonthlyPlanDocumentBuilder,
      documentKind: MonthlyPlanDocumentKind,
      subjectId: string | undefined,
      subjectLabel: string | undefined,
      busyKey: string,
      /** Whatever the builder's own `load` answered; undefined when it has none. */
      loaded: unknown,
    ) => {
      setBusy(busyKey);
      setFailure(prev => ({ ...prev, [documentKind]: undefined }));
      try {
        const file = await builder.file({ plan, subjectId, generatedAt: stamp }, loaded);
        // The builder names its own file; this is the fallback for one that does
        // not, and it carries the marker either way.
        triggerDownload(
          file.blob,
          file.filename ||
            monthlyPlanFileName(documentKind, plan, EXTENSION_HINT[documentKind], subjectLabel),
        );
      } catch (error) {
        // A half-built document is never offered: the failure is named and the
        // button stays available for a retry.
        setFailure(prev => ({
          ...prev,
          [documentKind]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        setBusy(null);
      }
    },
    [plan, stamp],
  );

  // ── Presentation ──────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 font-ui">
      {/* §1: a success message once the plan is confirmed. It says the rules are
          met, not that anything was filed — nothing has been stored yet. */}
      <Alert tone="positive" title={t('mplan.docs.successTitle')}>
        {confirmable ? t('mplan.docs.successBody') : t('mplan.docs.successBodyIncomplete')}
      </Alert>

      {/* Said once, in one place. The documents repeat it in their own headers. */}
      <Alert tone="caution" title={t('mplan.docs.proposalTitle')}>
        {t('mplan.docs.proposalBody')}
      </Alert>

      {plan.status === 'draft' ? (
        <Alert tone="neutral" title={t('mplan.docs.notSavedTitle')}>
          {t('mplan.docs.notSavedYet')}
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText aria-hidden className="size-4 text-fg-muted" />
            {t('mplan.docs.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={kind} onValueChange={value => setKind(value as MonthlyPlanDocumentKind)}>
            <TabsList className="mb-4">
              {DOCUMENT_KINDS.map(documentKind => (
                <TabsTrigger key={documentKind} value={documentKind}>
                  {t(TAB_KEYS[documentKind])}
                </TabsTrigger>
              ))}
            </TabsList>
            {DOCUMENT_KINDS.map(documentKind => (
              <TabsContent key={documentKind} value={documentKind}>
                <DocumentTab
                  documentKind={documentKind}
                  plan={plan}
                  confirmable={confirmable}
                  loadFailed={loadFailed}
                  builder={builders[documentKind]}
                  generatedAt={stamp}
                  subjectId={subjectByKind[documentKind]}
                  onSubjectChange={value =>
                    setSubjectByKind(prev => ({ ...prev, [documentKind]: value }))
                  }
                  busy={busy}
                  failure={failure[documentKind]}
                  onDownload={download}
                />
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      <Button variant="secondary" onClick={onBack}>
        {t('mplan.back')}
      </Button>
    </div>
  );
}

// ── One document ────────────────────────────────────────────────────────────

interface DocumentTabProps {
  documentKind: MonthlyPlanDocumentKind;
  plan: StoredMonthlyPlan;
  confirmable: boolean;
  loadFailed: boolean;
  builder: MonthlyPlanDocumentBuilder | undefined;
  generatedAt: Date;
  subjectId: string | undefined;
  onSubjectChange: (value: string) => void;
  busy: string | null;
  failure: string | undefined;
  onDownload: (
    builder: MonthlyPlanDocumentBuilder,
    documentKind: MonthlyPlanDocumentKind,
    subjectId: string | undefined,
    subjectLabel: string | undefined,
    busyKey: string,
    loaded: unknown,
  ) => void;
}

/**
 * The state of a builder's optional `load` step.
 *
 * `idle` is the whole state for a builder that has none, and the preview runs
 * immediately. For one that has (only the Fahrtenbuch, which overlays the plan
 * onto the *imported* rows), `pending` withholds the preview and the download
 * button rather than rendering an empty document — an empty Fahrtenbuch is a
 * claim that the month had no rides.
 */
type LoadState =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'ready'; value: unknown }
  | { state: 'error'; message: string };

function DocumentTab({
  documentKind,
  plan,
  confirmable,
  loadFailed,
  builder,
  generatedAt,
  subjectId,
  onSubjectChange,
  busy,
  failure,
  onDownload,
}: DocumentTabProps) {
  const { t } = useTranslation();

  /**
   * The builder's own list of per-document subjects, or null for a document that
   * has only one. `subjects()` is the builder's answer and not a list derived
   * here, so the picker and the document cannot disagree about who is in the
   * month. A builder that throws is treated as having no usable subjects rather
   * than taking the screen down.
   */
  const subjects = useMemo<readonly DocumentSubject[] | null>(() => {
    if (!builder?.subjects) return null;
    try {
      return builder.subjects(plan);
    } catch {
      return [];
    }
  }, [builder, plan]);

  /**
   * The builder's own `load` step, run once per plan.
   *
   * Only the Fahrtenbuch has one. It is an effect and not part of `preview`
   * because a preview must stay synchronous: every figure in it is a string the
   * builder already wrote, and a preview that could suspend would need the screen
   * to hold a half-built document.
   *
   * `cancelled` is not defensive noise — switching driver or month while the read
   * is in flight would otherwise let the older answer install itself over the
   * newer one, which is `AppConfigProvider`'s rule for the same race.
   */
  const [loaded, setLoaded] = useState<LoadState>({ state: 'idle' });
  const load = builder?.load;

  useEffect(() => {
    if (!load || !builder) {
      setLoaded({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setLoaded({ state: 'pending' });
    load.call(builder, { plan, generatedAt })
      .then(value => { if (!cancelled) setLoaded({ state: 'ready', value }); })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoaded({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => { cancelled = true; };
  }, [load, builder, plan, generatedAt]);

  const blocked = documentBlockReason({ plan, loadFailed, confirmable, builder, subjects });

  // The chosen subject, or the first one. A choice that is still in the list is
  // never overwritten, which is the same rule screen 1 follows for its months.
  const activeSubject = useMemo(() => {
    if (!subjects || subjects.length === 0) return null;
    return subjects.find(s => s.id === subjectId) ?? subjects[0];
  }, [subjects, subjectId]);

  /**
   * The document, as the builder wrote it. A builder that throws is reported
   * rather than rendered as an empty document: an empty Stundennachweis is a
   * claim that the driver worked no hours.
   */
  const preview = useMemo<{ document: DocumentPreview } | { error: string } | null>(() => {
    if (blocked || !builder) return null;
    // A failed prerequisite is the document's failure, reported in the same place
    // as a builder that threw: either way no document exists and none is offered.
    if (loaded.state === 'error') return { error: loaded.message };
    if (loaded.state === 'pending') return null;
    try {
      return {
        document: builder.preview(
          { plan, subjectId: activeSubject?.id, generatedAt },
          loaded.state === 'ready' ? loaded.value : undefined,
        ),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [blocked, builder, plan, activeSubject, generatedAt, loaded]);

  const busyKey = `${documentKind}:${activeSubject?.id ?? 'all'}`;
  const previewError = preview !== null && 'error' in preview ? preview.error : null;
  // A download is offered only for a document that could be previewed: the two
  // read the same plan through the same builder, so a preview that failed is a
  // document that must not be handed to an accountant.
  const canDownload =
    builder != null && !blocked && previewError === null && busy === null
    && loaded.state !== 'pending';
  const loadedValue = loaded.state === 'ready' ? loaded.value : undefined;

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{t(DESCRIPTION_KEYS[documentKind])}</p>

      {blocked ? (
        <Alert tone={blocked === 'builder_missing' ? 'neutral' : 'caution'}>
          {t(BLOCK_KEYS[blocked])}
        </Alert>
      ) : null}

      {previewError !== null ? (
        <Alert tone="critical" title={t('mplan.docs.previewFailed')}>
          <span className="text-[13px]">{previewError}</span>
        </Alert>
      ) : null}

      {/* The Fahrtenbuch reads the import's original rows before it can be
          drawn. Saying so is not decoration: without it the tab shows a
          description and no table, which reads as a document with no rows. */}
      {!blocked && loaded.state === 'pending' ? (
        <Alert tone="neutral">{t('mplan.docs.preparing')}</Alert>
      ) : null}

      {failure ? (
        <Alert tone="critical" title={t('mplan.docs.downloadFailed')}>
          <span className="text-[13px]">{failure}</span>
        </Alert>
      ) : null}

      {subjects && subjects.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:max-w-sm">
          <Field label={t('mplan.docs.driver')}>
            <NativeSelect
              value={activeSubject?.id ?? ''}
              onChange={event => onSubjectChange(event.target.value)}
            >
              {subjects.map(subject => (
                <option key={subject.id} value={subject.id}>
                  {subject.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!canDownload}
          onClick={() =>
            builder &&
            onDownload(
              builder, documentKind, activeSubject?.id, activeSubject?.label, busyKey, loadedValue,
            )
          }
        >
          <Download aria-hidden className="size-4" />
          {busy === busyKey ? t('mplan.docs.downloading') : t('mplan.docs.download')}
        </Button>
        {subjects && subjects.length > 0 ? (
          <Button
            variant="secondary"
            disabled={!canDownload}
            onClick={() => builder && onDownload(
              builder, documentKind, undefined, undefined, `${documentKind}:all`, loadedValue,
            )}
          >
            <Download aria-hidden className="size-4" />
            {busy === `${documentKind}:all`
              ? t('mplan.docs.downloading')
              : t('mplan.docs.downloadAll', { count: subjects.length })}
          </Button>
        ) : null}
      </div>

      {preview && 'document' in preview ? (
        <DocumentPreviewView
          documentKind={documentKind}
          document={preview.document}
          subjectLabel={activeSubject?.label}
        />
      ) : null}
    </div>
  );
}

// ── The preview ─────────────────────────────────────────────────────────────

function DocumentPreviewView({
  documentKind,
  document: preview,
  subjectLabel,
}: {
  documentKind: MonthlyPlanDocumentKind;
  document: DocumentPreview;
  subjectLabel: string | undefined;
}) {
  const { t } = useTranslation();

  // Used only where the builder gave a section no caption of its own. It names
  // the document, never one of its figures.
  const fallbackCaption = subjectLabel
    ? t('mplan.docs.previewCaptionSubject', {
        document: t(TAB_KEYS[documentKind]),
        subject: subjectLabel,
      })
    : t('mplan.docs.previewCaption', { document: t(TAB_KEYS[documentKind]) });

  return (
    <section className="rounded-surface border border-line bg-raised p-4" aria-label={t('mplan.docs.previewLabel')}>
      <header className="mb-4 space-y-1 border-b border-line pb-3">
        <Badge tone="caution" className="inline-flex items-center gap-1">
          <AlertTriangle aria-hidden className="size-3" />
          {t('mplan.docs.previewBadge')}
        </Badge>
        {/* The document's own header lines, as the builder wrote them. The first
            is expected to be PROPOSAL_NOTICE; nothing here adds or edits one. */}
        {preview.header.map((line, index) => (
          <p key={index} className={index === 0 ? 'text-sm font-medium text-fg' : 'text-[13px] text-fg-muted'}>
            {line}
          </p>
        ))}
      </header>

      <div className="space-y-6">
        {preview.sections.map((section, index) => (
          <PreviewSection
            key={`s${index}`}
            section={section}
            caption={section.caption ?? fallbackCaption}
          />
        ))}
      </div>

      {preview.footnotes && preview.footnotes.length > 0 ? (
        <ul className="mt-4 space-y-1 border-t border-line pt-3 text-[13px] text-fg-muted">
          {preview.footnotes.map((note, index) => (
            <li key={index} className="flex items-start gap-2">
              <Info aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function PreviewSection({ section, caption }: { section: DocumentPreviewSection; caption: string }) {
  const { t } = useTranslation();

  const rows: PreviewRow[] = useMemo(
    () =>
      section.rows.slice(0, PREVIEW_ROW_LIMIT).map((row: DocumentPreviewRow, index) => ({
        id: row.id || `row-${index}`,
        cells: row.cells,
      })),
    [section.rows],
  );

  /**
   * One column per column the builder declared. `cell` renders the builder's
   * string as it is — `kind: 'number'` is set only for the right alignment and
   * the tabular figures, and because `cell` is present `DataTable` never reaches
   * its own `formatValue`. A column with `value` instead would hand the figure
   * back to the table to format, which is the second source this screen exists
   * not to be.
   */
  const columns: DataTableColumn<PreviewRow>[] = useMemo(
    () =>
      section.columns.map((column, index) => ({
        id: `c${index}`,
        header: column.header,
        kind: column.numeric ? ('number' as const) : undefined,
        cell: (row: PreviewRow) => (
          <span className={column.numeric ? 'tabular-nums' : undefined}>{row.cells[index] ?? ''}</span>
        ),
      })),
    [section.columns],
  );

  const totals = useMemo(() => {
    if (!section.totals) return undefined;
    const entries: Record<string, string> = {};
    section.totals.forEach((value, index) => {
      if (value != null) entries[`c${index}`] = value;
    });
    return entries;
  }, [section.totals]);

  const hidden = section.rows.length - rows.length;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-fg">{caption}</h3>
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={row => row.id}
        caption={caption}
        density="compact"
        totals={totals}
        scrollClassName="max-h-[28rem]"
      />
      {hidden > 0 ? (
        // The cap is the preview's, never the file's.
        <p className="text-[13px] text-fg-muted">
          {t('mplan.docs.previewCapped', { shown: rows.length, total: section.rows.length })}
        </p>
      ) : null}
    </div>
  );
}
