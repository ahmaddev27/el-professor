import { useState, type FC } from 'react';
import { Copy } from 'lucide-react';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { useToast } from '../../contexts/ToastContext';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import { IMPRESSUM_FIELDS, impressumFromDocument, impressumIsPublished, type ImpressumField } from '../../lib/legalPages';
import {
  canReadSetting,
  canSaveSetting,
  impressumFormWithSeller,
  impressumFromForm,
  impressumToForm,
  parseImpressumDocument,
  parseSeller,
  settingRefusalKey,
  type ImpressumDocument,
  type ImpressumForm,
} from '../../lib/platformSettings';
import { getSetting } from '../../lib/platformSettingsClient';
import { ImpressumDocument as ImpressumView } from '../legal/LegalDocument';
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui';
import { EditorShell, Field, Note, SaveRow, useSettingEditor, type SettingEditorConfig } from './settingsEditorKit';

/**
 * The Impressum `/impressum` publishes (`legal.impressum`, migration
 * 20260921120000).
 *
 * A key of its own, never the invoice's `seller`: a rollback to the release
 * before this one must never be left unable to read the invoice's sender. The
 * one bridge between the two is the copy button, which puts the invoice's name,
 * address and VAT id into the fields left empty, for the owner to read and
 * save — nothing reaches the Impressum otherwise.
 *
 * Loaded, edited and saved like every other key: pinned to the version it read,
 * refused as a `version_conflict` if somebody saved first, recorded before and
 * after. The preview is the page's own component, fed the form through the
 * projection `get_legal_pages()` applies.
 */

const IMPRESSUM_EDITOR: SettingEditorConfig<ImpressumDocument, ImpressumForm> = {
  key: 'legal.impressum',
  read: record => parseImpressumDocument(record.value),
  toForm: impressumToForm,
  fromForm: impressumFromForm,
};

const LABELS: Record<ImpressumField, TranslationKey> = {
  legal_name:                  'admin.settings.impressum.legal_name',
  legal_form:                  'admin.settings.impressum.legal_form',
  street:                      'admin.settings.impressum.street',
  house_number:                'admin.settings.impressum.house_number',
  postal_code:                 'admin.settings.impressum.postal_code',
  city:                        'admin.settings.impressum.city',
  represented_by:              'admin.settings.impressum.represented_by',
  contact_email:               'admin.settings.impressum.contact_email',
  contact_phone:               'admin.settings.impressum.contact_phone',
  register_court:              'admin.settings.impressum.register_court',
  register_number:             'admin.settings.impressum.register_number',
  vat_id:                      'admin.settings.impressum.vat_id',
  content_responsible_name:    'admin.settings.impressum.content_responsible_name',
  content_responsible_address: 'admin.settings.impressum.content_responsible_address',
};

const INPUT_TYPES: Partial<Record<ImpressumField, string>> = {
  contact_email: 'email',
  contact_phone: 'tel',
};

const ImpressumEditor: FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { showToast } = useToast();
  const { t } = useTranslation();
  const maySave = canSaveSetting(platformAccess, 'legal.impressum');
  // The copy button reads the seller through the settings RPC, which needs
  // settings.read — the owner holds it with settings.manage, read_only without.
  const mayCopy = maySave && canReadSetting(platformAccess, 'seller');
  const { loading, problem, detail, loaded, form, setForm, saving, load, save } = useSettingEditor(IMPRESSUM_EDITOR);
  const [copying, setCopying] = useState(false);

  const copyFromSeller = async () => {
    if (!form) return;
    setCopying(true);
    try {
      const answer = await getSetting('seller');
      if (!answer.ok) {
        showToast('error', t(settingRefusalKey(answer.reason)));
        return;
      }
      const seller = parseSeller(answer.value);
      if (!seller) {
        showToast('error', t('admin.settings.refusal.invalidValue'));
        return;
      }
      setForm(impressumFormWithSeller(form, seller));
      showToast('success', t('admin.settings.impressum.copied'));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('admin.settings.refusal.failed'));
    } finally {
      setCopying(false);
    }
  };

  const impressum = form ? impressumFromDocument(form) : null;

  return (
    <EditorShell
      loading={loading}
      problem={problem}
      detail={detail}
      onReload={() => void load()}
      version={loaded?.version ?? null}
      updatedAt={loaded?.updatedAt ?? null}
    >
      {form && impressum && (
        <>
          <Note textKey="admin.settings.impressum.hint" />
          {!maySave && <Note textKey="admin.settings.readOnly" />}

          <Card className="font-ui">
            <CardHeader>
              <CardTitle>{t('admin.settings.impressum.title')}</CardTitle>
              {mayCopy ? (
                <Button variant="secondary" size="sm" loading={copying} onClick={() => void copyFromSeller()}>
                  <Copy aria-hidden />{t('admin.settings.impressum.copyFromSeller')}
                </Button>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              {mayCopy ? <p className="text-xs text-fg-muted">{t('admin.settings.impressum.copyHint')}</p> : null}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {IMPRESSUM_FIELDS.map(field => (
                  <Field
                    key={field}
                    labelKey={LABELS[field]}
                    value={form[field]}
                    disabled={!maySave}
                    type={INPUT_TYPES[field]}
                    onChange={value => setForm({ ...form, [field]: value })}
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="font-ui">
            <CardHeader>
              <CardTitle>{t('admin.settings.impressum.preview')}</CardTitle>
            </CardHeader>
            <CardContent>
              {impressumIsPublished(impressum)
                ? <ImpressumView impressum={impressum} />
                : <p className="text-sm text-fg-muted">{t('admin.settings.impressum.previewEmpty')}</p>}
            </CardContent>
          </Card>

          {maySave && <SaveRow saving={saving} onSave={() => void save()} />}
        </>
      )}
    </EditorShell>
  );
};

export default ImpressumEditor;
