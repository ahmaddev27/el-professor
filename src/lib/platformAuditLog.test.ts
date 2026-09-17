import { describe, expect, it } from 'vitest';
import {
  AUDIT_PAGE_SIZE,
  appendAuditRows,
  auditRpcArgs,
  dayBoundary,
  parseAuditAnswer,
  parseAuditCursor,
  type AuditRow,
} from './platformAuditLog';

const row = (id: number, occurredAt = '2026-09-16T10:00:00Z'): AuditRow => ({
  id,
  occurred_at: occurredAt,
  actor_user_id: null,
  actor_email: null,
  actor_role: null,
  session_id: null,
  company_id: null,
  company_name: null,
  category: 'read',
  action: 'platform_read.companies_list',
  outcome: 'ok',
  target_type: 'company',
  target_id: null,
  before_value: null,
  after_value: null,
});

describe('parseAuditAnswer', () => {
  it('reads a page and its cursor', () => {
    const result = parseAuditAnswer({
      ok: true,
      scope: 'all',
      limit: 100,
      next_cursor: { before_occurred_at: '2026-09-16T09:00:00Z', before_id: 41 },
      items: [{ id: 42, occurred_at: '2026-09-16T10:00:00Z', category: 'staff', action: 'platform_staff.insert', outcome: 'ok' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toBe('all');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].action).toBe('platform_staff.insert');
    expect(result.nextCursor).toEqual({ before_occurred_at: '2026-09-16T09:00:00Z', before_id: 41 });
  });

  it('reads the last page as having no cursor', () => {
    const result = parseAuditAnswer({ ok: true, scope: 'own', items: [] });
    expect(result).toEqual({ ok: true, scope: 'own', items: [], nextCursor: null });
  });

  it('keeps a refusal, and reports anything unreadable as malformed', () => {
    expect(parseAuditAnswer({ ok: false, reason: 'not_authorized' }))
      .toEqual({ ok: false, reason: 'not_authorized' });
    for (const data of [null, 'ok', [], { ok: true }]) {
      expect(parseAuditAnswer(data)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('defaults an unnamed scope to the narrower one', () => {
    const result = parseAuditAnswer({ ok: true, items: [] });
    expect(result.ok && result.scope).toBe('own');
  });
});

describe('parseAuditCursor', () => {
  it('needs both halves', () => {
    // platform_audit_list raises 22023 when one is given without the other, so
    // half a cursor must mean "no more pages", never a call.
    expect(parseAuditCursor({ before_occurred_at: '2026-09-16T09:00:00Z' })).toBeNull();
    expect(parseAuditCursor({ before_id: 41 })).toBeNull();
    expect(parseAuditCursor(null)).toBeNull();
    expect(parseAuditCursor({ before_occurred_at: '', before_id: 41 })).toBeNull();
  });

  it('reads an id that arrived as a string, as bigint JSON may', () => {
    expect(parseAuditCursor({ before_occurred_at: '2026-09-16T09:00:00Z', before_id: '41' }))
      .toEqual({ before_occurred_at: '2026-09-16T09:00:00Z', before_id: 41 });
  });
});

describe('appendAuditRows', () => {
  it('adds the next page after the rows already shown', () => {
    expect(appendAuditRows([row(9), row(8)], [row(7), row(6)]).map(r => r.id))
      .toEqual([9, 8, 7, 6]);
  });

  it('drops a row already on screen, so "load more" pressed twice cannot duplicate one', () => {
    expect(appendAuditRows([row(9), row(8)], [row(8), row(7)]).map(r => r.id))
      .toEqual([9, 8, 7]);
  });

  it('keeps the rows unchanged when the page adds nothing', () => {
    expect(appendAuditRows([row(9)], [row(9)]).map(r => r.id)).toEqual([9]);
  });
});

describe('auditRpcArgs', () => {
  it('sends NULL for every filter that was not set', () => {
    expect(auditRpcArgs({})).toEqual({
      p_actor_user_id: null,
      p_company_id: null,
      p_category: null,
      p_action_prefix: null,
      p_outcome: null,
      p_from: null,
      p_to: null,
      p_before_occurred_at: null,
      p_before_id: null,
      p_limit: AUDIT_PAGE_SIZE,
    });
  });

  it('turns a blank filter into NULL rather than an empty token', () => {
    const args = auditRpcArgs({ category: '  ', outcome: '', actionPrefix: ' platform_staff. ' });
    expect(args.p_category).toBeNull();
    expect(args.p_outcome).toBeNull();
    expect(args.p_action_prefix).toBe('platform_staff.');
  });

  it('sends a cursor as both halves or neither', () => {
    const paged = auditRpcArgs({ cursor: { before_occurred_at: '2026-09-16T09:00:00Z', before_id: 41 } });
    expect(paged.p_before_occurred_at).toBe('2026-09-16T09:00:00Z');
    expect(paged.p_before_id).toBe(41);

    const first = auditRpcArgs({ cursor: null });
    expect(first.p_before_occurred_at).toBeNull();
    expect(first.p_before_id).toBeNull();
  });
});

describe('dayBoundary', () => {
  // vitest.config.ts pins TZ=Europe/Berlin, so a day is the product's own day.
  it('starts a day at its local midnight', () => {
    expect(dayBoundary('2026-09-16', 'from')).toBe('2026-09-15T22:00:00.000Z');
  });

  it('ends a day at the next local midnight, so the day itself is included', () => {
    // p_to is exclusive: "to 16.09." has to mean the whole of the 16th.
    expect(dayBoundary('2026-09-16', 'to')).toBe('2026-09-16T22:00:00.000Z');
  });

  it('is null for anything that is not a date', () => {
    expect(dayBoundary('', 'from')).toBeNull();
    expect(dayBoundary('16.09.2026', 'from')).toBeNull();
  });
});
