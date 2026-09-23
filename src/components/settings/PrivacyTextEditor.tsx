import { useId, type FC } from 'react';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  canSaveSetting,
  parsePrivacyDocument,
  privacyFromForm,
  privacyProblemMessage,
  privacyStoredBytes,
  privacyToForm,
  PRIVACY_MAX_BYTES,
  type PrivacyDocument,
  type PrivacyForm,
} from '../../lib/platformSettings';
import { NO_PRIVACY_TEXT, type PrivacyContent } from '../../lib/legalPages';
import { PrivacyDocument as PrivacyDocumentView } from '../legal/LegalDocument';
import { Alert, Card, CardContent, CardHeader, CardTitle, cn } from '../ui';
import { controlFrameClass } from '../ui/Input';
import { EditorShell, Field, Note, SaveRow, useSettingEditor, type SettingEditorConfig } from './settingsEditorKit';

/**
 * The privacy policy `/datenschutz` publishes (`legal.privacy`, migration
 * 20260921120000): the lawyer's text and its "Stand" date.
 *
 * Loaded, edited and saved like every other key — pinned to the version it
 * read, refused as a `version_conflict` if somebody saved first, and recorded
 * with the text before and after. Reading is `settings.read` (owner,
 * read_only), saving `settings.manage` (owner). The preview is the page's own
 * component on the typed text, so what the owner reads is what a visitor reads.
 */

const PRIVACY_EDITOR: SettingEditorConfig<PrivacyDocument, PrivacyForm> = {
  key: 'legal.privacy',
  read: record => parsePrivacyDocument(record.value),
  toForm: privacyToForm,
  fromForm: privacyFromForm,
};

const toContent = (doc: PrivacyDocument): PrivacyContent =>
  doc.paragraphs === undefined ? NO_PRIVACY_TEXT : { asOf: doc.as_of, paragraphs: doc.paragraphs };

const PrivacyTextEditor: FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { t } = useTranslation();
  const textId = useId();
  const maySave = canSaveSetting(platformAccess, 'legal.privacy');
  const { loading, problem, detail, loaded, form, setForm, saving, load, save } = useSettingEditor(PRIVACY_EDITOR);

  const typed = form ? privacyFromForm(form) : null;
  const refusal = typed && 'error' in typed ? privacyProblemMessage(typed.error) : null;
  const content = typed && 'value' in typed ? toContent(typed.value) : null;

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
          <Note textKey="admin.settings.privacy.hint" />
          {!maySave && <Note textKey="admin.settings.readOnly" />}

          <Card className="font-ui">
            <CardHeader>
              <CardTitle>{t('admin.settings.privacy.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                labelKey="admin.settings.privacy.asOf"
                value={form.asOf}
                disabled={!maySave}
                width="12rem"
                onChange={asOf => setForm({ ...form, asOf })}
              />
              <div className="space-y-1.5">
                <label htmlFor={textId} className="block text-xs font-semibold text-fg-muted">
                  {t('admin.settings.privacy.text')}
                </label>
                <textarea
                  id={textId}
                  value={form.text}
                  disabled={!maySave}
                  spellCheck
                  lang="de"
                  rows={18}
                  onChange={event => setForm({ ...form, text: event.target.value })}
                  className={cn(controlFrameClass, 'h-auto min-h-[18rem] py-2 leading-relaxed [@media(pointer:coarse)]:h-auto')}
                />
                {typed && 'value' in typed ? (
                  <p className="text-xs tabular-nums text-fg-muted">
                    {t('admin.settings.privacy.size', {
                      paragraphs: typed.value.paragraphs?.length ?? 0,
                      // German grouping in both languages, like every figure.
                      bytes: privacyStoredBytes(typed.value).toLocaleString('de-DE'),
                      max: PRIVACY_MAX_BYTES.toLocaleString('de-DE'),
                    })}
                  </p>
                ) : null}
              </div>
              {refusal ? <Alert tone="caution">{t(refusal.key, refusal.vars)}</Alert> : null}
            </CardContent>
          </Card>

          <Card className="font-ui">
            <CardHeader>
              <CardTitle>{t('admin.settings.privacy.preview')}</CardTitle>
            </CardHeader>
            <CardContent>
              {content && content.paragraphs.length > 0
                ? <PrivacyDocumentView privacy={content} />
                : <p className="text-sm text-fg-muted">{refusal ? t(refusal.key, refusal.vars) : t('admin.settings.privacy.previewEmpty')}</p>}
            </CardContent>
          </Card>

          {maySave && <SaveRow saving={saving} disabled={!!refusal} onSave={() => void save()} />}
        </>
      )}
    </EditorShell>
  );
};

export default PrivacyTextEditor;
