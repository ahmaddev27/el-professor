import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '../lib/supabase';
import {
  NO_PLATFORM_ACCESS,
  parsePlatformWhoami,
  platformAccessCan,
  platformContextCompanyId,
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
  /**
   * Opens a company, and answers whether it opened. False when no support
   * session covers that company — the caller must not navigate on false, or the
   * tenant router would render against rows the database returns nothing for.
   */
  enterCompany: (company: CompanyListItem) => boolean;
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
  /**
   * Whether this account can actually read the effective company's business
   * data — `business.read` *and* an open context on that very company. It is
   * the browser's mirror of the database seam, and the screens that refuse to
   * print a figure they could not read (the cash ledger) ask this and not the
   * capability alone: since 20260917140000 the capability by itself reads
   * nothing at all.
   */
  platformReadsCompanyData: boolean;
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

  /*
    Opening a company needs an open support session on that company, not just
    the capability to read business data.

    Until 20260917140000 (plan 3.4) `business.read` was the whole story: the
    database answered a staff account with every company's rows, so entering was
    only a question of what the screens should show. That is no longer true.
    `get_active_company_id()` now answers with the *context's* company and
    nothing else, so entering without one renders all nineteen tenant routes
    against rows the database returns nothing for — every list empty, every
    total a confident zero, and no error anywhere to say why. One gate here is
    worth more than a guard on each of those screens, because it is also what
    the database actually says.

    It returns whether it opened; the callers must not navigate on false. 3.4b
    builds the screens that open a session, and reloadPlatformAccess() is how
    they make this see one.
  */
  const enterCompany = useCallback((company: CompanyListItem): boolean => {
    if (!platformAccessCan(platformAccess, 'business.read')) return false;
    if (platformContextCompanyId(platformAccess) !== company.id) return false;
    setActiveCompany(company);
    return true;
  }, [platformAccess]);

  const exitCompany = useCallback(() => {
    setActiveCompany(null);
  }, []);

  // Losing the role, the right to read business data, or the context that
  // covers this company closes it — an expired session leaves the screens the
  // moment the next whoami answer comes back.
  useEffect(() => {
    setActiveCompany(current => {
      if (!current) return current;
      if (!platformAccessCan(platformAccess, 'business.read')) return null;
      return platformContextCompanyId(platformAccess) === current.id ? current : null;
    });
  }, [platformAccess]);

  const isViewingAsCompany = isPlatformStaff && activeCompany !== null;
  const activeCompanyId = activeCompany?.id ?? null;
  // Super admin viewing as another company uses that company's id; otherwise own
  const effectiveCompanyId = isViewingAsCompany ? activeCompanyId : companyId;

  // The seam as the database now answers it: the capability, and a context on
  // this very company. A company user is not staff and reads its own data
  // through its own membership, so this is false for it and means nothing.
  const platformReadsCompanyData =
    platformAccessCan(platformAccess, 'business.read')
    && effectiveCompanyId !== null
    && platformContextCompanyId(platformAccess) === effectiveCompanyId;

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
      platformReadsCompanyData,
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
