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

/**
 * `key` is the stored `role_permissions.page_key` — it is matched, never displayed.
 * `label` and `description` hold TranslationKeys because this list is module-level
 * and `t()` is a hook value; RoleModal resolves them where it renders each row.
 */
export const PAGE_DEFINITIONS = [
  { key: 'overview', label: 'users.page.overview', description: 'users.page.overview.desc' },
  { key: 'drivers', label: 'users.page.drivers', description: 'users.page.drivers.desc' },
  { key: 'income', label: 'users.page.income', description: 'users.page.income.desc' },
  { key: 'receipts', label: 'users.page.receipts', description: 'users.page.receipts.desc' },
  { key: 'fixed-costs', label: 'users.page.fixedCosts', description: 'users.page.fixedCosts.desc' },
  { key: 'salaries', label: 'users.page.salaries', description: 'users.page.salaries.desc' },
  { key: 'cash-balance', label: 'users.page.cashBalance', description: 'users.page.cashBalance.desc' },
  { key: 'statistics', label: 'users.page.statistics', description: 'users.page.statistics.desc' },
  { key: 'documents', label: 'users.page.documents', description: 'users.page.documents.desc' },
  { key: 'accounting', label: 'users.page.accounting', description: 'users.page.accounting.desc' },
  { key: 'users', label: 'users.page.users', description: 'users.page.users.desc' },
  { key: 'cars', label: 'users.page.cars', description: 'users.page.cars.desc' },
  { key: 'werkstatt', label: 'users.page.werkstatt', description: 'users.page.werkstatt.desc' },
  { key: 'notes', label: 'users.page.notes', description: 'users.page.notes.desc' },
  { key: 'roles', label: 'users.page.roles', description: 'users.page.roles.desc' },
  { key: 'settings', label: 'users.page.settings', description: 'users.page.settings.desc' },
] as const;
