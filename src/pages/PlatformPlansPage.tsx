import { useCallback, useEffect, useMemo, useState } from 'react';
import { Save, ShieldAlert } from 'lucide-react';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import { Alert, Button, Field, Input, PageHeader, cn, formatEuroCents } from '../components/ui';
import { MODULE_DEFINITIONS } from '../lib/companyModules';
import {
  derivedMinPlan,
  listPlans,
  savePlans,
  saveRefusalMessage,
  setPlanFeature,
  type PlanCatalogue,
  type PlanRow,
  type ProblemLabels,
} from '../lib/platformPlansClient';
import { formatCentsForInput, parseGermanAmountToCents } from '../utils/money';
import type { TranslationKey } from '../i18n';

/**
 * Pläne (owner's decision of 26.10.2026): the plans, their price per car and
 * the features each one grants, edited in one place. The catalogue
 * (`public.plans`) is the source; the old price-book prices and the feature map
 * are projections of it.
 *
 * ## Rules that are easy to undo
 *
 * - **The feature list comes from the server** (`feature_keys`, plus whatever a
 *   plan already holds). A hand-typed list here would be a second source. A key
 *   this build has no label for renders as its raw key and still round-trips.
 * - **Monotonicity is a convenience here, never the wall.** Ticking a feature
 *   on a plan ticks it on every higher plan; the database refuses a violation
 *   regardless.
 * - **The version is the safety rule.** A save carries the version that was
 *   read; on `version_conflict` the screen reloads and discards the unsaved
 *   edits. It never retries with the newer version.
 * - **Money is integer cents.** The price is typed in German notation and read
 *   by `parseGermanAmountToCents`, which yields cents directly: no euro float
 *   and no multiplication by 100 exists anywhere on this page.
 * - **Three plans, fixed** (open decision D11): no plan is added, and a fixed
 *   plan cannot be deactivated. The page says so instead of offering controls
 *   the database would refuse.
 */

/** The label key of the sidebar entry that carries a feature, first match wins. */
const FEATURE_LABEL_KEY = new Map<string, TranslationKey>();
for (const definition of MODULE_DEFINITIONS) {
  if (!FEATURE_LABEL_KEY.has(definition.feature)) FEATURE_LABEL_KEY.set(definition.feature, definition.labelKey);
}

const NAME_MAX = 60;

function priceTexts(plans: PlanRow[]): Record<string, string> {
  return Object.fromEntries(plans.map(plan => [plan.slug, formatCentsForInput(plan.price_per_car_cents)]));
}

function sameRows(a: PlanRow[], b: PlanRow[]): boolean {
  return JSON.stringify(a.map(p => [p.slug, p.name, p.price_per_car_cents, [...p.features].sort(), p.is_active]))
    === JSON.stringify(b.map(p => [p.slug, p.name, p.price_per_car_cents, [...p.features].sort(), p.is_active]));
}

export default function PlatformPlansPage() {
  const { platformCan } = useSuperAdmin();
  const { t } = useTranslation();

  if (!platformCan('pricing.manage')) {
    return (
      <div className="flex flex-col items-center justify-center rounded-surface border border-line bg-raised py-20 text-center font-ui">
        <ShieldAlert size={40} className="mb-3 text-caution" aria-hidden />
        <p className="font-medium text-fg">{t('admin.read.denied')}</p>
        <p className="mt-1 text-sm text-fg-muted">{t('admin.plans.noAccessBody')}</p>
      </div>
    );
  }
  return <PlansEditor />;
}

function PlansEditor() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { refresh } = useAppConfig();

  const [loading, setLoading] = useState(true);
  // A catalogue that could not be read is not an empty one, and a price that
  // was not read is not 0,00 €: the error state replaces the whole editor.
  const [loadFailed, setLoadFailed] = useState(false);
  const [catalogue, setCatalogue] = useState<PlanCatalogue | null>(null);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const adopt = useCallback((next: PlanCatalogue) => {
    setCatalogue(next);
    setRows(next.plans);
    setTexts(priceTexts(next.plans));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      adopt(await listPlans());
    } catch (err) {
      console.error(err);
      setCatalogue(null);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [adopt]);

  useEffect(() => { void load(); }, [load]);

  const featureLabel = useCallback(
    (key: string) => { const labelKey = FEATURE_LABEL_KEY.get(key); return labelKey ? t(labelKey) : key; },
    [t],
  );
  const planLabel = useCallback(
    (slug: string) => rows.find(plan => plan.slug === slug)?.name || slug,
    [rows],
  );
  const labels: ProblemLabels = useMemo(() => ({ plan: planLabel, feature: featureLabel }), [planLabel, featureLabel]);

  // Server's list first, then any key a plan holds that the server did not
  // list, so an unknown key stays visible and keeps its state through a save.
  const featureKeys = useMemo(() => {
    const known = catalogue?.featureKeys ?? [];
    const extra = rows.flatMap(plan => plan.features).filter(key => !known.includes(key));
    return [...known, ...new Set(extra)];
  }, [catalogue, rows]);

  const priceCents = (slug: string): number | null => parseGermanAmountToCents(texts[slug] ?? '');
  const nameProblem = (plan: PlanRow) => plan.name.trim() === '' || plan.name.length > NAME_MAX;

  const withPrices = (): PlanRow[] | null => {
    const out: PlanRow[] = [];
    for (const plan of rows) {
      const cents = priceCents(plan.slug);
      if (cents === null) return null;
      out.push({ ...plan, name: plan.name.trim(), price_per_car_cents: cents });
    }
    return out;
  };

  const candidate = withPrices();
  const invalid = candidate === null || rows.some(nameProblem);
  const dirty = catalogue !== null && (candidate === null || !sameRows(candidate, catalogue.plans));

  const update = (slug: string, patch: Partial<PlanRow>) =>
    setRows(rows.map(plan => (plan.slug === slug ? { ...plan, ...patch } : plan)));

  const save = async () => {
    if (!catalogue || !candidate || invalid) return;
    setSaving(true);
    try {
      const result = await savePlans(candidate, catalogue.version);
      if (!result.ok) {
        showToast('error', saveRefusalMessage(result, t, labels));
        // Somebody else saved first: show what is there now. load() replaces
        // the edits, and the message says so. Never re-send with the newer
        // version, which would overwrite their change unseen.
        if (result.reason === 'version_conflict') await load();
        return;
      }
      showToast('success', t('admin.settings.saved'));
      adopt({ ...catalogue, plans: [...result.plans].sort((a, b) => a.rank - b.rank), version: result.version });
      // Every screen prices and gates from AppConfigContext.
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('admin.settings.refusal.failed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="font-ui text-sm text-fg-subtle">{t('common.loading')}</p>;

  if (loadFailed || !catalogue) {
    return (
      <div className="space-y-4 font-ui">
        <Alert tone="critical" title={t('admin.read.failedTitle')}>{t('admin.plans.loadFailed')}</Alert>
        <Button variant="secondary" onClick={() => void load()}>{t('admin.common.refresh')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 font-ui">
      <PageHeader
        title={t('admin.plans.title')}
        description={t('admin.plans.subtitle')}
        actions={
          <Button onClick={() => void save()} disabled={!dirty || invalid} loading={saving}>
            <Save aria-hidden />{saving ? t('admin.common.saving') : t('admin.settings.save')}
          </Button>
        }
      />

      <Alert tone="neutral">
        <ul className="list-disc space-y-1 pl-4 text-fg-muted">
          <li>{t('admin.plans.rule.monotonic')}</li>
          <li>{t('admin.plans.rule.fixedPlans')}</li>
          <li>{t('admin.plans.rule.perCar')}</li>
        </ul>
      </Alert>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {rows.map(plan => {
          const fixed = catalogue.fixedSlugs.includes(plan.slug);
          const cents = priceCents(plan.slug);
          return (
            <section key={plan.slug} className={cn('space-y-4 rounded-surface border bg-raised p-5', plan.is_active ? 'border-line' : 'border-critical/40')}>
              <header className="flex items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold text-fg">{plan.name || plan.slug}</h2>
                <code className="text-[11px] text-fg-subtle">{plan.slug}</code>
              </header>

              <Field label={t('admin.plans.field.name')}
                error={nameProblem(plan) ? t('admin.plans.field.nameInvalid') : undefined}>
                <Input value={plan.name} maxLength={NAME_MAX} onChange={e => update(plan.slug, { name: e.target.value })} />
              </Field>

              <Field label={t('admin.plans.field.price')}
                hint={cents === null ? undefined : t('admin.plans.field.priceHint', { amount: formatEuroCents(cents) })}
                error={cents === null ? t('admin.plans.field.priceInvalid') : undefined}>
                {/* German decimal comma in both languages. */}
                <Input value={texts[plan.slug] ?? ''} inputMode="decimal" placeholder="0,00"
                  onChange={e => setTexts({ ...texts, [plan.slug]: e.target.value })} />
              </Field>

              <label className="flex items-start gap-2 text-[13px] text-fg">
                <input type="checkbox" checked={plan.is_active} disabled={fixed}
                  onChange={e => update(plan.slug, { is_active: e.target.checked })}
                  className="mt-0.5 h-4 w-4 accent-brand disabled:cursor-not-allowed disabled:opacity-50" />
                <span>
                  {t('admin.plans.field.active')}
                  {fixed && <span className="block text-[12px] text-fg-muted">{t('admin.plans.field.activeFixed')}</span>}
                </span>
              </label>

              <fieldset className="space-y-1.5">
                <legend className="mb-1 text-xs font-semibold text-fg-muted">
                  {t('admin.plans.field.features', { count: plan.features.length, total: featureKeys.length })}
                </legend>
                {featureKeys.map(key => (
                  <label key={key} className="flex items-center gap-2 text-[13px] text-fg">
                    <input type="checkbox" checked={plan.features.includes(key)}
                      onChange={e => setRows(setPlanFeature(rows, plan.slug, key, e.target.checked))}
                      className="h-4 w-4 accent-brand" />
                    <span>{featureLabel(key)}</span>
                  </label>
                ))}
              </fieldset>
            </section>
          );
        })}
      </div>

      <section className="space-y-3 rounded-surface border border-line bg-raised p-5">
        <h2 className="text-base font-semibold text-fg">{t('admin.plans.derived.title')}</h2>
        <p className="text-[13px] text-fg-muted">{t('admin.plans.derived.hint')}</p>
        <ul className="divide-y divide-line">
          {featureKeys.map(key => {
            const slug = derivedMinPlan(rows, key);
            return (
              <li key={key} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                <span className="text-fg">{featureLabel(key)} <code className="ml-1 text-[11px] text-fg-subtle">{key}</code></span>
                <span className={slug ? 'font-medium text-fg' : 'font-medium text-critical'}>
                  {slug ? planLabel(slug) : t('admin.plans.derived.none')}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
