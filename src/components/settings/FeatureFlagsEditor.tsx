import React from 'react';
import { Trash2 } from 'lucide-react';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { canSaveSetting } from '../../lib/platformSettings';
import {
  flagDefinition,
  flagsFromRows,
  flagsToRows,
  parseFeatureFlags,
  type FeatureFlags,
  type FlagRow,
} from '../../lib/featureFlags';
import { Badge, Button, Card, cn } from '../ui';
import {
  EditorShell,
  Note,
  SaveRow,
  useSettingEditor,
  type SettingEditorConfig,
} from './settingsEditorKit';

/**
 * Feature-Flags (plan 3.11): the `feature_flags` setting, one switch per flag
 * **this build knows** (`FLAG_DEFINITIONS`), each with what switching it on
 * does.
 *
 * A flag the map does not name is off, so a known flag the stored map is silent
 * about shows as a switch that is off, and switching one off is the same as
 * removing it. The flags reach every signed-in screen through
 * `get_app_config()` — at once for this tab, and for every other open session
 * the next time it reads its configuration (on sign-in, and when a tab regains
 * focus after five minutes).
 *
 * **There is no "new flag" box.** It was here until 24.10.2026 and the owner
 * removed it: a flag belongs in this list because the build reads it, not
 * because somebody typed its name, and typing one ahead of the release that
 * reads it achieves nothing (an absent flag and a flag switched off are the
 * same state). A stored flag this build does not know is still drawn, marked as
 * such and removable — with no add box that removal is the only way to clear a
 * stale flag that arrived by SQL or from an older build.
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

  const hasUnknown = !!form?.some(row => !row.known);

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
          {hasUnknown && <Note textKey="admin.flags.unknownNote" />}
          {!maySave && <Note textKey="admin.settings.readOnly" />}

          <Card className="overflow-hidden font-ui">
            {form.length === 0 ? (
              <p className="px-5 py-6 text-sm text-fg-subtle">{t('admin.flags.none')}</p>
            ) : (
              <ul>
                {form.map((row, index) => {
                  const definition = flagDefinition(row.key);
                  return (
                    <li key={row.key} className={cn('flex items-start justify-between gap-4 px-5 py-4', index < form.length - 1 && 'border-b border-line')}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-fg">
                            {definition ? t(definition.label) : row.key}
                          </span>
                          {!row.known && (
                            <Badge tone="caution">{t('admin.flags.unknown')}</Badge>
                          )}
                        </div>
                        <code className="mt-0.5 block break-all text-xs text-fg-subtle">{row.key}</code>
                        <p className="mt-1.5 text-xs text-fg-muted">
                          {definition ? t(definition.description) : t('admin.flags.unknownDesc')}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <label className="flex items-center gap-2 text-sm text-fg-muted">
                          <input
                            type="checkbox"
                            className="size-4 cursor-pointer accent-brand disabled:cursor-not-allowed"
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
                        {/*
                          Only an unknown flag can be removed. Removing a known one
                          would be the same as switching it off and the registry
                          would draw its row again on the next load, so the button
                          would promise something it cannot do.
                        */}
                        {maySave && !row.known && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setForm(form.filter((_, i) => i !== index))}
                            className="text-critical hover:text-critical"
                            title={t('admin.flags.remove')}
                            aria-label={t('admin.flags.remove')}
                          >
                            <Trash2 size={15} />
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {maySave && <SaveRow saving={saving} onSave={() => void save()} />}
        </>
      )}
    </EditorShell>
  );
};

// ── Presentation (phase 5): the markup above only draws; its logic is unchanged ──

export default FeatureFlagsEditor;
