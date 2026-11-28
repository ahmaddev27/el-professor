/**
 * The unlink migration (20261128120000), read as text. The RLS kit executes it
 * (`tests/rls/partner-unlink.sql`); these are the properties a later edit could
 * lose without the kit's run being the first to say so.
 *
 * - The RPC takes the gate of partner_driver_link_confirm character for
 *   character: the owner's default was "the same right that confirms or
 *   rejects a link today; do not invent a new gate".
 * - It writes the link row and nothing else: the Belege, notes, income rows and
 *   submissions the link claimed are the driver's records and stay.
 * - The two restated functions are their previous body plus the skip, so the
 *   restatement cannot have dropped something else on the way.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string): string =>
  readFileSync(path.resolve(__dirname, '../../supabase/migrations', file), 'utf8');

const UNLINK_SQL = read('20261128120000_partner_driver_unlink.sql');
const CERTAIN_SQL = read('20261127120000_partner_certain_driver_link.sql');

/** One function from its CREATE to the closing dollar quote. 20261127120000
 *  creates the placement with a plain CREATE, having dropped its 4-argument
 *  form, so both spellings are read. */
function definitionIn(sql: string, signature: string): string {
  const found = [`CREATE OR REPLACE FUNCTION ${signature}(`, `CREATE FUNCTION ${signature}(`]
    .map((needle) => sql.indexOf(needle))
    .filter((i) => i > -1);
  expect(found.length, `${signature} is defined`).toBeGreaterThan(0);
  const start = Math.min(...found);
  const open = sql.indexOf('AS $$', start);
  return sql.slice(start, sql.indexOf('$$;', open + 5));
}

/** The body alone, between the dollar quotes. */
const bodyOf = (definition: string): string => definition.slice(definition.indexOf('AS $$'));

/** The header alone: the arguments and the attributes, no body. */
const headerOf = (definition: string): string => definition.slice(0, definition.indexOf('AS $$'));

/** The gate block: from the first IF to its END IF. */
function gateOf(body: string): string {
  const start = body.indexOf('IF v_caller IS NULL');
  return body.slice(start, body.indexOf('END IF;', start));
}

describe('partner_driver_link_unlink', () => {
  const definition = definitionIn(UNLINK_SQL, 'public.partner_driver_link_unlink');
  const body = bodyOf(definition);

  it('is a SECURITY DEFINER function with a pinned search_path', () => {
    expect(headerOf(definition)).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
  });

  it('is executable by authenticated and by neither PUBLIC nor anon', () => {
    expect(UNLINK_SQL).toContain(
      'REVOKE ALL ON FUNCTION public.partner_driver_link_unlink(uuid) FROM PUBLIC, anon;',
    );
    expect(UNLINK_SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.partner_driver_link_unlink(uuid) TO authenticated;',
    );
  });

  it('asks exactly the gate that confirms a link today', () => {
    const confirm = bodyOf(definitionIn(CERTAIN_SQL, 'public.partner_driver_link_confirm'));
    expect(gateOf(body)).toBe(gateOf(confirm));
    expect(gateOf(body)).toContain("public.current_role_permits('drivers', true)");
    expect(body).toContain('public.get_active_company_id()');
  });

  it('finds the link inside the active company only, and locks it', () => {
    expect(body).toMatch(/WHERE id = p_link_id AND company_id = v_company\s+FOR UPDATE;/);
  });

  it('answers with a stable reason for every refusal', () => {
    for (const reason of ['not_authorized', 'invalid_request', 'link_not_found', 'not_linked']) {
      expect(body).toContain(`HINT = '${reason}'`);
    }
  });

  it('takes the link apart and records who and when', () => {
    expect(body).toMatch(/SET status = 'pending', driver_id = NULL,/);
    expect(body).toMatch(/link_method = NULL, linked_by = NULL, linked_at = NULL,/);
    expect(body).toContain("decision_reason = 'unlinked'");
    expect(body).toContain('unlinked_by = v_caller, unlinked_at = now()');
  });

  it('writes the link row and nothing the link claimed', () => {
    expect(body.match(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+[\w.]+/g)).toEqual([
      'UPDATE public.partner_driver_links',
    ]);
    expect(body).not.toMatch(
      /receipts|driver_notes|income|partner_receipt_submissions|partner_note_submissions|public\.drivers/,
    );
  });
});

describe('the record', () => {
  it('has three CHECKs: a pair, a manual relink, and a reason that names a record', () => {
    expect(UNLINK_SQL).toMatch(
      /partner_driver_links_unlinked_pair\s+CHECK \(\(unlinked_by IS NULL\) = \(unlinked_at IS NULL\)\)/,
    );
    expect(UNLINK_SQL).toMatch(
      /partner_driver_links_unlinked_stays_manual\s+CHECK \(unlinked_at IS NULL OR status <> 'linked' OR link_method IS NOT DISTINCT FROM 'manual'\)/,
    );
    expect(UNLINK_SQL).toMatch(
      /partner_driver_links_unlinked_reason_recorded\s+CHECK \(decision_reason IS DISTINCT FROM 'unlinked' OR unlinked_at IS NOT NULL\)/,
    );
  });

  it('a CHECK compares with IS NOT DISTINCT FROM, so a NULL method cannot pass as manual', () => {
    expect(UNLINK_SQL).not.toMatch(/link_method = 'manual'\)/);
  });

  it('is guarded by a SECURITY INVOKER trigger, or the guard would refuse nobody', () => {
    const guard = definitionIn(UNLINK_SQL, 'app_private.partner_link_guard_unlink_record');
    expect(headerOf(guard)).toMatch(/SECURITY INVOKER/);
    expect(headerOf(guard)).not.toMatch(/SECURITY DEFINER/);
    expect(guard).toContain("ARRAY['anon', 'authenticated', 'service_role']");
    expect(guard).toContain("HINT = 'unlink_record_protected'");
    expect(UNLINK_SQL).toMatch(
      /CREATE TRIGGER partner_link_unlink_record_guard\s+BEFORE INSERT OR UPDATE ON public\.partner_driver_links\s+FOR EACH ROW/,
    );
  });
});

describe('no automatic path links an unlinked row again', () => {
  it('the placement is 20261127120000\'s body plus the one skip branch', () => {
    const signature = 'app_private.partner_place_earners';
    const before = bodyOf(definitionIn(CERTAIN_SQL, signature));
    const after = bodyOf(definitionIn(UNLINK_SQL, signature));
    const branch = after.slice(
      after.indexOf('    ELSIF FOUND AND v_link.unlinked_at IS NOT NULL THEN'),
      after.indexOf("    ELSIF p_new_status = 'active' THEN"),
    );
    expect(branch).toContain("v_reason := 'unlinked';");
    expect(after.replace(branch, '')).toBe(before);
  });

  it('the placement skips before either mode looks a driver up', () => {
    const after = bodyOf(definitionIn(UNLINK_SQL, 'app_private.partner_place_earners'));
    const skip = after.indexOf('ELSIF FOUND AND v_link.unlinked_at IS NOT NULL THEN');
    expect(skip).toBeGreaterThan(after.indexOf("IF FOUND AND v_link.status = 'rejected' THEN"));
    expect(skip).toBeLessThan(after.indexOf("ELSIF p_new_status = 'active' THEN"));
    expect(skip).toBeLessThan(after.indexOf('lower(btrim(d.name)) = v_key'));
  });

  it('the import keeps its gates and its one way to link', () => {
    const before = bodyOf(definitionIn(CERTAIN_SQL, 'public.partner_drivers_import'));
    const after = bodyOf(definitionIn(UNLINK_SQL, 'public.partner_drivers_import'));
    for (const fragment of [
      "HINT = 'platform_session_not_allowed'",
      'public.is_company_admin()',
      "hashtextextended('partner_fleet_import:' || v_company::text, 0)",
      "l.status = 'pending'",
      'app_private.partner_driver_link_apply(v_link.id, v_driver, v_caller, v_method)',
      "'limit_reached'",
    ]) {
      expect(before, fragment).toContain(fragment);
      expect(after, fragment).toContain(fragment);
    }
  });
});
