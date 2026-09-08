import { supabase } from '../lib/supabase';

export interface BackupData {
  timestamp: string;
  version: string;
  tables: {
    [key: string]: any[];
  };
}

async function fetchTableData(tableName: string, companyId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from(tableName)
    .select('*')
    .eq('company_id', companyId);

  if (error) {
    console.error(`Error fetching ${tableName}:`, error);
    return [];
  }

  return data || [];
}

export async function createBackup(companyId: string): Promise<BackupData> {
  if (!companyId) {
    throw new Error('Company ID is required for backup');
  }

  const tables = [
    'drivers',
    'receipts',
    'user_profiles',
    'fixed_costs',
    'income',
    'salaries',
    'cash_transactions',
  ];

  const backupData: BackupData = {
    timestamp: new Date().toISOString(),
    version: '1.0',
    tables: {},
  };

  for (const table of tables) {
    backupData.tables[table] = await fetchTableData(table, companyId);
  }

  return backupData;
}

export function downloadBackup(backupData: BackupData): void {
  const filename = `backup-${new Date().toISOString().split('T')[0]}.json`;
  const dataStr = JSON.stringify(backupData, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function createAndDownloadBackup(companyId: string): Promise<void> {
  try {
    const backupData = await createBackup(companyId);
    downloadBackup(backupData);
  } catch (error) {
    console.error('Error creating backup:', error);
    throw error;
  }
}
