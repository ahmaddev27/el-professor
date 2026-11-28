-- ════════════════════════════════════════════════════════════════════════════
--  A partner driver is linked automatically only when the match is certain
--  (20261127120000)
-- ════════════════════════════════════════════════════════════════════════════
--
--  CI's rls-kit job runs it on every push. If a line fails, read the actual
--  value and find why it moved before touching the expectation.
--
--  The owner's rule of 27.11.2026: the roster import and the nightly Uber
--  placement link by exact name, but only when certain, and leave every other
--  case a pending proposal with its reason.
--
--    §1  who may call the import (viewer, editor, anon), and that nothing moved.
--    §2  the import, one probe per branch of the rule: a certain match links
--        (automatic_match, linked_by the caller, the waiting note and Beleg are
--        claimed), no namesake creates (active, next staff number, German,
--        automatic_create), a departed driver with no namesake is created
--        inactive with no number, and every other case stays pending with the
--        reason: two active (name_ambiguous), active plus inactive and inactive
--        only (name_inactive), the single active one already linked
--        (name_taken), no usable name (name_missing). Another company is
--        untouched.
--    §3  a second run changes nothing and reports the same seven reasons.
--    §4  confirm writes manual and clears the reason, a driver that already
--        holds a link is still refused, reject clears the reason, and the three
--        CHECKs refuse what they must.
--    §5  the nightly placement (mode active) applies the same rule, with
--        linked_by NULL, the claim made with no session, and the reasons. A
--        subject is left set in the transaction ON PURPOSE while it runs, and
--        through the job's own door (uber_pull_place_unlinked) as well: who
--        made a link is said by the door, never read from the session.
--    §6  the human earnings resolve (mode inactive) matches exactly as before
--        and records the method and the administrator.
--    §7  the catalogue: nobody the API authenticates as reaches the three
--        app_private functions, the four-argument placement is gone, the
--        grants of the four public ones and of the job's door stand.
--    §8  mutation controls: each rule is broken inside a subtransaction and the
--        probe is shown to notice. The mutated function is rolled back each
--        time by the sentinel exception, as in conflict-review-record.sql, and
--        so is the unmutated run each control is compared with, because the
--        import walks every pending proposal of the company and would leave
--        none for the next control.
--
--  Two rules every probe here keeps, both learnt from this file's first run:
--  a read of a write goes in the statement AFTER the write (_pc_link is
--  STABLE and sees the snapshot of the statement that calls it), and _pc_call
--  clears the claims it set (set_config(..., true) lasts the transaction, so a
--  subject would otherwise follow every later probe).
--
--  Runs inside BEGIN ... ROLLBACK. Ids start with `2e` so a failure names a row.
--  All names are invented.

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _pc_as(p_who text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- A privilege error is raised at parse time and the plan the owner just
  -- warmed would hide it, so the owner's cached plans go first.
  DISCARD PLANS;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  IF p_who = 'anon' THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSIF p_who = 'service' THEN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_who, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/* The claims as the owner runs: no subject, no role, no sign-in method. */
CREATE OR REPLACE FUNCTION _pc_clear() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $$;

/* Runs p_sql as p_who ('owner', 'anon', 'service' or a user id) and returns the
   scalar, 'null' for NULL, or `ERR <sqlstate> <hint-or-none>`. It clears the
   claims on the way out, on both paths: without that the last user's subject
   stayed auth.uid() for every owner probe after it, and the nightly
   placement's first run here wrote that user as linked_by. */
CREATE OR REPLACE FUNCTION _pc_call(p_who text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_hint text; v_state text;
BEGIN
  IF p_who <> 'owner' THEN PERFORM _pc_as(p_who); END IF;
  EXECUTE p_sql INTO v_out;
  RESET ROLE;
  PERFORM _pc_clear();
  RETURN coalesce(v_out, 'null');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  RESET ROLE;
  PERFORM _pc_clear();
  RETURN 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), '(no hint)');
END $$;

CREATE TEMP TABLE _pc_out (
  n integer PRIMARY KEY, label text NOT NULL,
  actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _pc_rec(p_n integer, p_label text, p_actual text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := p_actual IS NOT DISTINCT FROM p_expected;
  INSERT INTO _pc_out VALUES (p_n, p_label, coalesce(p_actual, '<NULL>'), coalesce(p_expected, '<NULL>'), v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 3), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 3), p_label;
    RAISE WARNING '        expected: %', coalesce(p_expected, '<NULL>');
    RAISE WARNING '        actual:   %', coalesce(p_actual, '<NULL>');
  END IF;
END $$;

/* created/linked/pending/skipped_count of one roster import, as a string. */
CREATE OR REPLACE FUNCTION _pc_import() RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT $q$SELECT (x->>'created') || '/' || (x->>'linked') || '/' || (x->>'pending') || '/' || (x->>'skipped_count')
              FROM (SELECT partner_drivers_import() AS x) s$q$
$$;

/* the skipped reasons of one roster import, in link-id order. */
CREATE OR REPLACE FUNCTION _pc_import_reasons() RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT $q$SELECT coalesce(string_agg(e->>'reason', ',' ORDER BY e->>'link_id'), 'none')
              FROM jsonb_array_elements(partner_drivers_import()->'skipped') e$q$
$$;

/* One link of company A by its partner id: status, driver, method, reason, who.
   STABLE, so it reads with the snapshot of the statement that calls it: a
   write made by another call in that same statement is invisible to it. Read
   a write in the statement after it. */
CREATE OR REPLACE FUNCTION _pc_link(p_ext text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT l.status || '|' || coalesce(d.name, 'no driver') || '|' || coalesce(l.link_method, 'null') || '|'
         || coalesce(l.decision_reason, 'null') || '|' || coalesce(l.linked_by::text, 'null')
    FROM partner_driver_links l LEFT JOIN drivers d ON d.id = l.driver_id
   WHERE l.company_id = 'c0000000-0000-4000-8000-00000000000a' AND l.partner = 'reidey'
     AND l.external_driver_id = p_ext
$$;

/* The decision function's answer for one name, as `action:reason`. */
CREATE OR REPLACE FUNCTION _pc_decide(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT m.o_action || ':' || coalesce(m.o_reason, '')
    FROM app_private.partner_driver_certain_match('c0000000-0000-4000-8000-00000000000a', 'reidey', p_name) m
$$;

/* The placement of a list of earners, as the owner, with no caller: what the
   job's door passes. */
CREATE OR REPLACE FUNCTION _pc_place(p_earners jsonb, p_status text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT app_private.partner_place_earners('c0000000-0000-4000-8000-00000000000a', 'reidey', p_earners, p_status, NULL)
$$;

CREATE OR REPLACE FUNCTION _pc_earner(p_ext text, p_name text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('external_driver_id', p_ext, 'name', p_name) $$;

/* "6002:name_ambiguous,6003:..." from an answer's skipped list, by partner id. */
CREATE OR REPLACE FUNCTION _pc_refused(p_answer jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(string_agg((e->>'external_driver_id') || ':' || (e->>'reason'), ',' ORDER BY e->>'external_driver_id'), 'none')
    FROM jsonb_array_elements(p_answer->'skipped') e
$$;

CREATE OR REPLACE FUNCTION _pc_names(p_answer jsonb, p_key text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(string_agg((e->>'external_driver_id') || '=' || (e->>'name'), ',' ORDER BY e->>'external_driver_id'), 'none')
    FROM jsonb_array_elements(p_answer->p_key) e
$$;

/* Breaks one piece of a function as the owner: refuses a mutation that would
   change nothing, so a control cannot silently measure the unmutated code. */
CREATE OR REPLACE FUNCTION _pc_mutate_fn(p_sig text, p_from text, p_to text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_old text := pg_get_functiondef(to_regprocedure(p_sig));
BEGIN
  IF v_old IS NULL OR position(p_from IN v_old) = 0 THEN
    RAISE EXCEPTION 'mutation control: % does not contain [%], so the mutation would change nothing', p_sig, p_from;
  END IF;
  EXECUTE replace(v_old, p_from, p_to);
END $$;

/* p_sig mutated, then the probe as p_who, then everything rolled back. */
CREATE OR REPLACE FUNCTION _pc_mutant(p_sig text, p_from text, p_to text, p_who text, p_sql text)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  BEGIN
    PERFORM _pc_mutate_fn(p_sig, p_from, p_to);
    v_out := _pc_call(p_who, p_sql);
    RAISE EXCEPTION USING ERRCODE = 'ZZ042', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ042' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      v_out := 'MUTATION FAILED: ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_out;
END $$;

/* p_sql as p_who, then everything rolled back: the unmutated run a control is
   compared with, leaving the state as it found it for the next control. */
CREATE OR REPLACE FUNCTION _pc_undone(p_who text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  BEGIN
    v_out := _pc_call(p_who, p_sql);
    RAISE EXCEPTION USING ERRCODE = 'ZZ042', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ042' THEN
      v_out := SQLERRM;
  END;
  RESET ROLE;
  RETURN v_out;
END $$;

/* The open run of company A that §5 claims, for the job's door. */
CREATE TEMP TABLE _pc_run (id uuid);

/* The job's door for one earner, with a subject left set in the transaction
   on purpose, then the link it wrote, read in a statement of its own. The
   door must write no caller whatever the session says. */
CREATE OR REPLACE FUNCTION _pc_door_then(p_ext text, p_name text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_answer jsonb; v_out text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
  v_answer := uber_pull_place_unlinked((SELECT id FROM _pc_run), jsonb_build_array(_pc_earner(p_ext, p_name)));
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'SELECT _pc_link($1)' INTO v_out USING p_ext;
  RETURN coalesce(v_answer->>'ok', 'null') || '|' || coalesce(v_out, 'no link');
END $$;

/* The human earnings resolve for one earner, as whoever _pc_call made the
   caller, then the link it wrote. */
CREATE OR REPLACE FUNCTION _pc_resolve_then(p_ext text, p_name text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_answer jsonb; v_out text;
BEGIN
  v_answer := partner_earners_resolve('reidey', jsonb_build_array(_pc_earner(p_ext, p_name)));
  EXECUTE 'SELECT _pc_link($1)' INTO v_out USING p_ext;
  RETURN coalesce(v_answer->>'ok', 'null') || '|' || coalesce(v_out, 'no link');
END $$;

/* The roster import, then one read, in one function so the read sees the
   import's writes (a single statement would not, it keeps its snapshot). */
CREATE OR REPLACE FUNCTION _pc_import_then(p_read text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_out text;
BEGIN
  PERFORM partner_drivers_import();
  EXECUTE p_read INTO v_out;
  RETURN v_out;
END $$;

/* Import, then the method and claim of one proposal, as `method/claimed`. */
CREATE OR REPLACE FUNCTION _pc_probe(p_ext text, p_note text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format('SELECT _pc_import_then(%L)',
    'SELECT (SELECT coalesce(link_method, ''null'') FROM partner_driver_links WHERE external_driver_id = ' || quote_literal(p_ext)
    || ') || ''/'' || (SELECT (driver_id IS NOT NULL)::text FROM partner_note_submissions WHERE external_submission_id = '
    || quote_literal(p_note) || ')')
$$;

-- ─── fixtures (as the owner, so RLS does not apply) ─────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
BEGIN
  INSERT INTO drivers (id, company_id, name, status) VALUES
    -- one active namesake, unlinked: the certain match
    ('2e000000-0000-4000-8000-0000000000d1', co_a, 'Pc Eins', 'active'),
    -- two active namesakes
    ('2e000000-0000-4000-8000-0000000000d2', co_a, 'Pc Zwei', 'active'),
    ('2e000000-0000-4000-8000-0000000000d3', co_a, 'pc zwei', 'active'),
    -- an active one and a departed one
    ('2e000000-0000-4000-8000-0000000000d4', co_a, 'Pc Alt', 'active'),
    ('2e000000-0000-4000-8000-0000000000d5', co_a, 'pc alt', 'inactive'),
    -- only a departed one
    ('2e000000-0000-4000-8000-0000000000d6', co_a, 'Pc Nur Alt', 'inactive'),
    -- the single active one, already linked to another partner id
    ('2e000000-0000-4000-8000-0000000000d7', co_a, 'Pc Besetzt', 'active'),
    -- another company's driver of the same name as the match
    ('2e000000-0000-4000-8000-0000000000d8', co_b, 'Pc Eins', 'active');

  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, driver_id, proposed_name, status, linked_at)
  VALUES (co_a, 'reidey', '5900', '2e000000-0000-4000-8000-0000000000d7', 'Pc Besetzt', 'linked', now());

  -- The partner's list as it would arrive, in link-id order.
  INSERT INTO partner_driver_links
    (id, company_id, partner, external_driver_id, proposed_name, proposed_email, proposed_phone, partner_removed_at)
  VALUES
    ('2e000000-0000-4000-8000-000000005001', co_a, 'reidey', '5001', 'pc eins ', NULL, NULL, NULL),
    ('2e000000-0000-4000-8000-000000005002', co_a, 'reidey', '5002', ' Pc Neu', 'neu@example.com', '0176 1234567', NULL),
    ('2e000000-0000-4000-8000-000000005003', co_a, 'reidey', '5003', 'Pc Weg Neu', NULL, NULL, now()),
    ('2e000000-0000-4000-8000-000000005004', co_a, 'reidey', '5004', 'Pc Zwei', NULL, NULL, NULL),
    ('2e000000-0000-4000-8000-000000005005', co_a, 'reidey', '5005', 'PC ALT', NULL, NULL, NULL),
    ('2e000000-0000-4000-8000-000000005006', co_a, 'reidey', '5006', 'Pc Nur Alt', NULL, NULL, NULL),
    ('2e000000-0000-4000-8000-000000005007', co_a, 'reidey', '5007', 'Pc Besetzt', NULL, NULL, NULL),
    ('2e000000-0000-4000-8000-000000005008', co_a, 'reidey', '5008', 'Unbekannter Fahrer', NULL, NULL, NULL),
    ('2e000000-0000-4000-8000-000000005009', co_a, 'reidey', '5009', '', NULL, NULL, NULL),
    ('2e000000-0000-4000-8000-000000005010', co_a, 'reidey', '5010', NULL, NULL, NULL, NULL);
  -- Company B's own pending link, which company A's import must not touch.
  INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, proposed_name)
  VALUES ('2e000000-0000-4000-8000-000000009001', co_b, 'reidey', '9001', 'Pc Eins');

  -- Submissions that arrived before the links: a note and a Beleg for the
  -- certain match (claimed by the link), a note for the ambiguous one (not).
  INSERT INTO partner_note_submissions
         (id, company_id, partner, external_submission_id, external_driver_id, note_type, note_text)
  VALUES ('2e000000-0000-4000-8000-0000000c0001', co_a, 'reidey', 'pc-note-1', '5001', 'breakdown', 'Panne'),
         ('2e000000-0000-4000-8000-0000000c0002', co_a, 'reidey', 'pc-note-2', '5004', 'wait', 'Wartezeit'),
         ('2e000000-0000-4000-8000-0000000c0003', co_a, 'reidey', 'pc-note-3', '6001', 'wait', 'Wartezeit');
  INSERT INTO partner_receipt_submissions
         (id, company_id, partner, external_submission_id, external_driver_id, description)
  VALUES ('2e000000-0000-4000-8000-0000000d0001', co_a, 'reidey', 'pc-rec-1', '5001', 'Tanken');
END $$;

-- ─── 1. who may call it, refused before anything moves ──────────────────────

DO $$
DECLARE
  viewer_a constant text := 'a0000000-0000-4000-8000-000000000003';
  editor_a constant text := 'a0000000-0000-4000-8000-000000000002';
  v_drivers integer := (SELECT count(*) FROM drivers);
BEGIN
  PERFORM _pc_rec(1, 'a viewer is refused by the administrator gate',
    _pc_call(viewer_a, _pc_import()), 'ERR 42501 not_authorized');
  PERFORM _pc_rec(2, 'so is an editor',
    _pc_call(editor_a, _pc_import()), 'ERR 42501 not_authorized');
  PERFORM _pc_rec(3, 'anon cannot execute it',
    _pc_call('anon', _pc_import()), 'ERR 42501 (no hint)');
  PERFORM _pc_rec(4, 'nothing moved: no driver, and every proposal still pending',
    (SELECT count(*)::text FROM drivers) || '/'
    || (SELECT count(*)::text FROM partner_driver_links WHERE external_driver_id LIKE '50%' AND status = 'pending'),
    v_drivers::text || '/10');
END $$;

-- ─── 2. the import, one probe per branch of the rule ────────────────────────

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_next text := app_private.next_driver_personalnummer(co_a);
  v_b_drivers integer := (SELECT count(*) FROM drivers WHERE company_id = co_b);
BEGIN
  PERFORM _pc_rec(10, 'two created, one linked, seven left pending and reported',
    _pc_call(admin_a, _pc_import()), '2/1/7/7');

  PERFORM _pc_rec(11, 'a certain match: linked to the one active namesake, automatic_match, by the caller',
    _pc_link('5001'), 'linked|Pc Eins|automatic_match|null|' || admin_a);
  PERFORM _pc_rec(12, '...and the note and the Beleg that waited for it belong to that driver now',
    (SELECT (driver_id = '2e000000-0000-4000-8000-0000000000d1')::text FROM partner_note_submissions WHERE external_submission_id = 'pc-note-1')
    || '/' ||
    (SELECT (driver_id = '2e000000-0000-4000-8000-0000000000d1')::text FROM partner_receipt_submissions WHERE external_submission_id = 'pc-rec-1'),
    'true/true');
  PERFORM _pc_rec(13, 'the existing driver is not renamed or duplicated',
    (SELECT name FROM drivers WHERE id = '2e000000-0000-4000-8000-0000000000d1') || '/'
    || (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(btrim(name)) = 'pc eins'),
    'Pc Eins/1');

  PERFORM _pc_rec(14, 'no namesake of any status: the driver is created, active, numbered next, German, with a clean phone',
    (SELECT d.name || '|' || d.status || '|' || coalesce(d.personalnummer, 'null') || '|' || d.preferred_language
            || '|' || coalesce(d.email, 'null') || '|' || coalesce(d.phone, 'null')
       FROM drivers d WHERE d.company_id = co_a AND d.name = 'Pc Neu'),
    'Pc Neu|active|' || v_next || '|de|neu@example.com|+491761234567');
  PERFORM _pc_rec(15, '...and linked to it as automatic_create, by the caller',
    _pc_link('5002'), 'linked|Pc Neu|automatic_create|null|' || admin_a);
  PERFORM _pc_rec(16, 'a departed driver with no namesake is created inactive with no staff number',
    (SELECT d.status || '|' || coalesce(d.personalnummer, 'null') FROM drivers d WHERE d.company_id = co_a AND d.name = 'Pc Weg Neu')
    || '|' || _pc_link('5003'),
    'inactive|null|linked|Pc Weg Neu|automatic_create|null|' || admin_a);

  PERFORM _pc_rec(17, 'two active namesakes: left pending as name_ambiguous, nothing linked, nobody created',
    _pc_link('5004') || '|' || (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(btrim(name)) = 'pc zwei'),
    'pending|no driver|null|name_ambiguous|null|2');
  PERFORM _pc_rec(18, '...and its waiting note is not claimed',
    (SELECT coalesce(driver_id::text, 'unclaimed') FROM partner_note_submissions WHERE external_submission_id = 'pc-note-2'),
    'unclaimed');
  PERFORM _pc_rec(19, 'an active and an inactive namesake: name_inactive, neither linked',
    _pc_link('5005') || '|' || (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(btrim(name)) = 'pc alt'),
    'pending|no driver|null|name_inactive|null|2');
  PERFORM _pc_rec(20, 'only an inactive namesake: name_inactive, not linked and not created again',
    _pc_link('5006') || '|' || (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(btrim(name)) = 'pc nur alt'),
    'pending|no driver|null|name_inactive|null|1');
  PERFORM _pc_rec(21, 'the single active namesake already holds a link: name_taken, and that link stands',
    _pc_link('5007') || '|' || _pc_link('5900') || '|' ||
    (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(btrim(name)) = 'pc besetzt'),
    'pending|no driver|null|name_taken|null|linked|Pc Besetzt|null|null|null|1');
  PERFORM _pc_rec(22, 'the fallback name, an empty name and no name: name_missing, and no driver of that name',
    _pc_link('5008') || '|' || _pc_link('5009') || '|' || _pc_link('5010') || '|' ||
    (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(btrim(name)) = 'unbekannter fahrer'),
    'pending|no driver|null|name_missing|null|pending|no driver|null|name_missing|null|pending|no driver|null|name_missing|null|0');

  PERFORM _pc_rec(23, 'another company is untouched: its link pending with no reason, its drivers as they were',
    (SELECT status || '|' || coalesce(decision_reason, 'null') || '|' || coalesce(link_method, 'null')
       FROM partner_driver_links WHERE id = '2e000000-0000-4000-8000-000000009001')
    || '|' || (SELECT count(*)::text FROM drivers WHERE company_id = co_b),
    'pending|null|null|' || v_b_drivers::text);
  PERFORM _pc_rec(24, 'a link made before this migration keeps a NULL method',
    (SELECT coalesce(link_method, 'null') FROM partner_driver_links WHERE external_driver_id = '5900'), 'null');
END $$;

-- ─── 3. a second run changes nothing ────────────────────────────────────────

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _pc_rec(30, 'the second run reports the same seven reasons, in link order',
    _pc_call(admin_a, _pc_import_reasons()),
    'name_ambiguous,name_inactive,name_inactive,name_taken,name_missing,name_missing,name_missing');
  PERFORM _pc_rec(31, 'and creates and links nothing',
    _pc_call(admin_a, _pc_import()), '0/0/7/7');
END $$;

-- ─── 4. confirm, reject and the CHECKs ──────────────────────────────────────

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  v_out text;
BEGIN
  -- Each call is its own statement and its link is read in the next one: a
  -- read in the same statement keeps that statement's snapshot and shows the
  -- row as it was before the call (this file's first run read exactly that).
  v_out := _pc_call(admin_a, $q$SELECT partner_driver_link_confirm('2e000000-0000-4000-8000-000000005005',
                                '2e000000-0000-4000-8000-0000000000d4') ->> 'ok'$q$);
  PERFORM _pc_rec(40, 'a person confirms the doubtful link: manual, the reason cleared, linked_by the person',
    v_out || '|' || _pc_link('5005'),
    'true|linked|Pc Alt|manual|null|' || admin_a);
  v_out := _pc_call(admin_a, $q$SELECT partner_driver_link_confirm('2e000000-0000-4000-8000-000000005006',
                                '2e000000-0000-4000-8000-0000000000d4') ->> 'ok'$q$);
  PERFORM _pc_rec(41, 'a driver that already holds a link is still refused by name, and the other link keeps its reason',
    v_out || '|' || _pc_link('5006'),
    'ERR P0001 driver_already_linked|pending|no driver|null|name_inactive|null');
  PERFORM _pc_rec(42, 'a decided link cannot be confirmed again',
    _pc_call(admin_a, $q$SELECT partner_driver_link_confirm('2e000000-0000-4000-8000-000000005005',
                                '2e000000-0000-4000-8000-0000000000d4') ->> 'ok'$q$),
    'ERR P0001 already_decided');
  v_out := _pc_call(admin_a, $q$SELECT partner_driver_link_reject('2e000000-0000-4000-8000-000000005004') ->> 'stranded'$q$);
  PERFORM _pc_rec(43, 'rejecting clears the reason and reports the stranded note',
    v_out || '|' || _pc_link('5004'),
    '1|rejected|no driver|null|null|null');

  PERFORM _pc_rec(44, 'a reason on a link that is not pending is refused by the CHECK',
    _pc_call('owner', $q$UPDATE partner_driver_links SET decision_reason = 'name_taken'
                          WHERE external_driver_id = '5001' RETURNING id::text$q$),
    'ERR 23514 (no hint)');
  PERFORM _pc_rec(45, 'a method outside the three is refused',
    _pc_call('owner', $q$UPDATE partner_driver_links SET link_method = 'guess'
                          WHERE external_driver_id = '5001' RETURNING id::text$q$),
    'ERR 23514 (no hint)');
  PERFORM _pc_rec(46, 'a reason outside the four is refused, even on a pending link',
    _pc_call('owner', $q$UPDATE partner_driver_links SET decision_reason = 'guess'
                          WHERE external_driver_id = '5006' RETURNING id::text$q$),
    'ERR 23514 (no hint)');
END $$;

-- ─── 5. the nightly placement applies the same rule ─────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  v_next text;
  v_answer jsonb;
  v_run uuid;
BEGIN
  INSERT INTO drivers (id, company_id, name, status) VALUES
    ('2e000000-0000-4000-8000-0000000000e7', co_a, 'Pc Tuer Eins', 'active'),
    ('2e000000-0000-4000-8000-0000000000e1', co_a, 'Pc N Eins', 'active'),
    ('2e000000-0000-4000-8000-0000000000e2', co_a, 'Pc N Zwei', 'active'),
    ('2e000000-0000-4000-8000-0000000000e3', co_a, 'pc n zwei', 'active'),
    ('2e000000-0000-4000-8000-0000000000e4', co_a, 'Pc N Alt', 'active'),
    ('2e000000-0000-4000-8000-0000000000e5', co_a, 'pc n alt', 'inactive'),
    ('2e000000-0000-4000-8000-0000000000e6', co_a, 'Pc N Besetzt', 'active');
  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, driver_id, proposed_name, status, linked_at)
  VALUES (co_a, 'reidey', '6900', '2e000000-0000-4000-8000-0000000000e6', 'Pc N Besetzt', 'linked', now());

  v_next := app_private.next_driver_personalnummer(co_a);
  -- A subject left set in the transaction, on purpose: the placement reads no
  -- session, so it must still write no caller.
  PERFORM set_config('request.jwt.claim.sub', admin_a, true);
  v_answer := _pc_place(jsonb_build_array(
    _pc_earner('6001', ' pc n eins'), _pc_earner('6002', 'Pc N Zwei'), _pc_earner('6003', 'PC N ALT'),
    _pc_earner('6004', 'Pc N Besetzt'), _pc_earner('6005', 'Pc N Neu'), _pc_earner('6006', 'Unbekannter Fahrer')),
    'active');
  PERFORM _pc_clear();

  PERFORM _pc_rec(50, 'two active namesakes, active plus inactive, an already linked one and no name are refused with their reasons',
    _pc_refused(v_answer),
    '6002:name_ambiguous,6003:name_inactive,6004:name_taken,6006:name_missing');
  PERFORM _pc_rec(51, 'the certain match is linked and the new name is created',
    _pc_names(v_answer, 'linked') || ' / ' || _pc_names(v_answer, 'created'),
    '6001=Pc N Eins / 6005=Pc N Neu');
  PERFORM _pc_rec(52, 'the match: automatic_match with no caller, although a subject was set',
    _pc_link('6001'), 'linked|Pc N Eins|automatic_match|null|null');
  PERFORM _pc_rec(53, 'the created driver: active, numbered next, German, automatic_create with no caller',
    (SELECT d.status || '|' || coalesce(d.personalnummer, 'null') || '|' || d.preferred_language
       FROM drivers d WHERE d.company_id = co_a AND d.name = 'Pc N Neu') || '|' || _pc_link('6005'),
    'active|' || v_next || '|de|linked|Pc N Neu|automatic_create|null|null');
  PERFORM _pc_rec(54, 'the note that waited for the matched earner was claimed with no session',
    (SELECT (driver_id = '2e000000-0000-4000-8000-0000000000e1')::text
       FROM partner_note_submissions WHERE external_submission_id = 'pc-note-3'),
    'true');
  PERFORM _pc_rec(55, 'the refused earners got no link row and nobody was created or linked for them',
    (SELECT count(*)::text FROM partner_driver_links WHERE external_driver_id IN ('6002', '6003', '6004', '6006'))
    || '/' || (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(btrim(name)) IN ('pc n zwei', 'pc n alt', 'pc n besetzt', 'unbekannter fahrer')),
    '0/5');

  -- The job's own door, on an open run, with a subject left set: it names no
  -- caller, so the links it makes carry none.
  v_run := uber_pull_claim(co_a, ((now() AT TIME ZONE 'Europe/Berlin') - interval '4 hours')::date - 1, 'first');
  INSERT INTO _pc_run VALUES (v_run);
  PERFORM _pc_rec(56, 'fixture: an open run for company A',
    (v_run IS NOT NULL)::text, 'true');
  PERFORM set_config('request.jwt.claim.sub', admin_a, true);
  v_answer := uber_pull_place_unlinked(v_run, jsonb_build_array(
    _pc_earner('6101', 'pc tuer eins'), _pc_earner('6102', 'Pc Tuer Neu')));
  PERFORM _pc_clear();
  PERFORM _pc_rec(57, 'the door answers ok with one link and one new driver',
    (v_answer->>'ok') || ' ' || (v_answer->'linked')::text || ' ' || (v_answer->'created')::text,
    'true [{"name": "Pc Tuer Eins"}] [{"name": "Pc Tuer Neu"}]');
  PERFORM _pc_rec(58, 'through the door neither link carries a caller, although a subject was set',
    _pc_link('6101') || ' ' || _pc_link('6102'),
    'linked|Pc Tuer Eins|automatic_match|null|null linked|Pc Tuer Neu|automatic_create|null|null');
  PERFORM _pc_rec(59, 'and the run records both',
    (SELECT jsonb_array_length(placed_drivers)::text FROM uber_pull_runs WHERE id = v_run), '2');
END $$;

-- ─── 6. the human earnings resolve keeps its matching ───────────────────────

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  v_answer jsonb;
BEGIN
  -- The names the nightly call refused above are matched here as before: the
  -- first driver with that name who holds no link, active or not.
  v_answer := _pc_call(admin_a, format($q$SELECT partner_earners_resolve('reidey', %L::jsonb)::text$q$,
    jsonb_build_array(_pc_earner('7001', 'Pc N Alt'), _pc_earner('7002', 'Pc N Besetzt'),
                      _pc_earner('7003', 'Pc N Zwei'), _pc_earner('7004', 'Pc Nur Alt'))::text))::jsonb;

  PERFORM _pc_rec(60, 'it links two namesakes and an inactive one as before, and still refuses the one every namesake of which is linked',
    _pc_names(v_answer, 'linked') || ' / ' || _pc_refused(v_answer),
    '7001=Pc N Alt,7003=Pc N Zwei,7004=Pc Nur Alt / 7002:name_taken');
  PERFORM _pc_rec(61, 'the lowest-id namesake was taken, and the method is recorded',
    _pc_link('7001') || '|' || (SELECT (driver_id = '2e000000-0000-4000-8000-0000000000e4')::text
                                  FROM partner_driver_links WHERE external_driver_id = '7001'),
    'linked|Pc N Alt|automatic_match|null|a0000000-0000-4000-8000-000000000001|true');
  PERFORM _pc_rec(62, 'a departed driver is linked by the human call, which the nightly rule would hold back',
    _pc_link('7004'), 'linked|Pc Nur Alt|automatic_match|null|a0000000-0000-4000-8000-000000000001');
END $$;

-- ─── 7. the catalogue ───────────────────────────────────────────────────────

DO $$
DECLARE
  v_oid oid;
  v_bad text := '';
BEGIN
  FOREACH v_oid IN ARRAY ARRAY[
    'app_private.partner_driver_certain_match(uuid,text,text)'::regprocedure,
    'app_private.partner_driver_link_apply(uuid,uuid,uuid,text)'::regprocedure,
    'app_private.partner_place_earners(uuid,text,jsonb,text,uuid)'::regprocedure] LOOP
    IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_oid AND a.grantee = 0) THEN
      v_bad := v_bad || v_oid::regprocedure::text || ' ';
    END IF;
  END LOOP;
  PERFORM _pc_rec(70, 'no API role and not PUBLIC can execute any of the three app_private functions', v_bad, '');

  v_bad := '';
  FOREACH v_oid IN ARRAY ARRAY[
    'public.partner_drivers_import(text)'::regprocedure,
    'public.partner_driver_link_confirm(uuid,uuid)'::regprocedure,
    'public.partner_driver_link_reject(uuid)'::regprocedure,
    'public.partner_earners_resolve(text,jsonb)'::regprocedure] LOOP
    IF has_function_privilege('anon', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_oid AND a.grantee = 0) THEN
      v_bad := v_bad || v_oid::regprocedure::text || ' ';
    END IF;
  END LOOP;
  PERFORM _pc_rec(71, 'the four public functions keep authenticated and refuse anon and PUBLIC', v_bad, '');

  v_oid := 'public.uber_pull_place_unlinked(uuid,jsonb)'::regprocedure;
  PERFORM _pc_rec(73, 'the job''s door is service_role only',
    has_function_privilege('service_role', v_oid, 'EXECUTE')::text || '/'
    || has_function_privilege('authenticated', v_oid, 'EXECUTE')::text || '/'
    || has_function_privilege('anon', v_oid, 'EXECUTE')::text || '/'
    || EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_oid AND a.grantee = 0)::text,
    'true/false/false/false');
  PERFORM _pc_rec(74, 'the four-argument placement, which read the session, is gone',
    (to_regprocedure('app_private.partner_place_earners(uuid,text,jsonb,text)') IS NULL)::text, 'true');

  PERFORM _pc_rec(72, 'all eight are SECURITY DEFINER with a pinned search_path',
    (SELECT count(*)::text FROM pg_proc p
      WHERE p.oid IN ('app_private.partner_driver_certain_match(uuid,text,text)'::regprocedure,
                      'app_private.partner_driver_link_apply(uuid,uuid,uuid,text)'::regprocedure,
                      'app_private.partner_place_earners(uuid,text,jsonb,text,uuid)'::regprocedure,
                      'public.partner_drivers_import(text)'::regprocedure,
                      'public.partner_driver_link_confirm(uuid,uuid)'::regprocedure,
                      'public.partner_driver_link_reject(uuid)'::regprocedure,
                      'public.partner_earners_resolve(text,jsonb)'::regprocedure,
                      'public.uber_pull_place_unlinked(uuid,jsonb)'::regprocedure)
        AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public']),
    '8');
END $$;

-- ─── 8. mutation controls ───────────────────────────────────────────────────
-- Each rule is broken in turn inside a subtransaction and the probe that
-- guards it is shown to notice: the expectation is the WRONG answer the broken
-- function gives. A control that mutated nothing would raise, not pass.

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  c_sig constant text := 'app_private.partner_driver_certain_match(uuid,text,text)';
  c_apply constant text := 'app_private.partner_driver_link_apply(uuid,uuid,uuid,text)';
  c_place constant text := 'app_private.partner_place_earners(uuid,text,jsonb,text,uuid)';
  c_door constant text := 'public.uber_pull_place_unlinked(uuid,jsonb)';
  c_resolve constant text := 'public.partner_earners_resolve(text,jsonb)';
  v_zwei text := $q$SELECT _pc_decide('Pc Zwei')$q$;
  v_door text := $q$SELECT _pc_door_then('6201', 'Pc Tuer Mut')$q$;
  v_resolve text := $q$SELECT _pc_resolve_then('7101', 'Pc Res Mut')$q$;
BEGIN
  -- An active and a departed namesake, both unlinked (section 4 linked Pc Alt).
  INSERT INTO drivers (id, company_id, name, status) VALUES
    ('2e000000-0000-4000-8000-0000000000f8', 'c0000000-0000-4000-8000-00000000000a', 'Pc Paar', 'active'),
    ('2e000000-0000-4000-8000-0000000000f9', 'c0000000-0000-4000-8000-00000000000a', 'pc paar', 'inactive');
  PERFORM _pc_rec(80, 'control: unmutated, the probes read what §2 expects',
    _pc_call('owner', v_zwei) || ' ' || _pc_call('owner', $q$SELECT _pc_decide('Pc Nur Alt')$q$)
    || ' ' || _pc_call('owner', $q$SELECT _pc_decide('Pc Besetzt')$q$)
    || ' ' || _pc_call('owner', $q$SELECT _pc_decide('Pc Gibts Nicht')$q$)
    || ' ' || _pc_call('owner', $q$SELECT _pc_decide('Unbekannter Fahrer')$q$),
    'refuse:name_ambiguous refuse:name_inactive refuse:name_taken create: refuse:name_missing');

  PERFORM _pc_rec(81, 'control: without the two-active rule two namesakes are linked',
    _pc_mutant(c_sig, 'ELSIF v_active >= 2 THEN', 'ELSIF false THEN', 'owner', v_zwei), 'match:');
  PERFORM _pc_rec(82, 'control: without the inactive rule an active-and-departed pair is linked',
    _pc_mutant(c_sig, 'ELSIF v_inactive > 0 THEN', 'ELSIF false THEN', 'owner', $q$SELECT _pc_decide('Pc Paar')$q$),
    'match:');
  PERFORM _pc_rec(83, 'control: counting only active namesakes would create a second Pc Nur Alt',
    _pc_mutant(c_sig, 'IF v_active = 0 AND v_inactive = 0 THEN', 'IF v_active = 0 THEN', 'owner',
               $q$SELECT _pc_decide('Pc Nur Alt')$q$),
    'create:');
  PERFORM _pc_rec(84, 'control: without the already-linked rule the taken driver is linked a second time',
    _pc_mutant(c_sig, 'AND x.driver_id = v_one)', 'AND x.driver_id = v_one AND false)', 'owner',
               $q$SELECT _pc_decide('Pc Besetzt')$q$),
    'match:');
  PERFORM _pc_rec(85, 'control: without the fallback-name rule a driver called Unbekannter Fahrer is created',
    _pc_mutant(c_sig, 'v_key = ''unbekannter fahrer''', 'v_key = ''zzz''', 'owner',
               $q$SELECT _pc_decide('Unbekannter Fahrer')$q$),
    'create:');
  PERFORM _pc_rec(86, 'control: the nightly placement asks the rule, so breaking it changes the nightly answer',
    _pc_call('owner', $q$SELECT _pc_refused(_pc_place(jsonb_build_array(_pc_earner('6990', 'Pc Zwei')), 'active'))$q$)
    || ' vs ' ||
    _pc_mutant(c_sig, 'ELSIF v_active >= 2 THEN', 'ELSIF false THEN', 'owner',
               $q$SELECT _pc_refused(_pc_place(jsonb_build_array(_pc_earner('6991', 'Pc Zwei')), 'active'))$q$),
    '6990:name_ambiguous vs none');

  -- A certain match per control, each with a waiting note. The import walks
  -- every pending proposal of the company, so the unmutated run (87) is rolled
  -- back like the mutants: in this file's first run it was not, it linked all
  -- three, and 88 and 89 then read 87's links and measured nothing.
  INSERT INTO drivers (id, company_id, name, status) VALUES
    ('2e000000-0000-4000-8000-0000000000f4', 'c0000000-0000-4000-8000-00000000000a', 'Pc Res Mut', 'active'),
    ('2e000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-00000000000a', 'Pc Mut Eins', 'active'),
    ('2e000000-0000-4000-8000-0000000000f2', 'c0000000-0000-4000-8000-00000000000a', 'Pc Mut Zwei', 'active'),
    ('2e000000-0000-4000-8000-0000000000f3', 'c0000000-0000-4000-8000-00000000000a', 'Pc Mut Drei', 'active');
  INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, proposed_name) VALUES
    ('2e000000-0000-4000-8000-000000005901', 'c0000000-0000-4000-8000-00000000000a', 'reidey', '5901', 'Pc Mut Eins'),
    ('2e000000-0000-4000-8000-000000005902', 'c0000000-0000-4000-8000-00000000000a', 'reidey', '5902', 'Pc Mut Zwei'),
    ('2e000000-0000-4000-8000-000000005903', 'c0000000-0000-4000-8000-00000000000a', 'reidey', '5903', 'Pc Mut Drei');
  INSERT INTO partner_note_submissions
         (id, company_id, partner, external_submission_id, external_driver_id, note_type, note_text) VALUES
    ('2e000000-0000-4000-8000-0000000c0901', 'c0000000-0000-4000-8000-00000000000a', 'reidey', 'pc-note-m1', '5901', 'wait', 'x'),
    ('2e000000-0000-4000-8000-0000000c0902', 'c0000000-0000-4000-8000-00000000000a', 'reidey', 'pc-note-m2', '5902', 'wait', 'x'),
    ('2e000000-0000-4000-8000-0000000c0903', 'c0000000-0000-4000-8000-00000000000a', 'reidey', 'pc-note-m3', '5903', 'wait', 'x');

  PERFORM _pc_rec(87, 'control: the apply as written gives the method and the claim',
    _pc_undone(admin_a, _pc_probe('5901', 'pc-note-m1')), 'automatic_match/true');
  PERFORM _pc_rec(88, 'control: an apply that claims nothing leaves the waiting note unclaimed',
    _pc_mutant(c_apply, 'AND driver_id IS NULL AND status = ''pending'';', 'AND driver_id IS NULL AND status = ''never'';',
               admin_a, _pc_probe('5902', 'pc-note-m2')),
    'automatic_match/false');
  PERFORM _pc_rec(89, 'control: an apply that writes the wrong method is noticed',
    _pc_mutant(c_apply, 'link_method = p_method', 'link_method = ''manual''', admin_a, _pc_probe('5903', 'pc-note-m3')),
    'manual/true');

  -- Who made a link is said by the door. Each door's unmutated run is the
  -- control the mutants are compared with; all of them are rolled back.
  PERFORM _pc_rec(90, 'control: the job''s door as written leaves linked_by NULL with a subject set',
    _pc_undone('owner', v_door), 'true|linked|Pc Tuer Mut|automatic_create|null|null');
  PERFORM _pc_rec(91, 'control: a door that passes the session''s subject is noticed',
    _pc_mutant(c_door, 'p_earners, ''active'', NULL)', 'p_earners, ''active'', auth.uid())', 'owner', v_door),
    'true|linked|Pc Tuer Mut|automatic_create|null|' || admin_a);
  PERFORM _pc_rec(92, 'control: a placement that reads the session instead of p_caller is noticed',
    _pc_mutant(c_place, 'v_driver, p_caller, v_method)', 'v_driver, auth.uid(), v_method)', 'owner', v_door),
    'true|linked|Pc Tuer Mut|automatic_create|null|' || admin_a);
  PERFORM _pc_rec(93, 'control: the human resolve as written records its administrator',
    _pc_undone(admin_a, v_resolve), 'true|linked|Pc Res Mut|automatic_match|null|' || admin_a);
  PERFORM _pc_rec(94, 'control: a resolve that passes no caller is noticed',
    _pc_mutant(c_resolve, 'p_earners, ''inactive'', v_caller)', 'p_earners, ''inactive'', NULL)', admin_a, v_resolve),
    'true|linked|Pc Res Mut|automatic_match|null|null');
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad integer := (SELECT count(*) FROM _pc_out WHERE NOT matched);
  v_all integer := (SELECT count(*) FROM _pc_out);
BEGIN
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner certain link: % of % probes did not match', v_bad, v_all;
  END IF;
  RAISE NOTICE 'partner certain link: all % probes matched', v_all;
END $$;

ROLLBACK;
