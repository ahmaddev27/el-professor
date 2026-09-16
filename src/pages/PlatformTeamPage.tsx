import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert, Info, UserPlus, Mail, Ban, CheckCircle, Users } from 'lucide-react';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { PlatformRpcError } from '../lib/platformRpc';
import {
  addStaffMember,
  disableStaffMember,
  enableStaffMember,
  inviteStaffMember,
  loadStaffRoster,
  resendStaffInvite,
} from '../lib/platformStaffClient';
import {
  isUserId,
  staffRefusalHintKey,
  wouldRemoveLastOwner,
  type StaffMember,
} from '../lib/platformStaffRoster';
import { auditRefusalKey } from '../lib/platformAuditLog';
import { EMPTY_CELL, deDateTime, shortId } from '../lib/platformFormat';

/**
 * Team — the platform staff (plan 3.5 / 3.12).
 *
 * ## Where the list comes from
 *
 * `app_private.platform_staff` is in a schema PostgREST does not serve, and no
 * merged read model lists it: `platform_users_list` deliberately excludes every
 * account that has a staff row. What does exist is the append-only record —
 * `app_private.platform_staff_audit()` writes the whole row on every insert,
 * update and delete, whichever path made the change — so the roster is folded
 * out of `platform_audit_list`. That needs `audit.read`, which today is the
 * same role that holds `staff.manage`.
 *
 * Four consequences the screen states rather than hides: the log records the
 * staff row and not the account, so a member is identified by user id; the
 * trigger records the row and not the actor, so the list cannot say who granted
 * a membership; it shows only memberships whose log entries still exist, so
 * audit retention (decision D4) would make a member with full access disappear
 * from it; and a roster that reached the page limit, or that met a row it could
 * not parse, says so instead of looking complete.
 *
 * Only successful rows are folded. The `platform_staff.` prefix also matches the
 * RPCs' `denied` rows, which any non-owner can produce at 30 a minute, so the
 * read asks for `outcome: 'ok'` — see `platformStaffClient.ts`.
 *
 * ## Only owner
 *
 * `platform_staff_add` and `platform_staff_enable` refuse any other role with
 * reason `role_requires_3_3` and write a `denied` row; this screen offers no
 * other role, and shows that refusal in full if one ever arrives. The policy
 * argument the reason is named after is spent — 20260917130000 moved the tenant
 * policies onto capabilities — so lifting the refusal is a migration that
 * redefines those two functions, plan step 3.12.
 *
 * ## The last active owner
 *
 * `platform_staff_disable` refuses it with `last_owner`, and the table's own
 * trigger raises underneath. The button is disabled for that member so the only
 * possible outcome is not offered as an action.
 */

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
};

const controlStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.625rem 0.75rem',
  borderRadius: '0.75rem',
  fontSize: '0.875rem',
  background: 'var(--bg-subtle)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
};

const thStyle: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: '0.7rem',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const PlatformTeamPage: React.FC = () => {
  const { platformCan } = useSuperAdmin();
  const { showToast } = useToast();
  const { t } = useTranslation();

  const mayManage = platformCan('staff.manage');
  const mayReadRoster = platformCan('audit.read');

  const [members, setMembers] = useState<StaffMember[]>([]);
  const [truncated, setTruncated] = useState(false);
  /** Trigger rows this build could not read; those members are missing below. */
  const [unreadable, setUnreadable] = useState(0);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteNote, setInviteNote] = useState('');
  const [inviting, setInviting] = useState(false);

  const [addUserId, setAddUserId] = useState('');
  const [addNote, setAddNote] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!mayReadRoster) return;
    setLoading(true);
    setProblem(null);
    setDetail(null);
    try {
      const result = await loadStaffRoster();
      if (!result.ok) {
        setMembers([]);
        setUnreadable(0);
        setProblem(auditRefusalKey(result.reason));
        return;
      }
      setMembers(result.members);
      setTruncated(result.truncated);
      setUnreadable(result.unreadable);
    } catch (err) {
      setMembers([]);
      setUnreadable(0);
      setProblem('admin.read.failed');
      setDetail(err instanceof Error ? err.message : null);
    } finally {
      setLoading(false);
    }
  }, [mayReadRoster]);

  useEffect(() => { void load(); }, [load]);

  /** Reports a refused RPC as the database worded it, plus the rule behind it. */
  const reportFailure = (err: unknown) => {
    const message = err instanceof Error ? err.message : t('admin.team.failed');
    const hint = err instanceof PlatformRpcError ? staffRefusalHintKey(err.reason) : null;
    showToast('error', message, hint ? t(hint) : undefined);
  };

  const runOnMember = async (userId: string, action: () => Promise<unknown>, successKey: TranslationKey) => {
    setBusy(userId);
    try {
      await action();
      showToast('success', t(successKey));
      await load();
    } catch (err) {
      reportFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setInviting(true);
    try {
      await inviteStaffMember(inviteEmail, inviteName, inviteNote || null);
      showToast('success', t('admin.team.invite.success'));
      setInviteEmail('');
      setInviteName('');
      setInviteNote('');
      await load();
    } catch (err) {
      reportFailure(err);
    } finally {
      setInviting(false);
    }
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isUserId(addUserId)) {
      showToast('error', t('admin.team.invalidUserId'));
      return;
    }
    setAdding(true);
    try {
      await addStaffMember(addUserId, addNote || null);
      showToast('success', t('admin.team.add.success'));
      setAddUserId('');
      setAddNote('');
      await load();
    } catch (err) {
      reportFailure(err);
    } finally {
      setAdding(false);
    }
  };

  if (!mayManage) {
    return (
      <div className="flex flex-col items-center justify-center py-20 rounded-2xl text-center" style={cardStyle}>
        <ShieldAlert size={40} className="mb-3" style={{ color: 'var(--warning)' }} />
        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('admin.read.denied')}</p>
        <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>{t('admin.team.noAccessBody')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.team.title')}</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('admin.team.subtitle')}</p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium"
          style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />{t('admin.common.refresh')}
        </button>
      </div>

      <Note text={t('admin.team.roleNote')} />

      {/* The roster */}
      {!mayReadRoster ? (
        <Note text={t('admin.team.rosterUnavailable')} />
      ) : loading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={24} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
        </div>
      ) : problem ? (
        <div className="flex flex-col items-center justify-center py-16 rounded-2xl text-center px-6" style={cardStyle}>
          <ShieldAlert size={32} className="mb-3" style={{ color: 'var(--warning)' }} />
          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t(problem)}</p>
          {detail && <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>{detail}</p>}
        </div>
      ) : (
        <>
          <Note text={t('admin.team.sourceNote')} />
          {truncated && <Note text={t('admin.team.truncated')} />}
          {/* A row that could not be parsed removed that member from the fold,
              so the omission is named rather than left to look like an absence. */}
          {unreadable > 0 && <Note text={t('admin.team.unreadable', { count: unreadable })} />}

          {members.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 rounded-2xl" style={cardStyle}>
              <Users size={36} className="mb-3" style={{ color: 'var(--text-tertiary)' }} />
              <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('admin.team.empty')}</p>
            </div>
          ) : (
            <div className="rounded-2xl overflow-hidden" style={cardStyle}>
              <div style={{ overflowX: 'auto' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {([
                        'admin.team.col.member', 'admin.team.col.role', 'admin.team.col.status',
                        'admin.team.col.note', 'admin.team.col.changed',
                      ] as const).map(key => (
                        <th key={key} className="px-5 py-3.5 text-left" style={thStyle}>{t(key)}</th>
                      ))}
                      <th style={thStyle} />
                    </tr>
                  </thead>
                  <tbody>
                    {members.map(member => {
                      const active = member.disabledAt === null;
                      const isLastOwner = wouldRemoveLastOwner(members, member.userId);
                      const working = busy === member.userId;
                      return (
                        <tr key={member.userId} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td className="px-5 py-4">
                            <p className="font-semibold" style={{ color: 'var(--text-primary)' }} title={member.userId}>
                              {shortId(member.userId)}
                            </p>
                            <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                              {t('admin.team.since', { date: deDateTime(member.createdAt) })}
                            </p>
                          </td>
                          <td className="px-5 py-4">
                            <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold"
                              style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
                              {t(`admin.role.${member.role}` as TranslationKey)}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold"
                              style={active
                                ? { background: 'var(--success-subtle)', color: 'var(--success)' }
                                : { background: 'var(--bg-muted)', color: 'var(--text-tertiary)' }}>
                              {t(active ? 'admin.team.status.active' : 'admin.team.status.disabled')}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {member.note || EMPTY_CELL}
                          </td>
                          <td className="px-5 py-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {deDateTime(member.changedAt)}
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-2 justify-end">
                              {/* `otp_issue` issues an invite_activate code only
                                  for a profile still in `pending_invite`, so for
                                  an activated member the send fails and the
                                  route answers by suggesting this very button.
                                  A disabled member has no invitation to accept
                                  at all, so it is not offered there; whether an
                                  active member has already activated is not
                                  knowable here — the roster reads the staff
                                  table's log, and no read model returns a staff
                                  account's profile — so the title says so. */}
                              {active && (
                                <button
                                  onClick={() => void runOnMember(member.userId, () => resendStaffInvite(member.userId), 'admin.team.invite.resent')}
                                  disabled={working}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
                                  style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', opacity: working ? 0.6 : 1 }}
                                  title={t('admin.team.resendInviteHint')}
                                >
                                  <Mail size={13} />{t('admin.team.resendInvite')}
                                </button>
                              )}
                              {active ? (
                                <button
                                  onClick={() => void runOnMember(member.userId, () => disableStaffMember(member.userId), 'admin.team.disabled')}
                                  disabled={working || isLastOwner}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
                                  style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', opacity: working || isLastOwner ? 0.5 : 1 }}
                                  title={isLastOwner ? t('admin.team.hint.lastOwner') : t('admin.team.disable')}
                                >
                                  <Ban size={13} />{t('admin.team.disable')}
                                </button>
                              ) : (
                                <button
                                  onClick={() => void runOnMember(member.userId, () => enableStaffMember(member.userId), 'admin.team.enabled')}
                                  disabled={working}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
                                  style={{ background: 'var(--success-subtle)', color: 'var(--success)', opacity: working ? 0.6 : 1 }}
                                >
                                  <CheckCircle size={13} />{t('admin.team.enable')}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Adding somebody */}
      <div className="grid gap-4 lg:grid-cols-2">
        <form onSubmit={invite} className="rounded-2xl p-5 space-y-3" style={cardStyle}>
          <h2 className="font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <UserPlus size={16} />{t('admin.team.invite.title')}
          </h2>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('admin.team.invite.hint')}</p>
          <label className="block">
            <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              {t('admin.team.invite.email')}
            </span>
            <input type="email" required value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} style={controlStyle} />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              {t('admin.team.invite.fullName')}
            </span>
            <input required value={inviteName} onChange={e => setInviteName(e.target.value)} style={controlStyle} />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              {t('admin.team.note')}
            </span>
            <input value={inviteNote} maxLength={500} onChange={e => setInviteNote(e.target.value)} style={controlStyle} />
          </label>
          <button type="submit" disabled={inviting}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'var(--accent)', opacity: inviting ? 0.6 : 1 }}>
            {inviting ? t('admin.common.saving') : t('admin.team.invite.submit')}
          </button>
        </form>

        <form onSubmit={add} className="rounded-2xl p-5 space-y-3" style={cardStyle}>
          <h2 className="font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <UserPlus size={16} />{t('admin.team.add.title')}
          </h2>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('admin.team.add.hint')}</p>
          <label className="block">
            <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              {t('admin.team.add.userId')}
            </span>
            <input required value={addUserId} onChange={e => setAddUserId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000" style={controlStyle} />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              {t('admin.team.note')}
            </span>
            <input value={addNote} maxLength={500} onChange={e => setAddNote(e.target.value)} style={controlStyle} />
          </label>
          <button type="submit" disabled={adding}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold"
            style={{ border: '1px solid var(--border)', color: 'var(--text-primary)', opacity: adding ? 0.6 : 1 }}>
            {adding ? t('admin.common.saving') : t('admin.team.add.submit')}
          </button>
        </form>
      </div>
    </div>
  );
};

/** Takes the finished sentence, so a note may carry interpolated values. */
const Note: React.FC<{ text: string }> = ({ text }) => (
  <div className="flex items-start gap-2 rounded-xl p-3 text-xs"
    style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
    <Info size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--text-tertiary)' }} />
    <span>{text}</span>
  </div>
);

export default PlatformTeamPage;
