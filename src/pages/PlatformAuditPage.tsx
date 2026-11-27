import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw, ShieldAlert, ChevronDown, ChevronUp, ScrollText, Download, CheckCircle2, Clock, Ban, XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  appendAuditRows,
  auditRefusalKey,
  dayBoundary,
  type AuditCursor,
  type AuditRow,
} from '../lib/platformAuditLog';
import { fetchAuditPage } from '../lib/platformAuditClient';
import { fetchCompanies } from '../lib/platformDirectoryClient';
import type { PlatformCompanyRow } from '../lib/platformReadModels';
import { EMPTY_CELL, deCount, deDateTime, shortId } from '../lib/platformFormat';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { buildAuditExport } from '../lib/panelExports';
import { useExportChrome } from '../hooks/useExportChrome';
import { useToast } from '../contexts/ToastContext';
import { berlinToday } from '../utils/salaryCashReceiptFlow';
import { Alert, Badge, Button, EmptyState, Field as UiField, Input, NativeSelect, PageHeader } from '../components/ui';

/**
 * Protokoll — who read what, and who changed what (plan 3.B / 3.G).
 *
 * `platform_audit_log` is append-only and `platform_audit_list` is the only way
 * to read it. `audit.read` reads the whole log — all four staff roles hold it
 * since 15.10.2026 (decision D3, answered) — and a role without it would read
 * only the rows it is the actor of.
 * The answer says which, so the screen says so too rather than letting a
 * support account believe the platform was quiet.
 *
 * Paging is a keyset cursor on `(occurred_at, id)`, not an offset: the log only
 * grows, and an offset would shift under the reader between pages.
 *
 * Reading the log writes a row of its own — `platform_read.audit_list`. That is
 * intended, and it is why the filters are applied by a button rather than on
 * every keystroke.
 */

const CATEGORY_LABELS: Record<string, TranslationKey> = {
  read:     'admin.audit.category.read',
  write:    'admin.audit.category.write',
  support:  'admin.audit.category.support',
  auth:     'admin.audit.category.auth',
  settings: 'admin.audit.category.settings',
  staff:    'admin.audit.category.staff',
  legacy:   'admin.audit.category.legacy',
};

const OUTCOME_LABELS: Record<string, TranslationKey> = {
  attempt: 'admin.audit.outcome.attempt',
  ok:      'admin.audit.outcome.ok',
  denied:  'admin.audit.outcome.denied',
  error:   'admin.audit.outcome.error',
};

interface Filters {
  category: string;
  outcome: string;
  actionPrefix: string;
  companyId: string;
  from: string;
  to: string;
  mineOnly: boolean;
}

const EMPTY_FILTERS: Filters = {
  category: '', outcome: '', actionPrefix: '', companyId: '', from: '', to: '', mineOnly: false,
};

const PlatformAuditPage: React.FC = () => {
  const { user } = useAuth();
  const { platformCan, isPlatformStaff } = useSuperAdmin();
  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  const { showToast } = useToast();
  const exportChrome = useExportChrome();

  // Every active staff role may read its own rows, so the page is opened for
  // any of them; `audit.read` is what widens the scope, and the answer says so.
  const mayRead = isPlatformStaff;

  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<AuditCursor | null>(null);
  // Null until the first answer says which scope this account actually got.
  // Defaulting to 'own' told an owner, for as long as the first read took, that
  // they were seeing only their own entries.
  const [scope, setScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [companies, setCompanies] = useState<PlatformCompanyRow[]>([]);

  useEffect(() => {
    if (!mayRead || !platformCan('companies.read')) return;
    let cancelled = false;
    fetchCompanies().then(
      result => { if (!cancelled && result.ok) setCompanies(result.items); },
      () => { /* The picker stays empty; the log still reads. */ },
    );
    return () => { cancelled = true; };
  }, [mayRead, platformCan]);

  /**
   * One page. `next` continues from the cursor; otherwise this is a fresh read
   * and the rows already on screen are replaced, not appended to.
   */
  const load = useCallback(async (filters: Filters, from: AuditCursor | null) => {
    setLoading(true);
    if (!from) { setProblem(null); setFailure(null); }
    try {
      const result = await fetchAuditPage({
        category: filters.category,
        outcome: filters.outcome,
        actionPrefix: filters.actionPrefix,
        companyId: filters.companyId,
        actorUserId: filters.mineOnly ? user?.id ?? null : null,
        from: filters.from ? dayBoundary(filters.from, 'from') : null,
        to: filters.to ? dayBoundary(filters.to, 'to') : null,
        cursor: from,
      });

      if (!result.ok) {
        if (!from) { setRows([]); setCursor(null); }
        setProblem(auditRefusalKey(result.reason));
        return;
      }

      setScope(result.scope);
      setRows(previous => (from ? appendAuditRows(previous, result.items) : result.items));
      setCursor(result.nextCursor);
    } catch (err) {
      if (!from) { setRows([]); setCursor(null); }
      setProblem('admin.read.failed');
      setFailure(err instanceof Error ? err.message : null);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!mayRead) return;
    void load(applied, null);
  }, [mayRead, applied, load]);

  /**
   * The log as a workbook — what an incident report or a data protection request
   * is answered with, which a scrolling table cannot be.
   *
   * **The rule being preserved: a file says what it holds.** The log pages by a
   * keyset cursor on `(occurred_at, id)`, so there is no total to divide and no
   * page number to print — the file is the rows loaded so far, and the band says
   * exactly that. "Mehr laden" is how an operator puts more in it, and each press
   * is one audited `platform_read.audit_list` row; the export itself asks the
   * database for nothing, so it costs no audit row and cannot reach a row
   * `app_private.platform_audit_purge()` has already deleted.
   *
   * The band also carries the scope the answer reported: an account without
   * `audit.read` receives only the rows it is the actor of, and a file that did
   * not say so would read as "the platform was quiet".
   */
  const handleExport = () => {
    try {
      exportPicker.table('platformAudit', buildAuditExport({
        rows,
        filters: [
          {
            label: t('admin.audit.filter.category'),
            value: applied.category ? t(CATEGORY_LABELS[applied.category]) : null,
          },
          {
            label: t('admin.audit.filter.outcome'),
            value: applied.outcome ? t(OUTCOME_LABELS[applied.outcome]) : null,
          },
          { label: t('admin.audit.export.filterAction'), value: applied.actionPrefix || null },
          {
            label: t('admin.audit.filter.company'),
            value: applied.companyId
              ? companies.find(company => company.id === applied.companyId)?.name ?? applied.companyId
              : null,
          },
          { label: t('admin.audit.export.filterFrom'), value: applied.from || null },
          { label: t('admin.audit.export.filterTo'), value: applied.to || null },
          {
            label: t('admin.audit.export.filterMineOnly'),
            value: applied.mineOnly ? t('common.yes') : null,
          },
        ],
        filterLineTemplate: t('ui.export.filterLine'),
        today: berlinToday(),
        labels: {
          sheetTitle: t('admin.audit.title'),
          time: t('admin.audit.col.time'),
          actor: t('admin.audit.col.actor'),
          actorRole: t('admin.audit.export.actorRole'),
          action: t('admin.audit.col.action'),
          category: t('admin.audit.export.category'),
          outcome: t('admin.audit.col.outcome'),
          target: t('admin.audit.col.target'),
          targetId: t('admin.audit.export.targetId'),
          company: t('admin.audit.col.company'),
          before: t('admin.audit.before'),
          after: t('admin.audit.after'),
          categoryNames: Object.fromEntries(
            AUDIT_CATEGORIES.map((category): [string, string] => [category, t(CATEGORY_LABELS[category])]),
          ),
          outcomeNames: Object.fromEntries(
            AUDIT_OUTCOMES.map((outcome): [string, string] => [outcome, t(OUTCOME_LABELS[outcome])]),
          ),
          loadedNote: t('admin.audit.export.loaded'),
          // Only where the answer actually restricted the scope. Before the first
          // answer `scope` is null and no claim is made either way.
          ownScopeNote: scope !== null && scope !== 'all' ? t('admin.audit.scopeOwn') : null,
          chrome: exportChrome,
        },
      }));
    } catch (error: any) {
      showToast('error', t('ui.export.failed'), error?.message);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic; below, markup only draws.

  if (!mayRead) {
    return (
      <div className="glass-card rounded-surface">
        <EmptyState
          icon={ShieldAlert}
          title={t('admin.read.denied')}
          description={t('admin.audit.noAccessBody')}
          className="py-16"
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 font-ui">
      <PageHeader
        title={t('admin.audit.title')}
        description={t('admin.audit.subtitle')}
        className="pb-0"
        actions={(
          <>
            {/* Withheld while the read failed, while one is running and while
                nothing is loaded: an audit file of nought entries reads as "nothing
                happened", which is the strongest claim on this screen. */}
            <Button
              variant="secondary"
              disabled={loading || problem !== null || rows.length === 0}
              onClick={handleExport}
              title={t('common.exportExcel')}
            >
              <Download size={14} />{t('admin.export.download')}
            </Button>
            <Button variant="secondary" onClick={() => void load(applied, null)}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />{t('admin.common.refresh')}
            </Button>
          </>
        )}
      />

      {/* What this account is actually allowed to see, once the answer says so. */}
      {scope !== null && scope !== 'all' && (
        <Alert tone="neutral" role="note">{t('admin.audit.scopeOwn')}</Alert>
      )}

      {/* Filters. Applied by the button: every read writes a row of its own. */}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={event => { event.preventDefault(); setExpanded(null); setApplied(draft); }}
      >
        <FilterField labelKey="admin.audit.filter.category">
          <NativeSelect value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })}>
            <option value="">{t('admin.common.allCategories')}</option>
            {AUDIT_CATEGORIES.map(category => (
              <option key={category} value={category}>{t(CATEGORY_LABELS[category])}</option>
            ))}
          </NativeSelect>
        </FilterField>

        <FilterField labelKey="admin.audit.filter.outcome">
          <NativeSelect value={draft.outcome} onChange={e => setDraft({ ...draft, outcome: e.target.value })}>
            <option value="">{t('admin.common.allOutcomes')}</option>
            {AUDIT_OUTCOMES.map(outcome => (
              <option key={outcome} value={outcome}>{t(OUTCOME_LABELS[outcome])}</option>
            ))}
          </NativeSelect>
        </FilterField>

        <FilterField labelKey="admin.audit.filter.action">
          <Input
            value={draft.actionPrefix}
            onChange={e => setDraft({ ...draft, actionPrefix: e.target.value })}
            placeholder="platform_read."
            maxLength={100}
          />
        </FilterField>

        {companies.length > 0 && (
          <FilterField labelKey="admin.audit.filter.company">
            <NativeSelect value={draft.companyId} onChange={e => setDraft({ ...draft, companyId: e.target.value })}>
              <option value="">{t('admin.common.allCompanies')}</option>
              {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
            </NativeSelect>
          </FilterField>
        )}

        <FilterField labelKey="admin.audit.filter.from">
          <Input type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} />
        </FilterField>
        <FilterField labelKey="admin.audit.filter.to">
          <Input type="date" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} />
        </FilterField>

        {scope === 'all' && (
          <label className="flex items-center gap-2 pb-2.5 text-sm text-fg-muted">
            <input
              type="checkbox"
              className="size-4 accent-[rgb(var(--brand))]"
              checked={draft.mineOnly}
              onChange={e => setDraft({ ...draft, mineOnly: e.target.checked })}
            />
            {t('admin.audit.filter.mineOnly')}
          </label>
        )}

        <Button type="submit">{t('admin.audit.apply')}</Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => { setDraft(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); }}
        >
          {t('admin.common.reset')}
        </Button>
      </form>

      {problem ? (
        <div className="glass-card rounded-surface">
          <EmptyState icon={ShieldAlert} title={t(problem)} description={failure ?? undefined} className="py-14" />
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={24} className="animate-spin text-fg-subtle" />
        </div>
      ) : rows.length === 0 ? (
        <div className="glass-card rounded-surface">
          <EmptyState icon={ScrollText} title={t('admin.audit.empty')} className="py-14" />
        </div>
      ) : (
        <>
          <div className="glass-card relative overflow-x-auto rounded-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-wash">
                  {([
                    'admin.audit.col.time', 'admin.audit.col.actor', 'admin.audit.col.action',
                    'admin.audit.col.outcome', 'admin.audit.col.target', 'admin.audit.col.company',
                  ] as const).map(key => (
                    <th key={key} className={THEAD_CELL}>{t(key)}</th>
                  ))}
                  <th className={THEAD_CELL} />
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <Row
                    key={row.id}
                    row={row}
                    expanded={expanded === row.id}
                    onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs tabular-nums text-fg-subtle">
              {t('admin.audit.loaded', { count: deCount(rows.length) })}
            </p>
            {cursor ? (
              <Button
                onClick={() => void load(applied, cursor)}
                disabled={loading}
              >
                {loading ? t('admin.common.loading') : t('admin.audit.loadMore')}
              </Button>
            ) : (
              <p className="text-xs text-fg-subtle">{t('admin.audit.end')}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

const THEAD_CELL = 'whitespace-nowrap px-5 py-3.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle';

/** An outcome is a word and an icon: ok, refused, failed, or only attempted. */
const OUTCOME_TONES: Record<string, { tone: 'positive' | 'critical' | 'caution'; icon: LucideIcon }> = {
  ok:      { tone: 'positive', icon: CheckCircle2 },
  attempt: { tone: 'caution', icon: Clock },
  denied:  { tone: 'critical', icon: Ban },
  error:   { tone: 'critical', icon: XCircle },
};

const FilterField: React.FC<{ labelKey: TranslationKey; children: React.ReactNode }> = ({ labelKey, children }) => {
  const { t } = useTranslation();
  return (
    <UiField label={t(labelKey)} className="min-w-0 max-w-full">
      {children}
    </UiField>
  );
};

const Row: React.FC<{ row: AuditRow; expanded: boolean; onToggle: () => void }> = ({ row, expanded, onToggle }) => {
  const { t } = useTranslation();
  const outcome = OUTCOME_TONES[row.outcome] ?? OUTCOME_TONES.attempt;
  const OutcomeIcon = outcome.icon;
  const categoryKey = CATEGORY_LABELS[row.category];
  const hasDetail = row.before_value !== null || row.after_value !== null;

  return (
    <>
      <tr className="border-b border-line">
        <td className="whitespace-nowrap px-5 py-3 text-xs tabular-nums text-fg-muted">
          {deDateTime(row.occurred_at)}
        </td>
        <td className="px-5 py-3">
          <p className="text-sm text-fg">
            {row.actor_email ?? shortId(row.actor_user_id)}
          </p>
          {row.actor_role && (
            <p className="text-[11px] text-caution">{row.actor_role}</p>
          )}
        </td>
        <td className="px-5 py-3">
          <p className="text-sm font-medium text-fg">{row.action}</p>
          <p className="text-[11px] text-fg-subtle">
            {categoryKey ? t(categoryKey) : row.category}
          </p>
        </td>
        <td className="px-5 py-3">
          <Badge tone={outcome.tone}>
            <OutcomeIcon aria-hidden />
            {OUTCOME_LABELS[row.outcome] ? t(OUTCOME_LABELS[row.outcome]) : row.outcome}
          </Badge>
        </td>
        <td className="px-5 py-3 text-xs text-fg-muted">
          {row.target_type ?? EMPTY_CELL}
          {row.target_id && (
            <span className="block text-fg-subtle" title={row.target_id}>
              {shortId(row.target_id)}
            </span>
          )}
        </td>
        <td className="px-5 py-3 text-xs text-fg-subtle">
          {row.company_name ?? EMPTY_CELL}
        </td>
        <td className="px-5 py-3 text-right">
          {hasDetail && (
            <button onClick={onToggle} className="inline-flex items-center justify-center rounded-tight p-1.5 text-fg-subtle hover:bg-sunken hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10"
              title={t('admin.audit.details')}>
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
        </td>
      </tr>
      {expanded && hasDetail && (
        <tr className="border-b border-line bg-sunken">
          <td colSpan={7} className="px-5 py-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Detail labelKey="admin.audit.before" value={row.before_value} />
              <Detail labelKey="admin.audit.after" value={row.after_value} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

const Detail: React.FC<{ labelKey: TranslationKey; value: unknown }> = ({ labelKey, value }) => {
  const { t } = useTranslation();
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold text-fg-subtle">{t(labelKey)}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-tile border border-edge bg-raised p-3 font-mono text-xs text-fg-muted">
        {value === null || value === undefined ? EMPTY_CELL : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
};

export default PlatformAuditPage;
