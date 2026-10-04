import React, { useState, useEffect, useMemo } from 'react';
import { Download, Plus, CreditCard as Edit2, Trash2, Shield, ShieldCheck, Info, Eye } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { PAGE_DEFINITIONS, Role, RolePermission, RoleWithPermissions } from '../types/role';
import RoleModal from './RoleModal';
import {
  deleteRefusalMessage,
  ownRoles,
  permissionPayload,
  roleActionVerdict,
  roleHolderCounts,
  ROLE_PAGE_KEYS,
  saveRefusalMessage,
  templateRoles,
  type PermissionMap,
  type ProfileRoleRow,
  type RoleRpcResult,
} from '../lib/companyRoles';
import { exportTableToExcel } from '../utils/excelExport';
import { buildRolesExport } from '../utils/tableExportRows';
import { useExportChrome } from '../hooks/useExportChrome';
import { useToast } from '../contexts/ToastContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { Alert, Badge, Button, ConfirmDialog, DataTable, EmptyState, PageHeader, Skeleton, Tooltip, type DataTableColumn } from './ui';

const RolesManagement: React.FC = () => {
  const { t, tPlural } = useTranslation();
  const exportChrome = useExportChrome();
  const [roles, setRoles] = useState<RoleWithPermissions[]>([]);
  const [holders, setHolders] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState<RoleWithPermissions | undefined>();
  const [roleToDelete, setRoleToDelete] = useState<Role | null>(null);
  const { showToast } = useToast();
  /*
    The company the session is in, and whether it may be written (plan 3.4b).

    `roles_select` reads system roles (company_id IS NULL) plus the caller's
    own, and `get_user_company_id()` answers the open context for a platform
    account — so the list is already the right company's. What was missing is
    the dependency below: this effect ran once, on mount, so entering a company
    after the screen had rendered left the previous company's roles on it.

    In a read context the write buttons are hidden, because
    `refuse_read_only_context_write` refuses every one of them on `roles` and
    `role_permissions`.
  */
  const { effectiveCompanyId: companyId, companyScope } = useSuperAdmin();
  const readOnly = companyScope.readOnly;

  useEffect(() => {
    fetchRoles();
  }, [companyId]);

  const fetchRoles = async () => {
    try {
      setLoading(true);
      setLoadFailed(false);

      const { data: rolesData, error: rolesError } = await supabase
        .from('roles')
        .select('*')
        .order('name');

      if (rolesError) throw rolesError;

      const { data: permissionsData, error: permissionsError } = await supabase
        .from('role_permissions')
        .select('*');

      if (permissionsError) throw permissionsError;

      /*
        Who holds each role. `user_profiles_select` answers the caller's own
        company's profiles, which — since 20260923120000's scope trigger — is
        every account that can hold one of this company's roles. The count is
        what turns "this role cannot be deleted" into a sentence an
        administrator can act on; the foreign key is still the wall, and
        `company_role_delete` counts again under lock.
      */
      const { data: profilesData, error: profilesError } = await supabase
        .from('user_profiles')
        .select('role_id, role');

      if (profilesError) throw profilesError;

      const rolesWithPermissions: RoleWithPermissions[] = (rolesData || []).map(role => ({
        ...role,
        permissions: (permissionsData || []).filter(p => p.role_id === role.id),
      }));

      setRoles(rolesWithPermissions);
      setHolders(roleHolderCounts(rolesWithPermissions, (profilesData || []) as ProfileRoleRow[]));
    } catch (error: any) {
      console.error('Error fetching roles:', error);
      // A list drawn from a failed read is a claim, not a fact: an empty
      // "Eigene Rollen" would read as "this company has none".
      setLoadFailed(true);
      showToast('error', t('users.roles.error.load'));
    } finally {
      setLoading(false);
    }
  };

  /*
    One transaction per role.

    The screen used to insert the role and then its permission rows, and on an
    edit to delete every permission row before re-inserting them — so a failure
    between the two left a role with no permissions at all, which is every
    holder locked out of every page, with nothing on screen to say so.
    `company_role_save` (20260923120000) does both in one statement's
    transaction and answers a stable reason.
  */
  const handleSaveRole = async (roleData: Partial<Role>, permissions: PermissionMap) => {
    const { data, error } = await supabase.rpc('company_role_save', {
      p_name: roleData.name ?? '',
      p_description: roleData.description ?? '',
      p_permissions: permissionPayload(permissions),
      p_role_id: roleData.id ?? null,
    });

    if (error) throw new Error(error.message || t('users.roles.error.save'));

    const result = (data ?? null) as RoleRpcResult | null;
    const refusal = saveRefusalMessage(result);
    if (refusal) throw new Error(t(refusal.key, refusal.vars));

    showToast('success', roleData.id ? t('users.roles.updated') : t('users.roles.created'));
    await fetchRoles();
    setIsModalOpen(false);
    setSelectedRole(undefined);
  };

  const handleEditRole = (role: RoleWithPermissions) => {
    setSelectedRole(role);
    setIsModalOpen(true);
  };

  const handleDeleteClick = (role: Role) => {
    const verdict = roleActionVerdict(role, 'delete', { readOnly, holders: holders[role.id] ?? 0 });
    if (!verdict.allowed) {
      const reason = verdict.reason;
      if (reason?.kind === 'assigned') {
        showToast('error', t('users.roles.error.stillAssigned', { count: reason.count }));
      } else if (reason?.kind === 'system_role') {
        showToast('error', t('users.roles.systemCannotDelete'));
      } else {
        showToast('error', t('users.roles.error.notAuthorized'));
      }
      return;
    }
    setRoleToDelete(role);
    setIsDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!roleToDelete) return;

    try {
      const { data, error } = await supabase.rpc('company_role_delete', { p_role_id: roleToDelete.id });
      if (error) throw error;

      const result = (data ?? null) as RoleRpcResult | null;
      const refusal = deleteRefusalMessage(result);
      if (refusal) {
        showToast('error', t(refusal.key, refusal.vars));
      } else {
        showToast('success', t('users.roles.deleted'));
      }
      await fetchRoles();
    } catch (error: any) {
      console.error('Error deleting role:', error);
      showToast('error', error.message || t('users.roles.error.delete'));
    } finally {
      setIsDeleteModalOpen(false);
      setRoleToDelete(null);
    }
  };

  const getPermissionsSummary = (permissions: RolePermission[]) => {
    const viewCount = permissions.filter(p => p.can_view).length;
    const editCount = permissions.filter(p => p.can_edit).length;
    return t('users.roles.permissionsSummary', { view: viewCount, edit: editCount });
  };

  const templates = useMemo(() => templateRoles(roles), [roles]);
  const companyRoles = useMemo(() => ownRoles(roles), [roles]);

  /**
   * The access matrix as a workbook — the only artefact that answers "who could
   * read Gehälter". The screen's permissions column is a summary sentence
   * ("{view} ansehen, {edit} bearbeiten"), which is unusable in a file.
   *
   * **The rule being preserved: a page a role does not permit must read No, not
   * be absent.** A system role stores no `role_permissions` row at all for an
   * area it does not permit, so flattening `role.permissions` would emit a
   * different number of rows per role and leave every unpermitted area out — and
   * an access review reads a missing row as "not applicable". So the file is the
   * full matrix, one row per role and each of the sixteen page keys, resolved
   * through `permissionsFromTemplate`, the same helper RoleModal draws its boxes
   * with, which also applies `can_edit → can_view` exactly as the form and
   * `company_role_save` apply it. The file therefore says what an operator sees
   * when they open the role.
   *
   * `getPermissionsSummary` above is left alone: it counts the raw rows, so a
   * stored `{can_view: false, can_edit: true}` is one permission there and
   * view + edit here. The matrix is what the database enforces.
   */
  const handleExport = () => {
    try {
      exportTableToExcel(buildRolesExport({
        companyRoles,
        templates,
        holders,
        labels: {
          sheetTitle: t('users.roles.title'),
          role: t('users.form.role'),
          roleType: t('users.roles.type'),
          typeSystem: t('users.roles.typeSystem'),
          typeCustom: t('users.roles.typeCustom'),
          description: t('common.description'),
          holders: t('users.roles.holders'),
          area: t('users.roles.export.area'),
          areaKey: t('users.roles.export.areaKey'),
          view: t('users.roles.export.canView'),
          edit: t('users.roles.export.canEdit'),
          yes: t('common.yes'),
          no: t('common.no'),
          // PAGE_DEFINITIONS already carries a TranslationKey per page, the same
          // label RoleModal prints, so the area names cost no new keys.
          areaNames: Object.fromEntries(PAGE_DEFINITIONS.map((page): [string, string] => [page.key, t(page.label)])),
          scope: t('users.roles.export.scope', {
            roles: companyRoles.length + templates.length,
            areas: ROLE_PAGE_KEYS.length,
          }),
          chrome: exportChrome,
        },
      }));
    } catch (error: any) {
      showToast('error', t('ui.export.failed'), error?.message);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // The list is split in two, which is what the screen was missing: the four
  // system roles are templates a company may read and copy but never write —
  // the edit button used to be offered on them and the database refused it —
  // and below them the company's own roles, with how many accounts hold each.

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-6 font-ui" aria-busy="true">
        <PageHeader title={t('users.roles.title')} description={t('users.roles.subtitle')} />
        <div className="grid gap-3 rounded-surface border border-line bg-raised p-5">
          {[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-9 w-full" />)}
        </div>
        <p role="status" className="sr-only">{t('users.roles.loading')}</p>
      </div>
    );
  }

  const nameColumn: DataTableColumn<RoleWithPermissions> = {
    id: 'name',
    header: t('users.form.role'),
    value: role => role.name,
    cell: role => (
      <span className="flex items-center gap-2 font-medium">
        {role.is_system
          ? <ShieldCheck aria-hidden className="size-4 shrink-0 text-fg-subtle" />
          : <Shield aria-hidden className="size-4 shrink-0 text-brand-text" />}
        {role.name}
      </span>
    ),
  };

  const descriptionColumn: DataTableColumn<RoleWithPermissions> = {
    id: 'description',
    header: t('common.description'),
    value: role => role.description,
    cell: role => <span className="text-fg-muted">{role.description || '-'}</span>,
    hideBelow: 'md',
  };

  const permissionsColumn: DataTableColumn<RoleWithPermissions> = {
    id: 'permissions',
    header: t('users.roles.permissions'),
    cell: role => <span className="text-fg-muted">{getPermissionsSummary(role.permissions)}</span>,
    hideBelow: 'sm',
  };

  const holdersColumn: DataTableColumn<RoleWithPermissions> = {
    id: 'holders',
    header: t('users.roles.holders'),
    cell: role => {
      const count = holders[role.id] ?? 0;
      return (
        <span className="tabular-nums text-fg-muted">
          {count === 0
            ? t('users.roles.holders.none')
            : tPlural({ one: 'users.roles.holders.count.one', other: 'users.roles.holders.count.other' }, count)}
        </span>
      );
    },
    hideBelow: 'sm',
  };

  const templateColumns: DataTableColumn<RoleWithPermissions>[] = [
    nameColumn,
    descriptionColumn,
    permissionsColumn,
    holdersColumn,
    {
      id: 'type',
      header: t('users.roles.type'),
      cell: () => <Badge tone="neutral">{t('users.roles.typeSystem')}</Badge>,
      hideBelow: 'sm',
    },
  ];

  const companyColumns: DataTableColumn<RoleWithPermissions>[] = [
    nameColumn,
    descriptionColumn,
    permissionsColumn,
    holdersColumn,
  ];

  /* A template is opened read-only: RoleModal draws its boxes and offers no save. */
  const templateActions = (role: RoleWithPermissions) => (
    <Tooltip content={t('users.roles.viewTemplate')}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('users.roles.viewNamed', { name: role.name })}
        onClick={() => handleEditRole(role)}
      >
        <Eye aria-hidden />
      </Button>
    </Tooltip>
  );

  const companyActions = (role: RoleWithPermissions) => {
    const held = holders[role.id] ?? 0;
    const canDelete = roleActionVerdict(role, 'delete', { readOnly, holders: held }).allowed;
    return (
      <>
        <Tooltip content={t('common.edit')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('users.roles.editNamed', { name: role.name })}
            onClick={() => handleEditRole(role)}
          >
            <Edit2 aria-hidden />
          </Button>
        </Tooltip>
        <Tooltip content={canDelete ? t('common.delete') : t('users.roles.error.stillAssigned', { count: held })}>
          {/* A disabled button takes no pointer events, so the tooltip that says
              why sits on a wrapper that does. */}
          <span className="inline-flex" tabIndex={canDelete ? undefined : 0}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('users.roles.deleteNamed', { name: role.name })}
              onClick={() => handleDeleteClick(role)}
              disabled={!canDelete}
              className="hover:text-critical"
            >
              <Trash2 aria-hidden />
            </Button>
          </span>
        </Tooltip>
      </>
    );
  };

  return (
    <div className="grid grid-cols-1 gap-6 font-ui">
      <PageHeader
        title={t('users.roles.title')}
        description={t('users.roles.subtitle')}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            {/* Offered in a read-only support context too: the matrix is a read
                and writes nothing. Withheld while the read failed, because a
                matrix built from no roles would read as "nobody has access". */}
            <Button
              variant="secondary"
              disabled={loadFailed || roles.length === 0}
              onClick={handleExport}
            >
              <Download aria-hidden />
              <span>{t('common.exportExcelShort')}</span>
            </Button>
            {!readOnly && (
              <Button
                onClick={() => {
                  setSelectedRole(undefined);
                  setIsModalOpen(true);
                }}
              >
                <Plus aria-hidden />
                <span>{t('users.roles.new')}</span>
              </Button>
            )}
          </div>
        )}
        className="pb-0"
      />

      {loadFailed && <Alert tone="critical" title={t('users.roles.error.load')} />}

      <section className="grid grid-cols-1 gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-fg">{t('users.roles.yourRolesTitle')}</h2>
        </div>
        <DataTable
          caption={t('users.roles.yourRolesTitle')}
          columns={companyColumns}
          rows={companyRoles}
          getRowId={role => role.id}
          rowActions={!readOnly ? companyActions : undefined}
          rowActionsLabel={t('users.table.actions')}
          emptyState={<EmptyState size="sm" icon={Shield} title={t('users.roles.empty')} description={t('users.roles.yourRolesEmpty')} />}
          className="[&_td]:px-2 sm:[&_td]:px-4 [&_th]:px-2 sm:[&_th]:px-4"
        />
      </section>

      <section className="grid grid-cols-1 gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-fg">{t('users.roles.templatesTitle')}</h2>
          <p className="mt-1 text-sm text-fg-muted">{t('users.roles.templatesSubtitle')}</p>
        </div>
        <DataTable
          caption={t('users.roles.templatesTitle')}
          columns={templateColumns}
          rows={templates}
          getRowId={role => role.id}
          rowActions={templateActions}
          rowActionsLabel={t('users.table.actions')}
          emptyState={<EmptyState size="sm" icon={ShieldCheck} title={t('users.roles.empty')} />}
          className="[&_td]:px-2 sm:[&_td]:px-4 [&_th]:px-2 sm:[&_th]:px-4"
        />
      </section>

      {roles.length > 0 && (
        <Alert tone="brand" role="note" icon={Info} title={t('users.roles.noteTitle')}>
          <ul className="list-inside list-disc space-y-1">
            {/* `admin`, `supervisor` and `editor` inside this sentence are the stored
                role values, so both dictionaries name them verbatim. */}
            <li>{t('users.roles.note.systemUndeletable')}</li>
            <li>{t('users.roles.note.editImpliesView')}</li>
            <li>{t('users.roles.note.immediateEffect')}</li>
          </ul>
        </Alert>
      )}

      <RoleModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedRole(undefined);
        }}
        onSave={handleSaveRole}
        role={selectedRole}
        existingPermissions={selectedRole?.permissions}
        templates={templates}
      />

      <ConfirmDialog
        open={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setRoleToDelete(null);
        }}
        onConfirm={handleDeleteConfirm}
        title={t('users.roles.deleteTitle')}
        description={t('users.roles.deleteConfirm', { name: roleToDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
      />
    </div>
  );
};

export default RolesManagement;
