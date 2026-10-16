/**
 * The decisions the /delete-company route makes outside the database
 * (migration 20261016140000): which accounts go, which stay, how the database's
 * answer is read, and what a half-finished clean-up says.
 *
 * The database half (the company, its tables, the plan, the audit row) is
 * tests/rls/company-deletion.sql. GoTrue and the storage API are not in the kit,
 * so the only thing that can pin the order and the exclusions here is this file.
 */
import { describe, expect, it } from 'vitest';
import {
  batchObjects,
  cleanupIsIncomplete,
  decideAccounts,
  incompleteCleanupMessage,
  isAlreadyGone,
  parseDeleteCompanyRequest,
  parseDeletionAnswer,
  restoredStaffProfile,
  statusForDeleteReason,
  type CleanupReport,
  type DeletionAccount,
} from './company-delete-core.ts';

const ID = (n: number) => `3d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function account(n: number, action: 'delete' | 'keep', over: Partial<DeletionAccount> = {}): DeletionAccount {
  return {
    user_id: ID(n), email: `a${n}@test.invalid`, full_name: `A ${n}`, role: 'viewer',
    status: 'active', action, reason: action === 'keep' ? 'platform_staff' : null, ...over,
  };
}

describe('parseDeleteCompanyRequest', () => {
  it('accepts a company id and the typed name, and does not touch the name', () => {
    const r = parseDeleteCompanyRequest({ company_id: ID(1), confirm_name: ' Ziel GmbH ' });
    expect(r).toEqual({ ok: true, request: { companyId: ID(1), confirmName: ' Ziel GmbH ' } });
  });

  it('refuses everything else', () => {
    for (const body of [null, undefined, [], 'x', 3, {}, { company_id: 'nope', confirm_name: 'x' },
                        { company_id: ID(1) }, { company_id: ID(1), confirm_name: '   ' },
                        { company_id: ID(1), confirm_name: 5 }, { company_id: ID(1), confirm_name: 'x'.repeat(301) }]) {
      expect(parseDeleteCompanyRequest(body).ok, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('decideAccounts', () => {
  it('removes ordinary accounts and keeps what the database marked keep', async () => {
    const d = await decideAccounts([account(1, 'delete'), account(2, 'keep'), account(3, 'delete')], async () => false);
    expect(d.toDelete.map(a => a.user_id)).toEqual([ID(1), ID(3)]);
    expect(d.kept.map(a => a.user_id)).toEqual([ID(2)]);
    expect(d.kept[0].keptBecause).toBe('platform_staff');
  });

  it('never asks about, and never removes, an account the database already kept', async () => {
    const asked: string[] = [];
    const d = await decideAccounts([account(2, 'keep')], async id => { asked.push(id); return false; });
    expect(d.toDelete).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('keeps an account that joined the platform team after the plan was made', async () => {
    const d = await decideAccounts([account(1, 'delete'), account(2, 'delete')], async id => id === ID(2));
    expect(d.toDelete.map(a => a.user_id)).toEqual([ID(1)]);
    expect(d.kept.map(a => a.user_id)).toEqual([ID(2)]);
  });

  it('keeps an account when the staff check itself cannot be answered', async () => {
    const d = await decideAccounts([account(1, 'delete')], async () => { throw new Error('rpc down'); });
    expect(d.toDelete).toEqual([]);
    expect(d.kept).toHaveLength(1);
  });

  it('removes nothing that was not in the list it was given', async () => {
    const list = [account(1, 'delete'), account(2, 'delete')];
    const d = await decideAccounts(list, async () => false);
    expect(d.toDelete.every(a => list.some(l => l.user_id === a.user_id))).toBe(true);
    expect(d.toDelete.length + d.kept.length).toBe(list.length);
  });
});

describe('parseDeletionAnswer', () => {
  const plan = {
    rows_total: 12, tables: { drivers: 3, income: 9 },
    accounts: [account(1, 'delete'), account(2, 'keep')],
    files: { count: 1, by_bucket: { documents: 1 } },
  };

  it('reads a success', () => {
    const r = parseDeletionAnswer({ success: true, plan, objects: [{ bucket: 'documents', name: 'x/y.pdf' }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer.rowsTotal).toBe(12);
      expect(r.answer.accounts).toHaveLength(2);
      expect(r.answer.objects).toEqual([{ bucket: 'documents', name: 'x/y.pdf' }]);
      expect(r.answer.fileCount).toBe(1);
    }
  });

  it('keeps the reason and the sentence of a refusal', () => {
    const r = parseDeletionAnswer({ success: false, reason: 'company_delete_context_open', error: 'Zugriff offen.' });
    expect(r).toEqual({ ok: false, reason: 'company_delete_context_open', message: 'Zugriff offen.' });
  });

  it('treats an answer it cannot read as a refusal, so no account is removed on its strength', () => {
    for (const data of [null, 'x', {}, { success: 'yes' }, { success: true }, { success: true, plan: {}, objects: [] },
                        { success: true, plan: { accounts: [] }, objects: 'no' }]) {
      expect(parseDeletionAnswer(data).ok, JSON.stringify(data)).toBe(false);
    }
  });

  it('refuses a success whose account list has an entry it cannot read, rather than dropping the entry', () => {
    const bad = { success: true, plan: { ...plan, accounts: [account(1, 'delete'), { user_id: 'not-a-uuid', action: 'delete' }] }, objects: [] };
    expect(parseDeletionAnswer(bad).ok).toBe(false);
    const badAction = { success: true, plan: { ...plan, accounts: [{ ...account(1, 'delete'), action: 'purge' }] }, objects: [] };
    expect(parseDeletionAnswer(badAction).ok).toBe(false);
  });
});

describe('statusForDeleteReason', () => {
  it('maps a refusal to a status', () => {
    expect(statusForDeleteReason('denied')).toBe(403);
    expect(statusForDeleteReason('not_found')).toBe(404);
    expect(statusForDeleteReason('invalid')).toBe(400);
    expect(statusForDeleteReason('name_mismatch')).toBe(409);
    expect(statusForDeleteReason('company_delete_context_open')).toBe(409);
  });
});

describe('a kept platform account', () => {
  it('is written back without a company and with the least role', () => {
    const p = restoredStaffProfile(account(2, 'keep', { full_name: 'Kollege' }));
    expect(p).toMatchObject({ user_id: ID(2), company_id: null, role: 'viewer', role_id: null, status: 'active', is_super_admin: true });
    expect(p.full_name).toBe('Kollege');
  });
});

describe('removing things', () => {
  it('knows GoTrue\'s answer for an account that is already gone', () => {
    expect(isAlreadyGone({ status: 404 })).toBe(true);
    expect(isAlreadyGone({ code: 'user_not_found' })).toBe(true);
    expect(isAlreadyGone({ message: 'User not found' })).toBe(true);
    expect(isAlreadyGone({ status: 500, message: 'boom' })).toBe(false);
    expect(isAlreadyGone(null)).toBe(false);
  });

  it('groups files by bucket in slices', () => {
    const objects = [
      ...Array.from({ length: 3 }, (_, i) => ({ bucket: 'a', name: `a${i}` })),
      { bucket: 'b', name: 'b0' },
    ];
    expect(batchObjects(objects, 2)).toEqual([
      { bucket: 'a', names: ['a0', 'a1'] }, { bucket: 'a', names: ['a2'] }, { bucket: 'b', names: ['b0'] },
    ]);
    expect(batchObjects([])).toEqual([]);
  });

  const clean: CleanupReport = {
    accountsDeleted: [ID(1)], accountsKept: [], accountsFailed: [], profilesRestored: [],
    profilesNotRestored: [], filesRemoved: 2, filesFailed: 0,
  };

  it('calls a complete clean-up complete, and anything left over incomplete', () => {
    expect(cleanupIsIncomplete(clean)).toBe(false);
    expect(cleanupIsIncomplete({ ...clean, accountsFailed: [{ user_id: ID(1), email: 'x@test.invalid' }] })).toBe(true);
    expect(cleanupIsIncomplete({ ...clean, profilesNotRestored: [ID(2)] })).toBe(true);
    expect(cleanupIsIncomplete({ ...clean, filesFailed: 1 })).toBe(true);
  });

  it('says that the company is gone and which addresses still exist', () => {
    const m = incompleteCleanupMessage({ ...clean, accountsFailed: [{ user_id: ID(1), email: 'x@test.invalid' }], filesFailed: 2 });
    expect(m).toContain('Das Unternehmen und seine Daten wurden gelöscht');
    expect(m).toContain('x@test.invalid');
    expect(m).toContain('2 Datei(en)');
  });
});
