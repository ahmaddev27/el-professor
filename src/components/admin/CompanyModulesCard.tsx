/**
 * The per-company module editor, in the company detail view of
 * `/admin/companies` (Docs/design/per-company-modules.md, section 4).
 *
 * One company at a time, deliberately, and not a matrix across companies:
 * nineteen companies by sixteen toggleable modules is 300-plus checkboxes with
 * nowhere to show the per-cell plan state, and a misclick lands on the wrong
 * customer. One company at a time also keeps one audit row per decision and
 * gives the plan line somewhere to live.
 *
 * **Saved per row, on change**, through `platform_company_set_module` — one
 * module per call. A wholesale save would repeat `company_role_save`'s
 * documented failure: a stored key the build does not know is dropped on save,
 * with a success toast. There is no `expected_version` and that is correct —
 * the row is one boolean for one module of one company, two operators cannot
 * meaningfully conflict on it, and the `FOR NO KEY UPDATE` on the company row
 * serialises concurrent calls while the audit log keeps both decisions.
 *
 * After every call the map is **re-read**, never mutated optimistically, which
 * is the pattern every panel screen uses.
 *
 * ── Two things it reads for the company on screen and not for the operator ──
 *
 * The plan comes from `companies.plan` for **this** company, not from
 * `usePlan()`: inside the panel the signed-in account has no company, so
 * `usePlan()` answers the fabricated premium of a platform session and every
 * row would read "Aktiv". The question asked is `planHasFeature`, the **tier**
 * alone — not `planAllows`, which also folds in the subscription state. A
 * company whose subscription has merely lapsed must not be told its *plan* does
 * not include the module, which would be false.
 *
 * `minPlanForFeature` reads the live `plan_features` map through
 * `useAppConfig()`, the same map `LockedFeaturePage` reads, so the panel and the
 * locked screen can never quote different plans.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 * It writes no `note`. The column and the RPC's fourth argument exist, and the
 * design gives them a purpose ("why, for the next operator"), but the approved
 * layout has no field for one and a prompt per toggle would be friction on the
 * commonest act. Adding the field later needs no migration.
 *
 * It is styled with the design system's tokens rather than the surrounding
 * file's inline `var(--bg-surface)` objects. Measured on this branch, light
 * `--bg-surface` (#ffffff) and `--raised` (#FFFFFF) are the same colour and
 * `--border` / `--line` differ by a shade, so the card sits in the legacy
 * detail view unchanged in light and a hair different in dark — the seam
 * CLAUDE.md already accepts for `AppLayout`. The alternative was ~25 new inline
 * styles in a file the style ratchet records at 264, which is the debt that gate
 * exists to refuse.
 */
import { useCallback, useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { callPlatformRpc } from '../../lib/platformRpc';
import {
  MODULE_DEFINITIONS,
  type CompanyModules,
  type ModuleState,
  moduleEnabled,
  moduleState,
  NO_MODULE_DECISIONS,
  pagesClosedByDisabling,
  parseCompanyModules,
} from '../../lib/companyModules';
import { minPlanForFeature, planHasFeature } from '../../utils/planFeatures';
import type { Plan } from '../../contexts/PlanContext';
import { useAppConfig } from '../../contexts/AppConfigContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useToast } from '../../contexts/ToastContext';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from '../ui';

const PLAN_LABELS: Record<Plan, string> = { basic: 'Basic', advanced: 'Advanced', premium: 'Premium' };

/** The one-sentence reason a locked module shows instead of a checkbox. */
const LOCKED_REASON_KEYS = {
  overview: 'sa.modules.locked.overview',
  billing: 'sa.modules.locked.billing',
  users: 'sa.modules.locked.users',
  roles: 'sa.modules.locked.roles',
  settings: 'sa.modules.locked.settings',
  datensicherung: 'sa.modules.locked.datensicherung',
} as const;

interface CompanyModulesCardProps {
  companyId: string;
  /** False for a role without `companies.lifecycle`: the rows are read-only. */
  canEdit: boolean;
}

export default function CompanyModulesCard({ companyId, canEdit }: CompanyModulesCardProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { planFeatures } = useAppConfig();

  const [modules, setModules] = useState<CompanyModules>(NO_MODULE_DECISIONS);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [carLimit, setCarLimit] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // A load that failed must not be drawn as "every module active": an all-green
  // list is a claim about this customer's configuration.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    const [company, rows] = await Promise.all([
      supabase.from('companies').select('plan, subscription_car_limit').eq('id', companyId).maybeSingle(),
      supabase.from('company_modules').select('module_key, enabled').eq('company_id', companyId),
    ]);
    if (company.error || rows.error) {
      setLoadFailed(true);
      setLoading(false);
      return;
    }
    const stored = (company.data?.plan ?? null) as Plan | null;
    setPlan(stored === 'basic' || stored === 'advanced' || stored === 'premium' ? stored : null);
    setCarLimit(typeof company.data?.subscription_car_limit === 'number' ? company.data.subscription_car_limit : null);
    setModules(parseCompanyModules(rows.data));
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (moduleKey: string, enabled: boolean) => {
    setSaving(moduleKey);
    try {
      await callPlatformRpc('platform_company_set_module', {
        p_company_id: companyId,
        p_module_key: moduleKey,
        p_enabled: enabled,
      });
      showToast('success', t('sa.modules.saved'));
    } catch (err) {
      // PlatformRpcError carries the German sentence the database wrote —
      // `module_locked` and `denied` included — so it is shown as it stands.
      showToast('error', err instanceof Error ? err.message : t('sa.modules.saveFailed'));
    } finally {
      setSaving(null);
      // Re-read either way: a refused call changed nothing and a successful one
      // is confirmed by the database rather than assumed here.
      await load();
    }
  };

  // ── Presentation ──────────────────────────────────────────────────────────

  const stateLine = (state: ModuleState, feature: Parameters<typeof minPlanForFeature>[1]): string => {
    switch (state) {
      case 'active':
        return t('sa.modules.state.active');
      case 'operator_off':
        return t('sa.modules.state.operatorOff');
      case 'plan_inert':
        // The whole of what remains of the warning the owner originally asked
        // for: it says the toggle is inert, names the plan the company is on
        // and names the plan that would include the module. It does not ask
        // "are you sure" and offers no override, because there is none.
        return t('sa.modules.state.planInert', {
          plan: plan ? PLAN_LABELS[plan] : '—',
          minPlan: PLAN_LABELS[minPlanForFeature(planFeatures, feature)],
        });
      case 'plan_off':
        return t('sa.modules.state.planOff');
      default:
        return '';
    }
  };

  return (
    <Card className="font-ui">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle as="h3">{t('sa.modules.title')}</CardTitle>
          <CardDescription>{t('sa.modules.intro')}</CardDescription>
        </div>
        {plan !== null && (
          <span className="shrink-0 text-[13px] tabular-nums text-fg-muted">
            {t('sa.modules.planLine', {
              plan: PLAN_LABELS[plan],
              cars: carLimit === null ? '—' : String(carLimit),
            })}
          </span>
        )}
      </CardHeader>

      <CardContent>
        {loading && <p className="text-[13px] text-fg-subtle">{t('common.loading')}</p>}

        {!loading && loadFailed && (
          <Alert tone="critical" title={t('sa.modules.loadFailedTitle')}>
            {t('sa.modules.loadFailed')}
          </Alert>
        )}

        {!loading && !loadFailed && (
          <>
            {!canEdit && (
              <Alert tone="neutral" className="mb-3">
                {t('sa.modules.readOnly')}
              </Alert>
            )}
            <ul className="divide-y divide-line">
              {MODULE_DEFINITIONS.map(definition => {
                const planAllows = plan !== null && planHasFeature(planFeatures, plan, definition.feature);
                const enabled = moduleEnabled(modules, definition.key);
                const state = moduleState({ lockable: definition.lockable, planAllows, enabled });
                const closes = pagesClosedByDisabling(modules, definition.key);
                return (
                  <li key={definition.key} className="flex items-start gap-3 py-2.5">
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10">
                      {definition.lockable ? (
                        <input
                          type="checkbox"
                          id={`module-${definition.key}`}
                          checked={enabled}
                          disabled={!canEdit || saving !== null}
                          onChange={event => toggle(definition.key, event.target.checked)}
                          className="h-4 w-4 cursor-pointer accent-brand disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      ) : (
                        <Lock size={14} className="text-fg-subtle" aria-hidden />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <label
                        htmlFor={definition.lockable ? `module-${definition.key}` : undefined}
                        className={cn('text-[13px] font-medium text-fg', definition.lockable && 'cursor-pointer')}
                      >
                        {t(definition.labelKey)}
                      </label>
                      {/* The raw key, because it is what the audit row says. */}
                      <code className="ml-2 text-[11px] text-fg-subtle">{definition.key}</code>
                      <p className="mt-0.5 text-[12px] text-fg-muted">
                        {state === 'locked'
                          ? t(LOCKED_REASON_KEYS[definition.key as keyof typeof LOCKED_REASON_KEYS])
                          : stateLine(state, definition.feature)}
                        {/* Whether switching this one off closes tables or only
                            hides a screen — the one place an operator's
                            expectation and the mechanism diverge (the four
                            Dokumente entries share one page key). */}
                        {state === 'active' && (
                          <span className="text-fg-subtle">
                            {' '}
                            {closes.length > 0 ? t('sa.modules.closesData') : t('sa.modules.viewOnly')}
                          </span>
                        )}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
