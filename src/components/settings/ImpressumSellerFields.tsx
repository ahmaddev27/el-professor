import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import { impressumFromSeller, impressumIsPublished } from '../../lib/legalPages';
import { SELLER_IMPRESSUM_FIELDS, type SellerForm, type SellerImpressumField } from '../../lib/platformSettings';
import { ImpressumDocument } from '../legal/LegalDocument';
import { Card, CardContent, CardHeader, CardTitle } from '../ui';
import { Field, Note } from './settingsEditorKit';

/**
 * The seller's nine optional Impressum fields (migration 20260921120000), in the
 * seller editor, with the page they make.
 *
 * They are saved with the rest of the seller, by the seller's one save button
 * and against its one version. The preview is `/impressum` itself — the same
 * component, fed the typed form through the projection `get_legal_pages()`
 * applies — so the owner sees exactly which of the invoice's fields go public
 * (the address and the VAT id) and which never do.
 */

const LABELS: Record<SellerImpressumField, TranslationKey> = {
  legal_name:                  'admin.settings.impressum.legal_name',
  legal_form:                  'admin.settings.impressum.legal_form',
  represented_by:              'admin.settings.impressum.represented_by',
  contact_email:               'admin.settings.impressum.contact_email',
  contact_phone:               'admin.settings.impressum.contact_phone',
  register_court:              'admin.settings.impressum.register_court',
  register_number:             'admin.settings.impressum.register_number',
  content_responsible_name:    'admin.settings.impressum.content_responsible_name',
  content_responsible_address: 'admin.settings.impressum.content_responsible_address',
};

const INPUT_TYPES: Partial<Record<SellerImpressumField, string>> = {
  contact_email: 'email',
  contact_phone: 'tel',
};

export function ImpressumSellerFields({ form, disabled, onChange }: {
  form: SellerForm;
  disabled: boolean;
  onChange: (field: SellerImpressumField, value: string) => void;
}) {
  const { t } = useTranslation();
  const impressum = impressumFromSeller(form);

  return (
    <Card className="font-ui">
      <CardHeader>
        <CardTitle>{t('admin.settings.impressum.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Note textKey="admin.settings.impressum.hint" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {SELLER_IMPRESSUM_FIELDS.map(field => (
            <Field
              key={field}
              labelKey={LABELS[field]}
              value={form[field]}
              disabled={disabled}
              type={INPUT_TYPES[field]}
              onChange={value => onChange(field, value)}
            />
          ))}
        </div>

        <section className="space-y-3 rounded-surface border border-line p-4" aria-label={t('admin.settings.impressum.preview')}>
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{t('admin.settings.impressum.preview')}</p>
          {impressumIsPublished(impressum)
            ? <ImpressumDocument impressum={impressum} />
            : <p className="text-sm text-fg-muted">{t('admin.settings.impressum.previewEmpty')}</p>}
        </section>
      </CardContent>
    </Card>
  );
}
