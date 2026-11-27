import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw, ShieldAlert, UserPlus, Mail, Ban, CheckCircle, Users, Lock, UserCog, Download,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey, TranslationVars } from '../i18n';
import {
  Alert, Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, EmptyState, Field, Input, NativeSelect, PageHeader,
} from '../components/ui';
import { PlatformRpcError } from '../lib/platformRpc';
import { PLATFORM_ROLES, type PlatformRole } from '../lib/platformAccess';
import { platformReadRefusalKey, type PlatformStaffRow } from '../lib/platformReadModels';
import {
  addStaffMember,
  disableStaffMember,
  enableStaffMember,
  inviteStaffMember,
  loadStaffRoster,
  resendStaffInvite,
  setStaffRole,
} from '../lib/platformStaffClient';
import {
  activeOwnerCount,
  DEFAULT_STAFF_ROLE,
  grantedBy,
  isStaffRole,
  isUserId,
  mayChangeRole,
  offersResend,
  staffRefusalHintKey,
  STAFF_ROLE_OPTIONS,
  wouldRemoveLastOwner,
} from '../lib/platformStaffRoster';
import { deDate, shortId } from '../lib/platformFormat';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { buildStaffExport } from '../lib/panelExports';
import { useExportChrome } from '../hooks/useExportChrome';
import { berlinToday } from '../utils/salaryCashReceiptFlow';

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
 * ## The four roles
 *
 * All four are grantable since migration 20260923110000 (owner's decision,
 * 23.09.2026); until then `platform_staff_add` and `platform_staff_enable`
 * refused every role but `owner` with reason `role_requires_3_3`. Both forms
 * therefore carry a picker, and it names under each choice what that role may
 * read — `support` and `read_only` hold `business.read`, which is every
 * customer's business data, and that is the decision being taken at the moment
 * of the click.
 *
 * ## Changing a member's role
 *
 * `platform_staff_set_role` (migration 20260923140000) moves an existing member
 * between the four, keeping `created_by`, `created_at` and the note — before it,
 * the only way was to disable the row and add it again, which lost all three and
 * wrote a removal and a fresh grant into the audit log for what was one change.
 *
 * The control is offered for an **active** member who is not the last active
 * owner (`mayChangeRole`), and it is two steps: the same `RoleField` as the two
 * add forms, then a confirmation naming the member and both roles. An authority
 * change is worth a sentence before it happens, and a picker that applies on
 * change would make one an accident of a keystroke.
 *
 * Changing your **own** row is allowed while another owner remains — the
 * migration's header has the reasoning, in short: `staff.manage` is the owner's
 * capability alone, so every self-change this page can send takes power away,
 * and the case that would lock the platform out is the last active owner's,
 * which is refused for anybody. The confirmation says plainly what is lost and
 * that only another owner can undo it.
 *
 * No choice here can leave the platform without an active owner: the two forms
 * only ever *add* a row, and the role change is kept off the last active owner.
 *
 * ## The last active owner
 *
 * `platform_staff_disable` refuses disabling it with `last_owner`, and
 * `platform_staff_set_role` refuses demoting it with the same reason; the
 * table's trigger `platform_staff_keep_owner` raises underneath either. The page
 * shows that member as the last active owner instead of the disable and
 * role-change buttons, and says so above the list — but only when it read the
 * whole roster; from a partial one it draws no conclusion and leaves the
 * decision to the database.
 */

type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

const roleLabel = (t: Translate, role: string): string =>
  (PLATFORM_ROLES as readonly string[]).includes(role) ? t(`admin.role.${role}` as TranslationKey) : role;

/** What each role may do, said where it is picked rather than only in the docs. */
const ROLE_HINT_KEYS: Record<PlatformRole, TranslationKey> = {
  owner:     'admin.team.role.hint.owner',
  support:   'admin.team.role.hint.support',
  billing:   'admin.team.role.hint.billing',
  read_only: 'admin.team.role.hint.read_only',
};

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
  onChangeRole: (member: PlatformStaffRow) => void;
}

/** The member whose role is being changed, and the role picked so far. */
interface RoleEdit {
  member: PlatformStaffRow;
  role: PlatformRole;
}

const PlatformTeamPage: React.FC = () => {
  const { user } = useAuth();
  const { platformCan } = useSuperAdmin();
  const { showToast } = useToast();
  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  const exportChrome = useExportChrome();

  const mayManage = platformCan('staff.manage');

  const [members, setMembers] = useState<PlatformStaffRow[]>([]);
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<PlatformRole>(DEFAULT_STAFF_ROLE);
  const [inviteNote, setInviteNote] = useState('');
  const [inviting, setInviting] = useState(false);

  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<PlatformRole>(DEFAULT_STAFF_ROLE);
  const [addNote, setAddNote] = useState('');
  const [adding, setAdding] = useState(false);

  // Two pieces of state, not one: cancelling the confirmation goes back to the
  // picker with the chosen role, rather than throwing the choice away.
  const [roleEdit, setRoleEdit] = useState<RoleEdit | null>(null);
  const [confirmingRole, setConfirmingRole] = useState(false);

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
      await inviteStaffMember(inviteEmail, inviteName, inviteRole, inviteNote || null);
      showToast('success', t('admin.team.invite.success'));
      setInviteEmail('');
      setInviteName('');
      setInviteRole(DEFAULT_STAFF_ROLE);
      setInviteNote('');
      await load();
    } catch (err) {
      reportFailure(err);
    } finally {
      setInviting(false);
    }
  };

  /** Opens the picker on the role the member holds, so nothing is preselected. */
  const beginRoleChange = (member: PlatformStaffRow) => {
    setRoleEdit({ member, role: isStaffRole(member.role) ? member.role : DEFAULT_STAFF_ROLE });
    setConfirmingRole(false);
  };

  const closeRoleChange = () => {
    setRoleEdit(null);
    setConfirmingRole(false);
  };

  const applyRoleChange = () => {
    if (!roleEdit) return;
    const { member, role } = roleEdit;
    closeRoleChange();
    // The note is left alone: the RPC treats NULL as "unchanged", so a role
    // change never erases what somebody wrote about a member.
    void runOnMember(
      member.user_id,
      () => setStaffRole(member.user_id, role, null),
      'admin.team.role.change.success',
    );
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isUserId(addUserId)) {
      showToast('error', t('admin.team.invalidUserId'));
      return;
    }
    setAdding(true);
    try {
      await addStaffMember(addUserId, addRole, addNote || null);
      showToast('success', t('admin.team.add.success'));
      setAddUserId('');
      setAddRole(DEFAULT_STAFF_ROLE);
      setAddNote('');
      await load();
    } catch (err) {
      reportFailure(err);
    } finally {
      setAdding(false);
    }
  };

  /**
   * The roster as a workbook — the access-review artefact, and the platform's
   * counterpart to the Rollen matrix a company exports. It answers "who could
   * read every customer's data" in a form that can be attached to a review; the
   * screen answers it only by being looked at.
   *
   * **The rule being preserved: a file says what it holds.** `collectStaffRoster`
   * pages `platform_staff_list` to the end, so unlike every other panel export
   * this one is the whole list — and the band says so only when `complete` is
   * true. When the paging stopped early the band says the roster is partial
   * rather than the file implying a complete team; it is not withheld, because a
   * partial roster is still a fact once it is labelled as one.
   *
   * It carries the full `user_id`, which no other export here does: the screen
   * already shows it (shortened, with the whole value in the cell's title) and
   * "Vorhandenes Konto hinzufügen" takes exactly that id, so a roster without it
   * cannot be acted on. These are platform accounts, never a customer's.
   */
  const handleExport = () => {
    try {
      exportPicker.table('platformTeam', buildStaffExport({
        rows: members,
        complete,
        today: berlinToday(),
        labels: {
          sheetTitle: t('admin.team.title'),
          member: t('admin.team.col.member'),
          userId: t('admin.team.export.userId'),
          role: t('admin.team.col.role'),
          status: t('admin.team.col.status'),
          disabledOn: t('admin.team.export.disabledOn'),
          invitationPending: t('admin.team.export.invitationPending'),
          grantedBy: t('admin.team.col.grantedBy'),
          since: t('admin.team.export.since'),
          note: t('admin.team.col.note'),
          // The four roles, named as the picker names them. A fifth value the
          // database might hold is written verbatim by the builder.
          roleNames: Object.fromEntries(
            PLATFORM_ROLES.map((role): [string, string] => [role, roleLabel(t, role)]),
          ),
          statusActive: t('admin.dir.status.active'),
          statusDisabled: t('admin.team.status.disabled'),
          yes: t('common.yes'),
          no: t('common.no'),
          noAddress: t('admin.team.noAddress'),
          grantedByUnrecorded: t('admin.team.grantedBy.unrecorded'),
          scopeComplete: t('admin.team.export.scopeComplete'),
          scopeIncomplete: t('admin.team.export.scopeIncomplete'),
          chrome: exportChrome,
        },
      }));
    } catch (error: any) {
      showToast('error', t('ui.export.failed'), error?.message);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic; below, markup only draws.

  if (!mayManage) {
    return (
      <div className="glass-card rounded-surface">
        <EmptyState
          icon={ShieldAlert}
          title={t('admin.read.denied')}
          description={t('admin.team.noAccessBody')}
          className="py-16"
        />
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
    onChangeRole: beginRoleChange,
  };

  return (
    <div className="space-y-6 font-ui">
      <PageHeader
        title={t('admin.team.title')}
        description={t('admin.team.subtitle')}
        className="pb-0"
        actions={(
          <>
            {/* Withheld while the read failed or is running, and on an empty
                roster: a file saying nobody holds platform rights would be the
                most misleading artefact this screen could produce. An *incomplete*
                roster is exported and labelled, which is a different case. */}
            <Button
              variant="secondary"
              disabled={loading || problem !== null || members.length === 0}
              onClick={handleExport}
              title={t('common.exportExcel')}
            >
              <Download size={14} aria-hidden />{t('admin.export.download')}
            </Button>
            <Button variant="secondary" onClick={() => void load()}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />{t('admin.common.refresh')}
            </Button>
          </>
        )}
      />

      {/* The roster */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={24} className="animate-spin text-fg-subtle" />
        </div>
      ) : problem ? (
        <div className="glass-card rounded-surface">
          <EmptyState
            icon={ShieldAlert}
            title={t(problem)}
            description={detail ?? undefined}
            className="py-14"
          />
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
            <div className="glass-card rounded-surface">
              <EmptyState icon={Users} title={t('admin.team.empty')} className="py-14" />
            </div>
          ) : (
            <>
              {/* Wide screens: one table. It is only as wide as the panel beside
                  the sidebar, so the note sits under the member rather than in a
                  column of its own; should it still not fit, it scrolls inside
                  its card instead of cutting the actions off. */}
              <div className="glass-card relative hidden overflow-x-auto rounded-surface xl:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-wash">
                      {([
                        'admin.team.col.member', 'admin.team.col.role', 'admin.team.col.status',
                        'admin.team.col.grantedBy',
                      ] as const).map(key => (
                        <th key={key} className={THEAD_CELL}>{t(key)}</th>
                      ))}
                      <th className={THEAD_CELL} />
                    </tr>
                  </thead>
                  <tbody>
                    {views.map(view => (
                      <tr key={view.member.user_id} className="border-b border-line last:border-b-0">
                        <td className="min-w-[15rem] px-4 py-4 align-top">
                          <MemberIdentity member={view.member} t={t} />
                          {view.member.note && (
                            <p className="mt-1.5 text-xs text-fg-muted">
                              {t('admin.team.col.note')}: {view.member.note}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-4 align-top"><RoleBadge role={view.member.role} t={t} /></td>
                        <td className="px-4 py-4 align-top"><MemberStatus member={view.member} t={t} /></td>
                        <td className="min-w-[10rem] px-4 py-4 align-top">
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
              <ul className="space-y-3 xl:hidden">
                {views.map(view => (
                  <li key={view.member.user_id} className="glass-card space-y-3 rounded-surface p-4">
                    <div className="flex items-start justify-between gap-3">
                      <MemberIdentity member={view.member} t={t} />
                      <RoleBadge role={view.member.role} t={t} />
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                      <dt className="text-fg-muted">{t('admin.team.col.status')}</dt>
                      <dd><MemberStatus member={view.member} t={t} /></dd>
                      <dt className="text-fg-muted">{t('admin.team.col.grantedBy')}</dt>
                      <dd><GrantedBy member={view.member} t={t} /></dd>
                      {view.member.note && (
                        <>
                          <dt className="text-fg-muted">{t('admin.team.col.note')}</dt>
                          <dd className="text-fg-muted">{view.member.note}</dd>
                        </>
                      )}
                    </dl>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
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
        <h2 className="text-lg font-semibold text-fg">{t('admin.team.addSection')}</h2>
        <Note text={t('admin.team.roleNote')} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <form onSubmit={invite} className="glass-card grid content-start gap-3 rounded-surface p-5">
            <h3 className="flex items-center gap-2 font-semibold text-fg">
              <UserPlus size={16} />{t('admin.team.invite.title')}
            </h3>
            <p className="text-xs text-fg-subtle">{t('admin.team.invite.hint')}</p>
            <Field label={t('admin.team.invite.email')}>
              <Input type="email" required value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} />
            </Field>
            <Field label={t('admin.team.invite.fullName')}>
              <Input required value={inviteName} onChange={e => setInviteName(e.target.value)} />
            </Field>
            <RoleField t={t} value={inviteRole} onChange={setInviteRole} />
            <Field label={t('admin.team.note')}>
              <Input value={inviteNote} maxLength={500} onChange={e => setInviteNote(e.target.value)} />
            </Field>
            <Button type="submit" disabled={inviting} className="w-full">
              {inviting ? t('admin.common.saving') : t('admin.team.invite.submit')}
            </Button>
          </form>

          <form onSubmit={add} className="glass-card grid content-start gap-3 rounded-surface p-5">
            <h3 className="flex items-center gap-2 font-semibold text-fg">
              <UserPlus size={16} />{t('admin.team.add.title')}
            </h3>
            <p className="text-xs text-fg-subtle">{t('admin.team.add.hint')}</p>
            <Field label={t('admin.team.add.userId')}>
              <Input required value={addUserId} onChange={e => setAddUserId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000" />
            </Field>
            <RoleField t={t} value={addRole} onChange={setAddRole} />
            <Field label={t('admin.team.note')}>
              <Input value={addNote} maxLength={500} onChange={e => setAddNote(e.target.value)} />
            </Field>
            <Button type="submit" variant="secondary" disabled={adding} className="w-full">
              {adding ? t('admin.common.saving') : t('admin.team.add.submit')}
            </Button>
          </form>
        </div>
      </section>

      <RoleChangeFlow
        t={t}
        edit={roleEdit}
        confirming={confirmingRole}
        isSelf={roleEdit?.member.user_id === user?.id}
        onPick={role => setRoleEdit(prev => (prev ? { ...prev, role } : prev))}
        onContinue={() => setConfirmingRole(true)}
        onBack={() => setConfirmingRole(false)}
        onCancel={closeRoleChange}
        onConfirm={applyRoleChange}
      />
    </div>
  );
};

const THEAD_CELL = 'whitespace-nowrap px-4 py-3.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle';

/**
 * Picking the new role, then confirming it.
 *
 * The picker is the page's own `RoleField`, so the four choices and the sentence
 * under each are written once. The confirmation is the design system's
 * `ConfirmDialog`: it names the member and both roles, because this is a change
 * of authority and not of a detail. Its tone is `danger` only for the caller's
 * own row — the one change nobody at this screen can undo.
 */
const RoleChangeFlow: React.FC<{
  t: Translate;
  edit: RoleEdit | null;
  confirming: boolean;
  isSelf: boolean;
  onPick: (role: PlatformRole) => void;
  onContinue: () => void;
  onBack: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ t, edit, confirming, isSelf, onPick, onContinue, onBack, onCancel, onConfirm }) => {
  if (!edit) return null;

  const member = edit.member.email ?? t('admin.team.noAddress');
  const from = roleLabel(t, edit.member.role);
  const to = roleLabel(t, edit.role);
  const unchanged = edit.role === edit.member.role;

  return (
    <>
      <Dialog open={!confirming} onOpenChange={next => { if (!next) onCancel(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin.team.role.change.title')}</DialogTitle>
            <DialogDescription>{t('admin.team.role.change.subtitle', { member, role: from })}</DialogDescription>
          </DialogHeader>
          <RoleField t={t} value={edit.role} onChange={onPick} />
          {unchanged && <p className="text-xs text-fg-muted">{t('admin.team.role.change.same')}</p>}
          <DialogFooter>
            <Button variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
            <Button onClick={onContinue} disabled={unchanged}>{t('admin.team.role.change.submit')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirming}
        onClose={onBack}
        onConfirm={onConfirm}
        tone={isSelf ? 'danger' : 'primary'}
        icon={UserCog}
        title={t('admin.team.role.change.confirmTitle')}
        confirmLabel={t('admin.team.role.change.confirmSubmit')}
        description={
          <>
            {t('admin.team.role.change.confirmBody', { member, from, to })}
            {isSelf && <span className="mt-2 block font-semibold">{t('admin.team.role.change.confirmSelf')}</span>}
          </>
        }
      />
    </>
  );
};

/** The address first — the list exists to say who each row is — then the id and since when. */
const MemberIdentity: React.FC<{ member: PlatformStaffRow; t: Translate }> = ({ member, t }) => (
  <div className="min-w-0">
    <p className="break-words font-semibold text-fg [overflow-wrap:anywhere]">
      {member.email ?? t('admin.team.noAddress')}
    </p>
    <p className="mt-0.5 text-[11px] text-fg-muted">
      <span className="font-mono" title={member.user_id}>{t('admin.team.userId', { id: shortId(member.user_id) })}</span>
      {' · '}
      <span className="tabular-nums">{t('admin.team.since', { date: deDate(member.created_at) })}</span>
    </p>
  </div>
);

/** Owner stands out: it is the only role that can change the team itself. */
const RoleBadge: React.FC<{ role: string; t: Translate }> = ({ role, t }) => (
  <Badge tone={role === 'owner' ? 'caution' : 'neutral'}>
    {roleLabel(t, role)}
  </Badge>
);

const MemberStatus: React.FC<{ member: PlatformStaffRow; t: Translate }> = ({ member, t }) => {
  const active = member.status === 'active';
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone={active ? 'positive' : 'neutral'}>
        {active ? <CheckCircle aria-hidden /> : <Ban aria-hidden />}
        {t(active ? 'admin.team.status.active' : 'admin.team.status.disabled')}
      </Badge>
      {!active && member.disabled_at && (
        <span className="whitespace-nowrap text-[11px] tabular-nums text-fg-muted">
          {t('admin.team.disabledSince', { date: deDate(member.disabled_at) })}
        </span>
      )}
      {active && member.invitation_pending && (
        <Badge tone="brand">
          <Mail aria-hidden />
          {t('admin.team.invitationPending')}
        </Badge>
      )}
    </div>
  );
};

/** Who added the member, or plainly that nobody was recorded. */
const GrantedBy: React.FC<{ member: PlatformStaffRow; t: Translate }> = ({ member, t }) => {
  const granted = grantedBy(member);
  if (granted.kind === 'account') {
    return <span className="text-xs text-fg [overflow-wrap:anywhere]">{granted.email}</span>;
  }
  if (granted.kind === 'gone') {
    return (
      <span className="text-xs text-fg-muted" title={granted.userId}>
        {t('admin.team.grantedBy.gone')}
      </span>
    );
  }
  // The explanation is said once, above the list; the cell keeps it as a title.
  return (
    <span className="text-xs font-medium text-fg-muted"
      title={t('admin.team.grantedBy.unrecordedHint')}>
      {t('admin.team.grantedBy.unrecorded')}
    </span>
  );
};

const MemberActions: React.FC<MemberActionsProps> = ({
  member, isLastOwner, working, t, onResend, onDisable, onEnable, onChangeRole,
}) => {
  const active = member.status === 'active';
  return (
    <>
      {/* An active member who is not the last active owner; a disabled row keeps
          the role it was paused with, and re-enabling restores exactly that. */}
      {mayChangeRole(member, isLastOwner) && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChangeRole(member)}
          disabled={working}
        >
          <UserCog size={13} />{t('admin.team.role.change')}
        </Button>
      )}
      {offersResend(member) && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onResend(member.user_id)}
          disabled={working}
        >
          <Mail size={13} />{t('admin.team.resendInvite')}
        </Button>
      )}
      {active && isLastOwner && (
        <span className="flex items-center gap-1.5 whitespace-nowrap px-2 py-1.5 text-xs font-medium text-fg-muted"
          title={t('admin.team.hint.lastOwner')}>
          <Lock size={13} />{t('admin.team.lastOwner.label')}
        </span>
      )}
      {active && !isLastOwner && (
        <Button
          variant="danger"
          size="sm"
          onClick={() => onDisable(member.user_id)}
          disabled={working}
        >
          <Ban size={13} />{t('admin.team.disable')}
        </Button>
      )}
      {/* Every disabled member can be re-enabled since 20260923110000: enabling
          restores the role the row already carries and cannot remove an owner. */}
      {!active && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onEnable(member.user_id)}
          disabled={working}
          className="text-positive"
        >
          <CheckCircle size={13} />{t('admin.team.enable')}
        </Button>
      )}
    </>
  );
};

/**
 * The role a member gets — new, or changed — with what it may do said underneath.
 *
 * One picker for all three forms: the two that add a member and the one that
 * moves an existing one, so the four choices and the sentence under each are
 * written once. The four are `STAFF_ROLE_OPTIONS`, the same list the database's
 * CHECK constraint and capability matrix hold. Nothing offered here can leave
 * the platform without an active owner — see the module header — so this picker
 * needs no guard of its own; `isStaffRole` only keeps a value the browser did
 * not put there from reaching the RPC as a role.
 */
const RoleField: React.FC<{
  t: Translate;
  value: PlatformRole;
  onChange: (role: PlatformRole) => void;
}> = ({ t, value, onChange }) => (
  <Field label={t('admin.team.role.label')} hint={t(ROLE_HINT_KEYS[value])}>
    <NativeSelect
      value={value}
      onChange={e => onChange(isStaffRole(e.target.value) ? e.target.value : DEFAULT_STAFF_ROLE)}
    >
      {STAFF_ROLE_OPTIONS.map(role => (
        <option key={role} value={role}>{roleLabel(t, role)}</option>
      ))}
    </NativeSelect>
  </Field>
);

/** Takes the finished sentence, so a note may carry interpolated values. */
const Note: React.FC<{ text: string; tone?: 'info' | 'warning' }> = ({ text, tone = 'info' }) => (
  <Alert tone={tone === 'warning' ? 'caution' : 'neutral'} role="note">{text}</Alert>
);

export default PlatformTeamPage;
