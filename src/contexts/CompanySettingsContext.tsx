import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { CompanySettings } from '../types/settings';
import { supabase } from '../lib/supabase';
import { useSuperAdmin } from './SuperAdminContext';

// Resolves a logo value to a displayable URL.
// Handles both full URLs (new rows) and bare storage paths (legacy rows).
export function resolveLogoUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  // Bare storage path — resolve to public URL
  const { data } = supabase.storage.from('company-logos').getPublicUrl(value);
  return data.publicUrl || null;
}

interface CompanySettingsContextType {
  settings: CompanySettings | null;
  loading: boolean;
  error: string | null;
  refreshSettings: () => Promise<void>;
  updateSettings: (settings: Partial<CompanySettings>) => Promise<void>;
}

const CompanySettingsContext = createContext<CompanySettingsContextType | undefined>(undefined);

export const CompanySettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  /*
    The company the session is in, not the account's membership (plan 3.4b).

    These settings are the company's name, logo and letterhead — the things the
    shell and every document print. Read from `AuthContext.companyId` they were
    null for a platform account, so a support session saw "El-Professor" in the
    sidebar and an empty Einstellungen form for the company it had just opened,
    while the logo upload on that very screen already wrote to the right one.
    `company_settings` is part of the account shell, whose policy term is
    `get_user_company_id()` — which answers the open context — so the row is
    readable exactly when this id names it.
  */
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      setError(null);

      if (!companyId) {
        setSettings(null);
        return;
      }

      const { data, error: fetchError } = await supabase
        .from('company_settings')
        .select('*')
        .eq('company_id', companyId)
        .maybeSingle();

      if (fetchError) throw fetchError;

      // Resolve storage path → full public URL so all consumers get a usable URL
      if (data?.logo_url) {
        data.logo_url = resolveLogoUrl(data.logo_url) ?? data.logo_url;
      }

      setSettings(data);
    } catch (err: any) {
      console.error('Error fetching company settings:', err);
      setError(err.message || 'Failed to load company settings');
    } finally {
      setLoading(false);
    }
  };

  const refreshSettings = async () => {
    await fetchSettings();
  };

  const updateSettings = async (updatedSettings: Partial<CompanySettings>) => {
    if (!companyId) throw new Error('No company id');

    const { data, error: updateError } = await supabase
      .from('company_settings')
      .upsert(
        { ...updatedSettings, company_id: companyId },
        { onConflict: 'company_id', ignoreDuplicates: false }
      )
      .select()
      .maybeSingle();

    if (updateError) {
      console.error('Error updating company settings:', updateError);
      throw updateError;
    }

    if (!data) {
      // Upsert returned no row — re-fetch to stay consistent
      await fetchSettings();
      throw new Error('Einstellungen konnten nicht gespeichert werden (Zugriff verweigert)');
    }

    // Resolve logo path → public URL before storing in state
    if (data.logo_url) {
      data.logo_url = resolveLogoUrl(data.logo_url) ?? data.logo_url;
    }

    setSettings(data);
  };

  useEffect(() => {
    if (companyId) {
      fetchSettings();
    } else {
      setSettings(null);
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;

    const subscription = supabase
      .channel(`company_settings_${companyId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'company_settings',
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          fetchSettings();
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [companyId]);

  return (
    <CompanySettingsContext.Provider
      value={{
        settings,
        loading,
        error,
        refreshSettings,
        updateSettings,
      }}
    >
      {children}
    </CompanySettingsContext.Provider>
  );
};

export const useCompanySettings = () => {
  const context = useContext(CompanySettingsContext);
  if (context === undefined) {
    throw new Error('useCompanySettings must be used within a CompanySettingsProvider');
  }
  return context;
};
