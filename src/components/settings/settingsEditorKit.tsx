import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert, Info, Save } from 'lucide-react';
import { useAppConfig } from '../../contexts/AppConfigContext';
import { useToast } from '../../contexts/ToastContext';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey, TranslationVars } from '../../i18n';
import { isVersionConflict, settingRefusalKey, type SettingKey, type SettingRecord } from '../../lib/platformSettings';
import { getSetting, putSetting } from '../../lib/platformSettingsClient';
import { deDateTime } from '../../lib/platformFormat';

/**
 * The parts every editor on the settings screen shares (plan 3.6c, 3.10, 3.11):
 * the shell that shows loading, a refusal or the form; the hook that loads one
 * key, edits it and saves it pinned to the version it read; and the small
 * controls. They lived inside `PlatformSettingsPage` until the mail, flag and
 * announcement editors needed them too.
 */

export const controlStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderRadius: '0.75rem',
  fontSize: '0.875rem',
  background: 'var(--bg-subtle)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
};

export const cardStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
};

/** What one settings key looks like once it has been read. */
export interface Loaded<T> {
  value: T;
  version: number;
  updatedAt: string | null;
  /** NULL until somebody saves: the seed writes no actor. */
  updatedBy: string | null;
}

// ─── The shell ───────────────────────────────────────────────────────────────

interface EditorShellProps {
  loading: boolean;
  problem: TranslationKey | null;
  detail: string | null;
  onReload: () => void;
  version: number | null;
  updatedAt: string | null;
  children: React.ReactNode;
}

export const EditorShell: React.FC<EditorShellProps> = ({ loading, problem, detail, onReload, version, updatedAt, children }) => {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw size={24} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
      </div>
    );
  }

  if (problem) {
    return (
      <div className="flex flex-col items-center justify-center py-16 rounded-2xl text-center px-6" style={cardStyle}>
        <ShieldAlert size={32} className="mb-3" style={{ color: 'var(--warning)' }} />
        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t(problem)}</p>
        {detail && <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>{detail}</p>}
        <button onClick={onReload} className="mt-4 px-4 py-2 rounded-xl text-sm font-semibold"
          style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}>
          {t('admin.settings.reload')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
        <span>{version === null ? '' : t('admin.settings.version', { version: String(version) })}</span>
        <span>{updatedAt ? t('admin.settings.updatedAt', { date: deDateTime(updatedAt) }) : ''}</span>
      </div>
      {children}
    </div>
  );
};

// ─── Load, edit and save one key ─────────────────────────────────────────────

/**
 * Load, edit and save one settings key.
 *
 * The seller, the trial, the invoice defaults, the mail sender and templates
 * and the feature flags have the same shape — read the value with its version,
 * edit a form, send it back pinned to that version — so the shape lives here
 * once. The price book and the feature map keep their own bodies in
 * `PlatformSettingsPage`: one carries a worked example, the other a table of
 * changed rows.
 *
 * The version rule is the reason this is worth sharing: on `version_conflict`
 * the editor reloads, and the unsaved entries go with the old form. It is never
 * re-sent with the version that came back, which would overwrite somebody
 * else's change unseen.
 *
 * The configuration must keep its identity between renders — a module-level
 * constant, or one per key in a module-level map — so the load effect runs once.
 */
export interface SettingEditorConfig<T, F> {
  key: SettingKey;
  read: (record: SettingRecord) => T | null;
  toForm: (value: T) => F;
  fromForm: (form: F) => { value: T } | { error: string };
}

export function useSettingEditor<T, F>(config: SettingEditorConfig<T, F>) {
  const { refresh } = useAppConfig();
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const [form, setForm] = useState<F | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    setDetail(null);
    try {
      const answer = await getSetting(config.key);
      if (!answer.ok) {
        setProblem(settingRefusalKey(answer.reason));
        return;
      }
      const value = config.read(answer);
      if (value === null) {
        // A stored document this build cannot read is not edited blindly: a
        // save would send back whatever the form made of it.
        setProblem('admin.settings.refusal.invalidValue');
        return;
      }
      setLoaded({ value, version: answer.version, updatedAt: answer.updatedAt, updatedBy: answer.updatedBy });
      setForm(config.toForm(value));
    } catch (err) {
      setProblem('admin.settings.loadFailed');
      setDetail(err instanceof Error ? err.message : null);
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!form || !loaded) return;
    const parsed = config.fromForm(form);
    if ('error' in parsed) {
      showToast('error', t('admin.settings.invalidField', { field: parsed.error }));
      return;
    }

    setSaving(true);
    try {
      const answer = await putSetting(config.key, parsed.value, loaded.version);
      if (!answer.ok) {
        showToast('error', t(settingRefusalKey(answer.reason)));
        // Somebody else saved first: show what is there now, so the change is
        // made against their version rather than over it. load() replaces the
        // form, so the unsaved entries are gone — the message says so.
        if (isVersionConflict(answer)) await load();
        return;
      }
      showToast('success', t('admin.settings.saved'));
      setLoaded({ value: parsed.value, version: answer.version, updatedAt: answer.updatedAt, updatedBy: answer.updatedBy });
      // The stored document, not what was typed: trimmed as the database has it.
      setForm(config.toForm(parsed.value));
      // The trial and the feature flags reach AppConfigContext; refreshing for
      // every key keeps one path.
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('admin.settings.refusal.failed'));
    } finally {
      setSaving(false);
    }
  };

  return { loading, problem, detail, loaded, form, setForm, saving, load, save };
}

// ─── Small controls ──────────────────────────────────────────────────────────

export const SaveRow: React.FC<{ saving: boolean; onSave: () => void; disabled?: boolean }> = ({ saving, onSave, disabled }) => {
  const { t } = useTranslation();
  const off = saving || !!disabled;
  return (
    <div className="flex justify-end">
      <button
        onClick={onSave}
        disabled={off}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold"
        // A label on a filled background is --text-inverse, never a fixed white:
        // the dark theme's accent is light enough that white on it fails contrast.
        style={{ background: 'var(--accent)', color: 'var(--text-inverse)', opacity: off ? 0.6 : 1 }}
      >
        <Save size={16} />{saving ? t('admin.common.saving') : t('admin.settings.save')}
      </button>
    </div>
  );
};

export const Field: React.FC<{
  labelKey: TranslationKey;
  value: string;
  disabled: boolean;
  width?: string;
  onChange: (value: string) => void;
  type?: string;
}> = ({ labelKey, value, disabled, width, onChange, type }) => {
  const { t } = useTranslation();
  return (
    <label className="block">
      <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
        {t(labelKey)}
      </span>
      <input
        type={type ?? 'text'}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        style={{ ...controlStyle, width: width ?? '100%', opacity: disabled ? 0.6 : 1 }}
      />
    </label>
  );
};

export const Note: React.FC<{ textKey: TranslationKey; vars?: TranslationVars }> = ({ textKey, vars }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-xl p-3 text-xs"
      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
      <Info size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--text-tertiary)' }} />
      <span>{t(textKey, vars)}</span>
    </div>
  );
};
