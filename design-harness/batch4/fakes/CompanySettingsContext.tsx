/**
 * Stands in for CompanySettingsContext's hook in the batch-4 harness: the
 * invented company's full settings row, which Einstellungen edits. A save is
 * recorded and kept, so the form shows what it wrote.
 */
import { useState } from 'react';
import { companySettings } from '../fixtures';
import { answerLater, recordWrite } from './supabase';
import { scenario } from '../scenario';

export * from '../../../src/contexts/CompanySettingsContext';

let stored = companySettings();

export const useCompanySettings = () => {
  const [settings, setSettings] = useState(stored);
  return {
    settings,
    loading: scenario.screen === 'settings' && scenario.data === 'loading',
    error: null,
    updateSettings: (values: Record<string, unknown>) =>
      answerLater(() => {
        recordWrite('company_settings', 'update', values);
        stored = { ...stored, ...values };
        setSettings(stored);
      }),
    refreshSettings: async () => undefined,
  };
};
