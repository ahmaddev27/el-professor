import React, { useState } from 'react';
import { Plus, RotateCcw, Trash2, AlertTriangle } from 'lucide-react';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import {
  canSaveSetting,
  mailSenderFromForm,
  mailSenderToForm,
  mailTemplateDefaultsKept,
  mailTemplateFromForm,
  mailTemplateToForm,
  type MailSenderForm,
  type MailTemplateForm,
} from '../../lib/platformSettings';
import {
  MAIL_PARAGRAPH_MAX,
  MAIL_PARAGRAPHS_MAX,
  MAIL_TEMPLATE_HAS_BUTTON,
  MAIL_TEMPLATE_PURPOSES,
  MAIL_TEMPLATE_VARIABLES,
  mailTemplateKey,
  parseMailSender,
  parseMailTemplate,
  type MailSender,
  type MailTemplateOverrides,
  type MailTemplatePurpose,
} from '../../../supabase/functions/_shared/mail-template.ts';
import { buildOtpMail } from '../../../supabase/functions/_shared/otp-mail.ts';
import { Alert, Badge as UiBadge, Button, Card, CardContent, CardHeader, CardTitle, Field as UiField, Input, Tabs, TabsList, TabsTrigger, cn } from '../ui';
import {
  controlClass,
  EditorShell,
  Field,
  Note,
  SaveRow,
  useSettingEditor,
  type SettingEditorConfig,
} from './settingsEditorKit';

/**
 * E-Mails (plan 3.10): the sender's display name, and the text of the four
 * one-time-code mails.
 *
 * The mails are German whatever language the reader or the owner uses — like
 * every other mail the product sends — so the editor shows and previews German
 * text, while its own labels follow the UI language.
 *
 * **The preview is the mail.** It renders through `buildOtpMail`, the same
 * function the edge functions send with, on invented values, so what the owner
 * sees is what a new customer would receive: the same layout, the same code
 * box, the same fallback to the default wording when a field would be refused.
 *
 * A save sends only the fields that differ from the default (see
 * `mailTemplateFromForm`), so a field the owner never touched keeps following
 * the code.
 */

const PURPOSE_LABELS: Record<MailTemplatePurpose, TranslationKey> = {
  signup_verify:   'admin.mail.purpose.signup_verify',
  password_reset:  'admin.mail.purpose.password_reset',
  invite_activate: 'admin.mail.purpose.invite_activate',
  email_change:    'admin.mail.purpose.email_change',
};

const VARIABLE_LABELS: Record<string, TranslationKey> = {
  email:     'admin.mail.variable.email',
  new_email: 'admin.mail.variable.new_email',
  company:   'admin.mail.variable.company',
};

/** Invented values for the preview. Never a real address, never a real code. */
const PREVIEW_VALUES = {
  email: 'anna.beispiel@example.com',
  newEmail: 'anna.neu@example.com',
  companyName: 'Taxi Beispiel GmbH',
  code: '123456',
};

const SENDER_EDITOR: SettingEditorConfig<MailSender, MailSenderForm> = {
  key: 'mail.sender',
  read: record => parseMailSender(record.value),
  toForm: mailSenderToForm,
  fromForm: mailSenderFromForm,
};

/** One editor configuration per mail, built once so each keeps its identity. */
const TEMPLATE_EDITORS: Record<MailTemplatePurpose, SettingEditorConfig<MailTemplateOverrides, MailTemplateForm>> =
  Object.fromEntries(MAIL_TEMPLATE_PURPOSES.map(purpose => [purpose, {
    key: mailTemplateKey(purpose),
    read: record => parseMailTemplate(purpose, record.value),
    toForm: (value: MailTemplateOverrides) => mailTemplateToForm(purpose, value),
    fromForm: (form: MailTemplateForm) => mailTemplateFromForm(purpose, form),
  }])) as Record<MailTemplatePurpose, SettingEditorConfig<MailTemplateOverrides, MailTemplateForm>>;

const MailSettingsEditor: React.FC = () => {
  const { t } = useTranslation();
  const [purpose, setPurpose] = useState<MailTemplatePurpose>('signup_verify');

  return (
    <div className="space-y-6">
      <SenderSection />

      <div className="space-y-4">
        <div>
          <h2 className="font-ui font-semibold text-fg">{t('admin.mail.templates.title')}</h2>
          <p className="mt-1 font-ui text-xs text-fg-subtle">{t('admin.mail.templates.hint')}</p>
        </div>
        <Tabs value={purpose} onValueChange={id => setPurpose(id as MailTemplatePurpose)}>
          <TabsList variant="segmented" className="flex-wrap">
            {MAIL_TEMPLATE_PURPOSES.map(id => (
              <TabsTrigger key={id} value={id}>{t(PURPOSE_LABELS[id])}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {/* Keyed by the mail, so switching discards the other mail's unsaved form. */}
        <TemplateSection key={purpose} purpose={purpose} />
      </div>
    </div>
  );
};

// ─── The sender ──────────────────────────────────────────────────────────────

const SenderSection: React.FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { t } = useTranslation();
  const maySave = canSaveSetting(platformAccess, 'mail.sender');
  const { loading, problem, detail, loaded, form, setForm, saving, load, save } = useSettingEditor(SENDER_EDITOR);

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
          <Card className="font-ui">
            <CardHeader>
              <CardTitle>{t('admin.mail.sender.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                labelKey="admin.mail.sender.name"
                value={form.name}
                disabled={!maySave}
                onChange={name => setForm({ name })}
              />
              <Note textKey="admin.mail.sender.hint" />
            </CardContent>
          </Card>
          {!maySave && <Note textKey="admin.settings.readOnly" />}
          {maySave && <SaveRow saving={saving} onSave={() => void save()} />}
        </>
      )}
    </EditorShell>
  );
};

// ─── One mail's template ─────────────────────────────────────────────────────

const Badge: React.FC<{ isDefault: boolean }> = ({ isDefault }) => {
  const { t } = useTranslation();
  return (
    <UiBadge tone={isDefault ? 'neutral' : 'brand'}>
      {t(isDefault ? 'admin.mail.field.default' : 'admin.mail.field.custom')}
    </UiBadge>
  );
};

const FieldLabel: React.FC<{ labelKey: TranslationKey; isDefault: boolean }> = ({ labelKey, isDefault }) => {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-2 font-ui text-[13px] font-[550] text-fg-muted">
      {t(labelKey)} <Badge isDefault={isDefault} />
    </span>
  );
};

const TemplateSection: React.FC<{ purpose: MailTemplatePurpose }> = ({ purpose }) => {
  const { platformAccess } = useSuperAdmin();
  const maySave = canSaveSetting(platformAccess, mailTemplateKey(purpose));
  const { loading, problem, detail, loaded, form, setForm, saving, load, save } =
    useSettingEditor(TEMPLATE_EDITORS[purpose]);

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
        <TemplateForm purpose={purpose} form={form} setForm={setForm} maySave={maySave}
          saving={saving} onSave={() => void save()} />
      )}
    </EditorShell>
  );
};

const TemplateForm: React.FC<{
  purpose: MailTemplatePurpose;
  form: MailTemplateForm;
  setForm: (form: MailTemplateForm) => void;
  maySave: boolean;
  saving: boolean;
  onSave: () => void;
}> = ({ purpose, form, setForm, maySave, saving, onSave }) => {
  const { t } = useTranslation();
  const hasButton = MAIL_TEMPLATE_HAS_BUTTON[purpose];
  const typed = mailTemplateFromForm(purpose, form);
  const refusal = 'error' in typed ? typed.error : null;

  // The mail exactly as it would go out, from what is typed, through the
  // function the edge functions send with. A form the database would refuse is
  // not previewed as if it would be sent.
  const preview = 'value' in typed
    ? buildOtpMail(purpose, { appUrl: window.location.origin, ...PREVIEW_VALUES }, typed.value)
    : null;

  const kept = mailTemplateDefaultsKept(purpose, form);
  const allDefault = kept.subject && kept.heading && kept.paragraphs && kept.button;
  const setParagraph = (index: number, text: string) => {
    const paragraphs = [...form.paragraphs];
    paragraphs[index] = text;
    setForm({ ...form, paragraphs });
  };

  return (
    <>
      {!maySave && <Note textKey="admin.settings.readOnly" />}

      <Card className="font-ui">
        <CardHeader>
          <CardTitle as="h3">{t(PURPOSE_LABELS[purpose])}</CardTitle>
          {maySave && !allDefault && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setForm(mailTemplateToForm(purpose, {}))}
            >
              <RotateCcw size={13} />{t('admin.mail.resetAll')}
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
        <UiField label={<FieldLabel labelKey="admin.mail.field.subject" isDefault={kept.subject} />} hint={t('admin.mail.subjectRule')}>
          <Input value={form.subject} disabled={!maySave}
            onChange={e => setForm({ ...form, subject: e.target.value })} />
        </UiField>

        <UiField label={<FieldLabel labelKey="admin.mail.field.heading" isDefault={kept.heading} />}>
          <Input value={form.heading} disabled={!maySave}
            onChange={e => setForm({ ...form, heading: e.target.value })} />
        </UiField>

        <div className="space-y-2">
          <FieldLabel labelKey="admin.mail.field.paragraphs" isDefault={kept.paragraphs} />
          {form.paragraphs.map((text, index) => (
            <div key={index} className="flex items-start gap-2">
              <textarea
                value={text}
                disabled={!maySave}
                rows={3}
                maxLength={MAIL_PARAGRAPH_MAX}
                onChange={e => setParagraph(index, e.target.value)}
                aria-label={t('admin.mail.paragraphN', { n: index + 1 })}
                className={cn(controlClass, 'resize-y')}
              />
              {maySave && form.paragraphs.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setForm({ ...form, paragraphs: form.paragraphs.filter((_, i) => i !== index) })}
                  className="text-critical hover:text-critical"
                  title={t('admin.mail.removeParagraph')}
                  aria-label={t('admin.mail.removeParagraph')}
                >
                  <Trash2 size={15} />
                </Button>
              )}
            </div>
          ))}
          {maySave && form.paragraphs.length < MAIL_PARAGRAPHS_MAX && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setForm({ ...form, paragraphs: [...form.paragraphs, ''] })}
            >
              <Plus size={13} />{t('admin.mail.addParagraph')}
            </Button>
          )}
          <p className="text-xs text-fg-subtle">
            {t('admin.mail.variables')}{' '}
            {MAIL_TEMPLATE_VARIABLES[purpose].map((name, i) => (
              <span key={name}>
                {i > 0 && ' · '}
                <code className="rounded bg-sunken px-1">{`{${name}}`}</code>{' '}
                {t(VARIABLE_LABELS[name])}
              </span>
            ))}
          </p>
        </div>

        {hasButton && (
          <UiField label={<FieldLabel labelKey="admin.mail.field.button" isDefault={kept.button} />}>
            <Input value={form.button} disabled={!maySave}
              onChange={e => setForm({ ...form, button: e.target.value })} />
          </UiField>
        )}

        <Note textKey="admin.mail.fixedParts" />
        </CardContent>
      </Card>

      {refusal && (
        <Alert tone="caution" icon={AlertTriangle}>{t('admin.mail.refused', { field: refusal })}</Alert>
      )}

      <Card className="font-ui">
        <CardHeader>
          <CardTitle as="h3">{t('admin.mail.preview')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
        {preview ? (
          <>
            <p className="text-sm text-fg-muted">
              <span className="font-semibold">{t('admin.mail.previewSubject')}</span> {preview.subject}
            </p>
            {/* Sandboxed: no script runs and no link navigates. allow-same-origin
                keeps the frame in this page's process — a fully opaque frame
                rendered blank in headless Chrome whenever it was narrow — and
                is harmless without allow-scripts: nothing in it can execute to
                use that origin, and the mail is our own escaped markup anyway. */}
            <iframe
              title={t('admin.mail.preview')}
              sandbox="allow-same-origin"
              srcDoc={preview.html}
              className="h-[42rem] w-full rounded-tile border border-line"
            />
            <p className="text-xs text-fg-subtle">{t('admin.mail.previewValues')}</p>
          </>
        ) : (
          <p className="text-sm text-fg-subtle">{t('admin.settings.exampleUnavailable')}</p>
        )}
        </CardContent>
      </Card>

      {maySave && <SaveRow saving={saving} onSave={onSave} disabled={refusal !== null} />}
    </>
  );
};

// ── Presentation (phase 5): the markup above only draws; its logic is unchanged ──

export default MailSettingsEditor;
