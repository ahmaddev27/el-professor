import React, { useCallback, useEffect, useState } from 'react';
import {
  ShieldAlert, Save, Plus, Trash2, Tags, SlidersHorizontal,
  Building2, Receipt, Mail, Megaphone, ToggleRight, Scale, Landmark,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import type { Plan } from '../contexts/PlanContext';
import type { PlatformAccess } from '../lib/platformAccess';
import { calcPricing, fmt, type PriceBook } from '../utils/pricing';
import {
  Alert, Button, Card, Field as UiField, Input as UiInput,
  PageHeader, Tabs, TabsList, TabsTrigger,
} from '../components/ui';
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
      <Card className="flex flex-col items-center justify-center py-20 text-center font-ui">
        <ShieldAlert size={40} className="mb-3 text-caution" />
        <p className="font-medium text-fg">{t('admin.read.denied')}</p>
        <p className="mt-1 text-sm text-fg-subtle">{t('admin.settings.noAccessBody')}</p>
      </Card>
    );
  }

  const active: SettingsTab = tabs.some(item => item.id === tab) ? tab : tabs[0].id;

  return (
    <div className="space-y-6">
      <PageHeader title={t('admin.settings.title')} description={t('admin.settings.subtitle')} className="pb-0" />

      {/* Ten tabs do not fit one row, on a phone or on a laptop, so the strip
          scrolls inside its own frame rather than scrolling the page sideways. */}
      <Tabs value={active} onValueChange={id => setTab(id as SettingsTab)}>
        <TabsList>
          {tabs.map(({ id, icon: Icon, labelKey }) => (
            <TabsTrigger key={id} value={id}>
              <Icon size={15} />{t(labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

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

          <Card className="space-y-4 p-5 font-ui">
            <h2 className="font-semibold text-fg">{t('admin.settings.pricePerCar')}</h2>
            {/* The per-car prices are projected from the plan catalogue; the
                stored values are a shadow nothing reads, so they are shown, not
                edited. The save still sends them unchanged. */}
            <PlansPageNote />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {PLANS.map(plan => (
                <UiField key={plan} label={t(PLAN_LABELS[plan])}>
                  <UiInput
                    value={form.pricePerCar[plan]}
                    disabled
                    readOnly
                    /* German decimal comma in both languages — src/i18n/index.ts. */
                    placeholder="0,00"
                  />
                </UiField>
              ))}
            </div>
            <p className="text-xs text-fg-subtle">{t('admin.settings.perMonth')}</p>
          </Card>

          {/* The owner's first-month price (15.10.2026): one flat figure for a
              company's first invoice. */}
          <Card className="space-y-4 p-5 font-ui">
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
          </Card>

          <Card className="space-y-4 p-5 font-ui">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold text-fg">{t('admin.settings.tiers')}</h2>
              {maySave && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setForm({ ...form, tiers: [...form.tiers, { minCars: '', percent: '' }] })}
                >
                  <Plus size={13} />{t('admin.settings.tier.add')}
                </Button>
              )}
            </div>
            <p className="text-xs text-fg-subtle">{t('admin.settings.tiersHint')}</p>

            {form.tiers.length === 0 ? (
              <p className="text-sm text-fg-subtle">{t('admin.settings.noTiers')}</p>
            ) : form.tiers.map((tier, index) => (
              <div key={index} className="flex flex-wrap items-end gap-3">
                <UiField label={t('admin.settings.tier.minCars')} className="w-32">
                  <UiInput
                    value={tier.minCars}
                    disabled={!maySave}
                    onChange={e => {
                      const tiers = [...form.tiers];
                      tiers[index] = { ...tiers[index], minCars: e.target.value };
                      setForm({ ...form, tiers });
                    }}
                  />
                </UiField>
                <UiField label={t('admin.settings.tier.percent')} className="w-32">
                  <UiInput
                    value={tier.percent}
                    disabled={!maySave}
                    onChange={e => {
                      const tiers = [...form.tiers];
                      tiers[index] = { ...tiers[index], percent: e.target.value };
                      setForm({ ...form, tiers });
                    }}
                  />
                </UiField>
                {maySave && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setForm({ ...form, tiers: form.tiers.filter((_, i) => i !== index) })}
                    className="mb-0.5 text-critical hover:text-critical"
                    title={t('admin.settings.tier.remove')}
                    aria-label={t('admin.settings.tier.remove')}
                  >
                    <Trash2 size={15} />
                  </Button>
                )}
              </div>
            ))}
          </Card>

          <Card className="space-y-4 p-5 font-ui">
            <h2 className="font-semibold text-fg">{t('admin.settings.yearlyDiscount')}</h2>
            <UiInput
              value={form.yearlyDiscountPercent}
              disabled={!maySave}
              onChange={e => setForm({ ...form, yearlyDiscountPercent: e.target.value })}
              className="w-32"
              aria-label={t('admin.settings.yearlyDiscount')}
            />
          </Card>

          {/* The same arithmetic compute_plan_price runs, on the typed book. */}
          <Card className="space-y-3 p-5 font-ui">
            <h2 className="font-semibold text-fg">{t('admin.settings.example')}</h2>
            <UiField label={t('admin.settings.exampleCars')} className="w-32">
              <UiInput value={exampleCars} onChange={e => setExampleCars(e.target.value)} />
            </UiField>
            {preview ? (
              <div className="space-y-1 text-sm text-fg-muted tabular-nums">
                <p>{t('admin.settings.exampleMonthly', { amount: fmt(preview.monthlyAfterFleet), percent: String(preview.fleetDiscountPct) })}</p>
                <p>{t('admin.settings.exampleYearly', { amount: fmt(preview.yearlyTotal) })}</p>
                {firstMonthPreview && (
                  <p>{t('admin.settings.exampleFirstMonth', { amount: fmt(firstMonthPreview.finalTotal) })}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">{t('admin.settings.exampleUnavailable')}</p>
            )}
          </Card>

          {maySave && (
            <div className="flex justify-end">
              <Button onClick={() => void save()} disabled={saving}>
                <Save size={16} />{saving ? t('admin.common.saving') : t('admin.settings.save')}
              </Button>
            </div>
          )}
        </>
      )}
    </EditorShell>
  );
};

// ─── The plan feature map ───────────────────────────────────────────────────

const PlanFeaturesEditor: React.FC = () => {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded<PlanFeatureMap> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    setDetail(null);
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

  const features = loaded ? Object.keys(loaded.value).sort() : [];

  // Read-only since the plan catalogue became the source (26.10.2026): the
  // stored map is rewritten by every catalogue save and read by nothing, so an
  // editor here would write a value no screen or gate ever uses.
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
          <PlansPageNote />

          <Card className="relative overflow-x-auto font-ui">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  {(['admin.settings.col.feature', 'admin.settings.col.minPlan'] as const).map(key => (
                    <th key={key} className="px-5 py-3.5 text-left text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                      {t(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {features.map(feature => (
                  <tr key={feature} className="border-b border-line">
                    <td className="px-5 py-3 font-medium text-fg">{feature}</td>
                    <td className="px-5 py-3 text-fg-muted">{t(PLAN_LABELS[loaded.value[feature]])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </EditorShell>
  );
};

/** Points an operator at the page that now owns prices and features. */
const PlansPageNote: React.FC = () => {
  const { t } = useTranslation();
  return (
    <Alert tone="brand" className="font-ui">
      {t('admin.plans.editedOnPlansPage')}{' '}
      <Link to="/admin/plaene" className="font-semibold underline">{t('admin.plans.openPage')}</Link>
    </Alert>
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

          <Card className="space-y-4 p-5 font-ui">
            <h2 className="font-semibold text-fg">{t('admin.settings.seller.title')}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          </Card>

          <Card className="space-y-3 p-5 font-ui">
            <h2 className="font-semibold text-fg">{t('admin.settings.seller.preview')}</h2>
            {preview ? (
              <div className="space-y-0.5 text-sm text-fg-muted">
                {preview.map((line, index) => <p key={index}>{line}</p>)}
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">{t('admin.settings.exampleUnavailable')}</p>
            )}
          </Card>

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

          <Card className="space-y-4 p-5 font-ui">
            <h2 className="font-semibold text-fg">{t('admin.settings.invoice.title')}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
            <p className="text-sm text-fg-muted">
              {example
                ? t('admin.settings.invoice.example', { number: example })
                : t('admin.settings.exampleUnavailable')}
            </p>
          </Card>

          {maySave && <SaveRow saving={saving} onSave={() => void save()} />}
        </>
      )}
    </EditorShell>
  );
};

// ── Presentation (phase 5): the markup above only draws; its logic is unchanged ──

export default PlatformSettingsPage;
