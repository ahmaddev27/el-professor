import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '../lib/supabase';
import {
  NO_PLATFORM_ACCESS,
  parsePlatformWhoami,
  platformAccessCan,
  type PlatformAccess,
  type PlatformCapability,
} from '../lib/platformAccess';

export interface CompanyListItem {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  country: string;
  logo_url: string | null;
  status: 'active' | 'trial' | 'suspended' | 'inactive';
  created_at: string;
  updated_at: string;
  user_count?: number;
}

/** Where the platform_whoami() answer for the signed-in account stands. */
export type PlatformAccessStatus = 'idle' | 'loading' | 'ready' | 'error';

interface SuperAdminContextType {
  // Which company the super admin is currently "viewing as"
  activeCompanyId: string | null;
  activeCompany: CompanyListItem | null;
  isViewingAsCompany: boolean;
  enterCompany: (company: CompanyListItem) => void;
  exitCompany: () => void;
  // The effective company id to use for queries (own company OR switched-to company)
  effectiveCompanyId: string | null;
  /**
   * The account's platform role and capabilities, from platform_whoami(). This,
   * not the profile flag, is what the platform screens show and hide by; the
   * database checks every action again regardless.
   */
  platformAccess: PlatformAccess;
  platformAccessStatus: PlatformAccessStatus;
  /** An active staff role. False while the answer is loading or failed. */
  isPlatformStaff: boolean;
  platformCan: (capability: PlatformCapability) => boolean;
  reloadPlatformAccess: () => void;
}

const SuperAdminContext = createContext<SuperAdminContextType | undefined>(undefined);

export const SuperAdminProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { user, isSuperAdmin, companyId } = useAuth();
  const [activeCompany, setActiveCompany] = useState<CompanyListItem | null>(null);
  const [platformAccess, setPlatformAccess] = useState<PlatformAccess>(NO_PLATFORM_ACCESS);
  const [platformAccessStatus, setPlatformAccessStatus] = useState<PlatformAccessStatus>('idle');
  const [reloadKey, setReloadKey] = useState(0);
  const userId = user?.id ?? null;

  // The profile flag only decides whether the question is worth a request: it
  // follows platform_staff, so a company user is never a staff member. It grants
  // nothing by itself.
  useEffect(() => {
    if (!userId || !isSuperAdmin) {
      setPlatformAccess(NO_PLATFORM_ACCESS);
      setPlatformAccessStatus('idle');
      return;
    }
    let cancelled = false;
    setPlatformAccessStatus('loading');
    supabase.rpc('platform_whoami').then(
      ({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setPlatformAccess(NO_PLATFORM_ACCESS);
          setPlatformAccessStatus('error');
          return;
        }
        setPlatformAccess(parsePlatformWhoami(data));
        setPlatformAccessStatus('ready');
      },
      () => {
        if (cancelled) return;
        setPlatformAccess(NO_PLATFORM_ACCESS);
        setPlatformAccessStatus('error');
      },
    );
    return () => { cancelled = true; };
  }, [userId, isSuperAdmin, reloadKey]);

  const isPlatformStaff = platformAccess.role !== null;

  const platformCan = useCallback(
    (capability: PlatformCapability) => platformAccessCan(platformAccess, capability),
    [platformAccess],
  );

  const reloadPlatformAccess = useCallback(() => setReloadKey(k => k + 1), []);

  // Opening a company shows its business data, which only a role holding
  // business.read may see.
  const enterCompany = useCallback((company: CompanyListItem) => {
    if (!platformAccessCan(platformAccess, 'business.read')) return;
    setActiveCompany(company);
  }, [platformAccess]);

  const exitCompany = useCallback(() => {
    setActiveCompany(null);
  }, []);

  // Losing the role, or the right to read business data, closes the company.
  useEffect(() => {
    if (!platformAccessCan(platformAccess, 'business.read')) setActiveCompany(null);
  }, [platformAccess]);

  const isViewingAsCompany = isPlatformStaff && activeCompany !== null;
  const activeCompanyId = activeCompany?.id ?? null;
  // Super admin viewing as another company uses that company's id; otherwise own
  const effectiveCompanyId = isViewingAsCompany ? activeCompanyId : companyId;

  return (
    <SuperAdminContext.Provider value={{
      activeCompanyId,
      activeCompany,
      isViewingAsCompany,
      enterCompany,
      exitCompany,
      effectiveCompanyId,
      platformAccess,
      platformAccessStatus,
      isPlatformStaff,
      platformCan,
      reloadPlatformAccess,
    }}>
      {children}
    </SuperAdminContext.Provider>
  );
};

export const useSuperAdmin = () => {
  const context = useContext(SuperAdminContext);
  if (context === undefined) {
    throw new Error('useSuperAdmin must be used within a SuperAdminProvider');
  }
  return context;
};
