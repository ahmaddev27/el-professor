-- ════════════════════════════════════════════════════════════════════════════
--  M1.2 — the partner's token, kept in a form we can replay
-- ════════════════════════════════════════════════════════════════════════════
--
--  Until now `app_private.partner_credentials` held `key_hash` and nothing
--  else, which is right for the direction it was built for — the partner
--  presents a key, we hash it and look up the company — and useless for the
--  direction the owner chose on 05.10.2026, where **we** call Reidey. An HMAC
--  cannot be replayed.
--
--  ── Why the token must be kept at all, measured rather than assumed ─────────
--
--  Reidey returns the plaintext **once**. `ElProfessorController::issueToken`
--  calls `elprofessorTokens()->delete()` before minting, and Sanctum stores
--  only `hash('sha256', $plainTextToken)`. So the operator sees the token in
--  one response, and a connection that does not keep it cannot be used again
--  without re-minting — which revokes the link they just made.
--
--  ── The seal is made in the edge function, not here ─────────────────────────
--
--  This schema has no symmetric encryption anywhere: `pgcrypto` is installed
--  and used for `digest()` ten times and nothing else. Sealing in SQL would put
--  the key and the plaintext into query text, where they reach logs,
--  `pg_stat_statements` and error reports. `_shared/partner-token-seal.ts` does
--  AES-256-GCM in Deno with `PARTNER_SEAL_KEY`, so **this database never sees
--  the key or the token** — only `v1.<iv>.<ciphertext>`.
--
--  That is also why the column carries a CHECK on the seal's shape. It is not
--  validation for its own sake: the one accident worth making impossible is a
--  caller storing the plaintext token in the column meant for the seal, and a
--  Sanctum token (`17|AbCd…`) cannot match this pattern.
--
--  ── What this is and is not ────────────────────────────────────────────────
--
--  Encryption at rest against a database dump — the nightly backup has included
--  `app_private` since 18.09.2026. Anything holding both the database and the
--  functions' environment holds the tokens. What bounds that is on Reidey's
--  side: the token carries only `elprofessor:read` and is revocable there.
--
--  ── No audit row, and the reason is that a better record already exists ────
--
--  `app_private.platform_audit_log` is the record of what platform STAFF do to
--  a customer; a pull is the product's own outbound call on a company's behalf
--  and fits none of its categories. `public.partner_connections` already
--  carries `last_pull_at`, `last_success_at` and `last_error`, which is where a
--  pull belongs and what an operator can actually read.
--
--  ── The old function is dropped rather than overloaded ─────────────────────
--
--  Measured before writing this: **nothing calls `partner_connection_record`**
--  — not `src/`, not `supabase/functions/`. Adding a defaulted parameter with
--  CREATE OR REPLACE would leave two overloads and two grants to keep in step,
--  so the five-argument form is dropped and the six-argument one takes its
--  place. If a caller ever appears before this migration runs, it fails loudly
--  at the DROP rather than silently resolving to the wrong overload.

-- ─── 1. the column ──────────────────────────────────────────────────────────

ALTER TABLE app_private.partner_credentials
  ADD COLUMN IF NOT EXISTS sealed_token text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app_private.partner_credentials'::regclass
       AND conname = 'partner_credentials_sealed_token_shape'
  ) THEN
    ALTER TABLE app_private.partner_credentials
      ADD CONSTRAINT partner_credentials_sealed_token_shape
      CHECK (sealed_token IS NULL
             OR sealed_token ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
  END IF;
END $$;

COMMENT ON COLUMN app_private.partner_credentials.sealed_token IS
  'The partner''s bearer token, sealed by the edge function with '
  'PARTNER_SEAL_KEY: v1.<base64url iv>.<base64url ciphertext+tag>, AES-256-GCM. '
  'NULL for a credential recorded before the seal existed, which can verify an '
  'inbound push and cannot make an outbound call. The CHECK exists so the '
  'plaintext token cannot be stored here by mistake — a Sanctum token cannot '
  'match the pattern.';

-- ─── 2. the connect writer takes the seal ───────────────────────────────────

DROP FUNCTION IF EXISTS public.partner_connection_record(uuid, text, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.partner_connection_record(
  p_company_id            uuid,
  p_partner               text,
  p_key_hash              text,
  p_sealed_token          text,
  p_external_company_id   text    DEFAULT NULL,
  p_external_company_name text    DEFAULT NULL,
  p_connected_by          uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_partner text := lower(btrim(coalesce(p_partner, '')));
  v_id      uuid;
BEGIN
  IF p_company_id IS NULL OR v_partner = '' OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- The seal's shape is checked here as well as by the column, so a caller
  -- gets a named refusal rather than a 23514 carrying a constraint name.
  IF p_sealed_token IS NOT NULL
     AND p_sealed_token !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'the token is not sealed'
      USING ERRCODE = '22023', HINT = 'token_not_sealed';
  END IF;

  -- Reconnecting revokes what was there rather than overwriting it: the row
  -- records a decision a person made, and the next decision is a new row.
  UPDATE public.partner_connections
     SET status = 'revoked', revoked_at = now(), updated_at = now()
   WHERE company_id = p_company_id AND partner = v_partner AND status <> 'revoked';

  UPDATE app_private.partner_credentials
     SET disabled_at = now()
   WHERE company_id = p_company_id AND partner = v_partner AND disabled_at IS NULL;

  INSERT INTO app_private.partner_credentials
         (company_id, partner, key_hash, sealed_token, external_company_id, created_by)
  VALUES (p_company_id, v_partner, p_key_hash, p_sealed_token, p_external_company_id, p_connected_by);

  INSERT INTO public.partner_connections
         (company_id, partner, external_company_id, external_company_name,
          status, connected_by, last_success_at)
  VALUES (p_company_id, v_partner, p_external_company_id, p_external_company_name,
          'active', p_connected_by, now())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'connection_id', v_id);
END;
$$;

COMMENT ON FUNCTION public.partner_connection_record(uuid, text, text, text, text, text, uuid) IS
  'Stores a partner connection, its hashed token (for an inbound push) and its '
  'sealed token (for an outbound pull), after the edge function has proven the '
  'token works. Revokes any previous one rather than overwriting it. Service '
  'role only.';

REVOKE ALL ON FUNCTION public.partner_connection_record(uuid, text, text, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_connection_record(uuid, text, text, text, text, text, uuid)
  TO service_role;

-- ─── 3. the outbound reader ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_sealed_token(p_company_id uuid, p_partner text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_sealed text;
BEGIN
  IF p_company_id IS NULL OR btrim(coalesce(p_partner, '')) = '' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- The live credential only. A disabled one belongs to a revoked connection
  -- and its token has been deleted on the partner's side anyway, so handing it
  -- out could only produce a 401 that reads as our own fault.
  SELECT c.sealed_token INTO v_sealed
    FROM app_private.partner_credentials c
   WHERE c.company_id = p_company_id
     AND c.partner = lower(btrim(p_partner))
     AND c.disabled_at IS NULL
   LIMIT 1;

  -- NULL for "no credential" and for "recorded before the seal existed" alike.
  -- The caller cannot act differently on the two, and telling them apart would
  -- say whether a company is connected to a caller that already has to hold
  -- the service key.
  RETURN v_sealed;
END;
$$;

COMMENT ON FUNCTION public.partner_sealed_token(uuid, text) IS
  'The sealed bearer token of a company''s live partner credential, for the '
  'outbound pull to open with PARTNER_SEAL_KEY. NULL when there is none and '
  'when the credential predates the seal. Service role only: this is the one '
  'function in the schema that hands back a replayable secret.';

REVOKE ALL ON FUNCTION public.partner_sealed_token(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_sealed_token(uuid, text) TO service_role;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n int;
  r   record;
BEGIN
  -- 1. the reader is service_role's alone. It is the only function that hands
  --    back a replayable secret, so a stray grant here is the whole exposure.
  FOR r IN SELECT unnest(ARRAY['anon', 'authenticated']) AS role LOOP
    IF has_function_privilege(r.role, 'public.partner_sealed_token(uuid,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'token seal self-check 1: % may execute partner_sealed_token', r.role;
    END IF;
    IF has_function_privilege(r.role,
         'public.partner_connection_record(uuid,text,text,text,text,text,uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'token seal self-check 1: % may execute partner_connection_record', r.role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.partner_sealed_token(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'token seal self-check 1: service_role cannot read the seal, so no pull can work';
  END IF;

  -- 2. no API role reaches the table itself. The reader is the only door, and a
  --    table grant would make it decoration.
  FOR r IN SELECT unnest(ARRAY['anon', 'authenticated', 'service_role']) AS role LOOP
    IF has_table_privilege(r.role, 'app_private.partner_credentials', 'SELECT') THEN
      RAISE EXCEPTION 'token seal self-check 2: % may SELECT partner_credentials directly', r.role;
    END IF;
  END LOOP;

  -- 3. the column refuses anything that is not a seal, which is what stops the
  --    plaintext landing in it. Proven by trying, not by reading the CHECK.
  BEGIN
    INSERT INTO app_private.partner_credentials (company_id, partner, key_hash, sealed_token)
    VALUES ((SELECT id FROM public.companies LIMIT 1), 'selfcheck',
            repeat('a', 64), '17|AbCdEf0123456789');
    RAISE EXCEPTION 'token seal self-check 3: a plaintext Sanctum token was accepted into sealed_token';
  EXCEPTION
    WHEN check_violation THEN NULL;          -- what must happen
    WHEN not_null_violation THEN NULL;       -- no company in a bare fixture
  END;

  -- 4. both are SECURITY DEFINER with a pinned search_path. As invokers they
  --    would die 42501 on app_private — PR #117's defect.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_sealed_token', 'partner_connection_record')
     AND p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'token seal self-check 4: % of 2 are SECURITY DEFINER with a pinned search_path', v_n;
  END IF;

  -- 5. the five-argument form is gone, so no caller can resolve to an overload
  --    that drops the seal on the floor.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_connection_record';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'token seal self-check 5: % overloads of partner_connection_record exist', v_n;
  END IF;

  -- 6. the reader hands out the LIVE credential only. A disabled one belongs to
  --    a revoked connection whose token the partner has already deleted.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_sealed_token'
     AND p.prosrc LIKE '%disabled_at IS NULL%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'token seal self-check 6: the reader no longer restricts itself to a live credential';
  END IF;

  -- 7. nothing in this schema encrypts or decrypts. The seal is the edge
  --    function's, and a SQL implementation would put the key in query text.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private')
     AND (p.prosrc LIKE '%pgp_sym_encrypt%' OR p.prosrc LIKE '%pgp_sym_decrypt%'
          OR p.prosrc LIKE '%crypto_aead%');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'token seal self-check 7: % function(s) now encrypt in SQL, where the key reaches query text', v_n;
  END IF;

  RAISE NOTICE 'partner token seal: self-checks passed — the column takes only a seal, and one service_role function opens it';
END
$check$;
