import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Info, AlertTriangle } from 'lucide-react';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { useAppConfig } from '../../contexts/AppConfigContext';
import { useToast } from '../../contexts/ToastContext';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import type { Plan } from '../../contexts/PlanContext';
import { supabase } from '../../lib/supabase';
import { canWriteAnnouncements } from '../../lib/platformSettings';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_PLANS,
  ANNOUNCEMENT_TITLE_MAX,
  announcementFromForm,
  announcementRefusalKey,
  announcementState,
  announcementToForm,
  emptyAnnouncementForm,
  toIsoInstant,
  type Announcement,
  type AnnouncementAudience,
  type AnnouncementForm,
  type AnnouncementState,
  type PanelAnnouncement,
} from '../../lib/announcements';
import { deleteAnnouncement, listAnnouncements, saveAnnouncement } from '../../lib/announcementsClient';
import { deDateTimeMinute } from '../../lib/platformFormat';
import { AnnouncementItem } from '../AnnouncementBanner';
import { cardStyle, controlStyle, EditorShell, Note } from './settingsEditorKit';

/**
 * Ankündigungen (plan 3.11): what the platform shows the companies it is meant
 * for, above every tenant screen, for as long as it is meant to show.
 *
 * Each announcement is its own row with its own version, so two owners editing
 * two announcements never collide, and one editing a stale copy is refused and
 * shown the current one. A save needs `settings.manage` (owner only); the list
 * needs `settings.read`, which billing holds for the prices alone.
 *
 * The window is typed as a wall-clock time here, in the browser's zone — Berlin
 * for the people who use this screen — and leaves the browser as the instant it
 * names (`toIsoInstant`). The database refuses a time without an offset, so no
 * zone is ever guessed.
 */

const STATE_STYLE: Record<AnnouncementState, { bg: string; color: string; labelKey: TranslationKey }> = {
  showing:   { bg: 'var(--success-subtle)', color: 'var(--success)',       labelKey: 'admin.announcements.state.showing' },
  scheduled: { bg: 'var(--accent-subtle)',  color: 'var(--accent)',        labelKey: 'admin.announcements.state.scheduled' },
  ended:     { bg: 'var(--bg-subtle)',      color: 'var(--text-tertiary)', labelKey: 'admin.announcements.state.ended' },
};

const PLAN_LABELS: Record<Plan, TranslationKey> = {
  basic:    'admin.settings.plan.basic',
  advanced: 'admin.settings.plan.advanced',
  premium:  'admin.settings.plan.premium',
};

interface CompanyOption {
  id: string;
  name: string;
}

/** The field a refusal names, as a label the owner recognises. */
const FIELD_LABELS: Record<string, TranslationKey> = {
  'announcement.tone':        'admin.announcements.field.tone',
  'announcement.title_de':    'admin.announcements.field.titleDe',
  'announcement.body_de':     'admin.announcements.field.bodyDe',
  'announcement.title_en':    'admin.announcements.field.titleEn',
  'announcement.body_en':     'admin.announcements.field.bodyEn',
  'announcement.english':     'admin.announcements.field.english',
  'announcement.audience':    'admin.announcements.field.audience',
  'announcement.plans':       'admin.announcements.field.plans',
  'announcement.company_ids': 'admin.announcements.field.companies',
  'announcement.starts_at':   'admin.announcements.field.startsAt',
  'announcement.ends_at':     'admin.announcements.field.endsAt',
};

function fieldLabel(path: string): TranslationKey | null {
  return FIELD_LABELS[path] ?? (path.startsWith('announcement.company_ids.') ? FIELD_LABELS['announcement.company_ids'] : null);
}

interface Editing {
  id: string | null;
  version: number | null;
  form: AnnouncementForm;
}

const AnnouncementsEditor: React.FC = () => {
  const { platformAccess } = useSuperAdmin();
  const { refresh } = useAppConfig();
  const { showToast } = useToast();
  const { t } = useTranslation();
  const mayWrite = canWriteAnnouncements(platformAccess);

  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [items, setItems] = useState<PanelAnnouncement[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    setDetail(null);
    try {
      const answer = await listAnnouncements();
      if (!answer.ok) {
        setProblem(announcementRefusalKey(answer.reason));
        return;
      }
      setItems(answer.value);
    } catch (err) {
      setProblem('admin.settings.loadFailed');
      setDetail(err instanceof Error ? err.message : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The names behind the ids a company audience stores. A failed read leaves
  // the ids themselves on screen rather than hiding who an announcement is for.
  useEffect(() => {
    let alive = true;
    void supabase.from('companies').select('id, name').order('name').then(({ data }) => {
      if (alive && Array.isArray(data)) {
        setCompanies(data.filter((c): c is CompanyOption => typeof c?.id === 'string' && typeof c?.name === 'string'));
      }
    });
    return () => { alive = false; };
  }, []);

  const companyName = (id: string) => companies.find(c => c.id === id)?.name ?? id;

  const audienceSummary = (a: PanelAnnouncement): string => {
    if (a.audience === 'all') return t('admin.announcements.audience.all');
    if (a.audience === 'plans') {
      return t('admin.announcements.audience.plansList', { plans: a.plans.map(p => t(PLAN_LABELS[p])).join(', ') });
    }
    return t('admin.announcements.audience.companiesList', {
      count: a.companyIds.length,
      names: a.companyIds.map(companyName).join(', '),
    });
  };

  const save = async () => {
    if (!editing) return;
    const parsed = announcementFromForm(editing.form);
    if ('error' in parsed) {
      const label = fieldLabel(parsed.error);
      showToast('error', t('admin.settings.invalidField', { field: label ? t(label) : parsed.error }));
      return;
    }
    setBusy(true);
    try {
      const answer = await saveAnnouncement(editing.id, parsed.value, editing.version);
      if (!answer.ok) {
        const label = answer.problem ? fieldLabel(answer.problem) : null;
        showToast('error', label
          ? t('admin.settings.invalidField', { field: t(label) })
          : t(announcementRefusalKey(answer.reason)));
        // Somebody else saved first: show what is there now and close the
        // stale copy, rather than offer to send it again over their change.
        if (answer.reason === 'version_conflict' || answer.reason === 'not_found') {
          setEditing(null);
          await load();
        }
        return;
      }
      showToast('success', t('admin.settings.saved'));
      setEditing(null);
      await load();
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('admin.settings.refusal.failed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: PanelAnnouncement) => {
    setBusy(true);
    try {
      const answer = await deleteAnnouncement(a.id, a.version);
      if (!answer.ok) {
        showToast('error', t(announcementRefusalKey(answer.reason)));
      } else {
        showToast('success', t('admin.announcements.deleted'));
      }
      setConfirmDelete(null);
      await load();
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('admin.settings.refusal.failed'));
    } finally {
      setBusy(false);
    }
  };

  const now = Date.now();

  return (
    <EditorShell loading={loading} problem={problem} detail={detail} onReload={() => void load()}
      version={null} updatedAt={null}>
      <Note textKey="admin.announcements.hint" />
      {!mayWrite && <Note textKey="admin.settings.readOnly" />}

      {mayWrite && !editing && (
        <div className="flex justify-end">
          <button
            onClick={() => setEditing({ id: null, version: null, form: emptyAnnouncementForm() })}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
          >
            <Plus size={15} />{t('admin.announcements.new')}
          </button>
        </div>
      )}

      {editing && (
        <AnnouncementFormCard
          editing={editing}
          companies={companies}
          busy={busy}
          onChange={form => setEditing({ ...editing, form })}
          onCancel={() => setEditing(null)}
          onSave={() => void save()}
        />
      )}

      {items.length === 0 ? (
        <div className="rounded-2xl px-5 py-8 text-center text-sm" style={{ ...cardStyle, color: 'var(--text-tertiary)' }}>
          {t('admin.announcements.none')}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(a => {
            const state = STATE_STYLE[announcementState(a, now)];
            const ToneIcon = a.tone === 'warning' ? AlertTriangle : Info;
            return (
              <div key={a.id} className="rounded-2xl p-4 space-y-2" style={cardStyle}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-start gap-2 min-w-0">
                    <ToneIcon size={16} className="flex-shrink-0 mt-0.5"
                      style={{ color: a.tone === 'warning' ? 'var(--warning)' : 'var(--accent)' }} />
                    <div className="min-w-0">
                      <p className="font-semibold break-words" style={{ color: 'var(--text-primary)' }}>{a.titleDe}</p>
                      <p className="text-sm break-words" style={{ color: 'var(--text-secondary)' }}>{a.bodyDe}</p>
                    </div>
                  </div>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                    style={{ background: state.bg, color: state.color }}>
                    {t(state.labelKey)}
                  </span>
                </div>
                <div className="text-xs space-y-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  <p>{a.endsAt
                    ? t('admin.announcements.window', { from: deDateTimeMinute(a.startsAt), to: deDateTimeMinute(a.endsAt) })
                    : t('admin.announcements.windowOpen', { from: deDateTimeMinute(a.startsAt) })}</p>
                  <p>{audienceSummary(a)}</p>
                  {a.titleEn && <p>{t('admin.announcements.hasEnglish')}</p>}
                </div>
                {mayWrite && (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {confirmDelete === a.id ? (
                      <>
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('admin.announcements.confirmDelete')}</span>
                        <button onClick={() => void remove(a)} disabled={busy}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                          // A -solid fill takes a white label in both themes (accentLabel.contrast.test.ts).
                          style={{ background: 'var(--danger-solid)', color: 'white' }}>
                          {t('admin.announcements.delete')}
                        </button>
                        <button onClick={() => setConfirmDelete(null)}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                          style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
                          {t('admin.announcements.cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => setEditing({ id: a.id, version: a.version, form: announcementToForm(a) })}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
                          style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                          <Pencil size={13} />{t('admin.announcements.edit')}
                        </button>
                        <button onClick={() => setConfirmDelete(a.id)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
                          style={{ color: 'var(--danger)' }}>
                          <Trash2 size={13} />{t('admin.announcements.delete')}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </EditorShell>
  );
};

// ─── The form ────────────────────────────────────────────────────────────────

const AnnouncementFormCard: React.FC<{
  editing: Editing;
  companies: CompanyOption[];
  busy: boolean;
  onChange: (form: AnnouncementForm) => void;
  onCancel: () => void;
  onSave: () => void;
}> = ({ editing, companies, busy, onChange, onCancel, onSave }) => {
  const { t } = useTranslation();
  const { form } = editing;
  const [search, setSearch] = useState('');
  const set = <K extends keyof AnnouncementForm>(key: K, value: AnnouncementForm[K]) => onChange({ ...form, [key]: value });
  const input = { ...controlStyle, width: '100%' };

  // What a tenant would see, in both languages, from what is typed.
  const startsAt = toIsoInstant(form.startsLocal) ?? new Date().toISOString();
  const preview: Announcement = {
    id: 'preview',
    version: 0,
    tone: form.tone,
    titleDe: form.titleDe.trim() || t('admin.announcements.previewTitle'),
    bodyDe: form.bodyDe.trim() || t('admin.announcements.previewBody'),
    titleEn: form.titleEn.trim(),
    bodyEn: form.bodyEn.trim(),
    startsAt,
    endsAt: null,
  };

  const needle = search.trim().toLowerCase();
  const shown = needle ? companies.filter(c => c.name.toLowerCase().includes(needle)) : companies;

  const label = (key: TranslationKey, extra?: string) => (
    <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
      {t(key)}{extra ? <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}> {extra}</span> : null}
    </span>
  );

  return (
    <div className="rounded-2xl p-5 space-y-4" style={{ ...cardStyle, borderColor: 'var(--accent)' }}>
      <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>
        {t(editing.id ? 'admin.announcements.editTitle' : 'admin.announcements.newTitle')}
      </h2>

      <label className="block sm:w-64">
        {label('admin.announcements.field.tone')}
        <select value={form.tone} onChange={e => set('tone', e.target.value as AnnouncementForm['tone'])} style={input}>
          <option value="info">{t('admin.announcements.tone.info')}</option>
          <option value="warning">{t('admin.announcements.tone.warning')}</option>
        </select>
      </label>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <label className="block">
            {label('admin.announcements.field.titleDe')}
            <input value={form.titleDe} maxLength={ANNOUNCEMENT_TITLE_MAX} onChange={e => set('titleDe', e.target.value)} style={input} />
          </label>
          <label className="block">
            {label('admin.announcements.field.bodyDe')}
            <textarea value={form.bodyDe} maxLength={ANNOUNCEMENT_BODY_MAX} rows={3}
              onChange={e => set('bodyDe', e.target.value)} style={{ ...input, resize: 'vertical' }} />
          </label>
        </div>
        <div className="space-y-3">
          <label className="block">
            {label('admin.announcements.field.titleEn', t('admin.announcements.optional'))}
            <input value={form.titleEn} maxLength={ANNOUNCEMENT_TITLE_MAX} onChange={e => set('titleEn', e.target.value)} style={input} />
          </label>
          <label className="block">
            {label('admin.announcements.field.bodyEn', t('admin.announcements.optional'))}
            <textarea value={form.bodyEn} maxLength={ANNOUNCEMENT_BODY_MAX} rows={3}
              onChange={e => set('bodyEn', e.target.value)} style={{ ...input, resize: 'vertical' }} />
          </label>
        </div>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('admin.announcements.englishHint')}</p>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          {t('admin.announcements.field.audience')}
        </legend>
        <div className="flex flex-wrap gap-4">
          {(['all', 'plans', 'companies'] as AnnouncementAudience[]).map(audience => (
            <label key={audience} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
              <input type="radio" name="audience" checked={form.audience === audience}
                onChange={() => set('audience', audience)} />
              {t(`admin.announcements.audience.${audience}` as TranslationKey)}
            </label>
          ))}
        </div>

        {form.audience === 'plans' && (
          <div className="flex flex-wrap gap-4 pl-1">
            {ANNOUNCEMENT_PLANS.map(plan => (
              <label key={plan} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={form.plans.includes(plan)}
                  onChange={e => set('plans', e.target.checked
                    ? [...form.plans, plan]
                    : form.plans.filter(p => p !== plan))} />
                {t(PLAN_LABELS[plan])}
              </label>
            ))}
          </div>
        )}

        {form.audience === 'companies' && (
          <div className="space-y-2">
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder={t('admin.announcements.searchCompanies')} style={input} />
            <div className="max-h-48 overflow-y-auto rounded-xl p-2 space-y-1" style={{ border: '1px solid var(--border)' }}>
              {shown.length === 0 ? (
                <p className="text-xs px-1 py-2" style={{ color: 'var(--text-tertiary)' }}>{t('admin.announcements.noCompanies')}</p>
              ) : shown.map(c => (
                <label key={c.id} className="flex items-center gap-2 text-sm px-1" style={{ color: 'var(--text-primary)' }}>
                  <input type="checkbox" checked={form.companyIds.includes(c.id)}
                    onChange={e => set('companyIds', e.target.checked
                      ? [...form.companyIds, c.id]
                      : form.companyIds.filter(id => id !== c.id))} />
                  {c.name}
                </label>
              ))}
            </div>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('admin.announcements.companiesChosen', { count: form.companyIds.length })}
            </p>
          </div>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          {label('admin.announcements.field.startsAt')}
          <input type="datetime-local" value={form.startsLocal} onChange={e => set('startsLocal', e.target.value)} style={input} />
        </label>
        <label className="block">
          {label('admin.announcements.field.endsAt', t('admin.announcements.optional'))}
          <input type="datetime-local" value={form.endsLocal} onChange={e => set('endsLocal', e.target.value)} style={input} />
        </label>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('admin.announcements.windowHint')}</p>

      <div className="space-y-2">
        <p className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('admin.announcements.preview')}</p>
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          <AnnouncementItem announcement={preview} language="de" dismissLabel={t('announcement.dismiss')} />
          <AnnouncementItem announcement={preview} language="en" dismissLabel={t('announcement.dismiss')} />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-xl text-sm font-semibold"
          style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
          {t('admin.announcements.cancel')}
        </button>
        <button onClick={onSave} disabled={busy} className="px-5 py-2 rounded-xl text-sm font-semibold"
          style={{ background: 'var(--accent)', color: 'var(--text-inverse)', opacity: busy ? 0.6 : 1 }}>
          {busy ? t('admin.common.saving') : t('admin.settings.save')}
        </button>
      </div>
    </div>
  );
};

export default AnnouncementsEditor;
