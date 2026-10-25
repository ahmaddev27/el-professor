import React, { useState, useEffect, useCallback } from 'react';
import { Bell, BellOff, ShieldAlert, ShieldX, CheckCircle, Save, RotateCcw, Lock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationType = 'tuev_bald_ablaufend' | 'tuev_abgelaufen';

interface NotificationRow {
  notification_type: NotificationType;
  enabled: boolean;
  email_global_enabled: boolean;
}

interface NotificationDef {
  type: NotificationType;
  // Keys, not text: NOTIFICATION_DEFS is module-level and t() is a hook value.
  label: TranslationKey;
  description: TranslationKey;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  group: 'fahrzeuge';
}

const NOTIFICATION_DEFS: NotificationDef[] = [
  {
    type:        'tuev_bald_ablaufend',
    label:       'notif.tuevSoon',
    description: 'notif.tuevSoonBody',
    icon:        ShieldAlert,
    iconColor:   'var(--warning)',
    iconBg:      'var(--warning-subtle)',
    group:       'fahrzeuge',
  },
  {
    type:        'tuev_abgelaufen',
    label:       'notif.tuevExpired',
    description: 'notif.tuevExpiredBody',
    icon:        ShieldX,
    iconColor:   'var(--danger)',
    iconBg:      'var(--danger-subtle)',
    group:       'fahrzeuge',
  },
];

const DEFAULT_ENABLED: Record<NotificationType, boolean> = {
  tuev_bald_ablaufend: true,
  tuev_abgelaufen:     true,
};

// ─── Toggle component ─────────────────────────────────────────────────────────

const Toggle: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}> = ({ checked, onChange, disabled, size = 'md' }) => {
  const w = size === 'sm' ? 'w-8 h-4' : 'w-11 h-6';
  const knob = size === 'sm' ? 'w-3 h-3 top-0.5 left-0.5' : 'w-5 h-5 top-0.5 left-0.5';
  const translate = size === 'sm' ? 'translate-x-4' : 'translate-x-5';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed ${w}`}
      style={{ background: checked ? 'var(--accent)' : 'var(--bg-muted)' }}
    >
      <span
        className={`pointer-events-none inline-block rounded-full bg-white shadow transform transition duration-200 ease-in-out absolute ${knob} ${checked ? translate : 'translate-x-0'}`}
      />
    </button>
  );
};

// ─── Section header ───────────────────────────────────────────────────────────

const GroupHeader: React.FC<{ title: string; sub: string }> = ({ title, sub }) => (
  <div className="mb-3">
    <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
      {title}
    </h3>
    <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{sub}</p>
  </div>
);

// ─── Main page ────────────────────────────────────────────────────────────────

export default function NotificationsPage() {
  const { t } = useTranslation();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { showToast } = useToast();
  const { isAdmin } = useAuth();
  const scope = useCompanyScope();

  /**
   * The gate the database has always enforced, and which this page had not.
   *
   * `notification_settings` carries exactly three policies (20260917130000,
   * `'SIU'` with `admin_w`), and both write arms are
   * `company_id = get_active_company_id() AND is_company_admin()`. That
   * function is an administrator of the caller's own company, or a
   * company-less platform account inside an open **support** session
   * (20260917140000) — never a supervisor, an editor or a viewer, and never a
   * `view` context. SELECT carries no role term, so those callers read the
   * page, were offered the switches and the save, and the upsert came back
   * 42501: the INSERT arm as "new row violates row-level security policy", the
   * ON CONFLICT DO UPDATE arm as the same with "(USING expression)", because
   * PostgreSQL checks an upsert's existing row rather than filtering it out.
   * An error, then — not the silent zero-row success that a plain UPDATE or
   * DELETE behind the same gate produces (see `src/lib/writeOutcome.ts`).
   *
   * Same formula as TripAnalysisPage, whose `trip_analysis_settings` carries
   * the same administrator gate. This is the message, not the wall: the
   * policies refuse the write either way.
   */
  const canEdit = !scope.readOnly && (isAdmin || scope.kind === 'support');

  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [settings, setSettings] = useState<Record<NotificationType, boolean>>(DEFAULT_ENABLED);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Track initial state for reset
  const [savedGlobal, setSavedGlobal] = useState(true);
  const [savedSettings, setSavedSettings] = useState<Record<NotificationType, boolean>>(DEFAULT_ENABLED);

  // ── Load from DB ────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return; }
    try {
      const { data, error } = await supabase
        .from('notification_settings')
        .select('notification_type, enabled, email_global_enabled')
        .eq('company_id', companyId);

      if (error) throw error;

      if (!data || data.length === 0) {
        // No saved settings yet — keep defaults
        setLoading(false);
        return;
      }

      const rows = data as NotificationRow[];
      const global = rows[0]?.email_global_enabled ?? true;
      const map: Record<string, boolean> = {};
      rows.forEach(r => { map[r.notification_type] = r.enabled; });

      const merged = { ...DEFAULT_ENABLED } as Record<NotificationType, boolean>;
      NOTIFICATION_DEFS.forEach(def => {
        if (map[def.type] !== undefined) merged[def.type] = map[def.type];
      });

      setGlobalEnabled(global);
      setSettings(merged);
      setSavedGlobal(global);
      setSavedSettings(merged);
      setDirty(false);
    } catch (err: any) {
      console.error('Error loading notification settings:', err);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  // ── Dirty tracking ──────────────────────────────────────────────────────────
  const markDirty = () => setDirty(true);

  const handleGlobalToggle = (v: boolean) => {
    setGlobalEnabled(v);
    markDirty();
  };

  const handleTypeToggle = (type: NotificationType, v: boolean) => {
    setSettings(prev => ({ ...prev, [type]: v }));
    markDirty();
  };

  const handleEnableAll = () => {
    const all = {} as Record<NotificationType, boolean>;
    NOTIFICATION_DEFS.forEach(d => { all[d.type] = true; });
    setSettings(all);
    setGlobalEnabled(true);
    markDirty();
  };

  const handleDisableAll = () => {
    const none = {} as Record<NotificationType, boolean>;
    NOTIFICATION_DEFS.forEach(d => { none[d.type] = false; });
    setSettings(none);
    markDirty();
  };

  const handleReset = () => {
    setGlobalEnabled(savedGlobal);
    setSettings(savedSettings);
    setDirty(false);
  };

  // ── Save (upsert) ───────────────────────────────────────────────────────────
  const handleSave = async () => {
    // The save control is withheld without the right, so this is the second
    // wall: no request leaves for a caller the policies are about to refuse.
    if (!companyId || !canEdit) return;
    setSaving(true);
    try {
      const rows = NOTIFICATION_DEFS.map(def => ({
        company_id:           companyId,
        notification_type:    def.type,
        enabled:              settings[def.type],
        email_global_enabled: globalEnabled,
      }));

      const { error } = await supabase
        .from('notification_settings')
        .upsert(rows, { onConflict: 'company_id,notification_type' });

      if (error) throw error;

      setSavedGlobal(globalEnabled);
      setSavedSettings({ ...settings });
      setDirty(false);
      showToast('success', t('notif.saved'));
    } catch (err: any) {
      showToast('error', t('notif.saveFailedWith', { message: err.message }));
    } finally {
      setSaving(false);
    }
  };

  // ── Derived counts ──────────────────────────────────────────────────────────
  const enabledCount = NOTIFICATION_DEFS.filter(d => settings[d.type]).length;
  const totalCount   = NOTIFICATION_DEFS.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--accent)' }} />
      </div>
    );
  }

  const groups: { key: 'fahrzeuge'; title: string; sub: string }[] = [
    { key: 'fahrzeuge', title: t('notif.vehicles'), sub: t('notif.vehiclesSub') },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-10">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {t('notif.title')}
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('notif.subtitle')}
        </p>
      </div>

      {/*
        Why the sentences are SettingsPage's and not new ones: that screen owns
        the other `is_company_admin()`-gated settings writes and already says
        both of these. `settings.readOnlyBody` names the actionable fact for a
        platform read context ("…only in a support session"), which would be
        false for a company viewer; `settings.noWritePermission` is the one it
        prints on a 42501 from the `company_settings` upsert, which is the same
        refusal this page was walking into.

        Classes rather than a `style={…}` object: this is one of the six screens
        phase 5 never converted, and the style ratchet counts inline styles per
        file. `bg-[var(--token)]` is how NotesPage — another of the six — adds
        styling without raising that count.
      */}
      {!canEdit && (
        <div
          role="note"
          className="flex items-start gap-3 rounded-xl border px-4 py-3 text-sm bg-[var(--bg-subtle)] border-[var(--border-subtle)] text-[var(--text-secondary)]"
        >
          <Lock aria-hidden className="w-4 h-4 flex-shrink-0 mt-0.5 text-[var(--warning)]" />
          <span>
            {scope.isPlatformSession ? t('settings.readOnlyBody') : t('settings.noWritePermission')}
          </span>
        </div>
      )}

      {/* Global master toggle card */}
      <div
        className="rounded-2xl p-5"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: globalEnabled ? 'var(--accent-subtle)' : 'var(--bg-muted)' }}>
              {globalEnabled
                ? <Bell className="w-5 h-5" style={{ color: 'var(--accent-text)' }} />
                : <BellOff className="w-5 h-5" style={{ color: 'var(--text-tertiary)' }} />
              }
            </div>
            <div>
              <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                {t('notif.emailNotifications')}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {globalEnabled
                  ? t('notif.activeCount', { enabled: enabledCount, total: totalCount })
                  : t('notif.allDisabled')
                }
              </p>
            </div>
          </div>
          <Toggle checked={globalEnabled} onChange={handleGlobalToggle} disabled={!canEdit} />
        </div>

        {/* Quick actions */}
        <div className="flex gap-2 mt-4 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button
            type="button"
            onClick={handleEnableAll}
            disabled={!canEdit}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid transparent' }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <CheckCircle className="w-3.5 h-3.5" />
            {t('notif.enableAll')}
          </button>
          <button
            type="button"
            onClick={handleDisableAll}
            disabled={!canEdit}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid transparent' }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <BellOff className="w-3.5 h-3.5" />
            {t('notif.disableAll')}
          </button>
        </div>
      </div>

      {/* Per-group sections */}
      {groups.map(group => {
        const defs = NOTIFICATION_DEFS.filter(d => d.group === group.key);
        return (
          <div key={group.key}
            className="rounded-2xl p-5 space-y-1"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow-sm)',
              opacity: globalEnabled ? 1 : 0.55,
              pointerEvents: globalEnabled ? 'auto' : 'none',
            }}
          >
            <GroupHeader title={group.title} sub={group.sub} />

            <div className="space-y-1 mt-2">
              {defs.map((def, i) => {
                const Icon = def.icon;
                const isLast = i === defs.length - 1;
                return (
                  <div
                    key={def.type}
                    className="flex items-start justify-between gap-4 py-3"
                    style={{ borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)' }}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                        style={{ background: def.iconBg }}
                      >
                        <Icon className="w-4 h-4" style={{ color: def.iconColor }} />
                      </div>
                      <div>
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {t(def.label)}
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                          {t(def.description)}
                        </p>
                      </div>
                    </div>
                    <div className="flex-shrink-0 pt-0.5">
                      <Toggle
                        checked={settings[def.type]}
                        onChange={v => handleTypeToggle(def.type, v)}
                        disabled={!globalEnabled || !canEdit}
                        size="md"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Save / reset bar — withheld without the administrator right, because
          "Alle Änderungen gespeichert" and a Speichern button are both claims
          about a write this caller cannot make. */}
      {canEdit && (
      <div
        className="rounded-2xl p-4 flex items-center justify-between gap-4 flex-wrap"
        style={{
          background: dirty ? 'var(--accent-subtle)' : 'var(--bg-surface)',
          border: `1px solid ${dirty ? 'var(--accent)' : 'var(--border)'}`,
          transition: 'background 0.2s, border-color 0.2s',
        }}
      >
        <p className="text-sm" style={{ color: dirty ? 'var(--accent-text)' : 'var(--text-tertiary)' }}>
          {dirty ? t('notif.unsaved') : t('notif.allSaved')}
        </p>
        <div className="flex gap-2">
          {dirty && (
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-colors"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('notif.reset')}
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-opacity disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
            onMouseEnter={e => { if (!saving && dirty) e.currentTarget.style.background = 'var(--accent-hover)'; }}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? t('settings.savingEllipsis') : t('notif.saveSettings')}
          </button>
        </div>
      </div>
      )}

      {/* Info note */}
      <div
        className="rounded-xl px-4 py-3 text-xs"
        style={{
          background: 'var(--bg-subtle)',
          border: '1px solid var(--border-subtle)',
          color: 'var(--text-tertiary)',
        }}
      >
        {t('notif.infoNote')}
      </div>
    </div>
  );
}
