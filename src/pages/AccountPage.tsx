import React, { useEffect, useState } from 'react';
import { User, Mail, Lock, Eye, EyeOff, AlertCircle, CheckCircle2, Building2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';

const MIN_LEN = 8;

/**
 * The signed-in user's own account: display name, email address, password.
 *
 * Reachable by every authenticated principal, the platform super admin
 * included — PlatformAccountGuard lets this one path through precisely because
 * it shows no tenant data, only the caller's own record.
 *
 * Changing a password re-authenticates first. `supabase.auth.updateUser()`
 * accepts a new password on the strength of the session alone, so without this
 * an unattended logged-in browser is enough to take an account over. The
 * current password is verified with a sign-in call before the update is sent.
 */
const AccountPage: React.FC = () => {
  const { t } = useTranslation();
  const { user, profile, isSuperAdmin } = useAuth();

  const [companyName, setCompanyName] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [email, setEmail] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setFullName(profile?.full_name ?? '');
    setEmail(profile?.email ?? user?.email ?? '');
  }, [profile, user]);

  useEffect(() => {
    if (!profile?.company_id) { setCompanyName(null); return; }
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from('companies').select('name').eq('id', profile.company_id).maybeSingle();
      if (alive) setCompanyName(data?.name ?? null);
    })();
    return () => { alive = false; };
  }, [profile?.company_id]);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setNameMsg(null);
    const trimmed = fullName.trim();
    if (!trimmed) { setNameMsg({ ok: false, text: t('account.error.nameEmpty') }); return; }
    setNameBusy(true);
    const { error } = await supabase
      .from('user_profiles').update({ full_name: trimmed }).eq('user_id', user!.id);
    setNameBusy(false);
    setNameMsg(error
      ? { ok: false, text: error.message }
      : { ok: true, text: t('account.saved.name') });
  };

  const saveEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailMsg(null);
    const next = email.trim().toLowerCase();
    if (!next || !next.includes('@')) { setEmailMsg({ ok: false, text: t('account.error.emailInvalid') }); return; }
    if (next === (profile?.email ?? '').toLowerCase()) { setEmailMsg({ ok: false, text: t('account.error.emailUnchanged') }); return; }

    setEmailBusy(true);
    const { error } = await supabase.auth.updateUser({ email: next });
    if (error) {
      setEmailBusy(false);
      // Changing your own address is the one flow here that cannot complete
      // without mail delivery: the server sends a confirmation link and fails
      // the request when it cannot. Say that, rather than showing the 500 —
      // an administrator can still change the address from the Users screen,
      // which goes through the admin API and needs no confirmation.
      const mailFailure = /5\d\d|mail|smtp|send/i.test(`${error.status ?? ''} ${error.message}`);
      setEmailMsg({ ok: false, text: mailFailure ? t('account.error.emailNoMailer') : error.message });
      return;
    }

    // Keep the profile row in step. It is what every screen reads; auth.users is
    // only consulted at sign-in, so leaving the two apart shows the old address
    // everywhere while the new one is what actually logs in.
    const { error: profErr } = await supabase
      .from('user_profiles').update({ email: next }).eq('user_id', user!.id);
    setEmailBusy(false);
    setEmailMsg(profErr
      ? { ok: false, text: profErr.message }
      : { ok: true, text: t('account.saved.email') });
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (newPw.length < MIN_LEN) { setPwMsg({ ok: false, text: t('account.error.pwShort', { n: String(MIN_LEN) }) }); return; }
    if (newPw !== confirmPw)    { setPwMsg({ ok: false, text: t('account.error.pwMismatch') }); return; }
    if (newPw === currentPw)    { setPwMsg({ ok: false, text: t('account.error.pwSame') }); return; }

    setPwBusy(true);
    // Prove the person at the keyboard knows the current password before
    // accepting a new one. updateUser() would not ask.
    const { error: authErr } = await supabase.auth.signInWithPassword({
      email: profile?.email ?? user?.email ?? '',
      password: currentPw,
    });
    if (authErr) {
      setPwBusy(false);
      setPwMsg({ ok: false, text: t('account.error.pwCurrentWrong') });
      return;
    }

    const { error } = await supabase.auth.updateUser({ password: newPw });
    if (!error && profile?.must_change_password) {
      await supabase.from('user_profiles')
        .update({ must_change_password: false }).eq('user_id', user!.id);
    }
    setPwBusy(false);
    if (error) { setPwMsg({ ok: false, text: error.message }); return; }
    setCurrentPw(''); setNewPw(''); setConfirmPw('');
    setPwMsg({ ok: true, text: t('account.saved.password') });
  };

  const card: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-md)',
  };
  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-muted)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
  };
  const btn = (busy: boolean): React.CSSProperties => ({
    background: busy ? 'var(--bg-muted)' : 'var(--accent)',
    color: busy ? 'var(--text-tertiary)' : '#fff',
    cursor: busy ? 'not-allowed' : 'pointer',
  });

  const Notice: React.FC<{ msg: { ok: boolean; text: string } | null }> = ({ msg }) =>
    !msg ? null : (
      <div
        className="mt-3 flex items-start gap-2 rounded-lg p-3 text-sm"
        style={{
          background: msg.ok ? 'var(--success-subtle)' : 'var(--danger-subtle)',
          color: msg.ok ? 'var(--success)' : 'var(--danger)',
        }}
      >
        {msg.ok ? <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
                : <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />}
        <span>{msg.text}</span>
      </div>
    );

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {t('account.title')}
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          {t('account.subtitle')}
        </p>
      </div>

      {/* Who you are — read-only facts about the account */}
      <div className="rounded-xl p-5" style={card}>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              {t('account.field.role')}
            </p>
            <p className="text-sm font-semibold mt-1 flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
              <ShieldCheck size={14} style={{ color: 'var(--accent)' }} />
              {isSuperAdmin ? t('account.role.superAdmin') : t(`account.role.${profile?.role ?? 'viewer'}` as never)}
            </p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              {t('account.field.company')}
            </p>
            <p className="text-sm font-semibold mt-1 flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
              <Building2 size={14} style={{ color: 'var(--accent)' }} />
              {companyName ?? t('account.company.none')}
            </p>
          </div>
        </div>
      </div>

      {/* Display name */}
      <form onSubmit={saveName} className="rounded-xl p-5" style={card}>
        <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <User size={16} style={{ color: 'var(--accent)' }} />
          {t('account.name.heading')}
        </h3>
        <input
          type="text"
          value={fullName}
          onChange={e => setFullName(e.target.value)}
          className="mt-3 w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
          placeholder={t('account.name.placeholder')}
        />
        <Notice msg={nameMsg} />
        <button type="submit" disabled={nameBusy}
          className="mt-4 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          style={btn(nameBusy)}>
          {nameBusy ? t('common.saving') : t('common.save')}
        </button>
      </form>

      {/* Email */}
      <form onSubmit={saveEmail} className="rounded-xl p-5" style={card}>
        <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <Mail size={16} style={{ color: 'var(--accent)' }} />
          {t('account.email.heading')}
        </h3>
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
          {t('account.email.hint')}
        </p>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="mt-3 w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
          autoComplete="email"
        />
        <Notice msg={emailMsg} />
        <button type="submit" disabled={emailBusy}
          className="mt-4 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          style={btn(emailBusy)}>
          {emailBusy ? t('common.saving') : t('account.email.submit')}
        </button>
      </form>

      {/* Password */}
      <form onSubmit={savePassword} className="rounded-xl p-5" style={card}>
        <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <Lock size={16} style={{ color: 'var(--accent)' }} />
          {t('account.password.heading')}
        </h3>
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
          {t('account.password.hint', { n: String(MIN_LEN) })}
        </p>

        <div className="mt-3 space-y-3">
          <input
            type={showPw ? 'text' : 'password'}
            value={currentPw}
            onChange={e => setCurrentPw(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
            placeholder={t('account.password.current')}
            autoComplete="current-password"
          />
          <div className="relative">
            <input
              type={showPw ? 'text' : 'password'}
              value={newPw}
              onChange={e => setNewPw(e.target.value)}
              className="w-full rounded-lg px-3 py-2 pr-10 text-sm outline-none"
              style={inputStyle}
              placeholder={t('account.password.new')}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPw(v => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1"
              style={{ color: 'var(--text-tertiary)' }}
              aria-label={showPw ? t('account.password.hide') : t('account.password.show')}
            >
              {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <input
            type={showPw ? 'text' : 'password'}
            value={confirmPw}
            onChange={e => setConfirmPw(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
            placeholder={t('account.password.confirm')}
            autoComplete="new-password"
          />
        </div>

        <Notice msg={pwMsg} />
        <button type="submit" disabled={pwBusy}
          className="mt-4 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          style={btn(pwBusy)}>
          {pwBusy ? t('common.saving') : t('account.password.submit')}
        </button>
      </form>
    </div>
  );
};

export default AccountPage;
