import { useState, type FormEvent } from 'react';
import { FlaskConical, Settings2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import { TEST_DEFAULT_MINUTES, type EffectiveSetting, type EffectiveSettings, type SettingsRow } from '../../lib/tripAnalysisView';

export const BLOCK_GAP_RANGE = { min: 1, max: 720 } as const;
export const TRAVEL_MARGIN_RANGE = { min: 0, max: 240 } as const;

interface Props {
  row: SettingsRow | null;
  effective: EffectiveSettings;
  /** An administrator outside a read-only context. */
  canEdit: boolean;
  onSave: (values: { blockGapMinutes: number | null; travelMarginMinutes: number | null }) => Promise<boolean>;
  onUseTestDefault: (use: boolean) => void;
}

/** Whole minutes in a range, blank for "not set", or undefined when the text is neither. */
export function parseMinutes(text: string, range: { min: number; max: number }): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= range.min && value <= range.max ? value : undefined;
}

function SettingValue({ setting }: { setting: EffectiveSetting }) {
  const { t } = useTranslation();
  if (setting.source === 'missing') {
    return <Badge tone="caution">{t('ta.settings.notSet')}</Badge>;
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-[15px] font-semibold tabular-nums text-fg">{t('ta.minutes', { value: setting.value ?? 0 })}</span>
      {setting.source === 'test_default' ? (
        <Badge tone="caution">
          <FlaskConical aria-hidden />
          {t('ta.settings.testDefault')}
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * The two inputs the owner decides. Missing stays missing: the screen asks,
 * and uses the test value only when the viewer chooses it for this look.
 */
export function TripAnalysisSettingsCard({ row, effective, canEdit, onSave, onUseTestDefault }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [blockGapText, setBlockGapText] = useState('');
  const [travelMarginText, setTravelMarginText] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const blockGap = parseMinutes(blockGapText, BLOCK_GAP_RANGE);
  const travelMargin = parseMinutes(travelMarginText, TRAVEL_MARGIN_RANGE);
  const anyMissing = effective.blockGap.source !== 'stored' || effective.travelMargin.source !== 'stored';

  const startEditing = () => {
    setBlockGapText(row?.block_gap_minutes?.toString() ?? '');
    setTravelMarginText(row?.travel_margin_minutes?.toString() ?? '');
    setSubmitted(false);
    setEditing(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (blockGap === undefined || travelMargin === undefined) return;
    setSaving(true);
    const ok = await onSave({ blockGapMinutes: blockGap, travelMarginMinutes: travelMargin });
    setSaving(false);
    if (ok) setEditing(false);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Settings2 aria-hidden className="size-4 text-fg-subtle" />
          <CardTitle>{t('ta.settings.title')}</CardTitle>
        </div>
        {canEdit && !editing ? (
          <Button variant="secondary" size="sm" onClick={startEditing}>
            {t('ta.settings.edit')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        {editing ? (
          <form className="grid grid-cols-1 gap-4" onSubmit={submit} noValidate>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label={`${t('ta.settings.blockGap')} (${t('ta.settings.minutesLabel')})`}
                hint={t('ta.settings.blockGapHint')}
                error={submitted && blockGap === undefined ? t('ta.settings.invalid', BLOCK_GAP_RANGE) : undefined}
              >
                <Input inputMode="numeric" value={blockGapText} onChange={event => setBlockGapText(event.target.value)} />
              </Field>
              <Field
                label={`${t('ta.settings.travelMargin')} (${t('ta.settings.minutesLabel')})`}
                hint={t('ta.settings.travelMarginHint')}
                error={submitted && travelMargin === undefined ? t('ta.settings.invalid', TRAVEL_MARGIN_RANGE) : undefined}
              >
                <Input inputMode="numeric" value={travelMarginText} onChange={event => setTravelMarginText(event.target.value)} />
              </Field>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={() => setEditing(false)} disabled={saving}>
                {t('ta.settings.cancel')}
              </Button>
              <Button type="submit" loading={saving}>
                {t('ta.settings.save')}
              </Button>
            </div>
          </form>
        ) : (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1">
              <dt className="text-[13px] font-medium text-fg-muted">{t('ta.settings.blockGap')}</dt>
              <dd>
                <SettingValue setting={effective.blockGap} />
              </dd>
              <dd className="text-xs text-fg-subtle">{t('ta.settings.blockGapHint')}</dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-[13px] font-medium text-fg-muted">{t('ta.settings.travelMargin')}</dt>
              <dd>
                <SettingValue setting={effective.travelMargin} />
              </dd>
              <dd className="text-xs text-fg-subtle">{t('ta.settings.travelMarginHint')}</dd>
            </div>
          </dl>
        )}

        {anyMissing && !effective.usesTestDefault ? (
          <Alert
            tone="caution"
            title={t('ta.settings.missingTitle')}
            action={
              <Button variant="secondary" size="sm" onClick={() => onUseTestDefault(true)}>
                <FlaskConical aria-hidden />
                {t('ta.settings.useTestDefault', { minutes: TEST_DEFAULT_MINUTES })}
              </Button>
            }
          >
            {t('ta.settings.missingBody')}
            {!canEdit ? <span className="mt-1 block">{t('ta.settings.onlyAdmin')}</span> : null}
          </Alert>
        ) : null}

        {effective.usesTestDefault ? (
          <Alert
            tone="caution"
            icon={FlaskConical}
            action={
              <Button variant="secondary" size="sm" onClick={() => onUseTestDefault(false)}>
                {t('ta.settings.stopTestDefault')}
              </Button>
            }
          >
            {t('ta.settings.testDefaultActive', { minutes: TEST_DEFAULT_MINUTES })}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
