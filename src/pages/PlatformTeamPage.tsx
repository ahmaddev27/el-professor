import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw, ShieldAlert, Info, UserPlus, Mail, Ban, CheckCircle, Users, Lock, AlertTriangle,
} from 'lucide-react';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey, TranslationVars } from '../i18n';
import { PlatformRpcError } from '../lib/platformRpc';
import { PLATFORM_ROLES } from '../lib/platformAccess';
import { platformReadRefusalKey, type PlatformStaffRow } from '../lib/platformReadModels';
import {
  addStaffMember,
  disableStaffMember,
  enableStaffMember,
  inviteStaffMember,
  loadStaffRoster,
  resendStaffInvite,
} from '../lib/platformStaffClient';
import {
  activeOwnerCount,
  grantedBy,
  isUserId,
  mayReEnable,
  offersResend,
  staffRefusalHintKey,
  wouldRemoveLastOwner,
} from '../lib/platformStaffRoster';
import { deDate, shortId } from '../lib/platformFormat';

/**
 * Team — the platform staff (plan 3.5 / 3.12).
 *
 * ## Where the list comes from
 *
 * `platform_staff_list` (migration 20260920140000) reads the staff table itself,
 * with each member's sign-in address and who granted the membership. It needs
 * `staff.manage`, the same capability as everything else on this page, and each
 * load is one audited read. The roster no longer depends on the audit log, so
 * audit retention (decision D4) cannot make a member with full access vanish
 * from it.
 *
 * ## Only owner
 *
 * `platform_staff_add` and `platform_staff_enable` refuse every other role with
 * reason `role_requires_3_3`. The other roles are not enabled yet — enabling
 * them decides which accounts read every customer's data, and ships as a change
 * of its own. Where a role picker would go, the forms show the one role there is
 * and say so; a disabled member of another role is told it cannot be
 * re-enabled rather than offered a click the database refuses.
 *
 * ## The last active owner
 *
 * `platform_staff_disable` refuses it with `last_owner`, and the table's trigger
 * `platform_staff_keep_owner` raises underneath. The page shows that member as
 * the last active owner instead of a disable button, and says so above the
 * list — but only when it read the whole roster; from a partial one it draws no
 * conclusion and leaves the decision to the database.
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

const labelStyle: React.CSSProperties = { color: 'var(--text-secondary)' };

type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

const roleLabel = (t: Translate, role: string): string =>
  (PLATFORM_ROLES as readonly string[]).includes(role) ? t(`admin.role.${role}` as TranslationKey) : role;

interface MemberView {
  member: PlatformStaffRow;
  /** Disabling would be refused as last_owner; known only from a complete roster. */
  isLastOwner: boolean;
  working: boolean;
}

interface MemberActionsProps extends MemberView {
  t: Translate;
  onResend: (userId: string) => void;
  onDisable: (userId: string) => void;
  onEnable: (userId: string) => void;
}

const PlatformTeamPage: React.FC = () => {
  const { platformCan } = useSuperAdmin();
  const { showToast } = useToast();
  const { t } = useTranslation();

  const mayManage = platformCan('staff.manage');

  const [members, setMembers] = useState<PlatformStaffRow[]>([]);
  const [complete, setComplete] = useState(true);
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
    if (!mayManage) return;
    setLoading(true);
    setProblem(null);
    setDetail(null);
    try {
      const result = await loadStaffRoster();
      if (!result.ok) {
        setMembers([]);
        setProblem(platformReadRefusalKey(result.reason));
        return;
      }
      setMembers(result.members);
      setComplete(result.complete);
    } catch (err) {
      setMembers([]);
      setProblem('admin.read.failed');
      setDetail(err instanceof Error ? err.message : null);
    } finally {
      setLoading(false);
    }
  }, [mayManage]);

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

  const views: MemberView[] = members.map(member => ({
    member,
    isLastOwner: complete && wouldRemoveLastOwner(members, member.user_id),
    working: busy === member.user_id,
  }));
  const actions = {
    t,
    onResend: (userId: string) => void runOnMember(userId, () => resendStaffInvite(userId), 'admin.team.invite.resent'),
    onDisable: (userId: string) => void runOnMember(userId, () => disableStaffMember(userId), 'admin.team.disabled'),
    onEnable: (userId: string) => void runOnMember(userId, () => enableStaffMember(userId), 'admin.team.enabled'),
  };

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

      {/* The roster */}
      {loading ? (
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
        <div className="space-y-3">
          <Note text={t('admin.team.sourceNote')} />
          {!complete && <Note tone="warning" text={t('admin.team.incomplete')} />}
          {complete && activeOwnerCount(members) === 1 && <Note tone="warning" text={t('admin.team.lastOwner.note')} />}
          {members.some(member => grantedBy(member).kind === 'unrecorded') && (
            <Note text={t('admin.team.grantedBy.unrecordedNote')} />
          )}

          {members.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 rounded-2xl" style={cardStyle}>
              <Users size={36} className="mb-3" style={{ color: 'var(--text-tertiary)' }} />
              <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('admin.team.empty')}</p>
            </div>
          ) : (
            <>
              {/* Wide screens: one table. It is only as wide as the panel beside
                  the sidebar, so the note sits under the member rather than in a
                  column of its own; should it still not fit, it scrolls inside
                  its card instead of cutting the actions off. */}
              <div className="hidden xl:block rounded-2xl" style={{ ...cardStyle, overflowX: 'auto' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {([
                        'admin.team.col.member', 'admin.team.col.role', 'admin.team.col.status',
                        'admin.team.col.grantedBy',
                      ] as const).map(key => (
                        <th key={key} className="px-4 py-3.5 text-left" style={thStyle}>{t(key)}</th>
                      ))}
                      <th style={thStyle} />
                    </tr>
                  </thead>
                  <tbody>
                    {views.map(view => (
                      <tr key={view.member.user_id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td className="px-4 py-4 align-top" style={{ minWidth: '15rem' }}>
                          <MemberIdentity member={view.member} t={t} />
                          {view.member.note && (
                            <p className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)' }}>
                              {t('admin.team.col.note')}: {view.member.note}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-4 align-top"><RoleBadge role={view.member.role} t={t} /></td>
                        <td className="px-4 py-4 align-top"><MemberStatus member={view.member} t={t} /></td>
                        <td className="px-4 py-4 align-top" style={{ minWidth: '10rem' }}>
                          <GrantedBy member={view.member} t={t} />
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="flex flex-col items-end gap-2">
                            <MemberActions {...view} {...actions} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Narrower screens: one card per member, nothing to scroll sideways. */}
              <ul className="xl:hidden space-y-3">
                {views.map(view => (
                  <li key={view.member.user_id} className="rounded-2xl p-4 space-y-3" style={cardStyle}>
                    <div className="flex items-start justify-between gap-3">
                      <MemberIdentity member={view.member} t={t} />
                      <RoleBadge role={view.member.role} t={t} />
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                      <dt style={labelStyle}>{t('admin.team.col.status')}</dt>
                      <dd><MemberStatus member={view.member} t={t} /></dd>
                      <dt style={labelStyle}>{t('admin.team.col.grantedBy')}</dt>
                      <dd><GrantedBy member={view.member} t={t} /></dd>
                      {view.member.note && (
                        <>
                          <dt style={labelStyle}>{t('admin.team.col.note')}</dt>
                          <dd style={{ color: 'var(--text-secondary)' }}>{view.member.note}</dd>
                        </>
                      )}
                    </dl>
                    <div className="flex items-center gap-2 flex-wrap pt-1">
                      <MemberActions {...view} {...actions} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* Adding somebody */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.team.addSection')}</h2>
        <Note icon="lock" text={t('admin.team.roleNote')} />
        <div className="grid gap-4 lg:grid-cols-2">
          <form onSubmit={invite} className="rounded-2xl p-5 space-y-3" style={cardStyle}>
            <h3 className="font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <UserPlus size={16} />{t('admin.team.invite.title')}
            </h3>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('admin.team.invite.hint')}</p>
            <label className="block">
              <span className="block text-xs font-semibold mb-1.5" style={labelStyle}>{t('admin.team.invite.email')}</span>
              <input type="email" required value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} style={controlStyle} />
            </label>
            <label className="block">
              <span className="block text-xs font-semibold mb-1.5" style={labelStyle}>{t('admin.team.invite.fullName')}</span>
              <input required value={inviteName} onChange={e => setInviteName(e.target.value)} style={controlStyle} />
            </label>
            <RoleField t={t} />
            <label className="block">
              <span className="block text-xs font-semibold mb-1.5" style={labelStyle}>{t('admin.team.note')}</span>
              <input value={inviteNote} maxLength={500} onChange={e => setInviteNote(e.target.value)} style={controlStyle} />
            </label>
            <button type="submit" disabled={inviting}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white"
              style={{ background: 'var(--accent)', opacity: inviting ? 0.6 : 1 }}>
              {inviting ? t('admin.common.saving') : t('admin.team.invite.submit')}
            </button>
          </form>

          <form onSubmit={add} className="rounded-2xl p-5 space-y-3" style={cardStyle}>
            <h3 className="font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <UserPlus size={16} />{t('admin.team.add.title')}
            </h3>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('admin.team.add.hint')}</p>
            <label className="block">
              <span className="block text-xs font-semibold mb-1.5" style={labelStyle}>{t('admin.team.add.userId')}</span>
              <input required value={addUserId} onChange={e => setAddUserId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000" style={controlStyle} />
            </label>
            <RoleField t={t} />
            <label className="block">
              <span className="block text-xs font-semibold mb-1.5" style={labelStyle}>{t('admin.team.note')}</span>
              <input value={addNote} maxLength={500} onChange={e => setAddNote(e.target.value)} style={controlStyle} />
            </label>
            <button type="submit" disabled={adding}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold"
              style={{ border: '1px solid var(--border)', color: 'var(--text-primary)', opacity: adding ? 0.6 : 1 }}>
              {adding ? t('admin.common.saving') : t('admin.team.add.submit')}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
};

/** The address first — the list exists to say who each row is — then the id and since when. */
const MemberIdentity: React.FC<{ member: PlatformStaffRow; t: Translate }> = ({ member, t }) => (
  <div className="min-w-0">
    <p className="font-semibold" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
      {member.email ?? t('admin.team.noAddress')}
    </p>
    <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
      <span className="font-mono" title={member.user_id}>{t('admin.team.userId', { id: shortId(member.user_id) })}</span>
      {' · '}
      {t('admin.team.since', { date: deDate(member.created_at) })}
    </p>
  </div>
);

const RoleBadge: React.FC<{ role: string; t: Translate }> = ({ role, t }) => (
  <span className="inline-block px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
    style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
    {roleLabel(t, role)}
  </span>
);

const MemberStatus: React.FC<{ member: PlatformStaffRow; t: Translate }> = ({ member, t }) => {
  const active = member.status === 'active';
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
        style={active
          ? { background: 'var(--success-subtle)', color: 'var(--success)' }
          : { background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
        {t(active ? 'admin.team.status.active' : 'admin.team.status.disabled')}
      </span>
      {!active && member.disabled_at && (
        <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
          {t('admin.team.disabledSince', { date: deDate(member.disabled_at) })}
        </span>
      )}
      {active && member.invitation_pending && (
        <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
          style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}>
          {t('admin.team.invitationPending')}
        </span>
      )}
    </div>
  );
};

/** Who added the member, or plainly that nobody was recorded. */
const GrantedBy: React.FC<{ member: PlatformStaffRow; t: Translate }> = ({ member, t }) => {
  const granted = grantedBy(member);
  if (granted.kind === 'account') {
    return <span className="text-xs" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{granted.email}</span>;
  }
  if (granted.kind === 'gone') {
    return (
      <span className="text-xs" style={{ color: 'var(--text-secondary)' }} title={granted.userId}>
        {t('admin.team.grantedBy.gone')}
      </span>
    );
  }
  // The explanation is said once, above the list; the cell keeps it as a title.
  return (
    <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}
      title={t('admin.team.grantedBy.unrecordedHint')}>
      {t('admin.team.grantedBy.unrecorded')}
    </span>
  );
};

const MemberActions: React.FC<MemberActionsProps> = ({ member, isLastOwner, working, t, onResend, onDisable, onEnable }) => {
  const active = member.status === 'active';
  return (
    <>
      {offersResend(member) && (
        <button
          onClick={() => onResend(member.user_id)}
          disabled={working}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap"
          style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', opacity: working ? 0.6 : 1 }}
        >
          <Mail size={13} />{t('admin.team.resendInvite')}
        </button>
      )}
      {active && isLastOwner && (
        <span className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium whitespace-nowrap"
          style={{ color: 'var(--text-secondary)' }} title={t('admin.team.hint.lastOwner')}>
          <Lock size={13} />{t('admin.team.lastOwner.label')}
        </span>
      )}
      {active && !isLastOwner && (
        <button
          onClick={() => onDisable(member.user_id)}
          disabled={working}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap"
          style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', opacity: working ? 0.6 : 1 }}
        >
          <Ban size={13} />{t('admin.team.disable')}
        </button>
      )}
      {!active && mayReEnable(member) && (
        <button
          onClick={() => onEnable(member.user_id)}
          disabled={working}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap"
          style={{ background: 'var(--success-subtle)', color: 'var(--success)', opacity: working ? 0.6 : 1 }}
        >
          <CheckCircle size={13} />{t('admin.team.enable')}
        </button>
      )}
      {!active && !mayReEnable(member) && (
        <span className="flex items-start gap-1.5 text-xs max-w-[12rem]" style={{ color: 'var(--text-secondary)' }}
          title={t('admin.team.hint.roleRequires33')}>
          <Lock size={13} className="flex-shrink-0 mt-0.5" />{t('admin.team.reEnableOwnerOnly')}
        </span>
      )}
    </>
  );
};

/**
 * Where a role picker would go: the one role the database accepts today, shown
 * as a fact rather than as a control it would refuse.
 */
const RoleField: React.FC<{ t: Translate }> = ({ t }) => (
  <div>
    <span className="block text-xs font-semibold mb-1.5" style={labelStyle}>{t('admin.team.role.label')}</span>
    <div className="flex items-center gap-2" style={{ ...controlStyle, background: 'var(--bg-muted)' }}>
      <Lock size={13} style={{ color: 'var(--text-secondary)' }} />
      <span>{t('admin.role.owner')}</span>
    </div>
    <p className="text-[11px] mt-1" style={{ color: 'var(--text-secondary)' }}>{t('admin.team.role.locked')}</p>
  </div>
);

/** Takes the finished sentence, so a note may carry interpolated values. */
const Note: React.FC<{ text: string; tone?: 'info' | 'warning'; icon?: 'info' | 'lock' }> = ({ text, tone = 'info', icon = 'info' }) => {
  const Icon = tone === 'warning' ? AlertTriangle : icon === 'lock' ? Lock : Info;
  return (
    <div className="flex items-start gap-2 rounded-xl p-3 text-xs"
      style={tone === 'warning'
        ? { background: 'var(--warning-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
        : { background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
      <Icon size={14} className="flex-shrink-0 mt-0.5"
        style={{ color: tone === 'warning' ? 'var(--warning)' : 'var(--text-tertiary)' }} />
      <span>{text}</span>
    </div>
  );
};

export default PlatformTeamPage;
