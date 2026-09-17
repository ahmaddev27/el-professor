import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '../lib/supabase';
import {
  NO_PLATFORM_ACCESS,
  msUntilContextEnds,
  ownCompanyDataReadable,
  parsePlatformWhoami,
  platformAccessCan,
  platformCanEnterCompany,
  platformReadsCompany,
  samePlatformAccess,
  withoutCompanyContext,
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
   * Opens a company, and answers whether it opened. False when no live support
   * session covers that company — the caller must not navigate on false, or the
   * tenant router would render against rows the database returns nothing for.
   * Either way it asks the database again, so a session opened in another tab
   * is seen by the next attempt.
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
   * data through a support session — `business.read` *and* a context on that
   * very company that has not run out. The browser's mirror of the database
   * seam; the screens that refuse to print a figure they could not read (the
   * cash ledger) ask this and not the capability alone, which since
   * 20260917140000 reads nothing at all.
   */
  platformReadsCompanyData: boolean;
  /**
   * Whether the account's own company answers its business tables. Always true
   * for a company user, whom App.tsx's gates already settle. For a platform
   * account it is the database's own answer — get_active_company_id() naming
   * that company — because App.tsx skips the approval and subscription gates
   * for staff while the database does not.
   */
  ownCompanyReadable: boolean;
  reloadPlatformAccess: () => void;
}

const SuperAdminContext = createContext<SuperAdminContextType | undefined>(undefined);

/** setTimeout's ceiling; a longer delay would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * `focus` and `visibilitychange` arrive together when a tab comes back, and a
 * second question a moment after the first would bring no second answer.
 */
const WAKE_GAP_MS = 2_000;

interface RpcAnswer {
  data: unknown;
  failed: boolean;
}

const NOT_ASKED: RpcAnswer = { data: null, failed: false };

async function askRpc(fn: string): Promise<RpcAnswer> {
  try {
    const { data, error } = await supabase.rpc(fn);
    return { data, failed: !!error };
  } catch {
    return { data: null, failed: true };
  }
}

export const SuperAdminProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { user, isSuperAdmin, companyId } = useAuth();
  const [activeCompany, setActiveCompany] = useState<CompanyListItem | null>(null);
  const [platformAccess, setPlatformAccess] = useState<PlatformAccess>(NO_PLATFORM_ACCESS);
  const [platformAccessStatus, setPlatformAccessStatus] = useState<PlatformAccessStatus>('idle');
  const [ownActiveCompanyId, setOwnActiveCompanyId] = useState<string | null | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  /*
    The moment the gate judges a context by. It moves when an answer arrives,
    when the open context's end comes round, and when the tab comes back —
    never merely because something rendered, so every screen in one render is
    judged by the same moment.
  */
  const [clock, setClock] = useState(() => Date.now());
  const answeredFor = useRef<string | null>(null);
  const lastAskedAt = useRef(0);
  const userId = user?.id ?? null;

  const reloadPlatformAccess = useCallback(() => {
    const now = Date.now();
    lastAskedAt.current = now;
    setClock(now);
    setReloadKey(k => k + 1);
  }, []);

  // The profile flag only decides whether the question is worth a request: it
  // follows platform_staff, so a company user is never a staff member. It grants
  // nothing by itself.
  useEffect(() => {
    if (!userId || !isSuperAdmin) {
      answeredFor.current = null;
      setPlatformAccess(NO_PLATFORM_ACCESS);
      setOwnActiveCompanyId(undefined);
      setPlatformAccessStatus('idle');
      return;
    }
    let cancelled = false;
    // Only a first question shows as loading. A re-ask keeps the answer on
    // screen: AdminLayout turns 'loading' into a spinner, which would unmount
    // the page — and remount it, reading its data and writing its audit rows
    // again — every time the tab regained focus.
    const reAsking = answeredFor.current === userId;
    if (!reAsking) {
      setPlatformAccess(NO_PLATFORM_ACCESS);
      setOwnActiveCompanyId(undefined);
      setPlatformAccessStatus('loading');
    }
    lastAskedAt.current = Date.now();

    void Promise.all([
      askRpc('platform_whoami'),
      // Only an account with a company of its own has anything to ask here.
      companyId ? askRpc('get_active_company_id') : Promise.resolve(NOT_ASKED),
    ]).then(([whoami, active]) => {
      if (cancelled) return;
      const receivedAt = Date.now();
      setClock(receivedAt);
      setOwnActiveCompanyId(!active.failed && typeof active.data === 'string' ? active.data : null);

      if (!whoami.failed) {
        const next = parsePlatformWhoami(whoami.data, receivedAt);
        setPlatformAccess(previous => (samePlatformAccess(previous, next) ? previous : next));
        setPlatformAccessStatus('ready');
        answeredFor.current = userId;
        return;
      }
      if (reAsking) {
        setPlatformAccess(withoutCompanyContext);
        return;
      }
      setPlatformAccess(NO_PLATFORM_ACCESS);
      setPlatformAccessStatus('error');
    });
    return () => { cancelled = true; };
  }, [userId, isSuperAdmin, companyId, reloadKey]);

  /*
    The tab coming back is when a context closed in another tab, one that ran
    out while the laptop slept, or a staff row disabled in the meantime has to
    be seen. platform_whoami() and get_active_company_id() write nothing, so
    asking on every return costs two requests and no audit row.
  */
  useEffect(() => {
    if (!userId || !isSuperAdmin) return;
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastAskedAt.current < WAKE_GAP_MS) return;
      reloadPlatformAccess();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [userId, isSuperAdmin, reloadPlatformAccess]);

  /*
    The open context's end, on this browser's clock. Moving `clock` there is
    what closes the company at that moment rather than at whatever answer comes
    next; asking again is what brings the answer into line. Keyed on `clock` as
    well, so a timer that fired a moment early re-arms for the rest.
  */
  useEffect(() => {
    const ms = msUntilContextEnds(platformAccess, Date.now());
    if (ms === null) return;
    const timer = setTimeout(reloadPlatformAccess, Math.min(ms, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [platformAccess, clock, reloadPlatformAccess]);

  const isPlatformStaff = platformAccess.role !== null;

  const platformCan = useCallback(
    (capability: PlatformCapability) => platformAccessCan(platformAccess, capability),
    [platformAccess],
  );

  /*
    Opening a company needs a live support session on that company, not just
    the capability to read business data.

    Until 20260917140000 (plan 3.4) `business.read` was the whole story: the
    database answered a staff account with every company's rows, so entering was
    only a question of what the screens should show. That is no longer true.
    `get_active_company_id()` now answers with the *context's* company and
    nothing else, so entering without one renders all nineteen tenant routes
    against rows the database returns nothing for — every list empty, every
    total a confident zero, and no error anywhere to say why. One gate here is
    worth more than a guard on each of those screens, because it is also what
    the database actually says. The rule itself is platformCanEnterCompany().

    It returns whether it opened; the callers must not navigate on false. 3.4b
    builds the screens that open a session, and reloadPlatformAccess() is how
    they make this see one.
  */
  const enterCompany = useCallback((company: CompanyListItem): boolean => {
    reloadPlatformAccess();
    if (!platformCanEnterCompany(platformAccess, company.id, Date.now())) return false;
    setActiveCompany(company);
    return true;
  }, [platformAccess, reloadPlatformAccess]);

  const exitCompany = useCallback(() => {
    setActiveCompany(null);
  }, []);

  // Losing the role, the right to read business data, or a live context on this
  // company closes it: when an answer says so, and when the context's end comes
  // round on the clock whether or not any answer has arrived since. Dropping the
  // company is what sends the account back to the panel — PlatformAccountGuard
  // (App.tsx) routes a platform account with no effective company there.
  useEffect(() => {
    setActiveCompany(current =>
      current !== null && platformCanEnterCompany(platformAccess, current.id, clock) ? current : null);
  }, [platformAccess, clock]);

  const isViewingAsCompany = isPlatformStaff && activeCompany !== null;
  const activeCompanyId = activeCompany?.id ?? null;
  // Super admin viewing as another company uses that company's id; otherwise own
  const effectiveCompanyId = isViewingAsCompany ? activeCompanyId : companyId;

  const platformReadsCompanyData = platformReadsCompany(platformAccess, effectiveCompanyId, clock);
  const ownCompanyReadable = ownCompanyDataReadable({
    accountIsPlatformStaff: isSuperAdmin,
    ownCompanyId: companyId,
    activeCompanyId: ownActiveCompanyId,
  });

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
      ownCompanyReadable,
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
