import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { useAuth } from './AuthContext';

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

interface SuperAdminContextType {
  // Which company the super admin is currently "viewing as"
  activeCompanyId: string | null;
  activeCompany: CompanyListItem | null;
  isViewingAsCompany: boolean;
  enterCompany: (company: CompanyListItem) => void;
  exitCompany: () => void;
  // The effective company id to use for queries (own company OR switched-to company)
  effectiveCompanyId: string | null;
}

const SuperAdminContext = createContext<SuperAdminContextType | undefined>(undefined);

export const SuperAdminProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { isSuperAdmin, companyId } = useAuth();
  const [activeCompany, setActiveCompany] = useState<CompanyListItem | null>(null);

  const enterCompany = useCallback((company: CompanyListItem) => {
    setActiveCompany(company);
  }, []);

  const exitCompany = useCallback(() => {
    setActiveCompany(null);
  }, []);

  const isViewingAsCompany = isSuperAdmin && activeCompany !== null;
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
