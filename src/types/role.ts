export interface Role {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RolePermission {
  id: string;
  role_id: string;
  page_key: string;
  can_view: boolean;
  can_edit: boolean;
  created_at: string;
}

export interface RoleWithPermissions extends Role {
  permissions: RolePermission[];
}

export const PAGE_DEFINITIONS = [
  { key: 'overview', label: 'Übersicht', description: 'Dashboard overview' },
  { key: 'drivers', label: 'Fahrer', description: 'Driver management' },
  { key: 'income', label: 'Umsätze', description: 'Income tracking' },
  { key: 'receipts', label: 'Belege', description: 'Receipt management' },
  { key: 'fixed-costs', label: 'Fixkosten', description: 'Fixed costs' },
  { key: 'salaries', label: 'Gehälter', description: 'Salary management' },
  { key: 'cash-balance', label: 'Bargeldbestand', description: 'Cash balance' },
  { key: 'statistics', label: 'Statistiken', description: 'Statistics and reports' },
  { key: 'documents', label: 'Dokumente', description: 'Document management and generation' },
  { key: 'accounting', label: 'Abrechnung', description: 'Accounting' },
  { key: 'users', label: 'Benutzerverwaltung', description: 'User management' },
  { key: 'cars', label: 'Autos', description: 'Car management' },
  { key: 'werkstatt', label: 'Werkstatt', description: 'Workshop checks' },
  { key: 'notes', label: 'Notizen', description: 'Driver notes' },
  { key: 'roles', label: 'Rollen', description: 'Role management' },
  { key: 'settings', label: 'Einstellungen', description: 'System settings' },
] as const;
