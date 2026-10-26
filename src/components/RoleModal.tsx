import React, { useState, useEffect } from 'react';
import { Save, ShieldCheck } from 'lucide-react';
import { Role, RolePermission, RoleWithPermissions } from '../types/role';
import { emptyPermissions, permissionsFromTemplate, type PermissionMap } from '../lib/companyRoles';
import {
  editBoxIsSettable,
  grantedAreaCount,
  permissionGroups,
  viewBoxIsSettable,
  type PageEnforcement,
} from '../lib/rolePermissionEnforcement';
import { useTranslation } from '../contexts/LanguageContext';
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogTitle, Field, Input, NativeSelect, cn } from './ui';
import { controlFrameClass } from './ui/Input';

interface RoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  /*
    The permissions travel as the **map** the form holds, keyed by page_key, not
    as a list of rows. `permissionPayload()` — the caller's next step — reads
    `map[page_key]` for each of the sixteen known areas, so a list handed over
    here resolves to `undefined` on every lookup, every entry is dropped, and
    `company_role_save` is called with an empty `p_permissions`: a role saved
    with no permissions at all, which is every holder locked out of every page.
    That is the exact failure 20260923120000 was written to make impossible, so
    the two halves state the same type.
  */
  onSave: (role: Partial<Role>, permissions: PermissionMap) => Promise<void>;
  role?: Role;
  existingPermissions?: RolePermission[];
  /** The system roles a new role may be copied from. Ignored when editing one. */
  templates?: readonly RoleWithPermissions[];
}

const RoleModal: React.FC<RoleModalProps> = ({
  isOpen,
  onClose,
  onSave,
  role,
  existingPermissions = [],
  templates = [],
}) => {
  const { t, tPlural } = useTranslation();
  const [roleName, setRoleName] = useState('');
  const [roleDescription, setRoleDescription] = useState('');
  const [permissionMap, setPermissionMap] = useState<PermissionMap>({});
  const [templateId, setTemplateId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setIsInitialized(false);
      return;
    }
    if (isInitialized) return;

    setValidationError('');
    setTemplateId('');

    if (role) {
      setRoleName(role.name);
      setRoleDescription(role.description);
      // A full map over all sixteen areas, not only the rows that exist: a role
      // stores no row for an area it does not permit, and a map with holes is
      // drawn as unset by one box and read as absent by the next.
      setPermissionMap(permissionsFromTemplate(existingPermissions));
    } else {
      setRoleName('');
      setRoleDescription('');
      setPermissionMap(emptyPermissions());
    }

    setIsInitialized(true);
  }, [isOpen, role, existingPermissions, isInitialized]);

  /*
    "Als Kopie von": a new role starts from a system role's boxes. The template
    is read through `permissionsFromTemplate`, which drops a key this build does
    not know — `company_role_save` refuses an unknown page_key, so an older
    browser copying a template a newer migration widened would otherwise fail on
    save with nothing on screen to explain it.
  */
  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const chosen = templates.find(candidate => candidate.id === id);
    setPermissionMap(chosen ? permissionsFromTemplate(chosen.permissions) : emptyPermissions());
  };

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = 'unset'; };
    }
  }, [isOpen]);

  /*
    Reachable only while `viewBoxIsSettable()` is true, which it is not: the
    `Ansehen` boxes are rendered `disabled`, and a disabled input fires no
    change event. It is wired to the row all the same rather than deleted,
    because the one constant that stills the column —
    `VIEW_IS_ENFORCED` in `lib/rolePermissionEnforcement.ts` — is also the one
    thing that would bring it back, and a handler re-derived later would not be
    this one. `can_view` still travels in the payload; see `toggleEdit` below.
  */
  const toggleView = (pageKey: string) => {
    setPermissionMap(prev => {
      const newView = !(prev[pageKey]?.can_view || false);
      return {
        ...prev,
        [pageKey]: {
          can_view: newView,
          can_edit: newView ? (prev[pageKey]?.can_edit || false) : false,
        },
      };
    });
  };

  /*
    Unchanged, and it must stay unchanged: it is what keeps `can_view` true
    wherever `can_edit` is, which is the rule `company_role_save` enforces with
    `IS NOT DISTINCT FROM` and refuses as `edit_without_view`. The disabled
    `Ansehen` box therefore still moves when this one is ticked — deliberately
    visible, because that is the database's rule and not a glitch.
  */
  const toggleEdit = (pageKey: string) => {
    setPermissionMap(prev => {
      const newEdit = !(prev[pageKey]?.can_edit || false);
      return {
        ...prev,
        [pageKey]: {
          can_view: newEdit ? true : (prev[pageKey]?.can_view || false),
          can_edit: newEdit,
        },
      };
    });
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError('');

    const trimmedName = roleName.trim();
    if (!trimmedName) {
      setValidationError(t('users.roles.nameRequired'));
      return;
    }

    setIsSubmitting(true);
    try {
      const roleData: Partial<Role> = { name: trimmedName, description: roleDescription.trim() };
      if (role) roleData.id = role.id;

      await onSave(roleData, permissionMap);
      onClose();
    } catch (err: any) {
      setValidationError(err.message || t('users.roles.error.save'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => { if (!isSubmitting) onClose(); };

  if (!isOpen) return null;

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged, the scroll lock included (the dialog below
  // locks the page as well; the two agree). The form was an always-dark panel
  // drawn in inline styles; it is the design system's Dialog now, in both
  // themes. Closing asks handleClose, as the backdrop and × did, so nothing
  // closes the form while it saves. The permission boxes are real, visible
  // checkboxes: the old ones were hidden inputs under painted squares, which a
  // keyboard could not reach.

  const viewLabel = t('users.roles.col.view');
  const editLabel = t('users.roles.col.edit');

  /*
    What this role actually grants, which is not how many boxes are ticked.

    The subtitle counted every area with either box set. For a role copied from
    `viewer` — sixteen `can_view` rows and no `can_edit` — that read *16
    Bereiche ausgewählt* about a role which grants no right anywhere in the
    product, and it is the same claim the twenty-two disabled boxes below were
    making. `grantedAreaCount` counts `can_edit` on the ten pages a policy
    actually gates, and nothing else.
  */
  const grantedCount = grantedAreaCount(permissionMap);

  /*
    The sixteen areas, grouped by what enforces them, the ten that work first.

    Every reason is **visible text** under its section heading rather than a
    tooltip: an administrator who cannot tick a box is not going to hover it to
    find out why, and a disabled input is skipped by the tab order, so a
    `title` or an `aria-describedby` alone would be an explanation nobody is
    offered. The `aria-describedby` is set as well — it costs nothing and some
    screen-reader modes do read a disabled control — but the sentence on screen
    is the explanation.
  */
  const groups = permissionGroups();
  const viewNoteId = 'role-modal-view-note';
  const reasonId = (kind: PageEnforcement) => `role-modal-reason-${kind}`;
  const lastGroup = groups.length - 1;

  /*
    A system role is opened to be read. `roles_update` requires
    `is_system = false` and `company_role_save` answers `not_found` for a role
    that is not this company's — so offering Save here would only produce "Diese
    Rolle wurde nicht gefunden" for a row the screen is showing.
  */
  const readOnly = Boolean(role?.is_system);

  return (
    <Dialog open onOpenChange={next => { if (!next) handleClose(); }}>
      <DialogContent aria-labelledby="role-modal-title" className="max-w-[720px] gap-0 p-0">
        {/* HEADER */}
        <div className="flex items-center gap-3 border-b border-line px-5 py-4 pr-14 sm:px-6">
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand-text">
            <ShieldCheck className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <DialogTitle id="role-modal-title" className="text-base">
              {role ? t('users.roles.edit') : t('users.roles.createNew')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {grantedCount > 0
                ? tPlural({ one: 'users.roles.areasEffective.one', other: 'users.roles.areasEffective.other' }, grantedCount)
                : t('users.roles.noEffectivePermissions')}
            </DialogDescription>
          </div>
        </div>

        {/* FORM */}
        <form onSubmit={handleFormSubmit} className="flex min-h-0 flex-col">
          <div className="grid gap-6 px-5 py-5 sm:px-6">

            {/* ERROR */}
            {validationError && <Alert tone="critical" title={validationError} />}

            {/* SYSTEM ROLE NOTE */}
            {readOnly && (
              <Alert tone="brand" role="note" title={t('users.roles.systemCannotEdit')}>
                {t('users.roles.systemRoleNote')}
              </Alert>
            )}

            {/* ROLE NAME + DESCRIPTION */}
            <div className="grid grid-cols-1 gap-4">
              {!role && templates.length > 0 && (
                <Field
                  label={t('users.roles.template.label')}
                  id="role-template"
                  hint={t('users.roles.template.hint')}
                >
                  <NativeSelect
                    id="role-template"
                    value={templateId}
                    onChange={e => applyTemplate(e.target.value)}
                    disabled={isSubmitting}
                  >
                    <option value="">{t('users.roles.template.blank')}</option>
                    {templates.map(template => (
                      <option key={template.id} value={template.id}>{template.name}</option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              <Field label={t('users.roles.nameLabel')} id="role-name" required>
                <Input
                  id="role-name"
                  type="text"
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  disabled={role?.is_system || isSubmitting}
                  placeholder={t('users.roles.namePlaceholder')}
                  autoComplete="off"
                />
              </Field>
              <Field label={t('common.description')} id="role-description">
                <textarea
                  id="role-description"
                  value={roleDescription}
                  onChange={(e) => setRoleDescription(e.target.value)}
                  disabled={isSubmitting}
                  placeholder={t('users.roles.descriptionPlaceholder')}
                  rows={2}
                  autoComplete="off"
                  className={cn(controlFrameClass, 'h-auto resize-y py-2 leading-relaxed [@media(pointer:coarse)]:h-auto')}
                />
              </Field>
            </div>

            {/* PERMISSIONS */}
            <div>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-[15px] font-semibold text-fg">{t('users.roles.permissions')}</h3>
                <span className="text-xs text-fg-subtle">
                  {t('users.roles.editRequiresView')}
                </span>
              </div>

              <div className="overflow-hidden rounded-surface border border-line">
                {/* Table header. `Ansehen` is marked in the header itself, so the
                    column is labelled as stilled even before the sentence below. */}
                <div aria-hidden className="grid grid-cols-[1fr_4.5rem_4.5rem] items-start border-b border-line bg-sunken px-3 py-2 sm:grid-cols-[1fr_6.5rem_7rem] sm:px-4">
                  <span className="text-xs font-semibold text-fg-muted">{t('users.roles.col.area')}</span>
                  <span className="text-center text-xs font-semibold text-fg-subtle">
                    <span className="block line-through">{viewLabel}</span>
                    <span className="mt-0.5 block text-[10px] font-normal leading-tight">
                      {t('users.roles.col.view.disabled')}
                    </span>
                  </span>
                  <span className="text-center text-xs font-semibold text-fg-muted">{editLabel}</span>
                </div>

                {/* Why every `Ansehen` box is unsettable. One sentence for the
                    whole column, because the reason is the column's and not any
                    one row's. */}
                <p id={viewNoteId} className="border-b border-line bg-sunken/60 px-3 py-2 text-xs leading-snug text-fg-muted sm:px-4">
                  {t('users.roles.view.notEnforced')}
                </p>

                {/* Rows, in three sections */}
                {groups.map((group, groupIdx) => (
                  <div key={group.kind}>
                    <div className="border-b border-line bg-sunken/40 px-3 py-2 sm:px-4">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                        {t(group.headingKey)}
                      </h4>
                      {group.reasonKey && (
                        <p id={reasonId(group.kind)} className="mt-1 text-xs leading-snug text-fg-subtle">
                          {t(group.reasonKey)}
                        </p>
                      )}
                    </div>

                    {group.pages.map((page, idx) => {
                      const canView = permissionMap[page.key]?.can_view || false;
                      const canEdit = permissionMap[page.key]?.can_edit || false;
                      const isLast = groupIdx === lastGroup && idx === group.pages.length - 1;
                      const editSettable = editBoxIsSettable(page.key);

                      return (
                        <PermissionRow
                          key={page.key}
                          pageKey={page.key}
                          label={t(page.label)}
                          description={t(page.description)}
                          canView={canView}
                          canEdit={canEdit}
                          isLast={isLast}
                          isSubmitting={isSubmitting || readOnly}
                          onToggleView={toggleView}
                          onToggleEdit={toggleEdit}
                          viewLabel={viewLabel}
                          editLabel={editLabel}
                          /* Both boxes keep their stored value and their
                             handler; what changes is whether they can be
                             pressed. `viewSettable` is false on every row —
                             `viewBoxIsSettable()` takes no page, by design. */
                          viewSettable={viewBoxIsSettable()}
                          editSettable={editSettable}
                          viewReasonId={viewNoteId}
                          editReasonId={editSettable ? undefined : reasonId(group.kind)}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* FOOTER */}
          <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
            <Button
              type="button"
              variant={readOnly ? 'primary' : 'secondary'}
              onClick={handleClose}
              disabled={isSubmitting}
            >
              {readOnly ? t('common.close') : t('common.cancel')}
            </Button>
            {!readOnly && (
              <Button
                type="submit"
                disabled={isSubmitting}
              >
                <Save aria-hidden />
                {isSubmitting ? t('common.saving') : t('common.save')}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

interface PermissionRowProps {
  pageKey: string;
  label: string;
  description: string;
  canView: boolean;
  canEdit: boolean;
  isLast: boolean;
  isSubmitting: boolean;
  onToggleView: (key: string) => void;
  onToggleEdit: (key: string) => void;
  /** The two column names, for each box's accessible name. */
  viewLabel: string;
  editLabel: string;
  /**
   * Whether each box enforces anything, and so whether it may be pressed.
   *
   * A box that is not settable is still drawn, still shows the row's **stored**
   * value and still carries that value into the payload — it is only
   * unsettable. Removing it would answer "where did the column go?" with
   * silence; disabling it answers the question an administrator actually has.
   */
  viewSettable: boolean;
  editSettable: boolean;
  /** The id of the visible sentence that says why, for `aria-describedby`. */
  viewReasonId?: string;
  editReasonId?: string;
}

/**
 * One area and its two boxes. The boxes toggle through the form's own
 * toggleView / toggleEdit, which keep "edit implies view" and "no view, no
 * edit"; the row only draws. Each box is a 44 px target on a touch screen.
 *
 * A box is disabled for one of two reasons, and the row does not conflate them:
 * `isSubmitting` is temporary (the form is saving, or a system role is being
 * read) and gets no explanation, while `viewSettable` / `editSettable` are
 * permanent properties of the page that the sentence above the section states.
 * Only the second kind is described, so a saving form does not point every box
 * at a reason that is not the reason.
 */
const PermissionRow: React.FC<PermissionRowProps> = ({
  pageKey, label, description, canView, canEdit, isLast, isSubmitting, onToggleView, onToggleEdit, viewLabel, editLabel,
  viewSettable, editSettable, viewReasonId, editReasonId,
}) => {
  const box = 'size-4 cursor-pointer accent-brand disabled:cursor-not-allowed [@media(pointer:coarse)]:size-5';
  const target = 'flex size-9 items-center justify-center justify-self-center rounded-control [@media(pointer:coarse)]:size-11';
  // A stilled box is drawn faintly, so "ticked but inert" cannot be mistaken
  // for "ticked and in force" at a glance.
  const inert = 'opacity-50';

  return (
    <div
      className={cn(
        'grid grid-cols-[1fr_4.5rem_4.5rem] items-center px-3 py-2 transition-colors hover:bg-sunken/50 sm:grid-cols-[1fr_6.5rem_7rem] sm:px-4',
        !isLast && 'border-b border-line',
      )}
    >
      <div className="min-w-0 py-1">
        <div className="text-sm font-semibold leading-snug text-fg">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs leading-snug text-fg-subtle">{description}</div>
        )}
      </div>

      {/* View checkbox — never settable; shows what the row holds. */}
      <label className={cn(target, !viewSettable && inert)}>
        <input
          type="checkbox"
          checked={canView}
          onChange={() => onToggleView(pageKey)}
          disabled={isSubmitting || !viewSettable}
          aria-label={`${label}: ${viewLabel}`}
          aria-describedby={viewSettable ? undefined : viewReasonId}
          className={box}
        />
      </label>

      {/* Edit checkbox */}
      <label className={cn(target, !editSettable && inert)}>
        <input
          type="checkbox"
          checked={canEdit}
          onChange={() => onToggleEdit(pageKey)}
          disabled={isSubmitting || !editSettable}
          aria-label={`${label}: ${editLabel}`}
          aria-describedby={editSettable ? undefined : editReasonId}
          className={box}
        />
      </label>
    </div>
  );
};

export default RoleModal;
