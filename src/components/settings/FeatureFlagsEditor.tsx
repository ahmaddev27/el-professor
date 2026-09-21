import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { canSaveSetting } from '../../lib/platformSettings';
import {
  FLAGS_MAX,
  flagsFromRows,
  flagsToRows,
  isFlagKey,
  parseFeatureFlags,
  type FeatureFlags,
  type FlagRow,
} from '../../lib/featureFlags';
import {
  cardStyle,
  controlStyle,
  EditorShell,
  Note,
  SaveRow,
  useSettingEditor,
  type SettingEditorConfig,
} from './settingsEditorKit';

/**
 * Feature-Flags (plan 3.11): the `feature_flags` setting, a switch per name.
 *
 * A flag the map does not name is off, so removing a flag switches it off, and
 * a build can ship a flag-guarded screen before anybody writes the flag. The
 * flags reach every signed-in screen through `get_app_config()` — at once for
 * this tab, and for every other open session the next time it reads its
 * configuration (on sign-in, and when a tab regains focus after five minutes).
 */

const FLAGS_EDITOR: SettingEditorConfig<FeatureFlags, FlagRow[]> = {
  key: 'feature_flags',
  read: record => parseFeatureFlags(record.value),
  toForm: flagsToRows,
  fromForm: flagsFromRows,
};

const FeatureFlagsEditor: React.FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { t } = useTranslation();
  const maySave = canSaveSetting(platformAccess, 'feature_flags');
  const { loading, problem, detail, loaded, form, setForm, saving, load, save } = useSettingEditor(FLAGS_EDITOR);
  const [newKey, setNewKey] = useState('');

  const candidate = newKey.trim();
  const duplicate = !!form?.some(row => row.key === candidate);
  const canAdd = !!form && isFlagKey(candidate) && !duplicate && form.length < FLAGS_MAX;

  return (
    <EditorShell
      loading={loading}
      problem={problem}
      detail={detail}
      onReload={() => void load()}
      version={loaded?.version ?? null}
      updatedAt={loaded?.updatedAt ?? null}
    >
      {form && (
        <>
          <Note textKey="admin.flags.hint" />
          {!maySave && <Note textKey="admin.settings.readOnly" />}

          <div className="rounded-2xl overflow-hidden" style={cardStyle}>
            {form.length === 0 ? (
              <p className="px-5 py-6 text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('admin.flags.none')}</p>
            ) : (
              <ul>
                {form.map((row, index) => (
                  <li key={row.key} className="flex items-center justify-between gap-3 px-5 py-3"
                    style={{ borderBottom: index < form.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <code className="text-sm break-all" style={{ color: 'var(--text-primary)' }}>{row.key}</code>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          disabled={!maySave}
                          onChange={e => {
                            const rows = [...form];
                            rows[index] = { ...row, enabled: e.target.checked };
                            setForm(rows);
                          }}
                        />
                        {t(row.enabled ? 'admin.flags.on' : 'admin.flags.off')}
                      </label>
                      {maySave && (
                        <button
                          onClick={() => setForm(form.filter((_, i) => i !== index))}
                          className="p-1.5 rounded-lg"
                          style={{ color: 'var(--danger)' }}
                          title={t('admin.flags.remove')}
                          aria-label={t('admin.flags.remove')}
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {maySave && (
            <div className="rounded-2xl p-5 space-y-2" style={cardStyle}>
              <label className="block text-xs font-semibold" style={{ color: 'var(--text-secondary)' }} htmlFor="new-flag">
                {t('admin.flags.newLabel')}
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  id="new-flag"
                  value={newKey}
                  onChange={e => setNewKey(e.target.value)}
                  placeholder="new_export"
                  style={{ ...controlStyle, flex: '1 1 12rem' }}
                />
                <button
                  onClick={() => {
                    setForm([...form, { key: candidate, enabled: false }]);
                    setNewKey('');
                  }}
                  disabled={!canAdd}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold"
                  style={{ background: 'var(--accent-subtle)', color: 'var(--accent)', opacity: canAdd ? 1 : 0.5 }}
                >
                  <Plus size={14} />{t('admin.flags.add')}
                </button>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {duplicate ? t('admin.flags.duplicate') : t('admin.flags.keyRule')}
              </p>
            </div>
          )}

          {maySave && <SaveRow saving={saving} onSave={() => void save()} />}
        </>
      )}
    </EditorShell>
  );
};

export default FeatureFlagsEditor;
