import React, { useState, useEffect } from 'react';
import {
  Settings as SettingsIcon,
  Save,
  Building2,
  Mail,
  Phone,
  MapPin,
  User,
  FileText,
  CreditCard,
  Palette,
  Eye,
  Upload,
  X,
  AlertCircle,
  Users,
} from 'lucide-react';
import { useCompanySettings, resolveLogoUrl } from '../contexts/CompanySettingsContext';
import { useToast } from '../contexts/ToastContext';
import { CompanySettingsFormData } from '../types/settings';
import { supabase } from '../lib/supabase';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  padding: '0.5rem 0.75rem',
  outline: 'none',
};

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

    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      showError(t('settings.badFileType'), t('settings.badFileTypeBody'));
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      showError(t('settings.fileTooLarge'), t('settings.fileTooLargeBody'));
      return;
    }

    if (!companyId) {
      showError('Fehler', t('settings.noCompanyId'));
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
        Inside a support session this is where the screen stops, and the raw
        message does not say why. The `company-logos` policies
        (`20260507193515`) read the membership from `user_profiles` and demand
        `role IN ('admin','super_admin')` on that same profile — neither of
        which a company-less platform account has — so the upload is refused
        before the `company_settings` upsert below is ever reached. Fixing the
        policy is SQL, and the storage half of plan 3.C; saying so is not.
      */
      if (uploadError) {
        throw new Error(companyScope.isPlatformSession
          ? t('support.storage.membershipOnly')
          : `Speicher-Upload fehlgeschlagen: ${uploadError.message}`);
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
        throw new Error(`Datenbank-Fehler: ${reason}`);
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

      if (dbError) throw new Error(`Datenbank-Fehler: ${dbError.message}`);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--accent)' }}></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl p-6 text-white" style={{ background: 'linear-gradient(to right, var(--accent), var(--accent-hover))', boxShadow: 'var(--shadow-md)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-white bg-opacity-20 rounded-lg p-2">
              <SettingsIcon className="text-white" size={32} />
            </div>
            <div>
              <h1 className="text-3xl font-bold">{t('nav.settings')}</h1>
              <p className="mt-1" style={{ color: 'rgba(255,255,255,0.8)' }}>{t('settings.subtitle')}</p>
            </div>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Form Column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Company Logo */}
            <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-center space-x-2 mb-4">
                <Upload style={{ color: 'var(--accent-text)' }} size={24} />
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.logo')}</h2>
              </div>
              <div className="space-y-4">
                {logoPreview && (
                  <div className="flex items-center justify-center p-4 rounded-lg" style={{ background: 'var(--bg-subtle)' }}>
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
                    <div
                      style={{
                        display: 'none',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '6rem',
                        width: '12rem',
                        background: 'var(--bg-muted)',
                        border: '1px dashed var(--border)',
                        borderRadius: '0.5rem',
                        color: 'var(--text-tertiary)',
                        fontSize: '0.75rem',
                        flexDirection: 'column',
                        gap: '0.25rem',
                      }}
                    >
                      <AlertCircle size={20} />
                      <span>{t('settings.logoUnavailable')}</span>
                    </div>
                  </div>
                )}
                <div className="flex flex-col sm:flex-row gap-3">
                  <label className="flex-1">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/jpg,image/svg+xml,image/webp"
                      onChange={handleLogoUpload}
                      disabled={uploading}
                      className="hidden"
                      id="logo-upload"
                    />
                    <div
                      className="flex items-center justify-center space-x-2 px-4 py-2 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                      style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
                    >
                      <Upload size={20} />
                      <span>{uploading ? t('settings.uploading') : t('settings.uploadLogo')}</span>
                    </div>
                  </label>
                  {logoPreview && (
                    <button
                      type="button"
                      onClick={handleRemoveLogo}
                      disabled={uploading}
                      className="flex items-center justify-center space-x-2 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                      style={{ border: '1px solid var(--danger)', color: 'var(--danger)', background: 'transparent' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--danger-subtle)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <X size={20} />
                      <span>{t('common.remove')}</span>
                    </button>
                  )}
                </div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  Unterstützte Formate: PNG, JPG, SVG, WebP (max. 5MB)
                </p>
              </div>
            </div>

            {/* Company Identity */}
            <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-center space-x-2 mb-4">
                <Building2 style={{ color: 'var(--accent-text)' }} size={24} />
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.identity')}</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Firmenname *
                  </label>
                  <input
                    type="text"
                    value={formData.company_name}
                    onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    required
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Rechtliche Firmenbezeichnung
                  </label>
                  <input
                    type="text"
                    value={formData.legal_company_name}
                    onChange={(e) => setFormData({ ...formData, legal_company_name: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Slogan
                  </label>
                  <input
                    type="text"
                    value={formData.slogan}
                    onChange={(e) => setFormData({ ...formData, slogan: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    placeholder={t('settings.egTagline')}
                  />
                </div>
              </div>
            </div>

            {/* Contact Information */}
            <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-center space-x-2 mb-4">
                <Mail style={{ color: 'var(--accent-text)' }} size={24} />
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.contact')}</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    E-Mail
                  </label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Support E-Mail
                  </label>
                  <input
                    type="email"
                    value={formData.support_email}
                    onChange={(e) => setFormData({ ...formData, support_email: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Telefon
                  </label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Mobil
                  </label>
                  <input
                    type="tel"
                    value={formData.mobile}
                    onChange={(e) => setFormData({ ...formData, mobile: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Website
                  </label>
                  <input
                    type="url"
                    value={formData.website}
                    onChange={(e) => setFormData({ ...formData, website: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    placeholder="https://..."
                  />
                </div>
              </div>
            </div>

            {/* Address */}
            <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-center space-x-2 mb-4">
                <MapPin style={{ color: 'var(--accent-text)' }} size={24} />
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('common.address')}</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Straße
                  </label>
                  <input
                    type="text"
                    value={formData.street}
                    onChange={(e) => setFormData({ ...formData, street: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Hausnummer
                  </label>
                  <input
                    type="text"
                    value={formData.house_number}
                    onChange={(e) => setFormData({ ...formData, house_number: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    PLZ
                  </label>
                  <input
                    type="text"
                    value={formData.postal_code}
                    onChange={(e) => setFormData({ ...formData, postal_code: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Stadt
                  </label>
                  <input
                    type="text"
                    value={formData.city}
                    onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Bundesland
                  </label>
                  <input
                    type="text"
                    value={formData.state}
                    onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Land
                  </label>
                  <input
                    type="text"
                    value={formData.country}
                    onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
              </div>
            </div>

            {/* Management */}
            <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-center space-x-2 mb-4">
                <User style={{ color: 'var(--accent-text)' }} size={24} />
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.management')}</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Geschäftsführer
                  </label>
                  <input
                    type="text"
                    value={formData.manager_name}
                    onChange={(e) => setFormData({ ...formData, manager_name: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Inhaber
                  </label>
                  <input
                    type="text"
                    value={formData.owner_name}
                    onChange={(e) => setFormData({ ...formData, owner_name: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Vertretungsberechtigter
                  </label>
                  <input
                    type="text"
                    value={formData.authorized_representative}
                    onChange={(e) => setFormData({ ...formData, authorized_representative: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
              </div>
            </div>

            {/* Operations */}
            <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-center space-x-2 mb-4">
                <Users style={{ color: 'var(--accent-text)' }} size={24} />
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.operations')}</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Fahrer pro Fahrzeug
                  </label>
                  <select
                    value={driversPerCar}
                    onChange={(e) => setDriversPerCar(Number(e.target.value))}
                    style={inputStyle}
                    className="w-full"
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    Maximale Anzahl aktiver Fahrer = Fahrzeuge x {driversPerCar}
                  </p>
                </div>
              </div>
            </div>

            {/* Legal Data */}
            <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-center space-x-2 mb-4">
                <FileText style={{ color: 'var(--accent-text)' }} size={24} />
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.legal')}</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    USt-IdNr.
                  </label>
                  <input
                    type="text"
                    value={formData.vat_id}
                    onChange={(e) => setFormData({ ...formData, vat_id: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    placeholder="DE123456789"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Steuernummer
                  </label>
                  <input
                    type="text"
                    value={formData.tax_number}
                    onChange={(e) => setFormData({ ...formData, tax_number: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Handelsregisternummer
                  </label>
                  <input
                    type="text"
                    value={formData.commercial_register}
                    onChange={(e) => setFormData({ ...formData, commercial_register: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    placeholder="HRB 12345"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Registergericht
                  </label>
                  <input
                    type="text"
                    value={formData.court_of_registration}
                    onChange={(e) => setFormData({ ...formData, court_of_registration: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    placeholder={t('settings.egCourt')}
                  />
                </div>
              </div>
            </div>

            {/* Banking Data */}
            <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-center space-x-2 mb-4">
                <CreditCard style={{ color: 'var(--accent-text)' }} size={24} />
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.bank')}</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Kontoinhaber
                  </label>
                  <input
                    type="text"
                    value={formData.account_holder}
                    onChange={(e) => setFormData({ ...formData, account_holder: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Bankname
                  </label>
                  <input
                    type="text"
                    value={formData.bank_name}
                    onChange={(e) => setFormData({ ...formData, bank_name: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    IBAN
                  </label>
                  <input
                    type="text"
                    value={formData.iban}
                    onChange={(e) => setFormData({ ...formData, iban: e.target.value.toUpperCase() })}
                    className="w-full"
                    style={inputStyle}
                    placeholder="DE89 3704 0044 0532 0130 00"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    BIC
                  </label>
                  <input
                    type="text"
                    value={formData.bic}
                    onChange={(e) => setFormData({ ...formData, bic: e.target.value.toUpperCase() })}
                    className="w-full"
                    style={inputStyle}
                    placeholder="COBADEFFXXX"
                  />
                </div>
              </div>
            </div>

            {/* Document Defaults */}
            <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-center space-x-2 mb-4">
                <FileText style={{ color: 'var(--accent-text)' }} size={24} />
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.documents')}</h2>
              </div>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Standardort für Unterschriften
                  </label>
                  <input
                    type="text"
                    value={formData.default_signature_city}
                    onChange={(e) => setFormData({ ...formData, default_signature_city: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    placeholder={t('settings.egCity')}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Standard Fußzeilentext
                  </label>
                  <textarea
                    value={formData.default_footer_text}
                    onChange={(e) => setFormData({ ...formData, default_footer_text: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    rows={3}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Standard E-Mail-Signatur
                  </label>
                  <textarea
                    value={formData.default_email_signature}
                    onChange={(e) => setFormData({ ...formData, default_email_signature: e.target.value })}
                    className="w-full"
                    style={inputStyle}
                    rows={4}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Preview Column */}
          <div className="lg:col-span-1">
            <div className="rounded-xl p-6 sticky top-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
              <div className="flex items-center space-x-2 mb-4">
                <Eye style={{ color: 'var(--accent-text)' }} size={24} />
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('common.preview')}</h2>
              </div>
              <div className="space-y-4">
                {/* Logo Preview */}
                {logoPreview && (
                  <div className="text-center">
                    <img
                      src={logoPreview}
                      alt="Company Logo"
                      className="h-16 mx-auto object-contain"
                    />
                  </div>
                )}

                {/* Company Name */}
                <div className="text-center">
                  <h3 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{formData.company_name}</h3>
                  {formData.slogan && (
                    <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>{formData.slogan}</p>
                  )}
                </div>

                <div className="pt-4 space-y-3 text-sm" style={{ borderTop: '1px solid var(--border)' }}>
                  {/* Address */}
                  {(formData.street || formData.city) && (
                    <div>
                      <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.addressLabel')}</p>
                      <p style={{ color: 'var(--text-tertiary)' }}>
                        {formData.street} {formData.house_number}
                        {formData.street && <br />}
                        {formData.postal_code} {formData.city}
                      </p>
                    </div>
                  )}

                  {/* Contact */}
                  {(formData.email || formData.phone) && (
                    <div>
                      <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.contactLabel')}</p>
                      {formData.email && <p style={{ color: 'var(--text-tertiary)' }}>{formData.email}</p>}
                      {formData.phone && <p style={{ color: 'var(--text-tertiary)' }}>{formData.phone}</p>}
                    </div>
                  )}

                  {/* Banking */}
                  {formData.iban && (
                    <div>
                      <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.bankLabel')}</p>
                      {formData.bank_name && <p style={{ color: 'var(--text-tertiary)' }}>{formData.bank_name}</p>}
                      <p className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>{formData.iban}</p>
                    </div>
                  )}

                  {/* Legal */}
                  {(formData.vat_id || formData.tax_number) && (
                    <div>
                      <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.legalLabel')}</p>
                      {formData.vat_id && (
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>USt-IdNr: {formData.vat_id}</p>
                      )}
                      {formData.tax_number && (
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>St.-Nr: {formData.tax_number}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)' }}>
          <div className="flex justify-end space-x-3">
            <button
              type="button"
              onClick={handleReset}
              className="px-6 py-2 rounded-lg transition-colors"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              disabled={saving}
            >
              Zurücksetzen
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2 rounded-lg transition-colors flex items-center space-x-2 disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
            >
              <Save size={20} />
              <span>{saving ? t('settings.savingEllipsis') : 'Speichern'}</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

export default SettingsPage;
