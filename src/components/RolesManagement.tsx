import React, { useState, useEffect } from 'react';
import { Plus, CreditCard as Edit2, Trash2, Shield, Info } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Role, RolePermission, RoleWithPermissions } from '../types/role';
import RoleModal from './RoleModal';
import { useToast } from '../contexts/ToastContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { Alert, Badge, Button, ConfirmDialog, DataTable, EmptyState, PageHeader, Skeleton, Tooltip, type DataTableColumn } from './ui';

const RolesManagement: React.FC = () => {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<RoleWithPermissions[]>([]);
  const [loading, setLoading] = useState(true);
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

      const { data: rolesData, error: rolesError } = await supabase
        .from('roles')
        .select('*')
        .order('name');

      if (rolesError) throw rolesError;

      const { data: permissionsData, error: permissionsError } = await supabase
        .from('role_permissions')
        .select('*');

      if (permissionsError) throw permissionsError;

      const rolesWithPermissions: RoleWithPermissions[] = (rolesData || []).map(role => ({
        ...role,
        permissions: (permissionsData || []).filter(p => p.role_id === role.id),
      }));

      setRoles(rolesWithPermissions);
    } catch (error: any) {
      console.error('Error fetching roles:', error);
      showToast('error', t('users.roles.error.load'));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveRole = async (roleData: Partial<Role>, permissionsData: Partial<RolePermission>[]) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t('users.notSignedIn'));

      if (roleData.id) {
        const { error: updateError } = await supabase
          .from('roles')
          .update({
            name: roleData.name,
            description: roleData.description,
          })
          .eq('id', roleData.id);

        if (updateError) throw updateError;

        const { error: deletePermsError } = await supabase
          .from('role_permissions')
          .delete()
          .eq('role_id', roleData.id);

        if (deletePermsError) throw deletePermsError;

        const permsToInsert = permissionsData.map(p => ({
          role_id: roleData.id,
          page_key: p.page_key!,
          can_view: p.can_view!,
          can_edit: p.can_edit!,
        }));

        const { error: insertPermsError } = await supabase
          .from('role_permissions')
          .insert(permsToInsert);

        if (insertPermsError) throw insertPermsError;

        showToast('success', t('users.roles.updated'));
      } else {
        const { data: newRole, error: insertError } = await supabase
          .from('roles')
          .insert({
            name: roleData.name,
            description: roleData.description,
            is_system: false,
            created_by: user.id,
            company_id: companyId,
          })
          .select()
          .single();

        if (insertError) throw insertError;

        const permsToInsert = permissionsData.map(p => ({
          role_id: newRole.id,
          page_key: p.page_key!,
          can_view: p.can_view!,
          can_edit: p.can_edit!,
        }));

        const { error: insertPermsError } = await supabase
          .from('role_permissions')
          .insert(permsToInsert);

        if (insertPermsError) throw insertPermsError;

        showToast('success', t('users.roles.created'));
      }

      await fetchRoles();
      setIsModalOpen(false);
      setSelectedRole(undefined);
    } catch (error: any) {
      console.error('Error saving role:', error);
      throw new Error(error.message || t('users.roles.error.save'));
    }
  };

  const handleEditRole = (role: RoleWithPermissions) => {
    setSelectedRole(role);
    setIsModalOpen(true);
  };

  const handleDeleteClick = (role: Role) => {
    if (role.is_system) {
      showToast('error', t('users.roles.systemCannotDelete'));
      return;
    }
    setRoleToDelete(role);
    setIsDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!roleToDelete) return;

    try {
      const { error } = await supabase
        .from('roles')
        .delete()
        .eq('id', roleToDelete.id);

      if (error) throw error;

      showToast('success', t('users.roles.deleted'));
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged: the roles and their permissions as the
  // database answers them for the session's company, the save that replaces a
  // role's permissions, the refusal to delete a system role, and the delete.
  // In a read context (`readOnly`) no write control is offered, as before.

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

  const columns: DataTableColumn<RoleWithPermissions>[] = [
    {
      id: 'name',
      header: t('users.form.role'),
      value: role => role.name,
      cell: role => (
        <span className="flex items-center gap-2 font-medium">
          <Shield aria-hidden className="size-4 shrink-0 text-brand-text" />
          {role.name}
        </span>
      ),
    },
    {
      id: 'description',
      header: t('common.description'),
      value: role => role.description,
      cell: role => <span className="text-fg-muted">{role.description || '-'}</span>,
      hideBelow: 'md',
    },
    {
      id: 'permissions',
      header: t('users.roles.permissions'),
      cell: role => <span className="text-fg-muted">{getPermissionsSummary(role.permissions)}</span>,
      hideBelow: 'sm',
    },
    {
      id: 'type',
      header: t('users.roles.type'),
      cell: role => (
        role.is_system ? (
          <Badge tone="neutral">{t('users.roles.typeSystem')}</Badge>
        ) : (
          <Badge tone="positive">{t('users.roles.typeCustom')}</Badge>
        )
      ),
      hideBelow: 'sm',
    },
  ];

  const rowActions = (role: RoleWithPermissions) => (
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
      <Tooltip content={role.is_system ? t('users.roles.systemCannotDelete') : t('common.delete')}>
        {/* A disabled button takes no pointer events, so the tooltip that says
            why sits on a wrapper that does. */}
        <span className="inline-flex" tabIndex={role.is_system ? 0 : undefined}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('users.roles.deleteNamed', { name: role.name })}
            onClick={() => handleDeleteClick(role)}
            disabled={role.is_system}
            className="hover:text-critical"
          >
            <Trash2 aria-hidden />
          </Button>
        </span>
      </Tooltip>
    </>
  );

  return (
    <div className="grid grid-cols-1 gap-6 font-ui">
      <PageHeader
        title={t('users.roles.title')}
        description={t('users.roles.subtitle')}
        actions={!readOnly && (
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
        className="pb-0"
      />

      <DataTable
        caption={t('users.roles.title')}
        columns={columns}
        rows={roles}
        getRowId={role => role.id}
        rowActions={!readOnly ? rowActions : undefined}
        rowActionsLabel={t('users.table.actions')}
        emptyState={<EmptyState size="sm" icon={Shield} title={t('users.roles.empty')} />}
        className="[&_td]:px-2 sm:[&_td]:px-4 [&_th]:px-2 sm:[&_th]:px-4"
      />

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
