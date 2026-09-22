import React, { useState, useEffect } from 'react';
import { Plus, CreditCard as Edit, Trash2, User, Users, Mail, Lock, Eye, EyeOff, Save, CheckCircle, XCircle, Clock, MailCheck, Download, KeyRound, ShieldAlert, UserCheck, UserCog, UserX } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { supabase } from '../lib/supabase';
import { exportTableToExcel } from '../utils/excelExport';
import { useTranslation } from '../contexts/LanguageContext';
import { formatOtpMessage } from '../lib/otpClient';
import { inviteCreateFailure, resendInviteOutcome } from '../lib/accountFunctionResponses';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  KpiCard,
  MessageDialog,
  NativeSelect,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Tooltip,
  cn,
  type DataTableColumn,
} from './ui';

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
  /*
    Both are answered by `manage-users/list` and were not declared here, so the
    screen could not tell one company's accounts from another's — which is why
    it showed every one of them to a platform account. `is_super_admin` is the
    profile flag: a routing hint, never a right, and the reason a platform
    account has no business in a customer's user list.
  */
  company_id?: string | null;
  is_super_admin?: boolean;
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the form's behaviour and is unchanged: the role list,
  // the reset on open, and what handleSubmit sends — the password only with a
  // temporary one. Below it is a sheet on the design system. Escape and the
  // close button close it, as the × did; a click beside it does not, so a
  // stray click cannot throw away a typed form.

  return (
    <Sheet open onOpenChange={next => { if (!next) onClose(); }}>
      <SheetContent onInteractOutside={event => event.preventDefault()}>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <User aria-hidden className="size-5 text-fg-subtle" />
              <span>{title}</span>
            </SheetTitle>
            <SheetDescription>{t('users.subtitle')}</SheetDescription>
          </SheetHeader>

          <SheetBody className="grid content-start gap-5">
            <Field label={t('users.form.fullName')}>
              <Input
                type="text"
                value={formData.full_name}
                onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                placeholder={t('users.form.fullNamePlaceholder')}
                required
                disabled={loading}
              />
            </Field>

            <Field label={t('users.form.email')}>
              <div className="relative">
                <Mail aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="pl-9"
                  placeholder={t('users.form.emailPlaceholder')}
                  required
                  disabled={loading}
                />
              </div>
            </Field>

            {!user && (
              <div className="grid gap-3">
                <div className="flex min-h-9 items-center gap-2.5 [@media(pointer:coarse)]:min-h-11">
                  <input
                    type="radio"
                    id="mode-email"
                    name="creation-mode"
                    value="email"
                    checked={!formData.use_temp_password}
                    onChange={() => setFormData({ ...formData, use_temp_password: false, password: '' })}
                    disabled={loading}
                    className="size-4 shrink-0 accent-brand [@media(pointer:coarse)]:size-5"
                  />
                  <label htmlFor="mode-email" className="flex items-center gap-1.5 text-sm font-medium text-fg">
                    <MailCheck aria-hidden className="size-4 text-brand-text" />
                    <span>{t('users.invite.byEmail')}</span>
                  </label>
                </div>
                <div className="flex min-h-9 items-center gap-2.5 [@media(pointer:coarse)]:min-h-11">
                  <input
                    type="radio"
                    id="mode-temp"
                    name="creation-mode"
                    value="temp"
                    checked={formData.use_temp_password}
                    onChange={() => setFormData({ ...formData, use_temp_password: true })}
                    disabled={loading}
                    className="size-4 shrink-0 accent-brand [@media(pointer:coarse)]:size-5"
                  />
                  <label htmlFor="mode-temp" className="flex items-center gap-1.5 text-sm font-medium text-fg">
                    <Lock aria-hidden className="size-4 text-caution" />
                    <span>{t('users.invite.tempPassword')}</span>
                  </label>
                </div>

                {!formData.use_temp_password ? (
                  <Alert tone="brand" role="note" icon={MailCheck} title={t('users.invite.byEmail')}>
                    {t('users.invite.byEmailHint')}
                  </Alert>
                ) : (
                  <div className="grid gap-3">
                    <Field label={t('users.invite.tempPassword')}>
                      <div className="relative">
                        <Lock aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                        <Input
                          type={showPassword ? 'text' : 'password'}
                          value={formData.password}
                          onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                          className="pl-9 pr-11"
                          placeholder={t('users.invite.tempPasswordPlaceholder')}
                          required={formData.use_temp_password}
                          minLength={8}
                          disabled={loading}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setShowPassword(!showPassword)}
                          aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                          className="absolute right-0.5 top-1/2 -translate-y-1/2"
                        >
                          {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                        </Button>
                      </div>
                    </Field>
                    <Alert tone="caution" role="note">
                      {t('users.invite.firstLoginChangeHint')}
                    </Alert>
                  </div>
                )}
              </div>
            )}

            <Field label={t('users.form.role')} id="user-role">
              <NativeSelect
                id="user-role"
                value={formData.role}
                onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                disabled={loading}
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.name}>
                    {role.name} {role.description && `- ${role.description}`}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </SheetBody>

          <SheetFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={loading}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={loading}
              loading={loading}
            >
              {!loading && <Save aria-hidden />}
              <span>{loading ? t('common.saving') : t('common.save')}</span>
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
};

/** A row action: an icon button named for the row, with its short name on hover (phase 5). */
const IconAction: React.FC<{
  label: string;
  tooltip: string;
  onClick: () => void;
  critical?: boolean;
  children: React.ReactNode;
}> = ({ label, tooltip, onClick, critical = false, children }) => (
  <Tooltip content={tooltip}>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      onClick={onClick}
      className={cn(critical && 'hover:text-critical')}
    >
      {children}
    </Button>
  </Tooltip>
);

const UserManagement: React.FC = () => {
  const { t, tPlural } = useTranslation();
  const { isAdmin, profile, loading: authLoading } = useAuth();
  // Inside a support session this screen is about the company that was opened,
  // and null everywhere else — a company user's list is scoped by the function.
  const { companyScope } = useSuperAdmin();
  const scopeCompanyId = companyScope.isPlatformSession ? companyScope.companyId : null;
  /*
    Who may work this screen — asked of the **scope**, not of the profile.

    `isAdmin || kind === 'support'` was wrong in both directions. A platform
    account whose own profile happens to carry `admin` would have had a fully
    editable screen inside a *read* context, and every button here calls
    `manage-users`, a service-role function that — until plan 3.13a — never
    looked at the context, so those writes went through. The function now
    refuses a platform account outside a support session on the target's
    company; this screen still judges a platform session by its mode, so it
    offers only what the function will do. The profile role decides only when
    the scope is the account's own company.

    In a read context the screen is refused rather than shown with its buttons:
    every one of them writes. The read-only view of a company's accounts is
    /admin/verzeichnisse, which is paged, column-reduced and audited.

    (The other direction — a platform account never reaching this screen at all
    because its profile carries `viewer`, which is what `platform-staff` writes
    for every invited member — was in App.tsx, and is `CompanyAdminRoute`.)
  */
  const canManageUsers = companyScope.kind === 'own' ? isAdmin : companyScope.kind === 'support';
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
  // `scopeCompanyId` is in the list because the answer is filtered by it: a
  // session that moves to another company must not keep the first one's rows.
  useEffect(() => {
    if (canManageUsers) loadUsers();
  }, [canManageUsers, authLoading, scopeCompanyId]);

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

      /*
        Show the company that is open, and nothing else (plan 3.4b).

        Since plan 3.13a the function scopes this itself: `manage-users/list`
        answers every caller with the accounts of one company — a company
        admin's own, a platform account's support-session company — and a
        platform account with no support session open with a refusal. Before it
        a platform caller got every account of every company, which is the
        "Benutzer shows every platform user" the owner reported. This filter
        stays as the screen's own statement of what it shows (and keeps a
        platform account that sits in the company off the list); it is not what
        confines the answer any more.

        `scopeCompanyId` is only set inside a platform session, so this changes
        nothing for the tenant app.
      */
      setUsers(scopeCompanyId === null
        ? data
        : (data as UserData[]).filter(u => u.company_id === scopeCompanyId && !u.is_super_admin));
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
        const errorData = await response.json().catch(() => ({}));
        // The account and its profile exist; only the invitation mail failed.
        // Say exactly that and reload the list, where "resend invitation" is,
        // rather than inviting a second attempt that ends in "already registered".
        const inviteFailure = inviteCreateFailure(response.status, errorData);
        if (inviteFailure) {
          setIsModalOpen(false);
          loadUsers();
          setConfirmModal({
            isOpen: true,
            title: t('common.error'),
            message: formatOtpMessage(inviteFailure, t, tPlural),
            onConfirm: () => {},
            type: 'error' as const
          });
          return;
        }
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

  // `password` is absent on an edit that sets no new one: UserModal strips it.
  const handleEditUser = async (userData: { email: string; password?: string; full_name: string; role: string }) => {
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
          password: userData.password?.trim() ? userData.password : undefined,
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

      const body: unknown = await response.json().catch(() => null);
      // The cooldown, the hourly limit, a failed send and an invitation that was
      // already accepted each have their own message; anything else keeps the
      // generic one with the server's text.
      const outcome = resendInviteOutcome(response.status, body);
      if (!outcome.message) {
        const serverText = (body as { error?: unknown } | null)?.error;
        throw new Error(typeof serverText === 'string' && serverText ? serverText : 'Resend invite failed');
      }

      setConfirmModal({
        isOpen: true,
        title: outcome.ok ? t('users.successTitle') : t('common.error'),
        message: formatOtpMessage(outcome.message, t, tPlural),
        onConfirm: () => {},
        type: outcome.ok ? 'success' : 'error'
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged: who may work it
  // (the scope, not the profile), every manage-users call and its body, the
  // dialogs each outcome opens, and the Excel export, which only moved up
  // here, word for word, from between two of the early returns below.
  //
  // What each width offers is kept as it was. The desktop table has never
  // offered "Passwort zurücksetzen" or the "Passwortänderung erforderlich"
  // badge, and the phone cards always have; adding either to the table adds a
  // function to a screen, which is the owner's to approve (HANDOFF.md), not
  // this change's.

  type BadgeTone = 'neutral' | 'brand' | 'positive' | 'caution' | 'critical';

  const statusBadge = (status?: string, mustChangePassword?: boolean) => {
    if (mustChangePassword) {
      return <Badge tone="caution"><KeyRound aria-hidden />{t('users.badge.passwordChangeRequired')}</Badge>;
    }
    if (status === 'inactive') {
      return <Badge tone="neutral"><XCircle aria-hidden />{t('users.badge.inactive')}</Badge>;
    }
    if (status === 'pending_invite') {
      return <Badge tone="caution"><Clock aria-hidden />{t('users.badge.pendingInvite')}</Badge>;
    }
    return <Badge tone="positive"><CheckCircle aria-hidden />{t('users.badge.active')}</Badge>;
  };

  const roleBadge = (user: UserData) => {
    // The keys below are the stored `user_profiles.role` values that RLS policies
    // match on, not labels — and the badge shows the role verbatim because a custom
    // role's name is free text from the `roles` table. Nothing here is translatable.
    const roleTones: Record<string, BadgeTone> = {
      admin: 'critical',
      supervisor: 'caution',
      editor: 'brand',
      viewer: 'neutral',
    };

    const roleName = user.role_name || user.role || 'viewer';
    const roleKey = (user.role || 'viewer').toLowerCase();
    const roleTone = roleTones[roleKey as keyof typeof roleTones] || 'positive';

    return <Badge tone={roleTone}>{roleName}</Badge>;
  };

  const displayName = (user: UserData) => user.full_name || t('common.unknown');

  const avatar = (
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-text">
      <User className="size-4" />
    </span>
  );

  /**
   * The row's actions, in the old order. `phone` is the card list: the one
   * place that has always offered a password reset.
   */
  const actions = (user: UserData, place: 'table' | 'phone') => (
    <>
      {user.status === 'pending_invite' && (
        <IconAction
          label={t('users.action.resendInviteNamed', { name: displayName(user) })}
          tooltip={t('users.action.resendInvite')}
          onClick={() => handleResendInvite(user.id)}
        >
          <MailCheck aria-hidden />
        </IconAction>
      )}
      {user.status === 'active' && user.email !== 'support@yamobility.de' && (
        <IconAction
          label={t('users.action.deactivateNamed', { name: displayName(user) })}
          tooltip={t('users.action.deactivate')}
          onClick={() => handleActivateDeactivate(user.id, 'inactive')}
        >
          <UserX aria-hidden />
        </IconAction>
      )}
      {user.status === 'inactive' && (
        <IconAction
          label={t('users.action.activateNamed', { name: displayName(user) })}
          tooltip={t('users.action.activate')}
          onClick={() => handleActivateDeactivate(user.id, 'active')}
        >
          <UserCheck aria-hidden />
        </IconAction>
      )}
      <IconAction
        label={t('users.action.editNamed', { name: displayName(user) })}
        tooltip={t('common.edit')}
        onClick={() => {
          setEditingUser(user);
          setIsModalOpen(true);
        }}
      >
        <Edit aria-hidden />
      </IconAction>
      {place === 'phone' && user.email !== 'support@yamobility.de' && (
        <IconAction
          label={t('users.action.resetPasswordNamed', { name: displayName(user) })}
          tooltip={t('users.action.resetPassword')}
          onClick={() => handleResetPassword(user)}
        >
          <KeyRound aria-hidden />
        </IconAction>
      )}
      {user.email !== 'support@yamobility.de' && (
        <IconAction
          label={t('users.action.deleteNamed', { name: displayName(user) })}
          tooltip={t('common.delete')}
          onClick={() => handleDeleteUser(user)}
          critical
        >
          <Trash2 aria-hidden />
        </IconAction>
      )}
    </>
  );

  const waiting = (message: string) => (
    <div role="status" className="grid justify-items-center gap-3 py-12 text-center font-ui">
      <div aria-hidden className="size-10 rounded-full border-2 border-line border-b-brand motion-safe:animate-spin" />
      <p className="text-sm text-fg-muted">{message}</p>
    </div>
  );

  if (authLoading) {
    return waiting(t('users.checkingPermissions'));
  }

  if (!canManageUsers) {
    // A platform account in a read context is told what is missing — a support
    // session — rather than that its role is too low, which is not the reason.
    const readContext = companyScope.kind === 'view';
    return (
      <div className="rounded-surface border border-line bg-raised font-ui shadow-raised">
        <EmptyState
          icon={readContext ? ShieldAlert : UserX}
          title={t(readContext ? 'users.readOnlyTitle' : 'users.accessDenied')}
          description={
            <>
              {t(readContext ? 'users.readOnlyBody' : 'users.adminOnly')}
              {!readContext && (
                <span className="mt-2 block text-xs text-fg-subtle">{t('users.yourRole', { role: profile?.role || t('users.roleNone') })}</span>
              )}
            </>
          }
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-6 font-ui" aria-busy="true">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map(index => <KpiCard key={index} label="" value="" loading />)}
        </div>
        <div className="grid gap-3 rounded-surface border border-line bg-raised p-5">
          {[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-9 w-full" />)}
        </div>
        <p role="status" className="sr-only">{t('users.loadingUsers')}</p>
      </div>
    );
  }

  const columns: DataTableColumn<UserData>[] = [
    {
      id: 'user',
      header: t('users.table.user'),
      value: user => user.full_name ?? '',
      cell: user => (
        <div className="flex items-center gap-3 py-2">
          {avatar}
          <div className="min-w-0">
            <div className="font-semibold text-fg">{displayName(user)}</div>
            <div className="text-xs tabular-nums text-fg-subtle">ID: {user.id.slice(0, 8)}...</div>
          </div>
        </div>
      ),
    },
    { id: 'email', header: t('users.table.email'), value: user => user.email, className: 'break-all' },
    { id: 'role', header: t('users.form.role'), cell: user => roleBadge(user) },
    { id: 'status', header: t('common.status'), cell: user => statusBadge(user.status) },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 font-ui">
      {/* The page's own header, the heading and the tabs, is UsersPage's. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-fg-muted">{t('users.subtitle')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={handleExport}>
            <Download aria-hidden />
            {t('common.exportExcelShort')}
          </Button>
          <Button onClick={() => setIsModalOpen(true)}>
            <Plus aria-hidden />
            <span>{t('users.newUser')}</span>
          </Button>
        </div>
      </div>

      {/* Statistics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard icon={Users} label={t('users.stats.total')} value={<span className="tabular-nums">{users.length}</span>} />
        <KpiCard icon={UserCheck} label={t('users.stats.confirmed')} value={<span className="tabular-nums">{users.filter(u => u.email_confirmed_at).length}</span>} />
        <KpiCard icon={UserCog} label={t('users.stats.admins')} value={<span className="tabular-nums">{users.filter(u => u.role === 'admin').length}</span>} />
        <KpiCard icon={User} label={t('users.stats.viewers')} value={<span className="tabular-nums">{users.filter(u => u.role === 'viewer').length}</span>} />
      </div>

      {/* Users List */}
      {users.length === 0 ? (
        <div className="rounded-surface border border-line bg-raised shadow-raised">
          <EmptyState icon={Users} title={t('users.empty.title')} description={t('users.empty.hint')} />
        </div>
      ) : (
        <>
          {/* Desktop Table */}
          <div className="hidden md:block">
            <DataTable
              caption={t('users.table.caption')}
              columns={columns}
              rows={users}
              getRowId={user => user.id}
              rowActions={user => actions(user, 'table')}
              rowActionsLabel={t('users.table.actions')}
            />
          </div>

          {/* Mobile Cards */}
          <ul className="grid grid-cols-1 gap-3 md:hidden" aria-label={t('users.table.caption')}>
            {users.map((user) => (
              <li key={user.id} className="rounded-surface border border-line bg-raised p-4 shadow-raised">
                <div className="flex min-w-0 items-center gap-3">
                  {avatar}
                  <div className="min-w-0">
                    <div className="font-semibold text-fg">{displayName(user)}</div>
                    <div className="break-all text-sm text-fg-muted">{user.email}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {roleBadge(user)}
                  {statusBadge(user.status, user.must_change_password)}
                </div>
                <div className="mt-3 flex flex-wrap justify-end gap-1 border-t border-line pt-2">
                  {actions(user, 'phone')}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* User Modal: mounted only while open, as before (it returns null otherwise). */}
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

      {/* The legacy modal's four types, by the same `type`: a question, or a result to acknowledge. */}
      <ConfirmDialog
        open={confirmModal.isOpen && confirmModal.type === 'confirm'}
        onClose={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        description={confirmModal.message}
        confirmLabel={t('common.confirm')}
      />
      <MessageDialog
        open={confirmModal.isOpen && confirmModal.type !== 'confirm'}
        onClose={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        description={confirmModal.message}
        tone={confirmModal.type === 'success' ? 'positive' : confirmModal.type === 'error' ? 'critical' : 'brand'}
      />

      {/* Reset Password Modal */}
      <Dialog open={resetPasswordUser !== null} onOpenChange={next => { if (!next) closeResetPasswordModal(); }}>
        {resetPasswordUser && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('users.action.resetPassword')}</DialogTitle>
              <DialogDescription>
                {t('users.resetPassword.forUser')}{' '}
                <span className="font-medium text-fg">{resetPasswordUser.email}</span>
              </DialogDescription>
            </DialogHeader>

            {resetPasswordSuccess ? (
              <Alert tone="positive" title={t('users.resetPassword.success')} />
            ) : (
              <div className="grid gap-4">
                <Field label={t('users.resetPassword.label')}>
                  <div className="relative">
                    <Lock aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                    <Input
                      type={showResetPassword ? 'text' : 'password'}
                      value={resetPasswordValue}
                      onChange={(e) => setResetPasswordValue(e.target.value)}
                      className="pl-9 pr-11"
                      placeholder={t('users.password.minLengthPlaceholder')}
                      minLength={8}
                      disabled={resetPasswordLoading}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setShowResetPassword(!showResetPassword)}
                      aria-label={showResetPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                      className="absolute right-0.5 top-1/2 -translate-y-1/2"
                    >
                      {showResetPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                    </Button>
                  </div>
                </Field>
                <Alert tone="caution" role="note">{t('users.resetPassword.nextLoginHint')}</Alert>
                {resetPasswordError && <Alert tone="critical" title={resetPasswordError} />}
                <DialogFooter>
                  <Button
                    variant="secondary"
                    onClick={closeResetPasswordModal}
                    disabled={resetPasswordLoading}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    onClick={submitResetPassword}
                    disabled={resetPasswordLoading || resetPasswordValue.length < 8}
                    loading={resetPasswordLoading}
                  >
                    {!resetPasswordLoading && <KeyRound aria-hidden />}
                    <span>{t('users.action.resetPassword')}</span>
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
};

export default UserManagement;
