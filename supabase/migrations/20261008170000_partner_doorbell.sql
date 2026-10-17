-- ════════════════════════════════════════════════════════════════════════════
--  The doorbell: the partner says a submission is ready, and WE fetch it
-- ════════════════════════════════════════════════════════════════════════════
--
--  Owner's decision, 08.10.2026, taken on a measurement: **Reidey cannot replay
--  the token it issued.** Sanctum stores only a hash, so the partner's own
--  backend cannot read the plaintext back — and `partner-intake`'s door
--  authenticates with exactly that token (`X-Partner-Key` → HMAC →
--  `partner_credential_company`). So the push direction, for notes as well as
--  Belege, needed a credential nobody holds.
--
--  Three ways were put to the owner. He chose the one that needs no new secret
--  anywhere: **the partner rings, carrying no payload and no credential, and we
--  pull the submission with the token we already hold sealed** (`20261008110000`).
--
--    - a ring is `{partner, fleet, submission, kind}` and nothing else;
--    - the transfer is an authenticated GET to the partner's own host, the one
--      destination this product validates (`partner-endpoint.ts`);
--    - a FORGED ring therefore costs one request that answers 404. It cannot
--      inject a submission, because nothing in the ring is stored.
--
--  The alternatives and their costs, recorded because this is reversible: the
--  partner sealing its own plaintext at issue (a replayable secret at rest on
--  their side, readable by anyone with their database and APP_KEY), and a second
--  key we issue (two pastes in a Connect flow the owner designed as one).
--
--  ── What a ring must be bounded by, and why it is counted here ─────────────
--
--  The ring carries no credential, so it is reachable by anyone holding the anon
--  key — which ships in the browser bundle. It cannot lie, but it CAN make us
--  call the partner, so it is rate limited, and Kong has no rate limiting in
--  this stack: the limit belongs in the database, as `otp_issue`'s does.
--
--  Three counters, and the third is the one that protects the partner rather
--  than us: per fleet per minute, per fleet per hour, and across all fleets per
--  minute — because an attacker varying the fleet id would otherwise have an
--  unbounded number of per-fleet budgets.
--
--  **The table purges itself on each call** rather than growing until a host
--  cron removes it. `deploy/otp-housekeeping.sh` is installed by hand on the
--  host, and adding a line to it is a host change that waits for the owner; a
--  DELETE of rows older than the longest window is cheap, bounded and needs
--  nobody. That is a deliberate trade: the purge runs inside a ring, so a ring
--  pays for it.

-- ─── 1. the events, in app_private because they are a limiter's state ──────

CREATE TABLE IF NOT EXISTS app_private.partner_doorbell_events (
  id                  bigserial PRIMARY KEY,
  partner             text        NOT NULL,
  external_company_id text        NOT NULL,
  rung_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_doorbell_events_window
  ON app_private.partner_doorbell_events (rung_at DESC);
CREATE INDEX IF NOT EXISTS partner_doorbell_events_fleet
  ON app_private.partner_doorbell_events (partner, external_company_id, rung_at DESC);

COMMENT ON TABLE app_private.partner_doorbell_events IS
  'One row per ring, for the rate limit and nothing else. In app_private '
  'because it is a limiter''s state: a client that could read it would learn '
  'which fleets are active, and one that could delete from it would lift its '
  'own limit. Purged by partner_doorbell_resolve() on every call.';

-- The second wall. Missing USAGE on the schema is what keeps callers out; this
-- is what catches a future GRANT that hands the schema to an API role.
REVOKE ALL ON app_private.partner_doorbell_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app_private.partner_doorbell_events_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 2. who the ring is about, and whether it is allowed to ask ────────────

CREATE OR REPLACE FUNCTION public.partner_doorbell_resolve(
  p_partner             text,
  p_external_company_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Each limit is a CONSTANT in the one function that enforces it, which is
  -- this schema's rule for every limit since the OTP work.
  c_per_fleet_minute constant int := 20;
  c_per_fleet_hour   constant int := 120;
  c_global_minute    constant int := 240;
  c_keep             constant interval := interval '2 hours';

  v_partner text := lower(btrim(coalesce(p_partner, '')));
  v_fleet   text := btrim(coalesce(p_external_company_id, ''));
  v_company uuid;
  v_n       int;
BEGIN
  IF v_partner = '' OR v_fleet = '' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- Older than the longest window, so nothing a counter needs is removed.
  DELETE FROM app_private.partner_doorbell_events WHERE rung_at < now() - c_keep;

  SELECT count(*) INTO v_n
    FROM app_private.partner_doorbell_events
   WHERE rung_at > now() - interval '1 minute';
  IF v_n >= c_global_minute THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  SELECT count(*) INTO v_n
    FROM app_private.partner_doorbell_events
   WHERE partner = v_partner AND external_company_id = v_fleet
     AND rung_at > now() - interval '1 minute';
  IF v_n >= c_per_fleet_minute THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  SELECT count(*) INTO v_n
    FROM app_private.partner_doorbell_events
   WHERE partner = v_partner AND external_company_id = v_fleet
     AND rung_at > now() - interval '1 hour';
  IF v_n >= c_per_fleet_hour THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  -- The ring is counted whether or not the fleet is known, so enumerating
  -- fleet ids is bounded by the global counter rather than free.
  INSERT INTO app_private.partner_doorbell_events (partner, external_company_id)
  VALUES (v_partner, v_fleet);

  -- `20261007100000`'s index is on (partner, external_company_id) where the
  -- status is not revoked, so at most one live connection answers here. A
  -- revoked connection is not revived by a ring.
  SELECT c.company_id INTO v_company
    FROM public.partner_connections c
   WHERE c.partner = v_partner
     AND c.external_company_id = v_fleet
     AND c.status <> 'revoked'
   LIMIT 1;

  IF v_company IS NULL THEN
    -- The same answer as a fleet that exists but is not connected to us, so a
    -- ring cannot be used to ask which fleets this product knows.
    RETURN jsonb_build_object('ok', false, 'reason', 'not_connected');
  END IF;

  RETURN jsonb_build_object('ok', true, 'company_id', v_company);
END;
$$;

COMMENT ON FUNCTION public.partner_doorbell_resolve(text, text) IS
  'Answers which company a partner fleet belongs to, and counts the ring '
  'against three rate limits first. A ring carries no credential, so this is '
  'the only thing bounding it; past a limit the answer is rate_limited and the '
  'ring is not counted twice. An unknown fleet and a revoked connection are '
  'the same answer. Service role only, and a refusal is a return value.';

REVOKE ALL ON FUNCTION public.partner_doorbell_resolve(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_doorbell_resolve(text, text) TO service_role;

-- ─── 3. Self-check ─────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n int;
  r   record;
BEGIN
  -- 1. the four app_private rules: no API role reaches the schema or the table.
  FOR r IN SELECT unnest(ARRAY['anon', 'authenticated', 'service_role']) AS role LOOP
    IF has_schema_privilege(r.role, 'app_private', 'USAGE') THEN
      RAISE EXCEPTION 'doorbell self-check 1: % has USAGE on app_private', r.role;
    END IF;
    IF has_table_privilege(r.role, 'app_private.partner_doorbell_events', 'SELECT')
       OR has_table_privilege(r.role, 'app_private.partner_doorbell_events', 'INSERT')
       OR has_table_privilege(r.role, 'app_private.partner_doorbell_events', 'DELETE') THEN
      RAISE EXCEPTION 'doorbell self-check 1: % can reach partner_doorbell_events', r.role;
    END IF;
  END LOOP;

  -- 2. the resolver is service_role's alone. It answers which company a fleet
  --    id belongs to, which is a fact about a customer of ours.
  IF has_function_privilege('anon', 'public.partner_doorbell_resolve(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.partner_doorbell_resolve(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'doorbell self-check 2: a client role may call the resolver';
  END IF;

  -- 3. SECURITY DEFINER with a pinned search_path.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_doorbell_resolve'
     AND p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'doorbell self-check 3: the resolver is not a pinned SECURITY DEFINER';
  END IF;

  -- 4. all three counters are still in the body, and the purge with them. A
  --    resolver that lost the global counter would give an attacker an
  --    unbounded number of per-fleet budgets, one per invented fleet id.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_doorbell_resolve'
     AND p.prosrc LIKE '%c_global_minute%'
     AND p.prosrc LIKE '%c_per_fleet_minute%'
     AND p.prosrc LIKE '%c_per_fleet_hour%'
     AND p.prosrc LIKE '%DELETE FROM app_private.partner_doorbell_events%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'doorbell self-check 4: the resolver lost a counter or its purge';
  END IF;

  -- 5. a revoked connection is not an answer. The ring is how a submission
  --    enters this product, so a company that revoked its connection must stop
  --    receiving them.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_doorbell_resolve'
     AND p.prosrc LIKE '%status <> ''revoked''%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'doorbell self-check 5: the resolver no longer excludes a revoked connection';
  END IF;

  RAISE NOTICE 'partner doorbell: self-checks passed — a ring is bounded, and it carries nothing we store';
END
$check$;
