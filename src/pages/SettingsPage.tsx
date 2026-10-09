import React, { useState, useEffect } from 'react';
import {
  Save,
  Building2,
  Mail,
  MapPin,
  User,
  FileText,
  CreditCard,
  Eye,
  Upload,
  X,
  AlertCircle,
  Users,
  Lock,
  Link2,
} from 'lucide-react';
import { useCompanySettings, resolveLogoUrl } from '../contexts/CompanySettingsContext';
import { useToast } from '../contexts/ToastContext';
import { CompanySettingsFormData } from '../types/settings';
import { supabase } from '../lib/supabase';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { PartnerConnectCard } from '../components/partner/PartnerConnectCard';
import { useTranslation } from '../contexts/LanguageContext';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, NativeSelect, PageHeader, buttonVariants, cn } from '../components/ui';
import { controlFrameClass } from '../components/ui/Input';
import AbrechnungScheduleCard from '../components/AbrechnungScheduleCard';

const SettingsPage: React.FC = () => {
  const { t } = useTranslation();
  const { settings, loading, updateSettings, refreshSettings } = useCompanySettings();
  const { success, error: showError } = useToast();
  const { effectiveCompanyId: companyId, companyScope } = useSuperAdmin();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [driversPerCar, setDriversPerCar] = useState(4);
  const [formData, setFormData] = useState<CompanySettingsFormData>({
    company_name: '',
    legal_company_name: '',
    slogan: '',
    email: '',
    phone: '',
    mobile: '',
    website: '',
    support_email: '',
    street: '',
    house_number: '',
    postal_code: '',
    city: '',
    state: '',
    country: 'Deutschland',
    manager_name: '',
    owner_name: '',
    authorized_representative: '',
    vat_id: '',
    tax_number: '',
    commercial_register: '',
    court_of_registration: '',
    bank_name: '',
    iban: '',
    bic: '',
    account_holder: '',
    primary_color: '#2563eb',
    secondary_color: '#64748b',
    default_signature_city: '',
    default_footer_text: '',
    default_email_signature: '',
    default_print_header: '',
    default_print_footer: '',
  });

  useEffect(() => {
    if (settings) {
      setLogoPreview(settings.logo_url || null);
      setDriversPerCar(settings.drivers_per_car_limit ?? 4);
      setFormData({
        company_name: settings.company_name || '',
        legal_company_name: settings.legal_company_name || '',
        slogan: settings.slogan || '',
        email: settings.email || '',
        phone: settings.phone || '',
        mobile: settings.mobile || '',
        website: settings.website || '',
        support_email: settings.support_email || '',
        street: settings.street || '',
        house_number: settings.house_number || '',
        postal_code: settings.postal_code || '',
        city: settings.city || '',
        state: settings.state || '',
        country: settings.country || 'Deutschland',
        manager_name: settings.manager_name || '',
        owner_name: settings.owner_name || '',
        authorized_representative: settings.authorized_representative || '',
        vat_id: settings.vat_id || '',
        tax_number: settings.tax_number || '',
        commercial_register: settings.commercial_register || '',
        court_of_registration: settings.court_of_registration || '',
        bank_name: settings.bank_name || '',
        iban: settings.iban || '',
        bic: settings.bic || '',
        account_holder: settings.account_holder || '',
        primary_color: settings.primary_color || '#2563eb',
        secondary_color: settings.secondary_color || '#64748b',
        default_signature_city: settings.default_signature_city || '',
        default_footer_text: settings.default_footer_text || '',
        default_email_signature: settings.default_email_signature || '',
        default_print_header: settings.default_print_header || '',
        default_print_footer: settings.default_print_footer || '',
      });
    }
  }, [settings]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      await updateSettings({ ...formData, drivers_per_car_limit: driversPerCar });
      success(t('settings.saved'), t('settings.savedBody'));
    } catch (err: any) {
      showError(t('settings.saveFailed'), err.message || t('settings.saveFailedBody'));
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type.
    //
    // `image/svg+xml` was here and is gone on purpose. An SVG is a document, not
    // a picture: served inline with that content type it runs whatever script it
    // carries, and `company-logos` is a public bucket on the API origin. Uploading
    // is gated on is_company_admin(), so this list was the only thing between a
    // company administrator and a script executing on api.elprofessor.eu.
    //
    // This is the browser's half. The bucket refuses it too since
    // 20260928100000 — that is the wall, this is the message.
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      showError(t('settings.badFileType'), t('settings.badFileTypeBody'));
      return;
    }

    // Validate file size. The bucket's own limit is 2 MiB since 20260928100000,
    // so a larger file is refused by storage with a message nobody wrote; this
    // check is what explains it. The largest logo on production is 233 KiB.
    if (file.size > 2 * 1024 * 1024) {
      showError(t('settings.fileTooLarge'), t('settings.fileTooLargeBody'));
      return;
    }

    if (!companyId) {
      showError(t('common.error'), t('settings.noCompanyId'));
      return;
    }

    setUploading(true);

    try {
      const fileExt = (file.name.split('.').pop() || 'png').toLowerCase();
      // Deterministic company-scoped path — one file per company, always overwritten
      const filePath = `${companyId}/logo.${fileExt}`;

      // Step 1: Upload file to storage
      const { error: uploadError } = await supabase.storage
        .from('company-logos')
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: true,
          contentType: file.type,
        });

      /*
        Since 20260920100000 a support session uploads the opened company's
        logo (it passes the administrator gate through is_company_admin()), and
        a read-only (`view`) context is refused by the bucket policy — before
        the `company_settings` upsert below is ever reached. That refusal is a
        rule, so it gets the sentence that names it rather than the raw error.
      */
      if (uploadError) {
        throw new Error(companyScope.isPlatformSession && companyScope.readOnly
          ? t('support.storage.readOnly')
          : t('settings.uploadFailedWith', { message: uploadError.message }));
      }

      // Step 2: Get the public URL
      const { data: urlData } = supabase.storage
        .from('company-logos')
        .getPublicUrl(filePath);

      const publicUrl = urlData?.publicUrl;
      if (!publicUrl) throw new Error(t('settings.logoUrlFailed'));

      // Step 3: Save public URL — upsert creates the settings row if it doesn't exist yet
      console.log('[Logo upload] user companyId:', companyId);
      const { data: savedRow, error: dbError } = await supabase
        .from('company_settings')
        .upsert(
          { company_id: companyId, logo_url: publicUrl },
          { onConflict: 'company_id', ignoreDuplicates: false }
        )
        .select('id, company_id, logo_url')
        .maybeSingle();

      if (dbError) {
        const reason = dbError.code === '42501'
          ? t('settings.noWritePermission')
          : dbError.message;
        throw new Error(t('settings.dbErrorWith', { message: reason }));
      }
      if (!savedRow) {
        throw new Error(t('settings.logoUrlSaveFailed'));
      }

      // Step 4: Update context state with the confirmed URL
      await refreshSettings();

      // Step 5: Update local preview
      setLogoPreview(publicUrl);

      success(t('settings.logoUploaded'), t('settings.logoUploadedBody'));
    } catch (err: any) {
      console.error('Logo upload error:', err);
      showError(t('settings.logoUploadFailed'), err.message || t('settings.logoUploadFailedBody'));
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveLogo = async () => {
    if (!settings?.logo_url) return;

    try {
      setUploading(true);

      // Derive the storage path from whatever is saved (path or legacy full URL)
      let storagePath: string | null = null;
      const saved = settings.logo_url;
      if (saved.startsWith('http://') || saved.startsWith('https://')) {
        try {
          const url = new URL(saved);
          const marker = '/company-logos/';
          const idx = url.pathname.indexOf(marker);
          if (idx !== -1) storagePath = decodeURIComponent(url.pathname.slice(idx + marker.length));
        } catch {
          // ignore parse errors
        }
      } else {
        storagePath = saved;
      }

      if (storagePath) {
        await supabase.storage.from('company-logos').remove([storagePath]);
      }

      const { error: dbError } = await supabase
        .from('company_settings')
        .upsert(
          { company_id: companyId, logo_url: null },
          { onConflict: 'company_id', ignoreDuplicates: false }
        );

      if (dbError) throw new Error(t('settings.dbErrorWith', { message: dbError.message }));

      await refreshSettings();
      setLogoPreview(null);

      success(t('settings.logoRemoved'), t('settings.logoRemovedBody'));
    } catch (err: any) {
      console.error('Error removing logo:', err);
      showError(t('settings.removeFailed'), err.message || t('settings.removeFailedBody'));
    } finally {
      setUploading(false);
    }
  };

  const handleReset = () => {
    if (settings) {
      setLogoPreview(settings.logo_url || null);
      setFormData({
        company_name: settings.company_name || '',
        legal_company_name: settings.legal_company_name || '',
        slogan: settings.slogan || '',
        email: settings.email || '',
        phone: settings.phone || '',
        mobile: settings.mobile || '',
        website: settings.website || '',
        support_email: settings.support_email || '',
        street: settings.street || '',
        house_number: settings.house_number || '',
        postal_code: settings.postal_code || '',
        city: settings.city || '',
        state: settings.state || '',
        country: settings.country || 'Deutschland',
        manager_name: settings.manager_name || '',
        owner_name: settings.owner_name || '',
        authorized_representative: settings.authorized_representative || '',
        vat_id: settings.vat_id || '',
        tax_number: settings.tax_number || '',
        commercial_register: settings.commercial_register || '',
        court_of_registration: settings.court_of_registration || '',
        bank_name: settings.bank_name || '',
        iban: settings.iban || '',
        bic: settings.bic || '',
        account_holder: settings.account_holder || '',
        primary_color: settings.primary_color || '#2563eb',
        secondary_color: settings.secondary_color || '#64748b',
        default_signature_city: settings.default_signature_city || '',
        default_footer_text: settings.default_footer_text || '',
        default_email_signature: settings.default_email_signature || '',
        default_print_header: settings.default_print_header || '',
        default_print_footer: settings.default_print_footer || '',
      });
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged: the form's state, the save, the logo's
  // upload to the company's own folder and its removal, and Zurücksetzen.
  //
  // One thing is new, and it only draws: in a platform read context
  // (`companyScope.readOnly`, which this screen already read for the upload's
  // message) the whole form is a disabled fieldset under a note, where it used
  // to be an editable form whose save the database refuses since 3.13a
  // (owner's answer, 22.09.2026). The handlers are the same either way.

  const textArea = cn(controlFrameClass, 'h-auto py-2 leading-relaxed [@media(pointer:coarse)]:h-auto');

  const section = (icon: React.ElementType, title: string, children: React.ReactNode) => {
    const Icon = icon;
    return (
      <Card>
        <CardHeader className="justify-start gap-2">
          <Icon aria-hidden className="size-5 text-brand-text" />
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    );
  };

  if (loading) {
    return (
      <div role="status" className="flex items-center justify-center py-8 font-ui">
        <div aria-hidden className="size-8 rounded-full border-2 border-line border-b-brand motion-safe:animate-spin" />
        <span className="sr-only">{t('nav.settings')}</span>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 font-ui">
      <PageHeader title={t('nav.settings')} description={t('settings.subtitle')} className="pb-0" />

      {companyScope.readOnly && (
        <Alert tone="brand" role="note" icon={Lock} title={t('settings.readOnlyTitle')}>
          {t('settings.readOnlyBody')}
        </Alert>
      )}

      <form onSubmit={handleSubmit}>
        <fieldset disabled={companyScope.readOnly} className="m-0 grid min-w-0 grid-cols-1 gap-6 border-0 p-0">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Main Form Column */}
            <div className="grid grid-cols-1 content-start gap-6 lg:col-span-2">
              {/* Company Logo */}
              {section(Upload, t('settings.logo'), (
                <div className="grid gap-4">
                  {logoPreview && (
                    <div className="flex items-center justify-center rounded-control bg-sunken p-4">
                      <img
                        src={logoPreview}
                        alt={t('settings.logo')}
                        className="h-24 object-contain"
                        onError={(e) => {
                          console.warn(t('settings.logoLoadFailed'), logoPreview);
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                          const placeholder = e.currentTarget.nextElementSibling as HTMLElement;
                          if (placeholder) placeholder.style.display = 'flex';
                        }}
                      />
                      {/* Shown by the handler above when the logo cannot be loaded. */}
                      <div className="hidden h-24 w-48 flex-col items-center justify-center gap-1 rounded-control border border-dashed border-line-strong bg-raised text-xs text-fg-subtle">
                        <AlertCircle aria-hidden className="size-5" />
                        <span>{t('settings.logoUnavailable')}</span>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <label className="flex-1">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/jpg,image/svg+xml,image/webp"
                        onChange={handleLogoUpload}
                        disabled={uploading}
                        className="peer sr-only"
                        id="logo-upload"
                      />
                      <span
                        className={cn(
                          buttonVariants({ variant: 'primary' }),
                          'w-full cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus',
                          'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
                        )}
                      >
                        <Upload aria-hidden />
                        <span>{uploading ? t('settings.uploading') : t('settings.uploadLogo')}</span>
                      </span>
                    </label>
                    {logoPreview && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleRemoveLogo}
                        disabled={uploading}
                        className="text-critical"
                      >
                        <X aria-hidden />
                        <span>{t('common.remove')}</span>
                      </Button>
                    )}
                  </div>
                  <p className="text-sm text-fg-subtle">{t('settings.logoFormats')}</p>
                </div>
              ))}

              {/* Company Identity */}
              {section(Building2, t('settings.identity'), (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label={t('settings.field.companyName')} required className="md:col-span-2">
                    <Input
                      type="text"
                      value={formData.company_name}
                      onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                      required
                    />
                  </Field>
                  <Field label={t('settings.field.legalName')} className="md:col-span-2">
                    <Input
                      type="text"
                      value={formData.legal_company_name}
                      onChange={(e) => setFormData({ ...formData, legal_company_name: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.slogan')} className="md:col-span-2">
                    <Input
                      type="text"
                      value={formData.slogan}
                      onChange={(e) => setFormData({ ...formData, slogan: e.target.value })}
                      placeholder={t('settings.egTagline')}
                    />
                  </Field>
                </div>
              ))}

              {/* Contact Information */}
              {section(Mail, t('settings.contact'), (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label={t('settings.field.email')}>
                    <Input
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.supportEmail')}>
                    <Input
                      type="email"
                      value={formData.support_email}
                      onChange={(e) => setFormData({ ...formData, support_email: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.phone')}>
                    <Input
                      type="tel"
                      value={formData.phone}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.mobile')}>
                    <Input
                      type="tel"
                      value={formData.mobile}
                      onChange={(e) => setFormData({ ...formData, mobile: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.website')} className="md:col-span-2">
                    <Input
                      type="url"
                      value={formData.website}
                      onChange={(e) => setFormData({ ...formData, website: e.target.value })}
                      placeholder="https://..."
                    />
                  </Field>
                </div>
              ))}

              {/* Address */}
              {section(MapPin, t('common.address'), (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label={t('settings.field.street')}>
                    <Input
                      type="text"
                      value={formData.street}
                      onChange={(e) => setFormData({ ...formData, street: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.houseNumber')}>
                    <Input
                      type="text"
                      value={formData.house_number}
                      onChange={(e) => setFormData({ ...formData, house_number: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.postalCode')}>
                    <Input
                      type="text"
                      value={formData.postal_code}
                      onChange={(e) => setFormData({ ...formData, postal_code: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.city')}>
                    <Input
                      type="text"
                      value={formData.city}
                      onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.state')}>
                    <Input
                      type="text"
                      value={formData.state}
                      onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.country')}>
                    <Input
                      type="text"
                      value={formData.country}
                      onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                    />
                  </Field>
                </div>
              ))}

              {/* Management */}
              {section(User, t('settings.management'), (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label={t('settings.field.managerName')}>
                    <Input
                      type="text"
                      value={formData.manager_name}
                      onChange={(e) => setFormData({ ...formData, manager_name: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.ownerName')}>
                    <Input
                      type="text"
                      value={formData.owner_name}
                      onChange={(e) => setFormData({ ...formData, owner_name: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.representative')} className="md:col-span-2">
                    <Input
                      type="text"
                      value={formData.authorized_representative}
                      onChange={(e) => setFormData({ ...formData, authorized_representative: e.target.value })}
                    />
                  </Field>
                </div>
              ))}

              {/* Operations */}
              {section(Users, t('settings.operations'), (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label={t('settings.field.driversPerCar')} hint={t('settings.field.driversPerCarHint', { n: driversPerCar })} id="settings-drivers-per-car">
                    <NativeSelect
                      id="settings-drivers-per-car"
                      aria-describedby="settings-drivers-per-car-hint"
                      value={driversPerCar}
                      onChange={(e) => setDriversPerCar(Number(e.target.value))}
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
              ))}

              {/* Legal Data */}
              {section(FileText, t('settings.legal'), (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label={t('settings.field.vatId')}>
                    <Input
                      type="text"
                      value={formData.vat_id}
                      onChange={(e) => setFormData({ ...formData, vat_id: e.target.value })}
                      placeholder="DE123456789"
                    />
                  </Field>
                  <Field label={t('settings.field.taxNumber')}>
                    <Input
                      type="text"
                      value={formData.tax_number}
                      onChange={(e) => setFormData({ ...formData, tax_number: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.commercialRegister')}>
                    <Input
                      type="text"
                      value={formData.commercial_register}
                      onChange={(e) => setFormData({ ...formData, commercial_register: e.target.value })}
                      placeholder="HRB 12345"
                    />
                  </Field>
                  <Field label={t('settings.field.registerCourt')}>
                    <Input
                      type="text"
                      value={formData.court_of_registration}
                      onChange={(e) => setFormData({ ...formData, court_of_registration: e.target.value })}
                      placeholder={t('settings.egCourt')}
                    />
                  </Field>
                </div>
              ))}

              {/* Banking Data */}
              {section(CreditCard, t('settings.bank'), (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label={t('settings.field.accountHolder')} className="md:col-span-2">
                    <Input
                      type="text"
                      value={formData.account_holder}
                      onChange={(e) => setFormData({ ...formData, account_holder: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.bankName')} className="md:col-span-2">
                    <Input
                      type="text"
                      value={formData.bank_name}
                      onChange={(e) => setFormData({ ...formData, bank_name: e.target.value })}
                    />
                  </Field>
                  <Field label={t('settings.field.iban')}>
                    <Input
                      type="text"
                      value={formData.iban}
                      onChange={(e) => setFormData({ ...formData, iban: e.target.value.toUpperCase() })}
                      placeholder="DE89 3704 0044 0532 0130 00"
                    />
                  </Field>
                  <Field label={t('settings.field.bic')}>
                    <Input
                      type="text"
                      value={formData.bic}
                      onChange={(e) => setFormData({ ...formData, bic: e.target.value.toUpperCase() })}
                      placeholder="COBADEFFXXX"
                    />
                  </Field>
                </div>
              ))}

              {/* Reidey (M1). Its own file, so this page keeps its 2 inline
                  styles and 6 colours in the ratchet's baseline. */}
              {section(Link2, t('partner.connect.title'), (
                <PartnerConnectCard companyId={companyId} />
              ))}

              {/* Document Defaults */}
              {section(FileText, t('settings.documents'), (
                <div className="grid grid-cols-1 gap-4">
                  <Field label={t('settings.field.signatureCity')}>
                    <Input
                      type="text"
                      value={formData.default_signature_city}
                      onChange={(e) => setFormData({ ...formData, default_signature_city: e.target.value })}
                      placeholder={t('settings.egCity')}
                    />
                  </Field>
                  <Field label={t('settings.field.footerText')} id="settings-footer-text">
                    <textarea
                      id="settings-footer-text"
                      value={formData.default_footer_text}
                      onChange={(e) => setFormData({ ...formData, default_footer_text: e.target.value })}
                      className={textArea}
                      rows={3}
                    />
                  </Field>
                  <Field label={t('settings.field.emailSignature')} id="settings-email-signature">
                    <textarea
                      id="settings-email-signature"
                      value={formData.default_email_signature}
                      onChange={(e) => setFormData({ ...formData, default_email_signature: e.target.value })}
                      className={textArea}
                      rows={4}
                    />
                  </Field>
                </div>
              ))}
            </div>

            {/* Preview Column */}
            <div className="lg:col-span-1">
              <Card className="lg:sticky lg:top-6">
                <CardHeader className="justify-start gap-2">
                  <Eye aria-hidden className="size-5 text-brand-text" />
                  <CardTitle>{t('common.preview')}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4">
                  {/* Logo Preview */}
                  {logoPreview && (
                    <div className="text-center">
                      <img
                        src={logoPreview}
                        alt={t('settings.logo')}
                        className="mx-auto h-16 object-contain"
                      />
                    </div>
                  )}

                  {/* Company Name */}
                  <div className="text-center">
                    <p className="text-lg font-semibold text-fg">{formData.company_name}</p>
                    {formData.slogan && (
                      <p className="mt-1 text-sm text-fg-subtle">{formData.slogan}</p>
                    )}
                  </div>

                  <div className="grid gap-3 border-t border-line pt-4 text-sm">
                    {/* Address */}
                    {(formData.street || formData.city) && (
                      <div>
                        <p className="font-medium text-fg-muted">{t('settings.addressLabel')}</p>
                        <p className="text-fg-subtle">
                          {formData.street} {formData.house_number}
                          {formData.street && <br />}
                          {formData.postal_code} {formData.city}
                        </p>
                      </div>
                    )}

                    {/* Contact */}
                    {(formData.email || formData.phone) && (
                      <div className="min-w-0">
                        <p className="font-medium text-fg-muted">{t('settings.contactLabel')}</p>
                        {formData.email && <p className="break-all text-fg-subtle">{formData.email}</p>}
                        {formData.phone && <p className="text-fg-subtle">{formData.phone}</p>}
                      </div>
                    )}

                    {/* Banking */}
                    {formData.iban && (
                      <div>
                        <p className="font-medium text-fg-muted">{t('settings.bankLabel')}</p>
                        {formData.bank_name && <p className="text-fg-subtle">{formData.bank_name}</p>}
                        <p className="font-mono text-xs text-fg-subtle">{formData.iban}</p>
                      </div>
                    )}

                    {/* Legal */}
                    {(formData.vat_id || formData.tax_number) && (
                      <div>
                        <p className="font-medium text-fg-muted">{t('settings.legalLabel')}</p>
                        {formData.vat_id && (
                          <p className="text-xs text-fg-subtle">{t('settings.preview.vatId', { value: formData.vat_id })}</p>
                        )}
                        {formData.tax_number && (
                          <p className="text-xs text-fg-subtle">{t('settings.preview.taxNumber', { value: formData.tax_number })}</p>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 rounded-surface border border-line bg-raised p-4 shadow-raised">
            <Button
              type="button"
              variant="secondary"
              onClick={handleReset}
              disabled={saving}
            >
              {t('settings.reset')}
            </Button>
            <Button
              type="submit"
              disabled={saving}
            >
              <Save aria-hidden />
              <span>{saving ? t('settings.savingEllipsis') : t('common.save')}</span>
            </Button>
          </div>
        </fieldset>
      </form>

      {/* Its own row and its own save, so it sits beside the form, not in it. */}
      <AbrechnungScheduleCard readOnly={companyScope.readOnly} />
    </div>
  );
};

export default SettingsPage;
