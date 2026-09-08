import React, { useState, useEffect } from 'react';
import { Plus, CreditCard as Edit2, Trash2, Shield, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Role, RolePermission, RoleWithPermissions } from '../types/role';
import RoleModal from './RoleModal';
import ConfirmationModal from './ConfirmationModal';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

const RolesManagement: React.FC = () => {
  const [roles, setRoles] = useState<RoleWithPermissions[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState<RoleWithPermissions | undefined>();
  const [roleToDelete, setRoleToDelete] = useState<Role | null>(null);
  const { showToast } = useToast();
  const { companyId } = useAuth();

  useEffect(() => {
    fetchRoles();
  }, []);

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
      showToast('error', 'Fehler beim Laden der Rollen');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveRole = async (roleData: Partial<Role>, permissionsData: Partial<RolePermission>[]) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Nicht angemeldet');

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

        showToast('success', 'Rolle erfolgreich aktualisiert');
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

        showToast('success', 'Rolle erfolgreich erstellt');
      }

      await fetchRoles();
      setIsModalOpen(false);
      setSelectedRole(undefined);
    } catch (error: any) {
      console.error('Error saving role:', error);
      throw new Error(error.message || 'Fehler beim Speichern der Rolle');
    }
  };

  const handleEditRole = (role: RoleWithPermissions) => {
    setSelectedRole(role);
    setIsModalOpen(true);
  };

  const handleDeleteClick = (role: Role) => {
    if (role.is_system) {
      showToast('error', 'Systemrollen können nicht gelöscht werden');
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

      showToast('success', 'Rolle erfolgreich gelöscht');
      await fetchRoles();
    } catch (error: any) {
      console.error('Error deleting role:', error);
      showToast('error', error.message || 'Fehler beim Löschen der Rolle');
    } finally {
      setIsDeleteModalOpen(false);
      setRoleToDelete(null);
    }
  };

  const getPermissionsSummary = (permissions: RolePermission[]) => {
    const viewCount = permissions.filter(p => p.can_view).length;
    const editCount = permissions.filter(p => p.can_edit).length;
    return `${viewCount} Ansehen / ${editCount} Bearbeiten`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div style={{ color: 'var(--text-secondary)' }}>Lade Rollen...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Rollenverwaltung</h2>
          <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>
            Verwalten Sie Rollen und deren Berechtigungen
          </p>
        </div>
        <button
          onClick={() => {
            setSelectedRole(undefined);
            setIsModalOpen(true);
          }}
          className="flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors hover:opacity-90"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          <Plus size={20} />
          <span>Neue Rolle</span>
        </button>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)', border: '1px solid var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
              <tr>
                <th className="px-6 py-3 text-left text-sm font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                  Rolle
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                  Beschreibung
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                  Berechtigungen
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                  Typ
                </th>
                <th className="px-6 py-3 text-right text-sm font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                  Aktionen
                </th>
              </tr>
            </thead>
            <tbody>
              {roles.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                    Keine Rollen vorhanden
                  </td>
                </tr>
              ) : (
                roles.map((role) => (
                  <tr key={role.id} className="transition-colors" style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-6 py-4">
                      <div className="flex items-center space-x-2">
                        <Shield style={{ color: 'var(--accent-text)' }} size={20} />
                        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{role.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4" style={{ color: 'var(--text-secondary)' }}>
                      {role.description || '-'}
                    </td>
                    <td className="px-6 py-4" style={{ color: 'var(--text-secondary)' }}>
                      {getPermissionsSummary(role.permissions)}
                    </td>
                    <td className="px-6 py-4">
                      {role.is_system ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium" style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)' }}>
                          System
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>
                          Benutzerdefiniert
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end space-x-2">
                        <button
                          onClick={() => handleEditRole(role)}
                          className="p-2 rounded-lg transition-colors hover:opacity-80"
                          style={{ color: 'var(--accent-text)', background: 'transparent' }}
                          title="Bearbeiten"
                        >
                          <Edit2 size={18} />
                        </button>
                        <button
                          onClick={() => handleDeleteClick(role)}
                          disabled={role.is_system}
                          className="p-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-80"
                          style={{ color: 'var(--danger)', background: 'transparent' }}
                          title={role.is_system ? 'Systemrollen können nicht gelöscht werden' : 'Löschen'}
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {roles.length > 0 && (
        <div className="rounded-lg p-4" style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)' }}>
          <div className="flex items-start space-x-2">
            <AlertCircle style={{ color: 'var(--accent-text)' }} className="flex-shrink-0 mt-0.5" size={20} />
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              <p className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Hinweis:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Systemrollen (admin, supervisor, editor) können nicht gelöscht werden</li>
                <li>Bearbeiten-Berechtigung erfordert automatisch Ansehen-Berechtigung</li>
                <li>Änderungen an Rollen wirken sich sofort auf alle Benutzer mit dieser Rolle aus</li>
              </ul>
            </div>
          </div>
        </div>
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

      <ConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setRoleToDelete(null);
        }}
        onConfirm={handleDeleteConfirm}
        type="confirm"
        title="Rolle löschen"
        message={`Sind Sie sicher, dass Sie die Rolle "${roleToDelete?.name}" löschen möchten? Diese Aktion kann nicht rückgängig gemacht werden.`}
        confirmText="Löschen"
      />
    </div>
  );
};

export default RolesManagement;
