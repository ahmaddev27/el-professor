/** Stands in for CompanySettingsContext's hook: the invented company's name, nothing else. */
import { PREVIEW_COMPANY } from '../../src/design-preview/sampleData';

export * from '../../src/contexts/CompanySettingsContext';

const value = {
  settings: { company_name: PREVIEW_COMPANY, logo_url: null },
  loading: false,
  error: null,
  updateSettings: async () => undefined,
  refreshSettings: async () => undefined,
};

export const useCompanySettings = () => value;
