import React, { useState, useEffect, useCallback } from 'react';
import { Bell, BellOff, ShieldAlert, ShieldX, CheckCircle, Save, RotateCcw, Lock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { Alert, Button, PageHeader, cn } from '../components/ui';

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
  group: 'fahrzeuge';
}

const NOTIFICATION_DEFS: NotificationDef[] = [
  {
    type:        'tuev_bald_ablaufend',
    label:       'notif.tuevSoon',
    description: 'notif.tuevSoonBody',
    icon:        ShieldAlert,
    group:       'fahrzeuge',
  },
  {
    type:        'tuev_abgelaufen',
    label:       'notif.tuevExpired',
    description: 'notif.tuevExpiredBody',
    icon:        ShieldX,
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
  const knob = size === 'sm' ? 'w-3 h-3 top-0.5 start-0.5' : 'w-5 h-5 top-0.5 start-0.5';
  const translate = size === 'sm' ? 'translate-x-4 rtl:-translate-x-4' : 'translate-x-5 rtl:-translate-x-5';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:opacity-40 disabled:cursor-not-allowed [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-[''] ${w} ${checked ? 'bg-brand' : 'bg-fg-subtle'}`}
    >
      <span
        className={`pointer-events-none inline-block rounded-full shadow-elev-xs transform transition duration-200 ease-in-out absolute ${knob} ${checked ? `${translate} bg-brand-fg` : 'translate-x-0 bg-solid'}`}
      />
    </button>
  );
};

// ─── Section header ───────────────────────────────────────────────────────────

const GroupHeader: React.FC<{ title: string; sub: string }> = ({ title, sub }) => (
  <div className="mb-3">
    <h3 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
      {title}
    </h3>
    <p className="mt-0.5 text-xs text-fg-subtle">{sub}</p>
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged, bar the colour
  // fields NOTIFICATION_DEFS used to carry (now DEF_TONE below) and the classes
  // of the two small components above. Everything below only draws.

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 rounded-full border-b-2 border-brand motion-safe:animate-spin" />
      </div>
    );
  }

  const DEF_TONE: Record<NotificationType, string> = {
    tuev_bald_ablaufend: 'bg-caution-soft text-caution',
    tuev_abgelaufen: 'bg-critical-soft text-critical',
  };

  const groups: { key: 'fahrzeuge'; title: string; sub: string }[] = [
    { key: 'fahrzeuge', title: t('notif.vehicles'), sub: t('notif.vehiclesSub') },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-10 font-ui">
      <PageHeader className="pb-0" title={t('notif.title')} description={t('notif.subtitle')} />

      {/*
        Why the sentences are SettingsPage's and not new ones: that screen owns
        the other `is_company_admin()`-gated settings writes and already says
        both of these. `settings.readOnlyBody` names the actionable fact for a
        platform read context ("…only in a support session"), which would be
        false for a company viewer; `settings.noWritePermission` is the one it
        prints on a 42501 from the `company_settings` upsert, which is the same
        refusal this page was walking into.
      */}
      {!canEdit && (
        <Alert role="note" icon={Lock}>
          {scope.isPlatformSession ? t('settings.readOnlyBody') : t('settings.noWritePermission')}
        </Alert>
      )}

      {/* Global master toggle card */}
      <div className="glass-card rounded-surface p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={cn(
              'flex size-10 flex-shrink-0 items-center justify-center rounded-tile',
              globalEnabled ? 'bg-brand-soft text-brand-text' : 'bg-sunken text-fg-subtle',
            )}>
              {globalEnabled
                ? <Bell aria-hidden className="size-5" />
                : <BellOff aria-hidden className="size-5" />
              }
            </div>
            <div>
              <p className="text-sm font-semibold text-fg">
                {t('notif.emailNotifications')}
              </p>
              <p className="mt-0.5 text-xs text-fg-muted">
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
        <div className="mt-4 flex gap-2 border-t border-line pt-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleEnableAll}
            disabled={!canEdit}
          >
            <CheckCircle aria-hidden className="text-positive" />
            {t('notif.enableAll')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDisableAll}
            disabled={!canEdit}
          >
            <BellOff aria-hidden className="text-critical" />
            {t('notif.disableAll')}
          </Button>
        </div>
      </div>

      {/* Per-group sections */}
      {groups.map(group => {
        const defs = NOTIFICATION_DEFS.filter(d => d.group === group.key);
        return (
          <div key={group.key}
            className={cn('glass-card space-y-1 rounded-surface p-5', !globalEnabled && 'pointer-events-none opacity-[.55]')}
          >
            <GroupHeader title={group.title} sub={group.sub} />

            <div className="mt-2 space-y-1">
              {defs.map((def, i) => {
                const Icon = def.icon;
                const isLast = i === defs.length - 1;
                return (
                  <div
                    key={def.type}
                    className={cn('flex items-start justify-between gap-4 py-3', !isLast && 'border-b border-line')}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={cn('mt-0.5 flex size-8 flex-shrink-0 items-center justify-center rounded-tight', DEF_TONE[def.type])}
                      >
                        <Icon aria-hidden className="size-4" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-fg">
                          {t(def.label)}
                        </p>
                        <p className="mt-0.5 text-xs text-fg-muted">
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
        className={cn(
          'flex flex-wrap items-center justify-between gap-4 rounded-surface border p-4 transition-colors motion-safe:duration-200',
          dirty ? 'border-brand/40 bg-brand-soft' : 'glass-card',
        )}
      >
        <p className={cn('text-sm', dirty ? 'text-brand-text' : 'text-fg-muted')}>
          {dirty ? t('notif.unsaved') : t('notif.allSaved')}
        </p>
        <div className="flex gap-2">
          {dirty && (
            <Button variant="secondary" onClick={handleReset}>
              <RotateCcw aria-hidden />
              {t('notif.reset')}
            </Button>
          )}
          <Button onClick={handleSave} disabled={saving || !dirty}>
            <Save aria-hidden />
            {saving ? t('settings.savingEllipsis') : t('notif.saveSettings')}
          </Button>
        </div>
      </div>
      )}

      {/* Info note */}
      <div className="rounded-tile border border-line bg-sunken px-4 py-3 text-xs text-fg-muted">
        {t('notif.infoNote')}
      </div>
    </div>
  );
}
