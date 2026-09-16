import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw, ShieldAlert, Info, Save, Plus, Trash2, Tags, SlidersHorizontal,
  Building2, Hourglass, Receipt,
} from 'lucide-react';
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
  invoiceFromForm,
  invoiceNumberExample,
  invoiceToForm,
  isVersionConflict,
  parseInvoice,
  parseSeller,
  parseTrial,
  planFeaturesFromAnswer,
  planFeaturesFromForm,
  priceBookFromAnswer,
  priceBookFromForm,
  priceBookToForm,
  sellerAddressBlock,
  sellerFromForm,
  sellerToForm,
  settingRefusalKey,
  trialFromForm,
  trialToForm,
  SELLER_FIELDS,
  type InvoiceForm,
  type InvoiceSettings,
  type PriceBookForm,
  type Seller,
  type SellerField,
  type SellerForm,
  type SettingKey,
  type SettingRecord,
  type TrialForm,
  type TrialSettings,
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

/**
 * Every settings key, in the order the tabs appear. A role sees only the tabs
 * `canReadSetting` allows and only the save buttons `canSaveSetting` allows;
 * both are courtesies, and the database refuses regardless.
 */
const SETTING_TABS: { id: SettingKey; icon: React.ElementType; labelKey: TranslationKey }[] = [
  { id: 'price_book',    icon: Tags,              labelKey: 'admin.settings.tab.prices' },
  { id: 'plan_features', icon: SlidersHorizontal, labelKey: 'admin.settings.tab.features' },
  { id: 'seller',        icon: Building2,         labelKey: 'admin.settings.tab.seller' },
  { id: 'trial',         icon: Hourglass,         labelKey: 'admin.settings.tab.trial' },
  { id: 'invoice',       icon: Receipt,           labelKey: 'admin.settings.tab.invoice' },
];

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

  // Billing holds settings.read for the prices alone, so its panel is a single
  // tab; a role without settings.read at all gets none, and is told so rather
  // than shown a form that would fail on save.
  const tabs = SETTING_TABS.filter(item => canReadSetting(platformAccess, item.id));

  if (tabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 rounded-2xl text-center" style={cardStyle}>
        <ShieldAlert size={40} className="mb-3" style={{ color: 'var(--warning)' }} />
        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('admin.read.denied')}</p>
        <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>{t('admin.settings.noAccessBody')}</p>
      </div>
    );
  }

  const active: SettingKey = tabs.some(item => item.id === tab) ? tab : tabs[0].id;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.title')}</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('admin.settings.subtitle')}</p>
      </div>

      {/* Five tabs do not fit one phone-width row, so the strip wraps onto a
          second line rather than scrolling the page sideways. */}
      <div className="flex flex-wrap gap-1 p-1 rounded-xl" style={{ background: 'var(--bg-subtle)' }}>
        {tabs.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="grow basis-28 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all"
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

      {active === 'price_book'    ? <PriceBookEditor /> :
       active === 'plan_features' ? <PlanFeaturesEditor /> :
       active === 'seller'        ? <SellerEditor /> :
       active === 'trial'         ? <TrialEditor /> :
                                    <InvoiceEditor />}
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
        // made against their version rather than over it. load() replaces the
        // form, so the unsaved entries are gone — the message says so, because
        // an operator told to "save again" would otherwise press a button that
        // now holds somebody else's values.
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
        // As on the price book: load() replaces the map and clears `changes`,
        // so the unsaved edits are discarded rather than kept for a retry. The
        // message says so — never re-send with the version that came back,
        // which would overwrite somebody else's change unseen.
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

// ─── The three keys of plan 3.10 ────────────────────────────────────────────

/**
 * Load, edit and save one settings key.
 *
 * The seller, the trial and the invoice defaults have the same shape — read the
 * value with its version, edit a form, send it back pinned to that version — so
 * the shape lives here once rather than three times. The price book and the
 * feature map keep their own bodies above: one carries a worked example, the
 * other a table of changed rows, and neither would read more clearly through
 * this.
 *
 * The version rule is the same one, and it is the reason this is worth sharing:
 * on `version_conflict` the editor reloads, and the unsaved entries go with the
 * old form. It is never re-sent with the version that came back, which would
 * overwrite somebody else's change unseen.
 *
 * The configuration is a module-level constant per editor, so its identity is
 * stable and the load effect runs once.
 */
interface SettingEditorConfig<T, F> {
  key: SettingKey;
  read: (record: SettingRecord) => T | null;
  toForm: (value: T) => F;
  fromForm: (form: F) => { value: T } | { error: string };
}

function useSettingEditor<T, F>(config: SettingEditorConfig<T, F>) {
  const { refresh } = useAppConfig();
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const [form, setForm] = useState<F | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    setDetail(null);
    try {
      const answer = await getSetting(config.key);
      if (!answer.ok) {
        setProblem(settingRefusalKey(answer.reason));
        return;
      }
      const value = config.read(answer);
      if (value === null) {
        // A stored document this build cannot read is not edited blindly: a
        // save would send back whatever the form made of it.
        setProblem('admin.settings.refusal.invalidValue');
        return;
      }
      setLoaded({ value, version: answer.version, updatedAt: answer.updatedAt });
      setForm(config.toForm(value));
    } catch (err) {
      setProblem('admin.settings.loadFailed');
      setDetail(err instanceof Error ? err.message : null);
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!form || !loaded) return;
    const parsed = config.fromForm(form);
    if ('error' in parsed) {
      showToast('error', t('admin.settings.invalidField', { field: parsed.error }));
      return;
    }

    setSaving(true);
    try {
      const answer = await putSetting(config.key, parsed.value, loaded.version);
      if (!answer.ok) {
        showToast('error', t(settingRefusalKey(answer.reason)));
        // Somebody else saved first: show what is there now, so the change is
        // made against their version rather than over it. load() replaces the
        // form, so the unsaved entries are gone — the message says so.
        if (isVersionConflict(answer)) await load();
        return;
      }
      showToast('success', t('admin.settings.saved'));
      setLoaded({ value: parsed.value, version: answer.version, updatedAt: answer.updatedAt });
      // The stored document, not what was typed: trimmed as the database has it.
      setForm(config.toForm(parsed.value));
      // Of these three only the trial reaches AppConfigContext today, as
      // trial_days; refreshing for all of them keeps one path.
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('admin.settings.refusal.failed'));
    } finally {
      setSaving(false);
    }
  };

  return { loading, problem, detail, loaded, form, setForm, saving, load, save };
}

const SaveRow: React.FC<{ saving: boolean; onSave: () => void }> = ({ saving, onSave }) => {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end">
      <button
        onClick={onSave}
        disabled={saving}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
        style={{ background: 'var(--accent)', opacity: saving ? 0.6 : 1 }}
      >
        <Save size={16} />{saving ? t('admin.common.saving') : t('admin.settings.save')}
      </button>
    </div>
  );
};

const Field: React.FC<{
  labelKey: TranslationKey;
  value: string;
  disabled: boolean;
  width?: string;
  onChange: (value: string) => void;
}> = ({ labelKey, value, disabled, width, onChange }) => {
  const { t } = useTranslation();
  return (
    <label className="block">
      <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
        {t(labelKey)}
      </span>
      <input
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        style={{ ...controlStyle, width: width ?? '100%', opacity: disabled ? 0.6 : 1 }}
      />
    </label>
  );
};

// ─── The seller printed on invoices ─────────────────────────────────────────

const SELLER_LABELS: Record<SellerField, TranslationKey> = {
  name:           'admin.settings.seller.name',
  street:         'admin.settings.seller.street',
  house_number:   'admin.settings.seller.house_number',
  postal_code:    'admin.settings.seller.postal_code',
  city:           'admin.settings.seller.city',
  vat_id:         'admin.settings.seller.vat_id',
  tax_number:     'admin.settings.seller.tax_number',
  bank_name:      'admin.settings.seller.bank_name',
  iban:           'admin.settings.seller.iban',
  bic:            'admin.settings.seller.bic',
  account_holder: 'admin.settings.seller.account_holder',
};

const SELLER_EDITOR: SettingEditorConfig<Seller, SellerForm> = {
  key: 'seller',
  read: record => parseSeller(record.value),
  toForm: sellerToForm,
  fromForm: sellerFromForm,
};

const SellerEditor: React.FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { t } = useTranslation();
  const maySave = canSaveSetting(platformAccess, 'seller');
  const { loading, problem, detail, loaded, form, setForm, saving, load, save } =
    useSettingEditor(SELLER_EDITOR);

  // The block as the invoice PDF composes it, from what is typed rather than
  // from what is stored, so a correction is visible before it is saved.
  const typed = form ? sellerFromForm(form) : null;
  const preview = typed && 'value' in typed ? sellerAddressBlock(typed.value) : null;

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
          <Note textKey="admin.settings.seller.hint" />
          <Note textKey="admin.settings.notAppliedYet" />
          {!maySave && <Note textKey="admin.settings.readOnly" />}

          <div className="rounded-2xl p-5 space-y-4" style={cardStyle}>
            <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.seller.title')}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {SELLER_FIELDS.map(field => (
                <Field
                  key={field}
                  labelKey={SELLER_LABELS[field]}
                  value={form[field]}
                  disabled={!maySave}
                  onChange={value => setForm({ ...form, [field]: value })}
                />
              ))}
            </div>
          </div>

          <div className="rounded-2xl p-5 space-y-3" style={cardStyle}>
            <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.seller.preview')}</h2>
            {preview ? (
              <div className="text-sm space-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                {preview.map((line, index) => <p key={index}>{line}</p>)}
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('admin.settings.exampleUnavailable')}</p>
            )}
          </div>

          {maySave && <SaveRow saving={saving} onSave={() => void save()} />}
        </>
      )}
    </EditorShell>
  );
};

// ─── The trial length ───────────────────────────────────────────────────────

const TRIAL_EDITOR: SettingEditorConfig<TrialSettings, TrialForm> = {
  key: 'trial',
  read: record => parseTrial(record.value),
  toForm: trialToForm,
  fromForm: trialFromForm,
};

const TrialEditor: React.FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { t } = useTranslation();
  const maySave = canSaveSetting(platformAccess, 'trial');
  const { loading, problem, detail, loaded, form, setForm, saving, load, save } =
    useSettingEditor(TRIAL_EDITOR);

  return (
    <EditorShell
      loading={loading}
      problem={problem}
      detail={detail}
      onReload={() => void load()}
      version={loaded?.version ?? null}
      updatedAt={loaded?.updatedAt ?? null}
    >
      {form && loaded && (
        <>
          {/* A longer trial is not retroactive and a shorter one locks nobody
              out: trial_end is written once, when a company is created. */}
          <Note textKey="admin.settings.trial.hint" />
          {!maySave && <Note textKey="admin.settings.readOnly" />}

          <div className="rounded-2xl p-5 space-y-4" style={cardStyle}>
            <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.trial.title')}</h2>
            <Field
              labelKey="admin.settings.trial.days"
              value={form.days}
              disabled={!maySave}
              width="8rem"
              onChange={days => setForm({ days })}
            />
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('admin.settings.trial.current', { days: String(loaded.value.days) })}
            </p>
          </div>

          {maySave && <SaveRow saving={saving} onSave={() => void save()} />}
        </>
      )}
    </EditorShell>
  );
};

// ─── The invoice defaults ───────────────────────────────────────────────────

const INVOICE_EDITOR: SettingEditorConfig<InvoiceSettings, InvoiceForm> = {
  key: 'invoice',
  read: record => parseInvoice(record.value),
  toForm: invoiceToForm,
  fromForm: invoiceFromForm,
};

const InvoiceEditor: React.FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { t } = useTranslation();
  const maySave = canSaveSetting(platformAccess, 'invoice');
  const { loading, problem, detail, loaded, form, setForm, saving, load, save } =
    useSettingEditor(INVOICE_EDITOR);

  const typed = form ? invoiceFromForm(form) : null;
  const example = typed && 'value' in typed
    ? invoiceNumberExample(typed.value, new Date().getFullYear())
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
          <Note textKey="admin.settings.invoice.hint" />
          <Note textKey="admin.settings.notAppliedYet" />
          {!maySave && <Note textKey="admin.settings.readOnly" />}

          <div className="rounded-2xl p-5 space-y-4" style={cardStyle}>
            <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.invoice.title')}</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                labelKey="admin.settings.invoice.numberPrefix"
                value={form.numberPrefix}
                disabled={!maySave}
                onChange={numberPrefix => setForm({ ...form, numberPrefix })}
              />
              <Field
                labelKey="admin.settings.invoice.numberDigits"
                value={form.numberDigits}
                disabled={!maySave}
                onChange={numberDigits => setForm({ ...form, numberDigits })}
              />
              <Field
                labelKey="admin.settings.invoice.paymentMethod"
                value={form.defaultPaymentMethod}
                disabled={!maySave}
                onChange={defaultPaymentMethod => setForm({ ...form, defaultPaymentMethod })}
              />
            </div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {example
                ? t('admin.settings.invoice.example', { number: example })
                : t('admin.settings.exampleUnavailable')}
            </p>
          </div>

          {maySave && <SaveRow saving={saving} onSave={() => void save()} />}
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
