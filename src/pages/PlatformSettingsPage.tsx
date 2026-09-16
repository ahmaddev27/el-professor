import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert, Info, Save, Plus, Trash2, Tags, SlidersHorizontal } from 'lucide-react';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import type { Plan } from '../contexts/PlanContext';
import { calcPricing, fmt, type PriceBook } from '../utils/pricing';
import type { PlanFeatureMap } from '../utils/planFeatures';
import {
  canReadSetting,
  canSaveSetting,
  isVersionConflict,
  planFeaturesFromAnswer,
  planFeaturesFromForm,
  priceBookFromAnswer,
  priceBookFromForm,
  priceBookToForm,
  settingRefusalKey,
  type PriceBookForm,
  type SettingKey,
} from '../lib/platformSettings';
import { getSetting, putSetting } from '../lib/platformSettingsClient';
import { deDateTime } from '../lib/platformFormat';

/**
 * Einstellungen — the price book and the plan feature map (plan 3.E / 3.G).
 *
 * Both live in `app_private.platform_settings`, one JSON value per key with a
 * version every write bumps, and both are read and written only through
 * `platform_settings_get` / `platform_settings_put`.
 *
 * ## The version is the safety rule
 *
 * A save sends the version this screen read. If somebody else saved in the
 * meantime the database refuses with `version_conflict` and writes nothing —
 * that refusal is shown and the screen reloads. It is never retried with the
 * newer version, which would overwrite the other person's change unseen.
 *
 * ## Who may do what
 *
 * Reading needs `settings.read`, and billing holds that for the prices alone.
 * Saving the prices needs `pricing.manage` (owner and billing); saving the
 * feature map needs `settings.manage`, owner only — the map decides what every
 * customer may open, and a feature it fails to name reads as premium, so one
 * wrong write would lock every gated screen for every non-trial company below
 * premium. What this screen hides or disables is a courtesy; the database
 * refuses regardless.
 *
 * ## Money
 *
 * Prices are **integer cents per car per month**, discounts whole percents. The
 * amount is parsed once, on save, by the same reader the Gehaltsquittung uses,
 * so a typed "12,34" becomes 1234 and never passes through a float.
 */

const PLANS: Plan[] = ['basic', 'advanced', 'premium'];

const PLAN_LABELS: Record<Plan, TranslationKey> = {
  basic:    'admin.settings.plan.basic',
  advanced: 'admin.settings.plan.advanced',
  premium:  'admin.settings.plan.premium',
};

const controlStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderRadius: '0.75rem',
  fontSize: '0.875rem',
  background: 'var(--bg-subtle)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
};

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
};

/** What one settings key looks like once it has been read. */
interface Loaded<T> {
  value: T;
  version: number;
  updatedAt: string | null;
}

const PlatformSettingsPage: React.FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { t } = useTranslation();
  const [tab, setTab] = useState<SettingKey>('price_book');

  const mayReadPrices = canReadSetting(platformAccess, 'price_book');
  const mayReadFeatures = canReadSetting(platformAccess, 'plan_features');

  if (!mayReadPrices && !mayReadFeatures) {
    return (
      <div className="flex flex-col items-center justify-center py-20 rounded-2xl text-center" style={cardStyle}>
        <ShieldAlert size={40} className="mb-3" style={{ color: 'var(--warning)' }} />
        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('admin.read.denied')}</p>
        <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>{t('admin.settings.noAccessBody')}</p>
      </div>
    );
  }

  const tabs: { id: SettingKey; icon: React.ElementType; labelKey: TranslationKey; enabled: boolean }[] = [
    { id: 'price_book',    icon: Tags,              labelKey: 'admin.settings.tab.prices',   enabled: mayReadPrices },
    { id: 'plan_features', icon: SlidersHorizontal, labelKey: 'admin.settings.tab.features', enabled: mayReadFeatures },
  ];
  const active = tabs.find(item => item.id === tab && item.enabled) ? tab : (mayReadPrices ? 'price_book' : 'plan_features');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.title')}</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('admin.settings.subtitle')}</p>
      </div>

      <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--bg-subtle)' }}>
        {tabs.filter(item => item.enabled).map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all"
            style={{
              background: active === id ? 'var(--bg-surface)' : 'transparent',
              color: active === id ? 'var(--text-primary)' : 'var(--text-tertiary)',
              boxShadow: active === id ? 'var(--shadow-sm)' : 'none',
            }}
          >
            <Icon size={15} />{t(labelKey)}
          </button>
        ))}
      </div>

      {active === 'price_book' ? <PriceBookEditor /> : <PlanFeaturesEditor />}
    </div>
  );
};

// ─── Shared shell for one setting ───────────────────────────────────────────

interface EditorShellProps {
  loading: boolean;
  problem: TranslationKey | null;
  detail: string | null;
  onReload: () => void;
  version: number | null;
  updatedAt: string | null;
  children: React.ReactNode;
}

const EditorShell: React.FC<EditorShellProps> = ({ loading, problem, detail, onReload, version, updatedAt, children }) => {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw size={24} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
      </div>
    );
  }

  if (problem) {
    return (
      <div className="flex flex-col items-center justify-center py-16 rounded-2xl text-center px-6" style={cardStyle}>
        <ShieldAlert size={32} className="mb-3" style={{ color: 'var(--warning)' }} />
        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t(problem)}</p>
        {detail && <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>{detail}</p>}
        <button onClick={onReload} className="mt-4 px-4 py-2 rounded-xl text-sm font-semibold"
          style={{ background: 'var(--accent)', color: 'white' }}>
          {t('admin.settings.reload')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
        <span>{version === null ? '' : t('admin.settings.version', { version: String(version) })}</span>
        <span>{updatedAt ? t('admin.settings.updatedAt', { date: deDateTime(updatedAt) }) : ''}</span>
      </div>
      {children}
    </div>
  );
};

// ─── The price book ─────────────────────────────────────────────────────────

const PriceBookEditor: React.FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { refresh } = useAppConfig();
  const { showToast } = useToast();
  const { t } = useTranslation();

  const maySave = canSaveSetting(platformAccess, 'price_book');

  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded<PriceBook> | null>(null);
  const [form, setForm] = useState<PriceBookForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [exampleCars, setExampleCars] = useState('10');

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    setDetail(null);
    try {
      const answer = await getSetting('price_book');
      if (!answer.ok) {
        setProblem(settingRefusalKey(answer.reason));
        return;
      }
      const book = priceBookFromAnswer(answer);
      if (!book) {
        // A stored document this build cannot price from is not edited blindly.
        setProblem('admin.settings.refusal.invalidValue');
        return;
      }
      setLoaded({ value: book, version: answer.version, updatedAt: answer.updatedAt });
      setForm(priceBookToForm(book));
    } catch (err) {
      setProblem('admin.settings.loadFailed');
      setDetail(err instanceof Error ? err.message : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!form || !loaded) return;
    const parsed = priceBookFromForm(form);
    if ('error' in parsed) {
      showToast('error', t('admin.settings.invalidField', { field: parsed.error }));
      return;
    }

    setSaving(true);
    try {
      const answer = await putSetting('price_book', parsed.book, loaded.version);
      if (!answer.ok) {
        showToast('error', t(settingRefusalKey(answer.reason)));
        // Somebody else saved first: show what is there now, so the change is
        // made against their version rather than over it.
        if (isVersionConflict(answer)) await load();
        return;
      }
      showToast('success', t('admin.settings.saved'));
      setLoaded({ value: parsed.book, version: answer.version, updatedAt: answer.updatedAt });
      // Every screen prices from AppConfigContext, so it reads the new book now.
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('admin.settings.refusal.failed'));
    } finally {
      setSaving(false);
    }
  };

  const cars = Number.parseInt(exampleCars, 10);
  const preview = form && loaded && Number.isFinite(cars) && cars > 0
    ? (() => {
        const parsed = priceBookFromForm(form);
        return 'book' in parsed ? calcPricing(parsed.book, 'premium', cars, 'monthly') : null;
      })()
    : null;

  return (
    <EditorShell
      loading={loading}
      problem={problem}
      detail={detail}
      onReload={() => void load()}
      version={loaded?.version ?? null}
      updatedAt={loaded?.updatedAt ?? null}
    >
      {form && (
        <>
          {!maySave && (
            <Note textKey="admin.settings.readOnly" />
          )}

          <div className="rounded-2xl p-5 space-y-4" style={cardStyle}>
            <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.pricePerCar')}</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              {PLANS.map(plan => (
                <label key={plan} className="block">
                  <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    {t(PLAN_LABELS[plan])}
                  </span>
                  <input
                    value={form.pricePerCar[plan]}
                    disabled={!maySave}
                    onChange={e => setForm({ ...form, pricePerCar: { ...form.pricePerCar, [plan]: e.target.value } })}
                    /* German decimal comma in both languages — src/i18n/index.ts. */
                    placeholder="0,00"
                    style={{ ...controlStyle, width: '100%', opacity: maySave ? 1 : 0.6 }}
                  />
                </label>
              ))}
            </div>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('admin.settings.perMonth')}</p>
          </div>

          <div className="rounded-2xl p-5 space-y-4" style={cardStyle}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.tiers')}</h2>
              {maySave && (
                <button
                  onClick={() => setForm({ ...form, tiers: [...form.tiers, { minCars: '', percent: '' }] })}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
                  style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
                >
                  <Plus size={13} />{t('admin.settings.tier.add')}
                </button>
              )}
            </div>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('admin.settings.tiersHint')}</p>

            {form.tiers.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('admin.settings.noTiers')}</p>
            ) : form.tiers.map((tier, index) => (
              <div key={index} className="flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    {t('admin.settings.tier.minCars')}
                  </span>
                  <input
                    value={tier.minCars}
                    disabled={!maySave}
                    onChange={e => {
                      const tiers = [...form.tiers];
                      tiers[index] = { ...tiers[index], minCars: e.target.value };
                      setForm({ ...form, tiers });
                    }}
                    style={{ ...controlStyle, width: '8rem', opacity: maySave ? 1 : 0.6 }}
                  />
                </label>
                <label className="block">
                  <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    {t('admin.settings.tier.percent')}
                  </span>
                  <input
                    value={tier.percent}
                    disabled={!maySave}
                    onChange={e => {
                      const tiers = [...form.tiers];
                      tiers[index] = { ...tiers[index], percent: e.target.value };
                      setForm({ ...form, tiers });
                    }}
                    style={{ ...controlStyle, width: '8rem', opacity: maySave ? 1 : 0.6 }}
                  />
                </label>
                {maySave && (
                  <button
                    onClick={() => setForm({ ...form, tiers: form.tiers.filter((_, i) => i !== index) })}
                    className="p-2 rounded-lg mb-0.5"
                    style={{ color: 'var(--danger)' }}
                    title={t('admin.settings.tier.remove')}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-2xl p-5 space-y-4" style={cardStyle}>
            <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.yearlyDiscount')}</h2>
            <input
              value={form.yearlyDiscountPercent}
              disabled={!maySave}
              onChange={e => setForm({ ...form, yearlyDiscountPercent: e.target.value })}
              style={{ ...controlStyle, width: '8rem', opacity: maySave ? 1 : 0.6 }}
            />
          </div>

          {/* The same arithmetic compute_plan_price runs, on the typed book. */}
          <div className="rounded-2xl p-5 space-y-3" style={cardStyle}>
            <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.example')}</h2>
            <label className="block">
              <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                {t('admin.settings.exampleCars')}
              </span>
              <input value={exampleCars} onChange={e => setExampleCars(e.target.value)}
                style={{ ...controlStyle, width: '8rem' }} />
            </label>
            {preview ? (
              <div className="text-sm space-y-1" style={{ color: 'var(--text-secondary)' }}>
                <p>{t('admin.settings.exampleMonthly', { amount: fmt(preview.monthlyAfterFleet), percent: String(preview.fleetDiscountPct) })}</p>
                <p>{t('admin.settings.exampleYearly', { amount: fmt(preview.yearlyTotal) })}</p>
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('admin.settings.exampleUnavailable')}</p>
            )}
          </div>

          {maySave && (
            <div className="flex justify-end">
              <button
                onClick={() => void save()}
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
                style={{ background: 'var(--accent)', opacity: saving ? 0.6 : 1 }}
              >
                <Save size={16} />{saving ? t('admin.common.saving') : t('admin.settings.save')}
              </button>
            </div>
          )}
        </>
      )}
    </EditorShell>
  );
};

// ─── The plan feature map ───────────────────────────────────────────────────

const PlanFeaturesEditor: React.FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { refresh } = useAppConfig();
  const { showToast } = useToast();
  const { t } = useTranslation();

  const maySave = canSaveSetting(platformAccess, 'plan_features');

  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded<PlanFeatureMap> | null>(null);
  const [changes, setChanges] = useState<Record<string, Plan>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    setDetail(null);
    setChanges({});
    try {
      const answer = await getSetting('plan_features');
      if (!answer.ok) {
        setProblem(settingRefusalKey(answer.reason));
        return;
      }
      const map = planFeaturesFromAnswer(answer);
      if (!map) {
        setProblem('admin.settings.refusal.invalidValue');
        return;
      }
      setLoaded({ value: map, version: answer.version, updatedAt: answer.updatedAt });
    } catch (err) {
      setProblem('admin.settings.loadFailed');
      setDetail(err instanceof Error ? err.message : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!loaded) return;
    // Built from the map the database returned, so no key is ever dropped: a
    // map that fails to name a feature is refused, and a feature the map does
    // not name reads as premium.
    const map = planFeaturesFromForm(loaded.value, changes);
    if (!map) {
      showToast('error', t('admin.settings.refusal.invalidValue'));
      return;
    }

    setSaving(true);
    try {
      const answer = await putSetting('plan_features', map, loaded.version);
      if (!answer.ok) {
        const missing = !answer.ok && answer.missingFeatures?.length
          ? t('admin.settings.missingFeatures', { keys: answer.missingFeatures.join(', ') })
          : t(settingRefusalKey(answer.reason));
        showToast('error', missing);
        if (isVersionConflict(answer)) await load();
        return;
      }
      showToast('success', t('admin.settings.saved'));
      setLoaded({ value: map, version: answer.version, updatedAt: answer.updatedAt });
      setChanges({});
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('admin.settings.refusal.failed'));
    } finally {
      setSaving(false);
    }
  };

  const features = loaded ? Object.keys(loaded.value).sort() : [];

  return (
    <EditorShell
      loading={loading}
      problem={problem}
      detail={detail}
      onReload={() => void load()}
      version={loaded?.version ?? null}
      updatedAt={loaded?.updatedAt ?? null}
    >
      {loaded && (
        <>
          <Note textKey="admin.settings.featuresHint" />
          {!maySave && <Note textKey="admin.settings.readOnly" />}

          <div className="rounded-2xl overflow-hidden" style={cardStyle}>
            <div style={{ overflowX: 'auto' }}>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {(['admin.settings.col.feature', 'admin.settings.col.minPlan'] as const).map(key => (
                      <th key={key} className="px-5 py-3.5 text-left"
                        style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                        {t(key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {features.map(feature => {
                    const value = changes[feature] ?? loaded.value[feature];
                    return (
                      <tr key={feature} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td className="px-5 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>{feature}</td>
                        <td className="px-5 py-3">
                          <select
                            value={value}
                            disabled={!maySave}
                            onChange={e => setChanges({ ...changes, [feature]: e.target.value as Plan })}
                            style={{ ...controlStyle, opacity: maySave ? 1 : 0.6 }}
                          >
                            {PLANS.map(plan => <option key={plan} value={plan}>{t(PLAN_LABELS[plan])}</option>)}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {maySave && (
            <div className="flex justify-end">
              <button
                onClick={() => void save()}
                disabled={saving || Object.keys(changes).length === 0}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
                style={{ background: 'var(--accent)', opacity: saving || Object.keys(changes).length === 0 ? 0.6 : 1 }}
              >
                <Save size={16} />{saving ? t('admin.common.saving') : t('admin.settings.save')}
              </button>
            </div>
          )}
        </>
      )}
    </EditorShell>
  );
};

const Note: React.FC<{ textKey: TranslationKey }> = ({ textKey }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-xl p-3 text-xs"
      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
      <Info size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--text-tertiary)' }} />
      <span>{t(textKey)}</span>
    </div>
  );
};

export default PlatformSettingsPage;
