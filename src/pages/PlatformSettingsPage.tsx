import React, { useCallback, useEffect, useState } from 'react';
import {
  ShieldAlert, Save, Plus, Trash2, Tags, SlidersHorizontal,
  Building2, Receipt, Mail, Megaphone, ToggleRight, Scale, Landmark,
} from 'lucide-react';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import type { Plan } from '../contexts/PlanContext';
import type { PlatformAccess } from '../lib/platformAccess';
import { calcPricing, fmt, type PriceBook } from '../utils/pricing';
import { Field as UiField, Input as UiInput } from '../components/ui';
import type { PlanFeatureMap } from '../utils/planFeatures';
import {
  canReadAnnouncements,
  canReadSetting,
  canSaveSetting,
  invoiceFromForm,
  invoiceNumberExample,
  invoiceToForm,
  isVersionConflict,
  parseInvoice,
  parseSeller,
  planFeaturesFromAnswer,
  planFeaturesFromForm,
  priceBookFromAnswer,
  priceBookFromForm,
  priceBookToForm,
  sellerAddressBlock,
  sellerFromForm,
  sellerToForm,
  settingRefusalKey,
  SELLER_FIELDS,
  type InvoiceForm,
  type InvoiceSettings,
  type PriceBookForm,
  type Seller,
  type SellerField,
  type SellerForm,
} from '../lib/platformSettings';
import { getSetting, putSetting } from '../lib/platformSettingsClient';
import {
  cardStyle,
  controlStyle,
  EditorShell,
  Field,
  Note,
  SaveRow,
  useSettingEditor,
  type Loaded,
  type SettingEditorConfig,
} from '../components/settings/settingsEditorKit';
import MailSettingsEditor from '../components/settings/MailSettingsEditor';
import AnnouncementsEditor from '../components/settings/AnnouncementsEditor';
import FeatureFlagsEditor from '../components/settings/FeatureFlagsEditor';
import ImpressumEditor from '../components/settings/ImpressumEditor';
import PrivacyTextEditor from '../components/settings/PrivacyTextEditor';

/**
 * Einstellungen (plan 3.E / 3.G): the price book, the plan feature map, the
 * seller, the invoice defaults (3.9, 3.10), the mail sender and the
 * code-mail templates (3.10), the announcements and the feature flags (3.11),
 * and the legal pages: the Impressum and the privacy policy (20260921120000).
 *
 * Every key lives in `app_private.platform_settings`, one JSON value per key
 * with a version every write bumps, read and written only through
 * `platform_settings_get` / `platform_settings_put`. The announcements are rows
 * of their own, behind three RPCs of the same shape.
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
 * Saving the prices needs `pricing.manage` (owner and billing); saving anything
 * else needs `settings.manage`, owner only — the feature map decides what every
 * customer may open, the seller is printed on every invoice, the templates reach
 * every new customer, and an announcement shows on every screen of the
 * companies it names. What this screen hides or disables is a courtesy; the
 * database refuses regardless.
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

type SettingsTab =
  | 'price_book' | 'plan_features' | 'seller' | 'invoice'
  | 'mail' | 'announcements' | 'feature_flags' | 'impressum' | 'privacy';

/**
 * Every tab, in the order they appear, and who may read it. A role sees only
 * the tabs it may read and only the save buttons it may use; both are
 * courtesies, and the database refuses regardless.
 */
const SETTING_TABS: {
  id: SettingsTab;
  icon: React.ElementType;
  labelKey: TranslationKey;
  readable: (access: PlatformAccess) => boolean;
}[] = [
  { id: 'price_book',    icon: Tags,              labelKey: 'admin.settings.tab.prices',   readable: a => canReadSetting(a, 'price_book') },
  { id: 'plan_features', icon: SlidersHorizontal, labelKey: 'admin.settings.tab.features', readable: a => canReadSetting(a, 'plan_features') },
  { id: 'seller',        icon: Building2,         labelKey: 'admin.settings.tab.seller',   readable: a => canReadSetting(a, 'seller') },
  { id: 'invoice',       icon: Receipt,           labelKey: 'admin.settings.tab.invoice',  readable: a => canReadSetting(a, 'invoice') },
  { id: 'mail',          icon: Mail,              labelKey: 'admin.settings.tab.mail',     readable: a => canReadSetting(a, 'mail.sender') },
  { id: 'announcements', icon: Megaphone,         labelKey: 'admin.settings.tab.announcements', readable: canReadAnnouncements },
  { id: 'feature_flags', icon: ToggleRight,       labelKey: 'admin.settings.tab.flags',    readable: a => canReadSetting(a, 'feature_flags') },
  { id: 'impressum',     icon: Landmark,          labelKey: 'admin.settings.tab.impressum', readable: a => canReadSetting(a, 'legal.impressum') },
  { id: 'privacy',       icon: Scale,             labelKey: 'admin.settings.tab.privacy',  readable: a => canReadSetting(a, 'legal.privacy') },
];

const PlatformSettingsPage: React.FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { t } = useTranslation();
  const [tab, setTab] = useState<SettingsTab>('price_book');

  // Billing holds settings.read for the prices alone, so its panel is a single
  // tab; a role without settings.read at all gets none, and is told so rather
  // than shown a form that would fail on save.
  const tabs = SETTING_TABS.filter(item => item.readable(platformAccess));

  if (tabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 rounded-2xl text-center" style={cardStyle}>
        <ShieldAlert size={40} className="mb-3" style={{ color: 'var(--warning)' }} />
        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('admin.read.denied')}</p>
        <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>{t('admin.settings.noAccessBody')}</p>
      </div>
    );
  }

  const active: SettingsTab = tabs.some(item => item.id === tab) ? tab : tabs[0].id;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.settings.title')}</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('admin.settings.subtitle')}</p>
      </div>

      {/* Ten tabs do not fit one row, on a phone or on a laptop, so the strip
          wraps rather than scrolling the page sideways. */}
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
       active === 'invoice'       ? <InvoiceEditor /> :
       active === 'mail'          ? <MailSettingsEditor /> :
       active === 'announcements' ? <AnnouncementsEditor /> :
       active === 'impressum'     ? <ImpressumEditor /> :
       active === 'privacy'       ? <PrivacyTextEditor /> :
                                    <FeatureFlagsEditor />}
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
      setLoaded({ value: book, version: answer.version, updatedAt: answer.updatedAt, updatedBy: answer.updatedBy });
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
      setLoaded({ value: parsed.book, version: answer.version, updatedAt: answer.updatedAt, updatedBy: answer.updatedBy });
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

  // The first invoice under the typed book, when it names a first month.
  const firstMonthPreview = form && loaded && Number.isFinite(cars) && cars > 0
    ? (() => {
        const parsed = priceBookFromForm(form);
        if (!('book' in parsed) || parsed.book.first_month_cents === undefined) return null;
        return calcPricing(parsed.book, 'premium', cars, 'monthly', true);
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

          {/* The owner's first-month price (15.10.2026): one flat figure for a
              company's first invoice. Drawn with the design system's classes so
              the file's inline-style count does not move. */}
          <div className="space-y-4 rounded-2xl border border-line bg-raised p-5 font-ui">
            <UiField label={t('admin.settings.firstMonth')} hint={t('admin.settings.firstMonthHint')} className="max-w-xs">
              <UiInput
                value={form.firstMonth}
                disabled={!maySave}
                onChange={e => setForm({ ...form, firstMonth: e.target.value })}
                /* German decimal comma in both languages — src/i18n/index.ts. */
                placeholder="200,00"
                inputMode="decimal"
              />
            </UiField>
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
                {firstMonthPreview && (
                  <p>{t('admin.settings.exampleFirstMonth', { amount: fmt(firstMonthPreview.finalTotal) })}</p>
                )}
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
      setLoaded({ value: map, version: answer.version, updatedAt: answer.updatedAt, updatedBy: answer.updatedBy });
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
      setLoaded({ value: map, version: answer.version, updatedAt: answer.updatedAt, updatedBy: answer.updatedBy });
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

  // Still the placeholder the migration seeded, never edited: version 1, no
  // actor behind it, and no address. That is what both real databases got —
  // no platform account sits in a company, so the seed had nothing to copy —
  // and since 20260920130000 the invoice PDF prints exactly this, so the owner
  // is told before a customer sees a sender with no address.
  const notConfigured = !!loaded
    && loaded.version === 1
    && loaded.updatedBy === null
    && loaded.value.street.trim() === ''
    && loaded.value.iban.trim() === '';

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
          {notConfigured && <Note textKey="admin.settings.seller.notConfigured" />}
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

export default PlatformSettingsPage;
