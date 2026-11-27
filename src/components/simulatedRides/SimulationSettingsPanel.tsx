import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, NativeSelect } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { CompanySimulationSettings } from '../../lib/simulationSettingsClient';
import {
  SHARE_PERCENT_CHOICES,
  resolveShareRate,
  type SharePercent,
  type ShareScope,
  type ShareSetting,
} from '../../utils/simulatedRides/monthlyRate';
import {
  MAX_SETTINGS_SEED,
  draftFromSettings,
  settingFromDraft,
  type SettingsDraft,
  type SettingsDraftMode,
  type SettingsDraftProblem,
} from '../../utils/simulatedRides/settingsDraft';

/**
 * The company's simulation settings (FleetBook round 8, section 5 and D8): the
 * share rate and the return to the Betriebssitz. An administrator edits them;
 * everyone else reads them, because they decide what the month shows.
 *
 * The share's meaning is not a setting: it stays CONFIGURATION_REQUIRED (D1),
 * and the panel says so beside the rate rather than leaving it to the report.
 */

export interface SimulationSettingsPanelProps {
  /** Null while the first read is out. */
  settings: CompanySimulationSettings | null;
  loadFailed: boolean;
  canEdit: boolean;
  saving: boolean;
  /** The month chosen on the page, for the rate preview. */
  period: { year: number; month: number } | null;
  /** A fresh seed to offer for a random draw. */
  suggestedSeed: number;
  onSave: (values: { shareSetting: ShareSetting | null; returnToBase: boolean }) => void;
}

export function SimulationSettingsPanel({ settings, loadFailed, canEdit, saving, period, suggestedSeed, onSave }: SimulationSettingsPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromSettings(settings));
  const [problem, setProblem] = useState<SettingsDraftProblem | null>(null);

  // A stored row (or a save's answer) replaces the draft: the form shows what is saved.
  useEffect(() => {
    setDraft(draftFromSettings(settings));
    setProblem(null);
  }, [settings]);

  const parsed = useMemo(() => settingFromDraft(draft), [draft]);
  const preview = useMemo(() => {
    if (!parsed.ok || !parsed.shareSetting) return null;
    const s = parsed.shareSetting;
    if (s.mode === 'fixed') return t('simrides.settings.preview.fixed', { percent: s.percent });
    if (s.scope === 'day') return t('simrides.settings.preview.day');
    if (!period) return null;
    const rate = resolveShareRate(s, { ...period, day: 1 });
    return t('simrides.settings.preview.month', { percent: rate.ratePercent, month: `${String(period.month).padStart(2, '0')}/${period.year}` });
  }, [parsed, period, t]);

  const disabled = !canEdit || saving || settings === null;
  const set = (patch: Partial<SettingsDraft>) => { setDraft(d => ({ ...d, ...patch })); setProblem(null); };

  const save = () => {
    if (!parsed.ok) { setProblem(parsed.problem); return; }
    onSave({ shareSetting: parsed.shareSetting, returnToBase: draft.returnToBase });
  };

  return (
    <Card className="font-ui">
      <CardHeader>
        <CardTitle>{t('simrides.settings.title')}</CardTitle>
        <CardDescription>{t('simrides.settings.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        {loadFailed ? <Alert tone="critical" title={t('simrides.settings.loadFailed')} /> : null}
        {!canEdit ? <p className="text-sm text-fg-muted">{t('simrides.settings.adminOnly')}</p> : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field label={t('simrides.settings.mode')} id="simsettings-mode">
            <NativeSelect id="simsettings-mode" value={draft.mode} disabled={disabled}
              onChange={e => set({ mode: e.target.value as SettingsDraftMode, seed: e.target.value === 'random' && !draft.seed ? String(suggestedSeed) : draft.seed })}>
              <option value="none">{t('simrides.settings.mode.none')}</option>
              <option value="fixed">{t('simrides.settings.mode.fixed')}</option>
              <option value="random">{t('simrides.settings.mode.random')}</option>
            </NativeSelect>
          </Field>
          {draft.mode === 'fixed' ? (
            <Field label={t('simrides.settings.percent')} id="simsettings-percent">
              <NativeSelect id="simsettings-percent" value={draft.percent} disabled={disabled}
                onChange={e => set({ percent: Number(e.target.value) as SharePercent })}>
                {SHARE_PERCENT_CHOICES.map(p => <option key={p} value={p}>{`${p} %`}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
          {draft.mode === 'random' ? (
            <>
              <Field label={t('simrides.settings.scope')} id="simsettings-scope">
                <NativeSelect id="simsettings-scope" value={draft.scope} disabled={disabled}
                  onChange={e => set({ scope: e.target.value as ShareScope })}>
                  <option value="month">{t('simrides.settings.scope.month')}</option>
                  <option value="day">{t('simrides.settings.scope.day')}</option>
                </NativeSelect>
              </Field>
              <Field label={t('simrides.settings.seed')} id="simsettings-seed"
                error={problem === 'seed_invalid' ? t('simrides.settings.seedInvalid', { max: MAX_SETTINGS_SEED }) : undefined}>
                <Input id="simsettings-seed" inputMode="numeric" value={draft.seed} disabled={disabled}
                  onChange={e => set({ seed: e.target.value })} />
              </Field>
            </>
          ) : null}
        </div>
        <p className="text-sm text-fg">{preview ?? t('simrides.settings.preview.none')}</p>
        <p className="text-xs text-fg-subtle">{t('simrides.settings.meaning')}</p>
        <label className="flex cursor-pointer items-start gap-3 text-sm text-fg">
          <input type="checkbox" className="mt-1 size-4 shrink-0 cursor-pointer accent-brand disabled:cursor-not-allowed"
            checked={draft.returnToBase} disabled={disabled} onChange={e => set({ returnToBase: e.target.checked })} />
          <span>
            {t('simrides.settings.returnToBase')}
            <span className="block text-xs text-fg-subtle">{t('simrides.settings.returnToBaseHint')}</span>
          </span>
        </label>
        {canEdit ? (
          <div>
            <Button type="button" onClick={save} disabled={disabled}>
              {saving ? t('simrides.settings.saving') : t('simrides.settings.save')}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
