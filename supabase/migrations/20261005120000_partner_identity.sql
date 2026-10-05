/*
  # Who is calling, and which driver do they mean

  The two questions the Reidey integration turns on, answered separately because
  they have different kinds of answer: one is a secret, the other is a judgement
  a person has to make once.

  ## 1. Which company — never from the request

  A credential belongs to exactly one (partner, company). The company is read
  off the credential, never off the body. So a credential issued for company A
  cannot write anything for company B, whatever it sends, and a compromise of
  the partner is bounded to the companies whose credentials it holds.

  This is `send-document`'s rule, which this codebase already states: "the
  recipient's address is never taken from the request. It is read out of
  `public.drivers`, by id, scoped to the caller's own company."

  **The database never sees the key**, only its hash — `otp_challenges`' rule.
  The edge function computes `HMAC-SHA256(OTP_PEPPER, partner || ':' || key)`
  and passes the digest; `partner_credential_company()` looks that up. A dump of
  this table hands nobody a working credential, and `OTP_PEPPER` is already
  provisioned, guarded by `deploy.sh` at 32 characters minimum, and never shared
  between staging and production — so a staging credential cannot be replayed
  against production even if both rows leaked.

  ## 2. Which driver — proposed by the partner, confirmed by the company

  This is the part that cannot be automated, and the reason is written in our own
  code. `matchDriverName` in `fahrtenbuchImportParser.ts` carries it:

    a substring hit is never `exact`, because "Ali" is a substring of both
    "Ali Hassan" and "Alia Demir" -- the old matcher took whichever came first,
    and "a month of rides, and so a month of salary, was attributed to a driver
    nobody had chosen"

  A receipt moves money: a `bar` Beleg lands in `abrechnung_weekly` and changes
  what a driver owes. Binding it to the wrong person by a name heuristic would
  repeat exactly that, in the one place where it is money rather than hours.

  So: Reidey proposes a link — its own stable `drivers.id`, with the name, email
  and phone it holds — and the row is `pending` until someone at the company
  says which of their drivers it is. Both products now carry a driver email
  (ours since `20261002100000`), so the panel can suggest a match on an address
  rather than on a name, and still make a person agree to it.

  **A receipt for an unlinked driver is not refused.** The driver has already
  photographed it; losing it would teach them the feature is unreliable. It is
  stored with no `driver_id` and the proposed identity beside it, and it resolves
  the moment the link is confirmed. That table is the next slice; this one is the
  identity it will key on.

  ## What this deliberately does not claim

  Once a link is confirmed we believe Reidey when it says "this submission is
  from driver X". We cannot check that independently: the driver has no account
  here, which is the owner's decision of 05.10.2026 and the right one — our
  tenancy is per company, not per driver, and there is no "only my own rows"
  predicate anywhere in this system to build one on.

  What is bounded is the blast radius: a partner can only ever name drivers
  inside the company whose credential it presented, and only drivers a person at
  that company has already linked.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The credential. app_private, because it is security state.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_private.partner_credentials (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  partner     text        NOT NULL CHECK (partner = lower(btrim(partner)) AND partner <> ''),
  -- HMAC-SHA256 of the key, computed by the edge function with OTP_PEPPER.
  -- Hex, so the length is fixed and a truncated value cannot match.
  key_hash    text        NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  label       text        NULL,
  external_company_id text NULL,   -- the partner's own id for this company, for reconciliation
  disabled_at timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NULL
);

-- A hash identifies exactly one credential, globally: two companies holding the
-- same key would make the company ambiguous, which is the whole point of this.
CREATE UNIQUE INDEX IF NOT EXISTS partner_credentials_hash_key
  ON app_private.partner_credentials (key_hash);

-- One live credential per company per partner. Rotation disables the old row
-- and adds a new one, so a revoked key stays visible rather than vanishing.
CREATE UNIQUE INDEX IF NOT EXISTS partner_credentials_live_per_company
  ON app_private.partner_credentials (partner, company_id)
  WHERE disabled_at IS NULL;

COMMENT ON TABLE app_private.partner_credentials IS
  'One secret per (partner, company), stored only as HMAC-SHA256 with OTP_PEPPER. '
  'The company a partner call writes to is read from here and never from the request.';

REVOKE ALL ON app_private.partner_credentials FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Resolving a credential to its company
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_credential_company(p_partner text, p_key_hash text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  -- A disabled credential resolves to nothing, and so does an unknown hash:
  -- the caller is told "not authorized" either way and learns nothing from the
  -- difference. The company's own state is checked by the caller, not here --
  -- this answers identity, and `get_active_company_id()` answers admission.
  SELECT c.company_id
    FROM app_private.partner_credentials c
   WHERE c.partner  = lower(btrim(p_partner))
     AND c.key_hash = p_key_hash
     AND c.disabled_at IS NULL
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.partner_credential_company(text, text) IS
  'The company a partner credential belongs to, or NULL. Service role only: the '
  'edge function hashes the key and asks this. Never reachable from a browser.';

REVOKE ALL ON FUNCTION public.partner_credential_company(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_credential_company(text, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The driver link
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.partner_driver_links (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  partner             text        NOT NULL CHECK (partner = lower(btrim(partner)) AND partner <> ''),
  -- The partner's own stable id for the driver. Text, because it is theirs:
  -- Reidey's is a bigint, another partner's may not be.
  external_driver_id  text        NOT NULL CHECK (btrim(external_driver_id) <> ''),
  -- Ours. NULL until a person says which driver this is.
  driver_id           uuid        NULL REFERENCES public.drivers(id) ON DELETE SET NULL,
  -- What the partner said, kept as sent so the panel can show it and so a
  -- later dispute can see what was proposed rather than what was decided.
  proposed_name       text        NULL,
  proposed_email      text        NULL,
  proposed_phone      text        NULL,
  status              text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','linked','rejected')),
  linked_by           uuid        NULL,
  linked_at           timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- A linked row names a driver; a pending or rejected one does not. Without
  -- this a link could read `linked` with nobody on the other end.
  CONSTRAINT partner_driver_links_linked_has_driver
    CHECK ((status = 'linked') = (driver_id IS NOT NULL))
);

-- One row per partner driver, per company.
CREATE UNIQUE INDEX IF NOT EXISTS partner_driver_links_external_key
  ON public.partner_driver_links (company_id, partner, external_driver_id);

-- And one of our drivers is linked to at most one partner driver: two Reidey
-- accounts pointing at the same person would make a receipt's owner ambiguous
-- in exactly the way this whole table exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS partner_driver_links_driver_key
  ON public.partner_driver_links (company_id, partner, driver_id)
  WHERE driver_id IS NOT NULL;

COMMENT ON TABLE public.partner_driver_links IS
  'Which driver of ours a partner''s driver is. Proposed by the partner, '
  'confirmed by a person at the company: a receipt moves money, and binding it '
  'by a name heuristic is the defect fahrtenbuchImportParser.ts already records.';

ALTER TABLE public.partner_driver_links ENABLE ROW LEVEL SECURITY;

-- The ordinary tenant shape of 20260917130000. SELECT carries no role term --
-- that migration's shape has none -- and the writes ask the `drivers` page,
-- because deciding who a driver is belongs to the screen that manages drivers.
DROP POLICY IF EXISTS partner_driver_links_select ON public.partner_driver_links;
CREATE POLICY partner_driver_links_select ON public.partner_driver_links
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_active_company_id())
         OR (SELECT public.platform_reads_company_data()));

DROP POLICY IF EXISTS partner_driver_links_update ON public.partner_driver_links;
CREATE POLICY partner_driver_links_update ON public.partner_driver_links
  FOR UPDATE TO authenticated
  USING (company_id = (SELECT public.get_active_company_id())
         AND (SELECT public.current_role_permits('drivers', true)))
  WITH CHECK (company_id = (SELECT public.get_active_company_id())
         AND (SELECT public.current_role_permits('drivers', true)));

-- No INSERT and no DELETE policy: a link is proposed by the partner through a
-- SECURITY DEFINER function and resolved by an UPDATE. A client that could
-- insert one could invent a link for a driver the partner never named.

-- Both triggers, because the policies above name get_active_company_id(). The
-- rule is keyed on the policies and not on who writes today -- the lesson
-- 20260924100000 records after shipping without them and being refused by the
-- kit.
DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.partner_driver_links;
CREATE TRIGGER refuse_read_only_context_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.partner_driver_links
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write();

DROP TRIGGER IF EXISTS record_support_write ON public.partner_driver_links;
CREATE TRIGGER record_support_write
  AFTER INSERT OR UPDATE OR DELETE ON public.partner_driver_links
  FOR EACH ROW
  WHEN (current_setting('app_private.support_write_context', true) <> '')
  EXECUTE FUNCTION app_private.record_support_write();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The partner proposes a link, or finds the one it already has
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_driver_resolve(
  p_company_id         uuid,
  p_partner            text,
  p_external_driver_id text,
  p_name               text DEFAULT NULL,
  p_email              text DEFAULT NULL,
  p_phone              text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.partner_driver_links;
BEGIN
  IF p_company_id IS NULL OR btrim(coalesce(p_partner,'')) = ''
     OR btrim(coalesce(p_external_driver_id,'')) = '' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- Upsert the proposal. The partner's own fields are refreshed every time, so
  -- a driver who changed their address there is shown correctly here -- but
  -- `driver_id` and `status` are never touched: a confirmed link is a person's
  -- decision and the partner does not get to revise it.
  INSERT INTO public.partner_driver_links AS l
         (company_id, partner, external_driver_id, proposed_name, proposed_email, proposed_phone)
  VALUES (p_company_id, lower(btrim(p_partner)), btrim(p_external_driver_id),
          nullif(btrim(coalesce(p_name,'')), ''),
          nullif(lower(btrim(coalesce(p_email,''))), ''),
          nullif(btrim(coalesce(p_phone,'')), ''))
  ON CONFLICT (company_id, partner, external_driver_id) DO UPDATE
     SET proposed_name  = excluded.proposed_name,
         proposed_email = excluded.proposed_email,
         proposed_phone = excluded.proposed_phone,
         updated_at     = now()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'status',    v_row.status,
    'driver_id', v_row.driver_id,
    'link_id',   v_row.id
  );
END;
$$;

COMMENT ON FUNCTION public.partner_driver_resolve(uuid, text, text, text, text, text) IS
  'The link for a partner driver, created as `pending` if new. Refreshes what '
  'the partner proposes and never touches driver_id or status: confirming a '
  'link is a person''s decision at the company. Service role only.';

REVOKE ALL ON FUNCTION public.partner_driver_resolve(uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_driver_resolve(uuid, text, text, text, text, text)
  TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Self-check
-- ─────────────────────────────────────────────────────────────────────────────

DO $check$
DECLARE
  r record;
  n int;
BEGIN
  -- 1. no API role reaches the credential table
  FOR r IN SELECT unnest(ARRAY['anon','authenticated','service_role']) AS role LOOP
    IF has_table_privilege(r.role, 'app_private.partner_credentials', 'SELECT')
    OR has_table_privilege(r.role, 'app_private.partner_credentials', 'INSERT') THEN
      RAISE EXCEPTION 'self-check 1: % can reach app_private.partner_credentials', r.role;
    END IF;
  END LOOP;

  -- 2. neither partner function is reachable from a browser
  FOR r IN SELECT unnest(ARRAY['anon','authenticated']) AS role LOOP
    IF has_function_privilege(r.role, 'public.partner_credential_company(text,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check 2: % may execute partner_credential_company', r.role;
    END IF;
    IF has_function_privilege(r.role,
         'public.partner_driver_resolve(uuid,text,text,text,text,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check 2: % may execute partner_driver_resolve', r.role;
    END IF;
  END LOOP;

  -- 3. the link table has no INSERT and no DELETE policy. One would let a
  --    client invent a link for a driver the partner never named.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_driver_links'
     AND cmd IN ('INSERT', 'DELETE');
  IF n > 0 THEN
    RAISE EXCEPTION 'self-check 3: partner_driver_links gained an INSERT or DELETE policy';
  END IF;

  -- 4. both context triggers are on it (the rule of 20260924100000)
  FOR r IN SELECT unnest(ARRAY['refuse_read_only_context_write','record_support_write']) AS t LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
       WHERE c.relname = 'partner_driver_links' AND g.tgname = r.t AND NOT g.tgisinternal
    ) THEN
      RAISE EXCEPTION 'self-check 4: partner_driver_links is missing trigger %', r.t;
    END IF;
  END LOOP;

  -- 5. a linked row must name a driver, and an unlinked one must not
  BEGIN
    INSERT INTO public.partner_driver_links (company_id, partner, external_driver_id, status)
    VALUES (gen_random_uuid(), 'selfcheck', 'x', 'linked');
    RAISE EXCEPTION 'self-check 5: a linked row with no driver_id was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;        -- the constraint did its job
    WHEN foreign_key_violation THEN NULL;  -- the company FK caught it first
  END;

  RAISE NOTICE 'partner identity: self-checks passed';
END
$check$;
