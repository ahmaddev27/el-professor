import { describe, expect, it } from 'vitest';
import { companyScope, scopedCan, scopedWriteRights } from './companyScope';
import type { PlatformCompanyContext } from './platformAccess';

/**
 * The seam, tested without a renderer: which company a screen queries and
 * whether it may write there. The rules mirror the database — `20260917140000`
 * resolves a member first and only then the context, and a `view` context
 * writes nothing — so each test names the database rule it stands for.
 */

const context = (
  companyId: string,
  mode: 'view' | 'support',
  companyName: string | null = 'Taxi Nord',
): PlatformCompanyContext => ({
  companyId,
  companyName,
  mode,
  expiresAt: '2026-09-18T11:00:00Z',
  secondsRemaining: 3600,
  expiresAtMs: Date.parse('2026-09-18T11:00:00Z'),
});

describe('which company the screens query', () => {
  it('is the account\'s own company for a company user', () => {
    const scope = companyScope({ ownCompanyId: 'own', context: null });
    expect(scope.companyId).toBe('own');
    expect(scope.kind).toBe('own');
    expect(scope.isPlatformSession).toBe(false);
    expect(scope.readOnly).toBe(false);
  });

  it('is the open context\'s company for a company-less platform account', () => {
    const scope = companyScope({ ownCompanyId: null, context: context('c-b', 'support') });
    expect(scope.companyId).toBe('c-b');
    expect(scope.kind).toBe('support');
    expect(scope.companyName).toBe('Taxi Nord');
    expect(scope.isPlatformSession).toBe(true);
  });

  it('is nothing at all with no company and no context', () => {
    const scope = companyScope({ ownCompanyId: null, context: null });
    expect(scope.companyId).toBeNull();
    expect(scope.kind).toBe('none');
    expect(scope.isPlatformSession).toBe(false);
  });

  /*
    get_active_company_id() answers a member from its profile and reaches the
    staff branch only when the profile names no company — and
    platform_context_open refuses such an account with `account_in_company`. A
    browser that showed the context's company here would query rows the
    database answers for the other one.
  */
  it('is the own company even when a context is somehow open beside it', () => {
    const scope = companyScope({ ownCompanyId: 'own', context: context('c-b', 'support') });
    expect(scope.companyId).toBe('own');
    expect(scope.kind).toBe('own');
    expect(scope.isPlatformSession).toBe(false);
  });
});

describe('whether the screens may write', () => {
  it('lets a support session write', () => {
    expect(companyScope({ ownCompanyId: null, context: context('c', 'support') }).readOnly).toBe(false);
  });

  // refuse_read_only_context_write() raises on every INSERT, UPDATE and DELETE
  // a view context attempts, on all 39 tables.
  it('refuses a read context', () => {
    expect(companyScope({ ownCompanyId: null, context: context('c', 'view') }).readOnly).toBe(true);
  });

  it('refuses when there is no company at all', () => {
    expect(companyScope({ ownCompanyId: null, context: null }).readOnly).toBe(true);
  });

  it('never makes a company user read-only', () => {
    expect(companyScope({ ownCompanyId: 'own', context: null }).readOnly).toBe(false);
  });
});

describe('the rights the screens ask for', () => {
  const rights = { canCreate: true, canEdit: () => true, canDelete: () => true };

  it('are untouched outside a read context', () => {
    const scope = companyScope({ ownCompanyId: 'own', context: null });
    expect(scopedWriteRights(scope, rights)).toBe(rights);
  });

  it('are all refused inside one', () => {
    const scope = companyScope({ ownCompanyId: null, context: context('c', 'view') });
    const scoped = scopedWriteRights(scope, rights);
    expect(scoped.canCreate).toBe(false);
    expect(scoped.canEdit()).toBe(false);
    expect(scoped.canDelete()).toBe(false);
  });

  // current_role_permits(page, false) still answers for a support session's
  // reads; only the edit half is closed. Reading is the whole point of a view.
  it('keeps the view half of the permission matrix and drops the edit half', () => {
    const scope = companyScope({ ownCompanyId: null, context: context('c', 'view') });
    const can = scopedCan(scope, () => true);
    expect(can('drivers', 'view')).toBe(true);
    expect(can('drivers', 'edit')).toBe(false);
    // The screens call can(page) with no action, and AuthContext reads that as
    // 'edit'; the scope has to agree or a button comes back.
    expect(can('drivers')).toBe(false);
  });

  it('does not touch the matrix for a company user', () => {
    const scope = companyScope({ ownCompanyId: 'own', context: null });
    const can = () => true;
    expect(scopedCan(scope, can)).toBe(can);
  });
});
