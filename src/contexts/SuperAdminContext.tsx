import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '../lib/supabase';
import {
  NO_PLATFORM_ACCESS,
  liveCompanyContext,
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
  type PlatformCompanyContext,
  type PlatformContextMode,
} from '../lib/platformAccess';
import { companyScope, type CompanyScope } from '../lib/companyScope';
import { closeCompanyContext, openCompanyContext } from '../lib/supportSessionClient';

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
   *
   * It opens nothing itself: `openCompany` is what asks the database for a
   * context. This only records the fuller company row for the shell to show,
   * and re-checks that a context covers it.
   */
  enterCompany: (company: CompanyListItem) => boolean;
  exitCompany: () => void;
  /**
   * Asks the database for a context on this company (plan 3.4b) — `view` reads,
   * `support` reads and writes and records the reason given for it. Resolves
   * once the context is in hand, so a caller may navigate straight after;
   * rejects with the database's own refusal (`PlatformRpcError`), which is the
   * only authority on whether it opened.
   */
  openCompany: (
    company: CompanyListItem,
    mode: PlatformContextMode,
    reason?: string | null,
  ) => Promise<void>;
  /** Ends the open context, on the server and here. */
  closeCompany: () => Promise<void>;
  /** The open context as the database last reported it, or null once it ends. */
  companyContext: PlatformCompanyContext | null;
  /**
   * Which company the screens must query and whether they may write there. The
   * one seam: `effectiveCompanyId` is `companyScope.companyId`, and every
   * tenant screen, hook and context reads it rather than the membership in
   * AuthContext.
   */
  companyScope: CompanyScope;
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

/**
 * The open context as a company row, for the shell that shows a name.
 *
 * A context carries the company's id and name and nothing else, which is all
 * the shell reads. The remaining columns are filled with empty values rather
 * than invented ones, and the fuller row from the companies list replaces this
 * whenever the panel has one — which it does for every path that goes through
 * `openCompany`, and does not after a reload, where the context is the only
 * thing that survived.
 */
function companyFromContext(context: PlatformCompanyContext): CompanyListItem {
  return {
    id: context.companyId,
    name: context.companyName ?? '',
    slug: '',
    legal_name: null,
    email: null,
    phone: null,
    address: null,
    city: null,
    postal_code: null,
    country: '',
    logo_url: null,
    status: 'active',
    created_at: '',
    updated_at: '',
  };
}

export const SuperAdminProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { user, isSuperAdmin, companyId } = useAuth();
  /*
    The fuller company row, when a panel screen handed one over. It is a label,
    not a permission and not the seam: which company the screens query is
    `companyScope` below, and that comes from the context the database reports.
    Before 3.4b this state *was* the answer, which is why entering a company did
    not survive a reload.
  */
  const [enteredCompany, setEnteredCompany] = useState<CompanyListItem | null>(null);
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
    setEnteredCompany(company);
    return true;
  }, [platformAccess, reloadPlatformAccess]);

  /*
    Opening a company is one RPC, and the answer it returns is the context.

    Installing that answer rather than waiting for the next platform_whoami() is
    what lets the caller navigate in the same click: between a successful
    platform_context_open and the whoami that would confirm it, this provider
    would still hold no context, so `effectiveCompanyId` would be null and
    PlatformAccountGuard would bounce the tab straight back to /admin. The
    installed value is the database's own row, parsed by the same function the
    whoami answer goes through, and the re-ask that follows replaces it.
  */
  const openCompany = useCallback(async (
    company: CompanyListItem,
    mode: PlatformContextMode,
    reason?: string | null,
  ): Promise<void> => {
    const context = await openCompanyContext(company.id, mode, reason);
    const receivedAt = Date.now();
    setEnteredCompany(company);
    if (context !== null) {
      setPlatformAccess(previous => ({ ...previous, companyContext: context }));
      setClock(receivedAt);
    }
    lastAskedAt.current = receivedAt;
    setReloadKey(k => k + 1);
  }, []);

  /*
    Ending one closes it here first and on the server after.

    The optimistic half only ever takes access away, so a failed request leaves
    the browser showing less than it holds and never more; the re-ask that
    follows settles it either way. Doing it in the other order would leave the
    company open on screen for a round trip after the person asked to leave it.
  */
  const closeCompany = useCallback(async (): Promise<void> => {
    setPlatformAccess(withoutCompanyContext);
    setEnteredCompany(null);
    try {
      await closeCompanyContext();
    } finally {
      reloadPlatformAccess();
    }
  }, [reloadPlatformAccess]);

  const exitCompany = useCallback(() => {
    void closeCompany().catch(() => {
      // The screens have already left the company; a failed close is the
      // database's to time out, and the next answer reports whatever is true.
    });
  }, [closeCompany]);

  /*
    Which company the screens query, and whether they may write there.

    Derived from the context the database reports — not from state a click left
    behind — so it survives a reload, follows a session closed in another tab,
    and ends exactly when the context does. `clock` is what makes that last part
    true without an answer: it moves when the context's end comes round.
  */
  const companyContext = liveCompanyContext(platformAccess, clock);
  const scope = companyScope({ ownCompanyId: companyId, context: companyContext });

  // The label the shell shows. The fuller row when a panel screen handed one
  // over for this very company, the context's own name otherwise — after a
  // reload that is all there is.
  const activeCompany = scope.isPlatformSession && companyContext !== null
    ? (enteredCompany?.id === scope.companyId ? enteredCompany : companyFromContext(companyContext))
    : null;

  // A row for a company that is no longer open is a label with nothing behind
  // it; drop it so a later context cannot inherit the wrong name.
  useEffect(() => {
    setEnteredCompany(current => (current !== null && current.id === scope.companyId ? current : null));
  }, [scope.companyId]);

  const isViewingAsCompany = scope.isPlatformSession;
  const activeCompanyId = activeCompany?.id ?? null;
  const effectiveCompanyId = scope.companyId;

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
      openCompany,
      closeCompany,
      companyContext,
      companyScope: scope,
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
