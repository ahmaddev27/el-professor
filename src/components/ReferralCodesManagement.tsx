import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { Plus, CreditCard as Edit2, Trash2, RefreshCw, Gift, Check, X, ToggleLeft, ToggleRight } from 'lucide-react';
import { referralUsageCounts } from '../lib/panelFigures';
import { Alert } from './ui';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

interface ReferralCode {
  id: string;
  ref_code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  /**
   * Null where the companies this is counted over were not read. It used to be
   * `usageMap[r.ref_code] ?? 0`, so a failed company read in the parent made
   * every code report a confident `0 Nutzungen` — the one figure this section
   * exists to report. See referralUsageCounts() for the rule.
   */
  usage_count?: number | null;
}

interface CompanyRow {
  id: string;
  name: string;
  referral_code_used: string | null;
  created_at: string;
}

interface Props {
  companies: CompanyRow[];
  /**
   * Whether `companies` is the platform's companies, or whatever was left after
   * a read that did not succeed. The parent sets it false in its catch; where it
   * is false, every usage figure here is unknown rather than zero, and the
   * screen says so instead of counting.
   */
  companiesKnown: boolean;
}

const emptyForm = { ref_code: '', name: '', description: '' };

// Holds TranslationKeys: this list is module-level and t() is a hook value. The
// trailing empty key labels the action column, which has no header.
const TABLE_HEADER_KEYS: (TranslationKey | null)[] = [
  'codes.col.code',
  'codes.col.name',
  'codes.col.usages',
  'common.status',
  'codes.details.created',
  null,
];

export default function ReferralCodesManagement({ companies, companiesKnown }: Props) {
  const { showToast } = useToast();
  const { t, tPlural } = useTranslation();
  const [referrals, setReferrals] = useState<ReferralCode[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * The `referrals` read itself failed. Distinct from `companiesKnown`, which is
   * about the list the usage figures are counted over: this one decides whether
   * "Noch keine Empfehlungscodes" may be said at all.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [expandedCode, setExpandedCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const { data, error } = await supabase
        .from('referrals')
        .select('id, ref_code, name, description, is_active, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;

      // Count usage per ref_code — or, where the companies were not read, do
      // not count at all. `referralUsageCounts` answers null per code then.
      const rows = data ?? [];
      const usageMap = referralUsageCounts(rows.map(r => r.ref_code), companies, companiesKnown);

      setReferrals(rows.map(r => ({ ...r, usage_count: usageMap[r.ref_code] ?? null })));
    } catch (err: any) {
      console.error(err);
      setReferrals([]);
      setLoadFailed(true);
      showToast('error', err.message || t('common.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [companies, companiesKnown]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    const code = form.ref_code.trim().toUpperCase();
    const name = form.name.trim();
    if (!code || !name) return;
    setSaving(true);
    try {
      if (editingId) {
        const { error } = await supabase
          .from('referrals')
          .update({ ref_code: code, name, description: form.description.trim() || null, updated_at: new Date().toISOString() })
          .eq('id', editingId);
        if (error) throw error;
        showToast('success', t('codes.referral.updated'));
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        const { error } = await supabase
          .from('referrals')
          .insert({ ref_code: code, name, description: form.description.trim() || null, created_by: user?.id ?? null });
        if (error) throw error;
        showToast('success', t('codes.referral.created'));
      }
      setForm(emptyForm);
      setEditingId(null);
      setShowForm(false);
      load();
    } catch (err: any) {
      showToast('error', err.message || t('codes.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (r: ReferralCode) => {
    try {
      const { error } = await supabase
        .from('referrals')
        .update({ is_active: !r.is_active, updated_at: new Date().toISOString() })
        .eq('id', r.id);
      if (error) throw error;
      showToast('success', t(
        !r.is_active ? 'codes.referral.activated' : 'codes.referral.deactivated',
        { code: r.ref_code },
      ));
      load();
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    }
  };

  const handleDelete = async (r: ReferralCode) => {
    if (!window.confirm(t('codes.referral.deleteConfirm', { code: r.ref_code }))) return;
    try {
      const { error } = await supabase.from('referrals').delete().eq('id', r.id);
      if (error) throw error;
      showToast('success', t('codes.referral.deleted', { code: r.ref_code }));
      load();
    } catch (err: any) {
      showToast('error', err.message || t('common.error'));
    }
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: '1rem',
  };

  const inputClass = 'w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none';
  const inputStyle: React.CSSProperties = { background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' };

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gift size={18} style={{ color: '#10b981' }} />
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('codes.referral.title')}</h2>
          <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>
            {tPlural({ one: 'codes.countCode.one', other: 'codes.countCode.other' }, referrals.length)}
          </span>
        </div>
        <button
          onClick={() => { setShowForm(v => !v); setEditingId(null); setForm(emptyForm); }}
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold transition-opacity hover:opacity-85"
          style={{ background: '#10b981', color: 'white' }}
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? t('common.cancel') : t('codes.referral.newShort')}
        </button>
      </div>

      {/* Create/edit form */}
      {showForm && (
        <div className="p-5 space-y-4" style={cardStyle}>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {editingId ? t('codes.referral.edit') : t('codes.referral.new')}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>{t('codes.discount.codeRequired')}</label>
              <input
                type="text"
                value={form.ref_code}
                onChange={e => setForm(f => ({ ...f, ref_code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') }))}
                placeholder="PARTNER2024"
                className={`${inputClass} font-mono`}
                style={inputStyle}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>{t('codes.referral.nameRequired')}</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder={t('codes.referral.namePlaceholder')}
                className={inputClass}
                style={inputStyle}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>{t('codes.field.descriptionOptional')}</label>
            <input
              type="text"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder={t('codes.referral.descPlaceholder')}
              className={inputClass}
              style={inputStyle}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setShowForm(false); setEditingId(null); setForm(emptyForm); }}
              className="px-4 py-2 rounded-xl text-sm font-semibold"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !form.ref_code.trim() || !form.name.trim()}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-opacity hover:opacity-85 disabled:opacity-50"
              style={{ background: '#10b981', color: 'white' }}
            >
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />}
              {editingId ? t('common.save') : t('codes.actionCreate')}
            </button>
          </div>
        </div>
      )}

      {/*
        Why the Nutzungen column is a dash. The count is taken over the parent's
        company list, so when that list was not read there is no count — and a
        section whose whole point is "how often was this code used" must say that
        rather than print zeroes.
      */}
      {!loadFailed && !companiesKnown && (
        <Alert tone="caution" className="font-ui" title={t('admin.read.failedTitle')}>
          {t('admin.read.countsUnknown')}
        </Alert>
      )}

      {/* Table */}
      <div style={cardStyle} className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <RefreshCw size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
          </div>
        ) : loadFailed ? (
          /* Not "no referral codes yet" — the list was not read. */
          <div className="p-4">
            <Alert tone="critical" className="font-ui" title={t('admin.read.failedTitle')}>
              {t('admin.read.failed')}
            </Alert>
          </div>
        ) : referrals.length === 0 ? (
          <div className="py-10 text-center" style={{ color: 'var(--text-tertiary)' }}>
            <Gift size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('codes.referral.none')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                  {TABLE_HEADER_KEYS.map((key, i) => (
                    <th key={i} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{key ? t(key) : ''}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {referrals.map(r => (
                  <React.Fragment key={r.id}>
                    <tr
                      style={{ borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono text-sm font-bold px-2.5 py-1 rounded-lg" style={{ background: r.is_active ? 'rgba(16,185,129,0.1)' : 'var(--bg-subtle)', color: r.is_active ? '#10b981' : 'var(--text-tertiary)' }}>
                          {r.ref_code}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{r.name}</p>
                        {r.description && <p className="text-[11px] mt-0.5 truncate max-w-[200px]" style={{ color: 'var(--text-tertiary)' }}>{r.description}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setExpandedCode(expandedCode === r.ref_code ? null : r.ref_code)}
                          className="flex items-center gap-1.5 text-sm font-semibold transition-colors"
                          style={{ color: (r.usage_count ?? 0) > 0 ? '#10b981' : 'var(--text-tertiary)' }}
                        >
                          {/* A dash, not a zero, where the companies were not read. */}
                          {r.usage_count ?? '–'}
                          {(r.usage_count ?? 0) > 0 && <span className="text-[10px] font-normal">{t('codes.col.company')}</span>}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleToggleActive(r)}
                          className="flex items-center gap-1.5 text-xs font-semibold transition-opacity hover:opacity-80"
                          style={{ color: r.is_active ? '#10b981' : 'var(--text-tertiary)' }}
                        >
                          {r.is_active ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                          {r.is_active ? t('codes.status.active') : t('codes.status.inactive')}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {format(new Date(r.created_at), 'dd.MM.yyyy', { locale: de })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          <button
                            onClick={() => {
                              setEditingId(r.id);
                              setForm({ ref_code: r.ref_code, name: r.name, description: r.description ?? '' });
                              setShowForm(true);
                            }}
                            className="p-1.5 rounded-lg transition-colors"
                            style={{ color: 'var(--text-tertiary)' }}
                            onMouseEnter={e => { (e.currentTarget.style.background = 'var(--bg-muted)'); (e.currentTarget.style.color = 'var(--accent)'); }}
                            onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--text-tertiary)'); }}
                          >
                            <Edit2 size={13} />
                          </button>
                          <button
                            onClick={() => handleDelete(r)}
                            className="p-1.5 rounded-lg transition-colors"
                            style={{ color: 'var(--text-tertiary)' }}
                            onMouseEnter={e => { (e.currentTarget.style.background = 'var(--danger-subtle)'); (e.currentTarget.style.color = 'var(--danger)'); }}
                            onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--text-tertiary)'); }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {/* Expanded: companies that used this code */}
                    {expandedCode === r.ref_code && (r.usage_count ?? 0) > 0 && (
                      <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
                        <td colSpan={6} className="px-6 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>{t('codes.referral.companiesUsing')}</p>
                          <div className="flex flex-wrap gap-2">
                            {companies
                              .filter(c => c.referral_code_used === r.ref_code)
                              .map(c => (
                                <span key={c.id} className="px-2.5 py-1 rounded-lg text-xs font-medium" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                                  {c.name}
                                  <span className="ml-1.5" style={{ color: 'var(--text-tertiary)' }}>
                                    {format(new Date(c.created_at), 'dd.MM.yy', { locale: de })}
                                  </span>
                                </span>
                              ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
