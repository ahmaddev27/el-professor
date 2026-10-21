/**
 * What a screen may write, asked of the page the database asks about.
 *
 * `AuthContext.canEdit(record, page?)` and `canDelete(record, page?)` IGNORE
 * their first argument. Called without a page key they answer "is this an
 * administrator", whatever record was passed, so a screen that forgets the key
 * hides its edit and delete buttons from every role that holds `can_edit` on
 * the page, although `current_role_permits('<page>', true)` would let them
 * write. `canCreate` is the mirror: true when the role edits ANY page, so Add
 * showed to someone whose right sits on another page and the insert was then
 * refused. This module binds the page once, so a call site cannot leave it out.
 */
import type { PageKey } from '../contexts/AuthContext';

export type WriteRightFn = (record?: unknown, page?: PageKey) => boolean;

export interface PageRightsSource {
  can: (page: PageKey, action?: 'view' | 'edit') => boolean;
  canEdit: WriteRightFn;
  canDelete: WriteRightFn;
}

export interface PageWriteRights {
  canCreate: boolean;
  canEdit: (record?: unknown) => boolean;
  canDelete: (record?: unknown) => boolean;
}

export function pageWriteRights(page: PageKey, source: PageRightsSource): PageWriteRights {
  return {
    canCreate: source.can(page, 'edit'),
    canEdit: (record) => source.canEdit(record, page),
    canDelete: (record) => source.canDelete(record, page),
  };
}
