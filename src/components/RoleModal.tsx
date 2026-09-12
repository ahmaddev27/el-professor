import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Save, AlertCircle, ShieldCheck } from 'lucide-react';
import { Role, RolePermission, PAGE_DEFINITIONS } from '../types/role';
import { useTranslation } from '../contexts/LanguageContext';

interface RoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (role: Partial<Role>, permissions: Partial<RolePermission>[]) => Promise<void>;
  role?: Role;
  existingPermissions?: RolePermission[];
}

interface PermissionState {
  can_view: boolean;
  can_edit: boolean;
}

const RoleModal: React.FC<RoleModalProps> = ({
  isOpen,
  onClose,
  onSave,
  role,
  existingPermissions = [],
}) => {
  const { t, tPlural } = useTranslation();
  const [roleName, setRoleName] = useState('');
  const [roleDescription, setRoleDescription] = useState('');
  const [permissionMap, setPermissionMap] = useState<Record<string, PermissionState>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setIsInitialized(false);
      return;
    }
    if (isInitialized) return;

    setValidationError('');

    if (role) {
      setRoleName(role.name);
      setRoleDescription(role.description);
      const perms: Record<string, PermissionState> = {};
      existingPermissions.forEach(p => {
        perms[p.page_key] = { can_view: p.can_view, can_edit: p.can_edit };
      });
      setPermissionMap(perms);
    } else {
      setRoleName('');
      setRoleDescription('');
      const perms: Record<string, PermissionState> = {};
      PAGE_DEFINITIONS.forEach(page => {
        perms[page.key] = { can_view: false, can_edit: false };
      });
      setPermissionMap(perms);
    }

    setIsInitialized(true);
  }, [isOpen, role, existingPermissions, isInitialized]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = 'unset'; };
    }
  }, [isOpen]);

  const toggleView = (pageKey: string) => {
    setPermissionMap(prev => {
      const newView = !(prev[pageKey]?.can_view || false);
      return {
        ...prev,
        [pageKey]: {
          can_view: newView,
          can_edit: newView ? (prev[pageKey]?.can_edit || false) : false,
        },
      };
    });
  };

  const toggleEdit = (pageKey: string) => {
    setPermissionMap(prev => {
      const newEdit = !(prev[pageKey]?.can_edit || false);
      return {
        ...prev,
        [pageKey]: {
          can_view: newEdit ? true : (prev[pageKey]?.can_view || false),
          can_edit: newEdit,
        },
      };
    });
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError('');

    const trimmedName = roleName.trim();
    if (!trimmedName) {
      setValidationError(t('users.roles.nameRequired'));
      return;
    }

    setIsSubmitting(true);
    try {
      const roleData: Partial<Role> = { name: trimmedName, description: roleDescription.trim() };
      if (role) roleData.id = role.id;

      const permissionsData: Partial<RolePermission>[] = Object.entries(permissionMap).map(
        ([page_key, perms]) => ({ page_key, can_view: perms.can_view, can_edit: perms.can_edit })
      );

      await onSave(roleData, permissionsData);
      onClose();
    } catch (err: any) {
      setValidationError(err.message || t('users.roles.error.save'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => { if (!isSubmitting) onClose(); };

  if (!isOpen) return null;

  const enabledCount = Object.values(permissionMap).filter(p => p.can_view || p.can_edit).length;

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="role-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#111827',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '1rem',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          width: '100%',
          maxWidth: '720px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* HEADER */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{
              width: 36, height: 36, borderRadius: '0.5rem',
              background: 'rgba(6,182,212,0.12)',
              border: '1px solid rgba(6,182,212,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <ShieldCheck size={18} color="#06b6d4" />
            </div>
            <div>
              <h2 id="role-modal-title" style={{ fontSize: '1rem', fontWeight: 700, color: '#f1f5f9', margin: 0, lineHeight: 1.3 }}>
                {role ? t('users.roles.edit') : t('users.roles.createNew')}
              </h2>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0, marginTop: 2 }}>
                {enabledCount > 0
                  ? tPlural({ one: 'users.roles.areasSelected.one', other: 'users.roles.areasSelected.other' }, enabledCount)
                  : t('users.roles.noPermissionsSet')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#64748b',
              cursor: 'pointer',
              padding: '0.375rem',
              borderRadius: '0.375rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'color 0.15s, background 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#f1f5f9'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.07)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#64748b'; (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            aria-label={t('common.close')}
          >
            <X size={20} />
          </button>
        </div>

        {/* FORM */}
        <form onSubmit={handleFormSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

            {/* ERROR */}
            {validationError && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.625rem',
                padding: '0.75rem 1rem',
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: '0.5rem',
              }}>
                <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: '0.875rem', color: '#fca5a5' }}>{validationError}</span>
              </div>
            )}

            {/* SYSTEM ROLE NOTE */}
            {role?.is_system && (
              <div style={{
                padding: '0.75rem 1rem',
                background: 'rgba(6,182,212,0.08)',
                border: '1px solid rgba(6,182,212,0.18)',
                borderRadius: '0.5rem',
              }}>
                <p style={{ fontSize: '0.875rem', color: '#67e8f9', margin: 0 }}>
                  {t('users.roles.systemRoleNote')}
                </p>
              </div>
            )}

            {/* ROLE NAME + DESCRIPTION */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label
                  htmlFor="role-name"
                  style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.5rem', letterSpacing: '0.02em' }}
                >
                  {t('users.roles.nameLabel')} <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  id="role-name"
                  type="text"
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  disabled={role?.is_system || isSubmitting}
                  placeholder={t('users.roles.namePlaceholder')}
                  autoComplete="off"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    height: '2.625rem',
                    padding: '0 0.875rem',
                    background: '#141d2e',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '0.5rem',
                    color: '#f1f5f9',
                    fontSize: '0.9375rem',
                    outline: 'none',
                    transition: 'border-color 0.15s',
                    opacity: (role?.is_system || isSubmitting) ? 0.5 : 1,
                    cursor: (role?.is_system || isSubmitting) ? 'not-allowed' : 'text',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'rgba(6,182,212,0.5)'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
                />
              </div>
              <div>
                <label
                  htmlFor="role-description"
                  style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.5rem', letterSpacing: '0.02em' }}
                >
                  {t('common.description')}
                </label>
                <textarea
                  id="role-description"
                  value={roleDescription}
                  onChange={(e) => setRoleDescription(e.target.value)}
                  disabled={isSubmitting}
                  placeholder={t('users.roles.descriptionPlaceholder')}
                  rows={2}
                  autoComplete="off"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    padding: '0.625rem 0.875rem',
                    background: '#141d2e',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '0.5rem',
                    color: '#f1f5f9',
                    fontSize: '0.9375rem',
                    outline: 'none',
                    resize: 'vertical',
                    lineHeight: 1.6,
                    transition: 'border-color 0.15s',
                    opacity: isSubmitting ? 0.5 : 1,
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'rgba(6,182,212,0.5)'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
                />
              </div>
            </div>

            {/* PERMISSIONS */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.875rem' }}>
                <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, color: '#f1f5f9', margin: 0 }}>{t('users.roles.permissions')}</h3>
                <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                  {t('users.roles.editRequiresView')}
                </span>
              </div>

              <div style={{
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '0.625rem',
                overflow: 'hidden',
              }}>
                {/* Table header */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 100px 110px',
                  background: '#1a2235',
                  padding: '0.625rem 1rem',
                  borderBottom: '1px solid rgba(255,255,255,0.07)',
                }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{t('users.roles.col.area')}</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', letterSpacing: '0.05em', textTransform: 'uppercase', textAlign: 'center' }}>{t('users.roles.col.view')}</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', letterSpacing: '0.05em', textTransform: 'uppercase', textAlign: 'center' }}>{t('users.roles.col.edit')}</span>
                </div>

                {/* Rows */}
                {PAGE_DEFINITIONS.map((page, idx) => {
                  const canView = permissionMap[page.key]?.can_view || false;
                  const canEdit = permissionMap[page.key]?.can_edit || false;
                  const isLast = idx === PAGE_DEFINITIONS.length - 1;

                  return (
                    <PermissionRow
                      key={page.key}
                      pageKey={page.key}
                      label={t(page.label)}
                      description={t(page.description)}
                      canView={canView}
                      canEdit={canEdit}
                      isLast={isLast}
                      isSubmitting={isSubmitting}
                      onToggleView={toggleView}
                      onToggleEdit={toggleEdit}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {/* FOOTER */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem',
            padding: '1rem 1.5rem',
            borderTop: '1px solid rgba(255,255,255,0.07)',
            background: '#0f1623',
            flexShrink: 0,
          }}>
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              style={{
                height: '2.375rem',
                padding: '0 1.125rem',
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: '0.5rem',
                color: '#94a3b8',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                opacity: isSubmitting ? 0.5 : 1,
                transition: 'border-color 0.15s, color 0.15s, background 0.15s',
              }}
              onMouseEnter={e => { if (!isSubmitting) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.22)'; (e.currentTarget as HTMLButtonElement).style.color = '#f1f5f9'; } }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.12)'; (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'; }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                height: '2.375rem',
                padding: '0 1.25rem',
                background: isSubmitting ? 'rgba(6,182,212,0.5)' : '#06b6d4',
                border: 'none',
                borderRadius: '0.5rem',
                color: '#fff',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { if (!isSubmitting) (e.currentTarget as HTMLButtonElement).style.background = '#0891b2'; }}
              onMouseLeave={e => { if (!isSubmitting) (e.currentTarget as HTMLButtonElement).style.background = '#06b6d4'; }}
            >
              <Save size={15} />
              {isSubmitting ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};

interface PermissionRowProps {
  pageKey: string;
  label: string;
  description: string;
  canView: boolean;
  canEdit: boolean;
  isLast: boolean;
  isSubmitting: boolean;
  onToggleView: (key: string) => void;
  onToggleEdit: (key: string) => void;
}

const PermissionRow: React.FC<PermissionRowProps> = ({
  pageKey, label, description, canView, canEdit, isLast, isSubmitting, onToggleView, onToggleEdit,
}) => {
  const [hovered, setHovered] = React.useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 100px 110px',
        alignItems: 'center',
        padding: '0.75rem 1rem',
        borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.05)',
        background: hovered ? 'rgba(255,255,255,0.025)' : 'transparent',
        transition: 'background 0.15s',
      }}
    >
      <div>
        <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#e2e8f0', lineHeight: 1.3 }}>{label}</div>
        {description && (
          <div style={{ fontSize: '0.75rem', color: '#475569', marginTop: 2, lineHeight: 1.4 }}>{description}</div>
        )}
      </div>

      {/* View checkbox */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <label style={{ cursor: isSubmitting ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <input
            type="checkbox"
            checked={canView}
            onChange={() => onToggleView(pageKey)}
            disabled={isSubmitting}
            style={{ display: 'none' }}
          />
          <span style={{
            width: 18, height: 18,
            borderRadius: 4,
            border: canView ? 'none' : '1.5px solid rgba(255,255,255,0.2)',
            background: canView ? '#06b6d4' : 'rgba(255,255,255,0.04)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.15s, border 0.15s, box-shadow 0.15s',
            boxShadow: canView ? '0 0 8px rgba(6,182,212,0.35)' : 'none',
            opacity: isSubmitting ? 0.5 : 1,
          }}>
            {canView && (
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4L3.5 6.5L9 1" stroke="#fff" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
        </label>
      </div>

      {/* Edit checkbox */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <label style={{ cursor: isSubmitting ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <input
            type="checkbox"
            checked={canEdit}
            onChange={() => onToggleEdit(pageKey)}
            disabled={isSubmitting}
            style={{ display: 'none' }}
          />
          <span style={{
            width: 18, height: 18,
            borderRadius: 4,
            border: canEdit ? 'none' : '1.5px solid rgba(255,255,255,0.2)',
            background: canEdit ? '#10b981' : 'rgba(255,255,255,0.04)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.15s, border 0.15s, box-shadow 0.15s',
            boxShadow: canEdit ? '0 0 8px rgba(16,185,129,0.35)' : 'none',
            opacity: isSubmitting ? 0.5 : 1,
          }}>
            {canEdit && (
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4L3.5 6.5L9 1" stroke="#fff" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
        </label>
      </div>
    </div>
  );
};

export default RoleModal;
