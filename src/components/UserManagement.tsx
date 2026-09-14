import React, { useState, useEffect } from 'react';
import { Plus, CreditCard as Edit, Trash2, User, Users, Mail, Lock, Eye, EyeOff, Save, X, CheckCircle, XCircle, Clock, MailCheck, Download, AlertTriangle, KeyRound, AlertCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import ConfirmationModal from './ConfirmationModal';
import { exportTableToExcel } from '../utils/excelExport';
import { useTranslation } from '../contexts/LanguageContext';

interface UserData {
  id: string;
  email: string;
  full_name?: string;
  role: string;
  role_id?: string | null;
  role_name?: string;
  role_description?: string;
  status?: 'active' | 'inactive' | 'pending_invite';
  invited_at?: string;
  activated_at?: string;
  created_at: string;
  email_confirmed_at?: string;
  must_change_password?: boolean;
}

interface UserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (userData: { email: string; password?: string; full_name: string; role: string; use_temp_password?: boolean }) => Promise<void>;
  user?: UserData;
  title: string;
}

const UserModal: React.FC<UserModalProps> = ({ isOpen, onClose, onSave, user, title }) => {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    full_name: '',
    role: 'viewer',
    use_temp_password: false
  });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [roles, setRoles] = useState<Array<{ id: string; name: string; description: string }>>([]);

  useEffect(() => {
    const fetchRoles = async () => {
      try {
        const { data, error } = await supabase
          .from('roles')
          .select('id, name, description')
          .order('name');

        if (error) throw error;
        setRoles(data || []);
      } catch (error) {
        console.error('Error fetching roles:', error);
      }
    };

    if (isOpen) {
      fetchRoles();
    }
  }, [isOpen]);

  useEffect(() => {
    if (user) {
      setFormData({
        email: user.email,
        password: '',
        full_name: user.full_name || '',
        role: user.role
      });
    } else {
      setFormData({
        email: '',
        password: '',
        full_name: '',
        role: roles.length > 0 ? roles[0].name : 'viewer',
        use_temp_password: false
      });
    }
  }, [user, isOpen, roles]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.email.trim() && formData.full_name.trim()) {
      // Validate temp password if enabled
      if (!user && formData.use_temp_password && formData.password.trim().length < 8) {
        return;
      }
      setLoading(true);
      try {
        if (user) {
          // For editing, only include password if it's provided
          await onSave(formData.password ? formData : { ...formData, password: undefined, use_temp_password: undefined });
        } else {
          // For new users with temp password, send password; otherwise strip it
          if (formData.use_temp_password) {
            await onSave(formData);
          } else {
            const { password, use_temp_password, ...dataWithoutPassword } = formData;
            await onSave(dataWithoutPassword);
          }
        }
      } finally {
        setLoading(false);
      }
    }
  };

  if (!isOpen) return null;

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-subtle)',
    border: '1px solid var(--border)',
    borderRadius: '0.375rem',
    color: 'var(--text-primary)',
    fontSize: '0.875rem',
    padding: '0.5rem 0.75rem',
    outline: 'none',
    width: '100%',
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)', borderRadius: '0.5rem' }} className="w-full max-w-md">
        <div className="flex items-center justify-between p-6" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-xl font-semibold flex items-center space-x-2" style={{ color: 'var(--text-primary)' }}>
            <User size={20} />
            <span>{title}</span>
          </h2>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-tertiary)' }}
            className="transition-colors hover:opacity-70"
          >
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              {t('users.form.fullName')}
            </label>
            <input
              type="text"
              value={formData.full_name}
              onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
              style={inputStyle}
              placeholder={t('users.form.fullNamePlaceholder')}
              required
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              {t('users.form.email')}
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} size={16} />
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                style={{ ...inputStyle, paddingLeft: '2.25rem' }}
                placeholder={t('users.form.emailPlaceholder')}
                required
                disabled={loading}
              />
            </div>
          </div>

          {!user && (
            <div className="space-y-3">
              <div className="flex items-center space-x-2">
                <input
                  type="radio"
                  id="mode-email"
                  name="creation-mode"
                  value="email"
                  checked={!formData.use_temp_password}
                  onChange={() => setFormData({ ...formData, use_temp_password: false, password: '' })}
                  disabled={loading}
                  className="h-4 w-4"
                />
                <label htmlFor="mode-email" className="text-sm font-medium flex items-center space-x-1" style={{ color: 'var(--text-primary)' }}>
                  <MailCheck size={16} style={{ color: 'var(--accent-text)' }} />
                  <span>{t('users.invite.byEmail')}</span>
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="radio"
                  id="mode-temp"
                  name="creation-mode"
                  value="temp"
                  checked={formData.use_temp_password}
                  onChange={() => setFormData({ ...formData, use_temp_password: true })}
                  disabled={loading}
                  className="h-4 w-4"
                />
                <label htmlFor="mode-temp" className="text-sm font-medium flex items-center space-x-1" style={{ color: 'var(--text-primary)' }}>
                  <Lock size={16} style={{ color: 'var(--warning)' }} />
                  <span>{t('users.invite.tempPassword')}</span>
                </label>
              </div>

              {!formData.use_temp_password ? (
                <div style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)', borderRadius: '0.375rem', padding: '1rem' }}>
                  <div className="flex items-start space-x-2">
                    <MailCheck style={{ color: 'var(--accent-text)' }} className="mt-0.5 flex-shrink-0" size={18} />
                    <div>
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('users.invite.byEmail')}</p>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                        {t('users.invite.byEmailHint')}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                      {t('users.invite.tempPassword')}
                    </label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} size={16} />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        style={{ ...inputStyle, paddingLeft: '2.25rem', paddingRight: '2.25rem' }}
                        placeholder={t('users.invite.tempPasswordPlaceholder')}
                        required={formData.use_temp_password}
                        minLength={8}
                        disabled={loading}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 transform -translate-y-1/2"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-start space-x-2" style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)', borderRadius: '0.375rem', padding: '0.75rem' }}>
                    <AlertTriangle style={{ color: 'var(--warning)' }} className="mt-0.5 flex-shrink-0" size={16} />
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {t('users.invite.firstLoginChangeHint')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              {t('users.form.role')}
            </label>
            <select
              value={formData.role}
              onChange={(e) => setFormData({ ...formData, role: e.target.value })}
              style={inputStyle}
              disabled={loading}
            >
              {roles.map((role) => (
                <option key={role.id} value={role.name}>
                  {role.name} {role.description && `- ${role.description}`}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', borderRadius: '0.375rem', padding: '0.5rem 1rem' }}
              className="transition-colors hover:opacity-80 disabled:opacity-50"
              disabled={loading}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              style={{ background: 'var(--accent)', color: 'white', borderRadius: '0.375rem', padding: '0.5rem 1rem' }}
              className="transition-colors hover:opacity-90 flex items-center space-x-2 disabled:opacity-50"
              disabled={loading}
            >
              {loading ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              ) : (
                <Save size={16} />
              )}
              <span>{loading ? t('common.saving') : t('common.save')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

const UserManagement: React.FC = () => {
  const { t } = useTranslation();
  const { isAdmin, profile, loading: authLoading } = useAuth();
  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserData | undefined>();
  const [resetPasswordUser, setResetPasswordUser] = useState<UserData | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordLoading, setResetPasswordLoading] = useState(false);
  const [resetPasswordError, setResetPasswordError] = useState('');
  const [resetPasswordSuccess, setResetPasswordSuccess] = useState(false);
  // The reset-password dialog's eye toggle read `showPassword` from UserModal,
  // a different component, so opening the dialog threw a ReferenceError during
  // render and took the whole user list down with it. Same name, own state.
  const [showResetPassword, setShowResetPassword] = useState(false);
  // `type` was inferred as the literal 'confirm', so every success and error
  // dialog below was a type error the build never checked.
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    type: 'confirm' as 'confirm' | 'success' | 'error' | 'info'
  });

  // The debug logging and the "connectivity test" that used to run here printed
  // session details, and handleAddUser printed the new user's password, to the
  // browser console of every administrator. Nothing read either.
  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin, authLoading]);

  const loadUsers = async () => {
    setLoading(true);
    try {
      // Use edge function to list users
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('No active session');
      }

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/list`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to load users');
      }

      const data = await response.json();
      
      setUsers(data);
    } catch (error) {
      console.error('Error loading users:', error);
      setConfirmModal({
        isOpen: true,
        title: t('common.error'),
        message: t('users.error.loadUsers'),
        onConfirm: () => {},
        type: 'error' as const
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAddUser = async (userData: { email: string; password?: string; full_name: string; role: string; use_temp_password?: boolean }) => {
    try {
      // Use edge function to create user
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('No active session');
      }

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/create`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(userData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create user');
      }

      setConfirmModal({
        isOpen: true,
        title: t('users.successTitle'),
        message: userData.use_temp_password
          ? t('users.created.tempPassword', { name: userData.full_name })
          : t('users.created.invited', { name: userData.full_name }),
        onConfirm: () => {},
        type: 'success' as const
      });

      setIsModalOpen(false);
      loadUsers(); // Reload the user list
    } catch (error) {
      console.error('Error adding user:', error);
      setConfirmModal({
        isOpen: true,
        title: t('common.error'),
        // The interpolated detail can be a manage-users response message, which the
        // server already returns in German.
        message: t('users.error.create', { error: error instanceof Error ? error.message : t('users.error.unknown') }),
        onConfirm: () => {},
        type: 'error' as const
      });
    }
  };

  const handleEditUser = async (userData: { email: string; password: string; full_name: string; role: string }) => {
    if (!editingUser) return;

    try {
      // Use edge function to update user
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('No active session');
      }

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/update`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_id: editingUser.id,
          email: userData.email !== editingUser.email ? userData.email : undefined,
          password: userData.password.trim() ? userData.password : undefined,
          full_name: userData.full_name,
          role: userData.role
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update user');
      }

      const result = await response.json();

      setConfirmModal({
        isOpen: true,
        title: t('users.successTitle'),
        message: t('users.updated', { name: userData.full_name }),
        onConfirm: () => {},
        type: 'success' as const
      });

      setIsModalOpen(false);
      setEditingUser(undefined);
      loadUsers();
    } catch (error) {
      console.error('Error editing user:', error);
      setConfirmModal({
        isOpen: true,
        title: t('common.error'),
        message: t('users.error.unexpected'),
        onConfirm: () => {},
        type: 'error' as const
      });
    }
  };

  const handleResetPassword = (user: UserData) => {
    setResetPasswordUser(user);
    setResetPasswordValue('');
    setResetPasswordError('');
    setResetPasswordSuccess(false);
  };

  const closeResetPasswordModal = () => {
    setResetPasswordUser(null);
    setResetPasswordValue('');
    setResetPasswordError('');
    setResetPasswordSuccess(false);
    setResetPasswordLoading(false);
  };

  const submitResetPassword = async () => {
    if (!resetPasswordUser) return;
    if (resetPasswordValue.length < 8) {
      setResetPasswordError(t('users.password.minLength'));
      return;
    }
    setResetPasswordLoading(true);
    setResetPasswordError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No active session');
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/reset-password`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: resetPasswordUser.id, password: resetPasswordValue }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || t('users.error.resetPassword'));
      }
      setResetPasswordSuccess(true);
      await loadUsers();
      setTimeout(() => closeResetPasswordModal(), 1500);
    } catch (err) {
      // `err.message` here is the manage-users response text, which is German already.
      setResetPasswordError(err instanceof Error ? err.message : t('users.error.generic'));
    } finally {
      setResetPasswordLoading(false);
    }
  };

  const handleDeleteUser = (user: UserData) => {
    setConfirmModal({
      isOpen: true,
      title: t('users.delete.title'),
      message: t('users.delete.confirm', { name: user.full_name ?? '', email: user.email }),
      onConfirm: async () => {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            throw new Error('No active session');
          }

          const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/delete`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${session.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ user_id: user.id }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to delete user');
          }

          setConfirmModal({
            isOpen: true,
            title: t('users.successTitle'),
            message: t('users.deleted', { name: user.full_name ?? '' }),
            onConfirm: () => {},
            type: 'success' as const
          });

          loadUsers(); // Reload the user list
        } catch (error) {
          console.error('Error deleting user:', error);
          setConfirmModal({
            isOpen: true,
            title: t('common.error'),
            message: t('users.error.delete', { error: error instanceof Error ? error.message : t('users.error.unknown') }),
            onConfirm: () => {},
            type: 'error' as const
          });
        }
      },
      type: 'confirm' as const
    });
  };

  const handleActivateDeactivate = async (userId: string, newStatus: 'active' | 'inactive') => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No active session');

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/activate-deactivate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: userId, status: newStatus }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Status update failed');
      }

      setConfirmModal({
        isOpen: true,
        title: t('users.successTitle'),
        message: newStatus === 'active' ? t('users.status.activated') : t('users.status.deactivated'),
        onConfirm: () => {},
        type: 'success' as const
      });

      await loadUsers();
    } catch (error) {
      setConfirmModal({
        isOpen: true,
        title: t('common.error'),
        message: t('users.error.statusChange', { error: error instanceof Error ? error.message : t('users.error.unknown') }),
        onConfirm: () => {},
        type: 'error' as const
      });
    }
  };

  const handleResendInvite = async (userId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No active session');

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/resend-invite`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: userId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Resend invite failed');
      }

      setConfirmModal({
        isOpen: true,
        title: t('users.successTitle'),
        message: t('users.invite.resent'),
        onConfirm: () => {},
        type: 'success' as const
      });

      await loadUsers();
    } catch (error) {
      setConfirmModal({
        isOpen: true,
        title: t('common.error'),
        message: t('users.error.resendInvite', { error: error instanceof Error ? error.message : t('users.error.unknown') }),
        onConfirm: () => {},
        type: 'error' as const
      });
    }
  };

  const getStatusBadge = (status?: string, mustChangePassword?: boolean) => {
    if (mustChangePassword) {
      return (
        <span className="px-2 py-1 text-xs font-medium rounded-full flex items-center space-x-1" style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
          <KeyRound size={12} />
          <span>{t('users.badge.passwordChangeRequired')}</span>
        </span>
      );
    }
    if (status === 'inactive') {
      return (
        <span className="px-2 py-1 text-xs font-medium rounded-full flex items-center space-x-1" style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)' }}>
          <XCircle size={12} />
          <span>{t('users.badge.inactive')}</span>
        </span>
      );
    }
    if (status === 'pending_invite') {
      return (
        <span className="px-2 py-1 text-xs font-medium rounded-full flex items-center space-x-1" style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
          <Clock size={12} />
          <span>{t('users.badge.pendingInvite')}</span>
        </span>
      );
    }
    return (
      <span className="px-2 py-1 text-xs font-medium rounded-full flex items-center space-x-1" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>
        <CheckCircle size={12} />
        <span>{t('users.badge.active')}</span>
      </span>
    );
  };

  const getRoleBadge = (user: UserData) => {
    // The keys below are the stored `user_profiles.role` values that RLS policies
    // match on, not labels — and the badge shows the role verbatim because a custom
    // role's name is free text from the `roles` table. Nothing here is translatable.
    const roleStyles: Record<string, React.CSSProperties> = {
      admin: { background: 'var(--danger-subtle)', color: 'var(--danger)' },
      supervisor: { background: 'var(--warning-subtle)', color: 'var(--warning)' },
      editor: { background: 'var(--accent-subtle)', color: 'var(--accent-text)' },
      viewer: { background: 'var(--bg-muted)', color: 'var(--text-secondary)' },
    };

    const roleName = user.role_name || user.role || 'viewer';
    const roleKey = (user.role || 'viewer').toLowerCase();
    const roleStyle = roleStyles[roleKey as keyof typeof roleStyles] || { background: 'var(--success-subtle)', color: 'var(--success)' };

    return (
      <span className="px-2 py-1 text-xs font-medium rounded-full" style={roleStyle}>
        {roleName}
      </span>
    );
  };

  if (authLoading) {
    return (
      <div className="text-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 mx-auto mb-4" style={{ borderBottom: '2px solid var(--accent)', border: '2px solid var(--border)', borderBottomColor: 'var(--accent)' }}></div>
        <p style={{ color: 'var(--text-secondary)' }}>{t('users.checkingPermissions')}</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="text-center py-12">
        <div className="rounded-full p-6 w-24 h-24 mx-auto mb-4 flex items-center justify-center" style={{ background: 'var(--danger-subtle)' }}>
          <User className="h-12 w-12" style={{ color: 'var(--danger)' }} />
        </div>
        <h3 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{t('users.accessDenied')}</h3>
        <p style={{ color: 'var(--text-secondary)' }}>{t('users.adminOnly')}</p>
        <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>{t('users.yourRole', { role: profile?.role || t('users.roleNone') })}</p>
      </div>
    );
  }

  const handleExport = () => {
    // A user list is not one of the four statutory artefacts, so its headers
    // follow the UI language — see the closed list in i18n/index.ts. The German
    // filename slug matches what WerkstattPage and BargeldbestandPage already
    // write, and the date format stays de-DE like every other figure.
    exportTableToExcel({
      filename: `benutzer_${new Date().toISOString().split('T')[0]}`,
      sheetTitle: t('users.export.sheetTitle'),
      moduleName: t('nav.users'),
      columns: [
        { key: 'full_name',   label: t('users.export.name'),       width: 28 },
        { key: 'email',       label: t('auth.email'),              width: 34 },
        { key: 'role',        label: t('users.export.systemRole'), width: 16 },
        { key: 'role_name',   label: t('users.export.customRole'), width: 24 },
        { key: 'status',      label: t('common.status'),           width: 16, format: v => ({
          active:         t('overview.status.active'),
          inactive:       t('overview.status.inactive'),
          pending_invite: t('users.badge.pendingInvite'),
        }[v as string] ?? String(v ?? '')) },
        { key: 'created_at',  label: t('users.export.createdAt'),  width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '' },
      ],
      rows: users as unknown as Record<string, unknown>[],
      totals: { full_name: t('users.export.totalRow', { count: users.length }) },
    });
  };

  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 mx-auto mb-4" style={{ border: '2px solid var(--border)', borderBottomColor: 'var(--accent)' }}></div>
        <p style={{ color: 'var(--text-secondary)' }}>{t('users.loadingUsers')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 rounded-xl shadow-lg p-6 text-white">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center space-y-4 sm:space-y-0">
          <div>
            <div className="flex items-center space-x-3 mb-2">
              <div className="bg-white bg-opacity-20 rounded-lg p-2">
                <Users className="text-white" size={32} />
              </div>
              <div>
                <h1 className="text-3xl font-bold">{t('users.title')}</h1>
                <p className="text-blue-100 mt-1">{t('users.subtitle')}</p>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <button
              onClick={handleExport}
              className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium bg-white bg-opacity-20 hover:bg-opacity-30 text-white transition-all"
              title={t('common.exportExcelShort')}
            >
              <Download size={16} />
              <span>Excel</span>
            </button>
            <button
              onClick={() => setIsModalOpen(true)}
              className="px-6 py-3 bg-white text-blue-600 rounded-lg hover:bg-blue-50 transition-all duration-200 flex items-center space-x-2 shadow-md font-semibold hover:shadow-lg transform hover:-translate-y-0.5"
            >
              <Plus size={18} />
              <span>{t('users.newUser')}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Statistics */}
      <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)', border: '1px solid var(--border)' }}>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="text-center">
            <div className="rounded-full p-4 w-16 h-16 mx-auto mb-3 flex items-center justify-center" style={{ background: 'var(--accent-subtle)' }}>
              <Users style={{ color: 'var(--accent-text)' }} size={24} />
            </div>
            <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{users.length}</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('users.stats.total')}</p>
          </div>
          <div className="text-center">
            <div className="rounded-full p-4 w-16 h-16 mx-auto mb-3 flex items-center justify-center" style={{ background: 'var(--success-subtle)' }}>
              <User style={{ color: 'var(--success)' }} size={24} />
            </div>
            <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{users.filter(u => u.email_confirmed_at).length}</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('users.stats.confirmed')}</p>
          </div>
          <div className="text-center">
            <div className="rounded-full p-4 w-16 h-16 mx-auto mb-3 flex items-center justify-center" style={{ background: 'var(--danger-subtle)' }}>
              <User style={{ color: 'var(--danger)' }} size={24} />
            </div>
            <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{users.filter(u => u.role === 'admin').length}</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('users.stats.admins')}</p>
          </div>
          <div className="text-center">
            <div className="rounded-full p-4 w-16 h-16 mx-auto mb-3 flex items-center justify-center" style={{ background: 'var(--warning-subtle)' }}>
              <User style={{ color: 'var(--warning)' }} size={24} />
            </div>
            <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{users.filter(u => u.role === 'viewer').length}</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('users.stats.viewers')}</p>
          </div>
        </div>
      </div>

      {/* Users List */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)' }}>
        {users.length === 0 ? (
          <div className="text-center py-16">
            <div className="rounded-full p-6 w-24 h-24 mx-auto mb-4 flex items-center justify-center" style={{ background: 'var(--bg-muted)' }}>
              <Users className="h-12 w-12" style={{ color: 'var(--text-tertiary)' }} />
            </div>
            <h3 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{t('users.empty.title')}</h3>
            <p className="mb-6 max-w-md mx-auto" style={{ color: 'var(--text-secondary)' }}>
              {t('users.empty.hint')}
            </p>
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block">
              <table className="w-full">
                <thead style={{ background: 'var(--bg-subtle)' }}>
                  <tr>
                    <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                      {t('users.table.user')}
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                      {t('users.table.email')}
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                      {t('users.form.role')}
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                      {t('common.status')}
                    </th>
                    <th className="px-6 py-4 text-right text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                      {t('users.table.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="transition-all duration-200" style={{ borderTop: '1px solid var(--border)' }}>
                      <td className="px-6 py-5 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-10 w-10">
                            <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center shadow-md">
                              <User className="h-5 w-5 text-white" />
                            </div>
                          </div>
                          <div className="ml-4">
                            <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                              {user.full_name || t('common.unknown')}
                            </div>
                            <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                              ID: {user.id.slice(0, 8)}...
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-5 whitespace-nowrap">
                        <div className="text-sm" style={{ color: 'var(--text-primary)' }}>{user.email}</div>
                      </td>
                      <td className="px-6 py-5 whitespace-nowrap">
                        {getRoleBadge(user)}
                      </td>
                      <td className="px-6 py-5 whitespace-nowrap">
                        {getStatusBadge(user.status)}
                      </td>
                      <td className="px-6 py-5 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex justify-end space-x-2">
                          {user.status === 'pending_invite' && (
                            <button
                              onClick={() => handleResendInvite(user.id)}
                              className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                              style={{ color: 'var(--accent-text)', background: 'transparent' }}
                              title={t('users.action.resendInvite')}
                            >
                              <MailCheck size={18} />
                            </button>
                          )}
                          {user.status === 'active' && user.email !== 'support@yamobility.de' && (
                            <button
                              onClick={() => handleActivateDeactivate(user.id, 'inactive')}
                              className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                              style={{ color: 'var(--warning)', background: 'transparent' }}
                              title={t('users.action.deactivate')}
                            >
                              <XCircle size={18} />
                            </button>
                          )}
                          {user.status === 'inactive' && (
                            <button
                              onClick={() => handleActivateDeactivate(user.id, 'active')}
                              className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                              style={{ color: 'var(--success)', background: 'transparent' }}
                              title={t('users.action.activate')}
                            >
                              <CheckCircle size={18} />
                            </button>
                          )}
                          <button
                            onClick={() => {
                              setEditingUser(user);
                              setIsModalOpen(true);
                            }}
                            className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                            style={{ color: 'var(--accent-text)', background: 'transparent' }}
                            title={t('common.edit')}
                          >
                            <Edit size={18} />
                          </button>
                          {user.email !== 'support@yamobility.de' && (
                            <button
                              onClick={() => handleDeleteUser(user)}
                              className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                              style={{ color: 'var(--danger)', background: 'transparent' }}
                              title={t('common.delete')}
                            >
                              <Trash2 size={18} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden">
              {users.map((user) => (
                <div key={user.id} className="p-6 transition-all duration-200" style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-3">
                      <div className="flex-shrink-0 h-12 w-12">
                        <div className="h-12 w-12 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center shadow-md">
                          <User className="h-6 w-6 text-white" />
                        </div>
                      </div>
                      <div>
                        <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {user.full_name || t('common.unknown')}
                        </div>
                        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{user.email}</div>
                      </div>
                    </div>
                    <div className="flex space-x-2">
                      {user.status === 'pending_invite' && (
                        <button
                          onClick={() => handleResendInvite(user.id)}
                          className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                          style={{ color: 'var(--accent-text)', background: 'transparent' }}
                          title={t('users.action.resendInvite')}
                        >
                          <MailCheck size={18} />
                        </button>
                      )}
                      {user.status === 'active' && user.email !== 'support@yamobility.de' && (
                        <button
                          onClick={() => handleActivateDeactivate(user.id, 'inactive')}
                          className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                          style={{ color: 'var(--warning)', background: 'transparent' }}
                          title={t('users.action.deactivate')}
                        >
                          <XCircle size={18} />
                        </button>
                      )}
                      {user.status === 'inactive' && (
                        <button
                          onClick={() => handleActivateDeactivate(user.id, 'active')}
                          className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                          style={{ color: 'var(--success)', background: 'transparent' }}
                          title={t('users.action.activate')}
                        >
                          <CheckCircle size={18} />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setEditingUser(user);
                          setIsModalOpen(true);
                        }}
                        className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                        style={{ color: 'var(--accent-text)', background: 'transparent' }}
                      >
                        <Edit size={18} />
                      </button>
                      {user.email !== 'support@yamobility.de' && (
                        <button
                          onClick={() => handleResetPassword(user)}
                          className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                          style={{ color: 'var(--warning)', background: 'transparent' }}
                          title={t('users.action.resetPassword')}
                        >
                          <KeyRound size={18} />
                        </button>
                      )}
                      {user.email !== 'support@yamobility.de' && (
                        <button
                          onClick={() => handleDeleteUser(user)}
                          className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                          style={{ color: 'var(--danger)', background: 'transparent' }}
                        >
                          <Trash2 size={18} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3">
                    <div className="flex items-center space-x-2">
                      {getRoleBadge(user)}
                      {getStatusBadge(user.status, user.must_change_password)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* User Modal */}
      <UserModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingUser(undefined);
        }}
        onSave={editingUser ? handleEditUser : handleAddUser}
        user={editingUser}
        title={editingUser ? t('users.editUser') : t('users.newUser')}
      />

      {/* Confirmation Modal */}
      <ConfirmationModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        message={confirmModal.message}
        type={confirmModal.type}
      />

      {/* Reset Password Modal */}
      {resetPasswordUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={closeResetPasswordModal}>
          <div className="w-full max-w-md rounded-2xl p-6" style={{ background: 'var(--surface)' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('users.action.resetPassword')}</h3>
              <button onClick={closeResetPasswordModal} className="p-1 rounded-lg" style={{ color: 'var(--text-tertiary)' }}>
                <X size={20} />
              </button>
            </div>
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
              {t('users.resetPassword.forUser')}{' '}
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{resetPasswordUser.email}</span>
            </p>
            {resetPasswordSuccess ? (
              <div className="flex items-center space-x-2 p-3 rounded-lg" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>
                <CheckCircle size={18} />
                <span className="text-sm">{t('users.resetPassword.success')}</span>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    {t('users.resetPassword.label')}
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} size={16} />
                    <input
                      type={showResetPassword ? 'text' : 'password'}
                      value={resetPasswordValue}
                      onChange={(e) => setResetPasswordValue(e.target.value)}
                      className="w-full pl-10 pr-10 py-2 rounded-lg"
                      style={{ background: 'var(--surface-hover)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      placeholder={t('users.password.minLengthPlaceholder')}
                      minLength={8}
                      disabled={resetPasswordLoading}
                    />
                    <button
                      type="button"
                      onClick={() => setShowResetPassword(!showResetPassword)}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {showResetPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div className="flex items-start space-x-2" style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)', borderRadius: '0.375rem', padding: '0.75rem' }}>
                  <AlertTriangle style={{ color: 'var(--warning)' }} className="mt-0.5 flex-shrink-0" size={16} />
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {t('users.resetPassword.nextLoginHint')}
                  </p>
                </div>
                {resetPasswordError && (
                  <div className="flex items-center space-x-2 p-3 rounded-lg" style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}>
                    <AlertCircle size={16} />
                    <span className="text-sm">{resetPasswordError}</span>
                  </div>
                )}
                <div className="flex space-x-2">
                  <button
                    onClick={closeResetPasswordModal}
                    className="flex-1 py-2 px-4 rounded-lg font-medium"
                    style={{ background: 'var(--surface-hover)', color: 'var(--text-secondary)' }}
                    disabled={resetPasswordLoading}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={submitResetPassword}
                    className="flex-1 py-2 px-4 rounded-lg font-medium flex items-center justify-center space-x-2"
                    style={{ background: 'var(--warning)', color: 'white' }}
                    disabled={resetPasswordLoading || resetPasswordValue.length < 8}
                  >
                    {resetPasswordLoading ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                    ) : (
                      <>
                        <KeyRound size={16} />
                        <span>{t('users.action.resetPassword')}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default UserManagement;