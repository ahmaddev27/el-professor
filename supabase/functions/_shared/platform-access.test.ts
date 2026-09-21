import { describe, expect, it, vi } from 'vitest';
import {
  accountIsPlatformStaff,
  auditedPlatformRead,
  auditedPlatformWrite,
  auditRpcArgs,
  PLATFORM_CAPABILITIES,
  PlatformAuditError,
  PlatformCheckError,
  platformCan,
  platformCanManageAccount,
  platformSupportCompanyId,
  recordPlatformAudit,
  requirePlatformAudit,
  type PlatformAuditSubject,
  type RpcClient,
  type RpcResult,
} from './platform-access.ts';
import { decideAccountTarget, MANAGE_USERS_ROUTES, resolveManageUsersRoute } from './manage-users-routes.ts';

type Call = [string, Record<string, unknown> | undefined];
type Answer = RpcResult | Error;

/** Answers every call with the same result, or rejects with the same error. */
function client(result: Answer): RpcClient & { calls: Call[] } {
  return scripted(() => result);
}

/** Answers each call from `answer(fn, args)`, so one stub can fail only the audit. */
function scripted(answer: (fn: string, args?: Record<string, unknown>) => Answer): RpcClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push([fn, args]);
      const result = answer(fn, args);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

const outcomesOf = (c: { calls: Call[] }) =>
  c.calls.filter(([fn]) => fn === 'platform_audit_record').map(([, args]) => args?.p_outcome);

const silent = () => {};

describe('platformCan', () => {
  it('asks platform_can for exactly the capability', async () => {
    const c = client({ data: true, error: null });
    await expect(platformCan(c, 'codes.manage')).resolves.toBe(true);
    expect(c.calls).toEqual([['platform_can', { p_capability: 'codes.manage' }]]);
  });

  it('counts only a literal true as permission', async () => {
    for (const data of [false, null, undefined, 'true', 1, {}]) {
      await expect(platformCan(client({ data, error: null }), 'companies.read')).resolves.toBe(false);
    }
  });

  it('throws when the check itself fails, rather than answering either way', async () => {
    const c = client({ data: true, error: { code: '42501', message: 'permission denied' } });
    await expect(platformCan(c, 'staff.manage')).rejects.toBeInstanceOf(PlatformCheckError);
  });
});

describe('platformSupportCompanyId', () => {
  const company = 'c0000000-0000-4000-8000-00000000000a';

  it('asks platform_support_company_id with no arguments, through the client it is given', async () => {
    const c = client({ data: company, error: null });
    await expect(platformSupportCompanyId(c)).resolves.toBe(company);
    expect(c.calls).toEqual([['platform_support_company_id', undefined]]);
  });

  it('answers null for no session, and for anything that is not a uuid', async () => {
    for (const data of [null, undefined, '', 'not-a-uuid', 42, true, {}, [company]]) {
      await expect(platformSupportCompanyId(client({ data, error: null }))).resolves.toBeNull();
    }
  });

  it('throws when the check itself fails, so a broken check never reads as a session', async () => {
    const c = client({ data: company, error: { code: '42501', message: 'permission denied' } });
    await expect(platformSupportCompanyId(c)).rejects.toBeInstanceOf(PlatformCheckError);
  });
});

describe('platformCanManageAccount', () => {
  const target = 'a0000000-0000-4000-8000-000000000001';

  it('asks platform_can_manage_account for exactly that account', async () => {
    const c = client({ data: true, error: null });
    await expect(platformCanManageAccount(c, target)).resolves.toBe(true);
    expect(c.calls).toEqual([['platform_can_manage_account', { p_user_id: target }]]);
  });

  it('counts only a literal true, so a NULL or odd answer refuses', async () => {
    for (const data of [false, null, undefined, 'true', 1]) {
      await expect(platformCanManageAccount(client({ data, error: null }), target)).resolves.toBe(false);
    }
  });

  it('throws when the check fails, so a broken check can never let the change through', async () => {
    await expect(platformCanManageAccount(client({ data: true, error: { message: 'boom' } }), target))
      .rejects.toBeInstanceOf(PlatformCheckError);
    await expect(platformCanManageAccount(client(new Error('network')), target))
      .rejects.toBeInstanceOf(Error);
  });
});

describe('recordPlatformAudit (best-effort)', () => {
  const entry = {
    category: 'write' as const,
    action: 'manage_users.create',
    outcome: 'ok' as const,
    companyId: 'c0000000-0000-4000-8000-00000000000a',
    targetType: 'user',
    targetId: 'a0000000-0000-4000-8000-000000000001',
    after: { role: 'viewer' },
  };

  it('maps an entry onto the RPC arguments, sending absent fields as null', () => {
    expect(auditRpcArgs({ category: 'read', action: 'manage_users.list', outcome: 'denied' })).toEqual({
      p_category: 'read', p_action: 'manage_users.list', p_outcome: 'denied',
      p_company_id: null, p_target_type: null, p_target_id: null, p_before: null, p_after: null,
    });
  });

  it('calls platform_audit_record and reports a written row', async () => {
    const c = client({ data: 42, error: null });
    await expect(recordPlatformAudit(c, entry)).resolves.toBe(true);
    expect(c.calls[0][0]).toBe('platform_audit_record');
    expect(c.calls[0][1]).toMatchObject({ p_action: 'manage_users.create', p_after: { role: 'viewer' } });
  });

  it('reports nothing written for a caller who is not platform staff', async () => {
    await expect(recordPlatformAudit(client({ data: null, error: null }), entry)).resolves.toBe(false);
  });

  it('never throws, and logs the action without its details on failure', async () => {
    const log = vi.fn();
    await expect(recordPlatformAudit(client({ data: null, error: { message: 'boom' } }), entry, log)).resolves.toBe(false);
    await expect(recordPlatformAudit(client(new Error('network')), entry, log)).resolves.toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
    for (const [line] of log.mock.calls) {
      const parsed = JSON.parse(line as string);
      expect(parsed.action).toBe('manage_users.create');
      expect(line).not.toContain('viewer');
      expect(line).not.toContain('a0000000-0000-4000-8000-000000000001');
    }
  });
});

describe('requirePlatformAudit (fails closed)', () => {
  const entry = { category: 'read' as const, action: 'manage_users.list', outcome: 'ok' as const, after: { secret: 'x' } };

  it('returns the id of the written row', async () => {
    await expect(requirePlatformAudit(client({ data: 7, error: null }), entry)).resolves.toBe(7);
  });

  it('throws PlatformAuditError when the RPC answers an error, rejects, or writes no row', async () => {
    for (const failing of [
      client({ data: null, error: { code: '22023', message: 'platform_audit_record: invalid arguments' } }),
      client(new Error('connection reset')),
      client({ data: null, error: null }),
    ]) {
      const attempt = requirePlatformAudit(failing, entry);
      await expect(attempt).rejects.toBeInstanceOf(PlatformAuditError);
      await expect(attempt).rejects.toThrow(/manage_users\.list/);
      await expect(attempt).rejects.not.toThrow(/secret/);
    }
  });
});

describe('auditedPlatformWrite', () => {
  const subject: PlatformAuditSubject = {
    category: 'write', action: 'manage_users.reset_password', targetType: 'user',
    targetId: 'a0000000-0000-4000-8000-000000000001',
  };

  it('never runs the change when the attempt row cannot be written', async () => {
    const mutate = vi.fn(async () => 'changed');
    const failing = scripted(() => ({ data: null, error: { code: '08006', message: 'connection failure' } }));

    await expect(auditedPlatformWrite(failing, subject, mutate, { log: silent }))
      .rejects.toBeInstanceOf(PlatformAuditError);
    expect(mutate).not.toHaveBeenCalled();
    expect(outcomesOf(failing)).toEqual(['attempt']);
  });

  it('also refuses when the attempt call rejects or writes no row', async () => {
    for (const failing of [scripted(() => new Error('network')), scripted(() => ({ data: null, error: null }))]) {
      const mutate = vi.fn(async () => 'changed');
      await expect(auditedPlatformWrite(failing, subject, mutate, { log: silent }))
        .rejects.toBeInstanceOf(PlatformAuditError);
      expect(mutate).not.toHaveBeenCalled();
    }
  });

  it('writes attempt before the change and ok after it, with what the change learned', async () => {
    const order: string[] = [];
    const learned: { targetId?: string } = {};
    const c = scripted((fn, args) => {
      order.push(`${fn}:${String(args?.p_outcome)}`);
      return { data: 1, error: null };
    });

    const result = await auditedPlatformWrite(c, { ...subject, targetId: null }, async () => {
      order.push('mutate');
      learned.targetId = 'b0000000-0000-4000-8000-000000000001';
      return 'changed';
    }, { details: () => ({ targetId: learned.targetId ?? null }) });

    expect(result).toBe('changed');
    expect(order).toEqual(['platform_audit_record:attempt', 'mutate', 'platform_audit_record:ok']);
    expect(c.calls[0][1]).toMatchObject({ p_target_id: null });
    expect(c.calls[1][1]).toMatchObject({ p_target_id: 'b0000000-0000-4000-8000-000000000001' });
  });

  it('keeps the result when only the outcome row fails: the change has already happened', async () => {
    const log = vi.fn();
    const c = scripted((_fn, args) =>
      args?.p_outcome === 'attempt' ? { data: 1, error: null } : { data: null, error: { message: 'boom' } });

    await expect(auditedPlatformWrite(c, subject, async () => 'changed', { log })).resolves.toBe('changed');
    expect(outcomesOf(c)).toEqual(['attempt', 'ok']);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('records a failed change as error and rethrows the original error', async () => {
    const c = client({ data: 1, error: null });
    const boom = new Error('GoTrue said no');

    await expect(auditedPlatformWrite(c, subject, async () => { throw boom; }, { log: silent })).rejects.toBe(boom);
    expect(outcomesOf(c)).toEqual(['attempt', 'error']);
  });
});

describe('auditedPlatformRead', () => {
  const subject: PlatformAuditSubject = { category: 'read', action: 'manage_users.list' };

  it('hands back nothing when its row cannot be written', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const failing = scripted(() => ({ data: null, error: { message: 'boom' } }));

    await expect(auditedPlatformRead(failing, subject, async () => rows, { details: (v) => ({ after: { count: v.length } }) }))
      .rejects.toBeInstanceOf(PlatformAuditError);
    expect(failing.calls).toHaveLength(1);
    expect(failing.calls[0][1]).toMatchObject({ p_outcome: 'ok', p_after: { count: 2 } });
  });

  it('refuses the same way when the call rejects or no row is written', async () => {
    for (const failing of [scripted(() => new Error('network')), scripted(() => ({ data: null, error: null }))]) {
      await expect(auditedPlatformRead(failing, subject, async () => ['x'])).rejects.toBeInstanceOf(PlatformAuditError);
    }
  });

  it('writes the row, then returns the value', async () => {
    const c = client({ data: 9, error: null });
    await expect(auditedPlatformRead(c, subject, async () => 'rows', { details: () => ({ after: { count: 1 } }) }))
      .resolves.toBe('rows');
    expect(outcomesOf(c)).toEqual(['ok']);
  });

  it('records a failed load as error, best-effort, and rethrows it', async () => {
    const boom = new Error('listUsers failed');
    const c = client({ data: null, error: { message: 'audit down too' } });

    await expect(auditedPlatformRead(c, subject, async () => { throw boom; }, { log: silent })).rejects.toBe(boom);
    expect(outcomesOf(c)).toEqual(['error']);
  });
});

describe('decideAccountTarget', () => {
  const companyA = 'c0000000-0000-4000-8000-00000000000a';
  const companyB = 'c0000000-0000-4000-8000-00000000000b';

  function facts(overrides: Partial<Parameters<typeof decideAccountTarget>[0]> = {}) {
    const platformCanManage = vi.fn(async () => true);
    const targetIsPlatformStaff = vi.fn(async () => false);
    return {
      platformCanManage,
      targetIsPlatformStaff,
      value: {
        isPlatformCaller: false,
        scopeCompanyId: companyA,
        targetCompanyId: companyA,
        platformCanManage,
        targetIsPlatformStaff,
        ...overrides,
      },
    };
  }

  it('refuses a company admin on a same-company account with a staff row', async () => {
    const f = facts({ targetIsPlatformStaff: vi.fn(async () => true) });
    await expect(decideAccountTarget(f.value)).resolves.toBe('platform_staff_account');
    expect(f.platformCanManage).not.toHaveBeenCalled();
  });

  it('allows a company admin on a normal same-company user', async () => {
    const f = facts();
    await expect(decideAccountTarget(f.value)).resolves.toBe('allowed');
    expect(f.targetIsPlatformStaff).toHaveBeenCalledTimes(1);
  });

  it('refuses a company admin on another company without asking about staff', async () => {
    for (const target of [companyB, null]) {
      const f = facts({ targetCompanyId: target });
      await expect(decideAccountTarget(f.value)).resolves.toBe('other_company');
      expect(f.targetIsPlatformStaff).not.toHaveBeenCalled();
    }
    const noCompany = facts({ scopeCompanyId: null, targetCompanyId: null });
    await expect(decideAccountTarget(noCompany.value)).resolves.toBe('other_company');
  });

  it('decides a platform caller inside its scope by platform_can_manage_account', async () => {
    const allowed = facts({ isPlatformCaller: true });
    await expect(decideAccountTarget(allowed.value)).resolves.toBe('allowed');
    expect(allowed.platformCanManage).toHaveBeenCalledTimes(1);
    expect(allowed.targetIsPlatformStaff).not.toHaveBeenCalled();

    const refused = facts({ isPlatformCaller: true, platformCanManage: vi.fn(async () => false) });
    await expect(decideAccountTarget(refused.value)).resolves.toBe('platform_staff_account');
  });

  // 3.13a: before it, a platform caller was decided by platform_can_manage_account
  // alone and reached any account of any company. The scope comes first now,
  // for everyone, and a platform caller outside it is not even asked about.
  it('refuses a platform caller on an account outside its scope, without asking anything', async () => {
    for (const target of [companyB, null]) {
      const f = facts({ isPlatformCaller: true, targetCompanyId: target });
      await expect(decideAccountTarget(f.value)).resolves.toBe('other_company');
      expect(f.platformCanManage).not.toHaveBeenCalled();
      expect(f.targetIsPlatformStaff).not.toHaveBeenCalled();
    }
    const noScope = facts({ isPlatformCaller: true, scopeCompanyId: null, targetCompanyId: null });
    await expect(decideAccountTarget(noScope.value)).resolves.toBe('other_company');
  });

  it('compares the two companies as uuids, whatever their case', async () => {
    const f = facts({ isPlatformCaller: true, targetCompanyId: companyA.toUpperCase() });
    await expect(decideAccountTarget(f.value)).resolves.toBe('allowed');
  });

  it('lets a failed staff check throw instead of allowing the change', async () => {
    const f = facts({ targetIsPlatformStaff: vi.fn(async () => { throw new PlatformCheckError('account_is_platform_staff failed'); }) });
    await expect(decideAccountTarget(f.value)).rejects.toBeInstanceOf(PlatformCheckError);
  });
});

describe('manage-users routes', () => {
  it('resolves each route by method and path, as the function always matched them', () => {
    expect(resolveManageUsersRoute('GET', '/manage-users/list')?.name).toBe('list');
    expect(resolveManageUsersRoute('POST', '/manage-users/create')?.name).toBe('create');
    expect(resolveManageUsersRoute('PUT', '/manage-users/update')?.name).toBe('update');
    expect(resolveManageUsersRoute('POST', '/manage-users/activate-deactivate')?.name).toBe('activate-deactivate');
    expect(resolveManageUsersRoute('POST', '/manage-users/resend-invite')?.name).toBe('resend-invite');
    expect(resolveManageUsersRoute('POST', '/manage-users/reset-password')?.name).toBe('reset-password');
    expect(resolveManageUsersRoute('DELETE', '/manage-users/delete')?.name).toBe('delete');
  });

  it('resolves nothing for a wrong method or an unknown path', () => {
    expect(resolveManageUsersRoute('POST', '/manage-users/list')).toBeNull();
    expect(resolveManageUsersRoute('GET', '/manage-users/create')).toBeNull();
    expect(resolveManageUsersRoute('GET', '/manage-users/other')).toBeNull();
  });

  it('lets a platform account list users with a read capability and change them only with company_users.manage', () => {
    expect(resolveManageUsersRoute('GET', '/manage-users/list')).toMatchObject({ capability: 'business.read', category: 'read' });
    for (const route of MANAGE_USERS_ROUTES.filter(r => r.name !== 'list')) {
      expect(route).toMatchObject({ capability: 'company_users.manage', category: 'write' });
    }
  });

  it('asks account_is_platform_staff for exactly that account, and a failed check throws', async () => {
    const target = 'a0000000-0000-4000-8000-000000000002';
    const c = client({ data: true, error: null });
    await expect(accountIsPlatformStaff(c, target)).resolves.toBe(true);
    expect(c.calls).toEqual([['account_is_platform_staff', { p_user_id: target }]]);
    await expect(accountIsPlatformStaff(client({ data: null, error: null }), target)).resolves.toBe(false);
    await expect(accountIsPlatformStaff(client({ data: true, error: { code: '42501', message: 'permission denied' } }), target))
      .rejects.toBeInstanceOf(PlatformCheckError);
  });

  it('names only known capabilities, the categories platform_audit_record accepts, and no reserved action', () => {
    for (const route of MANAGE_USERS_ROUTES) {
      expect(PLATFORM_CAPABILITIES).toContain(route.capability);
      expect(['read', 'write']).toContain(route.category);
      expect(route.action).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
      expect(route.action).not.toMatch(/^(platform_staff|legacy|auth)(\.|$)/);
    }
  });
});
