import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert, Info, ChevronDown, ChevronUp, ScrollText } from 'lucide-react';
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

/**
 * Protokoll — who read what, and who changed what (plan 3.B / 3.G).
 *
 * `platform_audit_log` is append-only and `platform_audit_list` is the only way
 * to read it. `audit.read` reads the whole log — today the owner (open decision
 * D3) — and every other active staff role reads the rows it is the actor of.
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

const OUTCOME_COLORS: Record<string, { color: string; background: string }> = {
  ok:      { color: 'var(--success)', background: 'var(--success-subtle)' },
  attempt: { color: 'var(--text-tertiary)', background: 'var(--bg-muted)' },
  denied:  { color: 'var(--warning)', background: 'var(--warning-subtle)' },
  error:   { color: 'var(--danger)', background: 'var(--danger-subtle)' },
};

const controlStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderRadius: '0.75rem',
  fontSize: '0.875rem',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
};

const thStyle: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: '0.7rem',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontWeight: 600,
  whiteSpace: 'nowrap',
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

  if (!mayRead) {
    return (
      <div className="flex flex-col items-center justify-center py-20 rounded-2xl text-center"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <ShieldAlert size={40} className="mb-3" style={{ color: 'var(--warning)' }} />
        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('admin.read.denied')}</p>
        <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>{t('admin.audit.noAccessBody')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.audit.title')}</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('admin.audit.subtitle')}</p>
        </div>
        <button
          onClick={() => void load(applied, null)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium"
          style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />{t('admin.common.refresh')}
        </button>
      </div>

      {/* What this account is actually allowed to see, once the answer says so. */}
      {scope !== null && scope !== 'all' && (
        <div className="flex items-start gap-2 rounded-xl p-3 text-xs"
          style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          <Info size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--text-tertiary)' }} />
          <span>{t('admin.audit.scopeOwn')}</span>
        </div>
      )}

      {/* Filters. Applied by the button: every read writes a row of its own. */}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={event => { event.preventDefault(); setExpanded(null); setApplied(draft); }}
      >
        <Field labelKey="admin.audit.filter.category">
          <select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} style={controlStyle}>
            <option value="">{t('admin.common.allCategories')}</option>
            {AUDIT_CATEGORIES.map(category => (
              <option key={category} value={category}>{t(CATEGORY_LABELS[category])}</option>
            ))}
          </select>
        </Field>

        <Field labelKey="admin.audit.filter.outcome">
          <select value={draft.outcome} onChange={e => setDraft({ ...draft, outcome: e.target.value })} style={controlStyle}>
            <option value="">{t('admin.common.allOutcomes')}</option>
            {AUDIT_OUTCOMES.map(outcome => (
              <option key={outcome} value={outcome}>{t(OUTCOME_LABELS[outcome])}</option>
            ))}
          </select>
        </Field>

        <Field labelKey="admin.audit.filter.action">
          <input
            value={draft.actionPrefix}
            onChange={e => setDraft({ ...draft, actionPrefix: e.target.value })}
            placeholder="platform_read."
            maxLength={100}
            style={controlStyle}
          />
        </Field>

        {companies.length > 0 && (
          <Field labelKey="admin.audit.filter.company">
            <select value={draft.companyId} onChange={e => setDraft({ ...draft, companyId: e.target.value })} style={controlStyle}>
              <option value="">{t('admin.common.allCompanies')}</option>
              {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </Field>
        )}

        <Field labelKey="admin.audit.filter.from">
          <input type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} style={controlStyle} />
        </Field>
        <Field labelKey="admin.audit.filter.to">
          <input type="date" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} style={controlStyle} />
        </Field>

        {scope === 'all' && (
          <label className="flex items-center gap-2 text-sm pb-2" style={{ color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={draft.mineOnly}
              onChange={e => setDraft({ ...draft, mineOnly: e.target.checked })}
            />
            {t('admin.audit.filter.mineOnly')}
          </label>
        )}

        <button type="submit" className="px-4 py-2 rounded-xl text-sm font-semibold"
          style={{ background: 'var(--accent)', color: 'white' }}>
          {t('admin.audit.apply')}
        </button>
        <button
          type="button"
          onClick={() => { setDraft(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); }}
          className="px-4 py-2 rounded-xl text-sm font-medium"
          style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
        >
          {t('admin.common.reset')}
        </button>
      </form>

      {problem ? (
        <div className="flex flex-col items-center justify-center py-16 rounded-2xl text-center px-6"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <ShieldAlert size={32} className="mb-3" style={{ color: 'var(--warning)' }} />
          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t(problem)}</p>
          {failure && <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>{failure}</p>}
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={24} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 rounded-2xl"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <ScrollText size={36} className="mb-3" style={{ color: 'var(--text-tertiary)' }} />
          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('admin.audit.empty')}</p>
        </div>
      ) : (
        <>
          <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div style={{ overflowX: 'auto' }}>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {([
                      'admin.audit.col.time', 'admin.audit.col.actor', 'admin.audit.col.action',
                      'admin.audit.col.outcome', 'admin.audit.col.target', 'admin.audit.col.company',
                    ] as const).map(key => (
                      <th key={key} className="px-5 py-3.5 text-left" style={thStyle}>{t(key)}</th>
                    ))}
                    <th style={thStyle} />
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
          </div>

          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('admin.audit.loaded', { count: deCount(rows.length) })}
            </p>
            {cursor ? (
              <button
                onClick={() => void load(applied, cursor)}
                disabled={loading}
                className="px-4 py-2 rounded-xl text-sm font-semibold"
                style={{ background: 'var(--accent)', color: 'white', opacity: loading ? 0.6 : 1 }}
              >
                {loading ? t('admin.common.loading') : t('admin.audit.loadMore')}
              </button>
            ) : (
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('admin.audit.end')}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

const Field: React.FC<{ labelKey: TranslationKey; children: React.ReactNode }> = ({ labelKey, children }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold" style={{ color: 'var(--text-tertiary)' }}>{t(labelKey)}</span>
      {children}
    </div>
  );
};

const Row: React.FC<{ row: AuditRow; expanded: boolean; onToggle: () => void }> = ({ row, expanded, onToggle }) => {
  const { t } = useTranslation();
  const outcome = OUTCOME_COLORS[row.outcome] ?? OUTCOME_COLORS.attempt;
  const categoryKey = CATEGORY_LABELS[row.category];
  const hasDetail = row.before_value !== null || row.after_value !== null;

  return (
    <>
      <tr style={{ borderBottom: '1px solid var(--border)' }}>
        <td className="px-5 py-3 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
          {deDateTime(row.occurred_at)}
        </td>
        <td className="px-5 py-3">
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {row.actor_email ?? shortId(row.actor_user_id)}
          </p>
          {row.actor_role && (
            <p className="text-[11px]" style={{ color: 'var(--warning)' }}>{row.actor_role}</p>
          )}
        </td>
        <td className="px-5 py-3">
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{row.action}</p>
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {categoryKey ? t(categoryKey) : row.category}
          </p>
        </td>
        <td className="px-5 py-3">
          <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold" style={outcome}>
            {OUTCOME_LABELS[row.outcome] ? t(OUTCOME_LABELS[row.outcome]) : row.outcome}
          </span>
        </td>
        <td className="px-5 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {row.target_type ?? EMPTY_CELL}
          {row.target_id && (
            <span className="block" style={{ color: 'var(--text-tertiary)' }} title={row.target_id}>
              {shortId(row.target_id)}
            </span>
          )}
        </td>
        <td className="px-5 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {row.company_name ?? EMPTY_CELL}
        </td>
        <td className="px-5 py-3 text-right">
          {hasDetail && (
            <button onClick={onToggle} className="p-1.5 rounded-lg" style={{ color: 'var(--text-tertiary)' }}
              title={t('admin.audit.details')}>
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
        </td>
      </tr>
      {expanded && hasDetail && (
        <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
          <td colSpan={7} className="px-5 py-4">
            <div className="grid gap-4 md:grid-cols-2">
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
      <p className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>{t(labelKey)}</p>
      <pre
        className="text-xs rounded-xl p-3"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          color: 'var(--text-secondary)',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {value === null || value === undefined ? EMPTY_CELL : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
};

export default PlatformAuditPage;
