/*
  # The legal pages: the Impressum and the privacy policy

  Production (`https://elprofessor.eu`) has no Impressum and no privacy policy.
  A German commercial site must carry an Impressum (§ 5 DDG), and Google's
  consent screen will not let Google sign-in go live on production without a
  privacy-policy URL. The facts belong to the owner and the privacy text comes
  from a lawyer: this file builds the place for both, and invents neither. The
  owner enters them once under /admin → Einstellungen.

  Builds on `20260919120000` (the `seller` key and its validator,
  `platform_settings_problem_3_10`) and `20260920130000` (the latest restatement
  of `app_private.platform_settings_problem`).

  ## What this adds

  - **Nine optional fields on `seller`**, the ones § 5 DDG and § 18 Abs. 2 MStV
    ask for that the invoice's eleven do not carry. Optional means *may be
    absent*: the document every database holds today — the eleven fields —
    stays valid unchanged, and the browser writes one of the nine only once it
    holds a value (see *Compatibility*).
  - **`legal.privacy`**, a new key: the privacy policy as German paragraphs of
    plain text plus the date it is valid from ("Stand"). Seeded `{}`, which is
    "nothing published".
  - **`public.get_legal_pages()`**, anonymous and unaudited like
    `get_public_config()`: exactly the fields an Impressum shows, and the
    privacy text. Nothing else.

  ## The nine seller fields

    legal_name                    the provider's full name, or the Firma as the
                                  register has it (§ 5 Abs. 1 Nr. 1)
    legal_form                    the Rechtsform, for a legal person (Nr. 1)
    represented_by                the authorised representative(s), e.g. the
                                  Geschäftsführer (Nr. 1)
    contact_email                 an address for fast electronic contact (Nr. 2)
    contact_phone                 a second fast channel (Nr. 2)
    register_court                the Registergericht (Nr. 4)
    register_number               the register number, e.g. HRB 12345 (Nr. 4)
    content_responsible_name      the person responsible for content under
    content_responsible_address     § 18 Abs. 2 MStV, with their address, if the
                                  owner names one

  `legal_name` is not the invoice's `name`. `name` was seeded with the fallback
  'El-Professor' wherever the migration found no row to copy — both real
  databases — and that is a product name, not a fact about who operates the
  site. An Impressum that printed it would publish a placeholder as the
  provider. So the Impressum shows only what the owner entered for it, and
  `name` stays the invoice's sender.

  Each follows the rules the eleven already follow — a JSON string, at most 200
  characters, no control character — and two more: a non-empty `contact_email`
  must look like an address, and a non-empty `contact_phone` like a number
  (digits, spaces, `+ ( ) / . -`, at least three digits), because the page
  links both.

  The eleven are still judged by `platform_settings_problem_3_10`, unchanged:
  the new validator strips the nine and hands it the rest, so a missing field, a
  field nobody knows, a nameless seller or a newline in an address line are
  refused exactly as before and by the very same code.

  ## What goes public, and why each field is there

  `get_legal_pages()` returns fourteen Impressum fields, every one of them a
  string ('' when unfilled), and the privacy text. The list is a data
  protection decision, pinned key by key in `tests/rls/legal-pages.sql` and
  compared with `IMPRESSUM_FIELDS` in `src/lib/legalPages.ts` by
  `src/lib/legalPages.test.ts`:

    legal_name, legal_form        § 5 Abs. 1 Nr. 1 DDG: name, and for a legal
                                  person the Rechtsform
    street, house_number,         § 5 Abs. 1 Nr. 1 DDG: the address the provider
    postal_code, city               is established at — the invoice's address,
                                  which is the same one
    represented_by                § 5 Abs. 1 Nr. 1 DDG: the representative
    contact_email, contact_phone  § 5 Abs. 1 Nr. 2 DDG: fast contact
    register_court,               § 5 Abs. 1 Nr. 4 DDG: the register entry
    register_number
    vat_id                        § 5 Abs. 1 Nr. 6 DDG: the USt-IdNr, where one
                                  exists — already printed on every invoice
    content_responsible_name,     § 18 Abs. 2 MStV: the person responsible for
    content_responsible_address     content, if the owner names one

  **Never public:** `name` (the invoice's sender, a seeded placeholder, above),
  `tax_number` (the Steuernummer: no provision asks for it, and publishing it
  invites misuse), `bank_name`, `iban`, `bic`, `account_holder` (our bank
  details, printed only on invoices a customer receives), and nothing at all of
  the `invoice` key (the numbering) or any other key. The function names the
  fourteen fields; it never passes the seller document through.

  ## The privacy text

  `{}`, or exactly `{"as_of": "YYYY-MM-DD", "paragraphs": [...]}`:

  - `as_of` is a real calendar date between 2000 and 2100, written the way
    storage writes dates; the page prints it DD.MM.YYYY.
  - `paragraphs` is 1 to 300 strings, each at most 4000 characters and not
    blank. **Plain text only**: no `<` or `>` anywhere, so no HTML can be stored,
    whatever a generator pasted; no control character but a line break inside a
    paragraph (an address block needs one), and no blank line inside a
    paragraph — a blank line separates two paragraphs.
  - The whole document may take **32000 bytes**, not the 16384 every other key
    shares. That is the one exception to the shared bound, and it is why the
    privacy branch is dispatched *before* the shared size check. A
    lawyer's Datenschutzerklärung for a product with sign-in, Google, mail and
    hosting runs to several thousand words, which 16 KB does not hold. The new
    bound is not a free choice either: `platform_settings_put` records the value
    before and after every write, `app_private.audit_write` refuses a before or
    after document above 32768 bytes (20260916110000), and the put wraps the
    value as `{"value": …, "version": n}`. 32000 leaves that wrapper room, and
    self-check 5 proves a document at the bound passes the audit bound. A text
    longer than that needs a decision of its own; it cannot be had by editing a
    number here.

  Reading `legal.privacy` through the panel is `settings.read` (owner,
  read_only; not billing, not support) and writing it `settings.manage`, owner
  only — both fall out of `app_private.platform_setting_is_pricing()` unchanged.

  ## get_legal_pages()

  SECURITY DEFINER, STABLE, `search_path` pinned; EXECUTE for `anon` and
  `authenticated` only, revoked from PUBLIC first. It writes nothing and records
  nothing, like `get_public_config()`: what it returns is published on a public
  page anyway. Its only outcome is its answer — it never raises — and a stored
  document its own validator would refuse publishes nothing rather than a
  broken page, the rule `platform_invoice_seller()` applies to the invoice.

  ## platform_settings_problem

  Restated, because a validator can only be added there. `20260920130000`'s body
  is carried over character for character, with three changes and no others:

  1. the key gate names `legal.privacy`;
  2. `legal.privacy` is handed to the new validator ahead of the shared size
     check (its own bound, above);
  3. `seller` is handed to the new validator right after the size check. The
     old dispatch line below it still names `seller` and is carried over as it
     was; it is now reached by `trial` and `invoice`.

  Self-check 4 restates what every earlier branch must still refuse — the two
  lists `20260920130000` checked, and the seller's rules of `20260919120000` —
  so a botched copy fails this release instead of a customer's screen.

  ## What is deliberately not redefined

  `public.platform_settings_get`, `public.platform_settings_put`,
  `public.platform_audit_record`, `app_private.platform_settings_problem_3_10`,
  `_mail` and `_flags`, for the reason every settings slice has given: each
  carries rules a re-creation silently drops. Self-check 8 asserts the two RPCs
  still carry their cap and their audit write.

  ## Compatibility

  Expansive; **no SCHEMA_EPOCH bump**. One row is added, one validator learns a
  key and nine optional fields, and one function is new. The seller document on
  every database stays the eleven fields, so the previous release reads it, and
  its invoice PDF prints it, exactly as before.

  **One consequence of the owner using the new fields.** The previous release's
  browser reads a seller only when it names exactly the eleven fields
  (`parseSeller`). Once the owner saves an Impressum field, a rollback to that
  release would refuse to build an invoice PDF ("the sender cannot be read")
  and show the seller tab as unreadable, until the seller is saved again with
  the Impressum fields emptied — which this release's editor does by leaving
  them blank, since it writes an optional field only when it holds a value.
  Nothing is lost and nothing wrong is printed: the old release fails closed.
  HANDOFF.md carries it.

  ## Money

  No price, percentage or amount is read, written or computed here.
*/

-- ─── The validator for the Impressum fields and the privacy text ────────────

/*
  Kept out of platform_settings_problem itself so the copy below stays a copy,
  and so this slice's rules are in one place. The seller's eleven fields are
  judged by platform_settings_problem_3_10, called on the document without the
  nine new ones.
*/
CREATE OR REPLACE FUNCTION app_private.platform_settings_problem_legal(p_key text, p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- In byte order, like every field list the settings validators compare.
  c_impressum_fields    CONSTANT text[]  := ARRAY[
    'contact_email', 'contact_phone', 'content_responsible_address',
    'content_responsible_name', 'legal_form', 'legal_name', 'register_court',
    'register_number', 'represented_by'];
  -- platform_settings_problem_3_10's c_max_field: one bound for every seller field.
  c_max_field           CONSTANT integer := 200;
  c_email               CONSTANT text    := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  c_phone               CONSTANT text    := '^\+?[0-9 ()/.-]+$';
  c_min_phone_digits    CONSTANT integer := 3;

  -- The privacy text. The byte bound is audit_write's 32768 less room for the
  -- {"value": …, "version": n} wrapper platform_settings_put records.
  c_privacy_max_bytes   CONSTANT integer := 32000;
  c_max_paragraphs      CONSTANT integer := 300;
  c_paragraph_max       CONSTANT integer := 4000;
  c_min_year            CONSTANT integer := 2000;
  c_max_year            CONSTANT integer := 2100;

  v_problem text;
  v_field   text;
  v_part    jsonb;
  v_item    jsonb;
  v_text    text;
  v_count   integer;
  v_index   integer;
  v_year    integer;
  v_month   integer;
  v_day     integer;
BEGIN
  IF p_key = 'seller' THEN
    -- Not an object: the eleven-field rule names it, as it always has.
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
      RETURN app_private.platform_settings_problem_3_10(p_key, p_value);
    END IF;

    -- The invoice's eleven, by the code that has always judged them. A shape
    -- error is reported as a shape error before any field of the nine.
    v_problem := app_private.platform_settings_problem_3_10(p_key, p_value - c_impressum_fields);
    IF v_problem IS NOT NULL THEN
      RETURN v_problem;
    END IF;

    FOREACH v_field IN ARRAY c_impressum_fields LOOP
      CONTINUE WHEN NOT (p_value ? v_field);
      v_part := p_value -> v_field;
      IF jsonb_typeof(v_part) IS DISTINCT FROM 'string' THEN
        RETURN 'seller.' || v_field;
      END IF;
      v_text := v_part #>> '{}';
      IF length(v_text) > c_max_field OR v_text ~ '[[:cntrl:]]' THEN
        RETURN 'seller.' || v_field;
      END IF;
    END LOOP;

    -- The page links both, so each must be what it says it is.
    v_text := btrim(coalesce(p_value ->> 'contact_email', ''));
    IF v_text <> '' AND v_text !~ c_email THEN
      RETURN 'seller.contact_email';
    END IF;

    v_text := btrim(coalesce(p_value ->> 'contact_phone', ''));
    IF v_text <> ''
       AND (v_text !~ c_phone
            OR length(regexp_replace(v_text, '[^0-9]', '', 'g')) < c_min_phone_digits) THEN
      RETURN 'seller.contact_phone';
    END IF;

    RETURN NULL;
  END IF;

  IF p_key = 'legal.privacy' THEN
    IF p_value IS NULL OR octet_length(p_value::text) > c_privacy_max_bytes THEN
      RETURN 'value_size';
    END IF;
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
      RETURN 'legal.privacy';
    END IF;

    -- Nothing published: the seed, and what an owner saves to take the text down.
    IF p_value = '{}'::jsonb THEN
      RETURN NULL;
    END IF;

    IF app_private.settings_object_keys(p_value) IS DISTINCT FROM ARRAY['as_of', 'paragraphs'] THEN
      RETURN 'legal.privacy';
    END IF;

    -- The "Stand": a real date, YYYY-MM-DD. make_date + interval is immutable
    -- and raises on nothing here, because the parts are range-checked first.
    v_part := p_value -> 'as_of';
    IF jsonb_typeof(v_part) IS DISTINCT FROM 'string'
       OR (v_part #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN 'legal.privacy.as_of';
    END IF;
    v_text  := v_part #>> '{}';
    v_year  := substr(v_text, 1, 4)::integer;
    v_month := substr(v_text, 6, 2)::integer;
    v_day   := substr(v_text, 9, 2)::integer;
    IF v_year < c_min_year OR v_year > c_max_year
       OR v_month < 1 OR v_month > 12
       OR v_day < 1
       OR v_day > extract(day FROM make_date(v_year, v_month, 1) + interval '1 month' - interval '1 day') THEN
      RETURN 'legal.privacy.as_of';
    END IF;

    v_part := p_value -> 'paragraphs';
    IF jsonb_typeof(v_part) IS DISTINCT FROM 'array' THEN
      RETURN 'legal.privacy.paragraphs';
    END IF;
    v_count := jsonb_array_length(v_part);
    IF v_count < 1 OR v_count > c_max_paragraphs THEN
      RETURN 'legal.privacy.paragraphs';
    END IF;

    FOR v_index IN 0 .. v_count - 1 LOOP
      v_item := v_part -> v_index;
      IF jsonb_typeof(v_item) IS DISTINCT FROM 'string' THEN
        RETURN 'legal.privacy.paragraphs.' || v_index;
      END IF;
      v_text := v_item #>> '{}';
      IF btrim(v_text, E' \n') = ''
         OR length(v_text) > c_paragraph_max
         -- a control character other than a line break
         OR replace(v_text, E'\n', '') ~ '[[:cntrl:]]'
         -- a blank line belongs between two paragraphs, not inside one
         OR v_text ~ E'\n *\n'
         -- plain text: nothing that could be read as markup
         OR v_text ~ '[<>]' THEN
        RETURN 'legal.privacy.paragraphs.' || v_index;
      END IF;
    END LOOP;

    RETURN NULL;
  END IF;

  RETURN 'unknown_key';
END;
$$;

-- ─── platform_settings_problem learns the new key and the seller's fields ───

/*
  20260920130000's body with three changes and no others: the key gate names
  legal.privacy; legal.privacy is handed to the validator above ahead of the
  shared size check, because it has a bound of its own (see the header); and
  seller is handed to the same validator right after that check. The dispatch of
  seller, trial and invoice to platform_settings_problem_3_10 is carried over
  character for character and is now reached by trial and invoice. The mail,
  flags, price_book and plan_features branches are carried over character for
  character. Self-check 4 restates what each must still do.
*/
CREATE OR REPLACE FUNCTION app_private.platform_settings_problem(p_key text, p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_value_bytes CONSTANT integer := 16384;
  c_max_cents       CONSTANT integer := 1000000;   -- 10.000,00 € per car per month
  c_max_tiers       CONSTANT integer := 20;
  c_max_min_cars    CONSTANT integer := 100000;
  c_max_features    CONSTANT integer := 200;
  -- Open decision D11: the three plans are fixed until the owner decides
  -- otherwise, so a price book names exactly these, in byte order.
  c_plans           CONSTANT text[]  := ARRAY['advanced', 'basic', 'premium'];

  v_part    jsonb;
  v_tier    jsonb;
  v_plan    text;
  v_index   integer;
  v_prev    integer;
  v_entry   record;
  v_missing text[];
BEGIN
  IF p_key IS NULL
     OR p_key NOT IN ('price_book', 'plan_features', 'seller', 'trial', 'invoice',
                      'mail.sender',
                      'mail.template.signup_verify', 'mail.template.password_reset',
                      'mail.template.invite_activate', 'mail.template.email_change',
                      'feature_flags',
                      'legal.privacy') THEN
    RETURN 'unknown_key';
  END IF;

  -- 20260921120000: the privacy text carries its own size bound, which is the
  -- one exception to the shared bound below (see that file's header).
  IF p_key = 'legal.privacy' THEN
    RETURN app_private.platform_settings_problem_legal(p_key, p_value);
  END IF;

  IF p_value IS NULL OR octet_length(p_value::text) > c_max_value_bytes THEN
    RETURN 'value_size';
  END IF;

  -- 20260921120000: the seller's optional Impressum fields. Its eleven invoice
  -- fields are still judged by platform_settings_problem_3_10, which the legal
  -- validator calls on the document without the new fields.
  IF p_key = 'seller' THEN
    RETURN app_private.platform_settings_problem_legal(p_key, p_value);
  END IF;

  -- Plan 3.10, first half. Checked after the size limit above, so every key
  -- shares one bound on how much one row may hold.
  IF p_key IN ('seller', 'trial', 'invoice') THEN
    RETURN app_private.platform_settings_problem_3_10(p_key, p_value);
  END IF;

  -- Plan 3.10, second half, and plan 3.11's flags (20260920130000).
  IF p_key = 'mail.sender' OR left(p_key, 14) = 'mail.template.' THEN
    RETURN app_private.platform_settings_problem_mail(p_key, p_value);
  END IF;
  IF p_key = 'feature_flags' THEN
    RETURN app_private.platform_settings_problem_flags(p_value);
  END IF;

  IF p_key = 'price_book' THEN
    IF app_private.settings_object_keys(p_value)
       IS DISTINCT FROM ARRAY['fleet_discount_tiers', 'price_per_car_cents', 'yearly_discount_percent'] THEN
      RETURN 'price_book';
    END IF;

    v_part := p_value -> 'price_per_car_cents';
    IF app_private.settings_object_keys(v_part) IS DISTINCT FROM c_plans THEN
      RETURN 'price_book.price_per_car_cents';
    END IF;
    FOREACH v_plan IN ARRAY c_plans LOOP
      IF NOT app_private.settings_integer_between(v_part -> v_plan, 0, c_max_cents) THEN
        RETURN 'price_book.price_per_car_cents.' || v_plan;
      END IF;
    END LOOP;

    v_part := p_value -> 'fleet_discount_tiers';
    IF jsonb_typeof(v_part) IS DISTINCT FROM 'array' THEN
      RETURN 'price_book.fleet_discount_tiers';
    END IF;
    IF jsonb_array_length(v_part) > c_max_tiers THEN
      RETURN 'price_book.fleet_discount_tiers';
    END IF;
    v_prev := 0;
    FOR v_index IN 0 .. jsonb_array_length(v_part) - 1 LOOP
      v_tier := v_part -> v_index;
      IF app_private.settings_object_keys(v_tier) IS DISTINCT FROM ARRAY['min_cars', 'percent'] THEN
        RETURN 'price_book.fleet_discount_tiers.' || v_index;
      END IF;
      IF NOT app_private.settings_integer_between(v_tier -> 'min_cars', 1, c_max_min_cars)
         OR NOT app_private.settings_integer_between(v_tier -> 'percent', 0, 100) THEN
        RETURN 'price_book.fleet_discount_tiers.' || v_index;
      END IF;
      -- Sorted by min_cars, strictly increasing, so the tier a car count
      -- reaches is never ambiguous.
      IF (v_tier ->> 'min_cars')::integer <= v_prev THEN
        RETURN 'price_book.fleet_discount_tiers.' || v_index;
      END IF;
      v_prev := (v_tier ->> 'min_cars')::integer;
    END LOOP;

    IF NOT app_private.settings_integer_between(p_value -> 'yearly_discount_percent', 0, 100) THEN
      RETURN 'price_book.yearly_discount_percent';
    END IF;
    RETURN NULL;
  END IF;

  -- plan_features: feature key -> the minimum plan.
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RETURN 'plan_features';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_value)) > c_max_features THEN
    RETURN 'plan_features';
  END IF;
  FOR v_entry IN
    SELECT e.key, e.value FROM jsonb_each(p_value) AS e ORDER BY e.key COLLATE "C"
  LOOP
    IF length(v_entry.key) > 60 OR v_entry.key !~ '^[a-z][a-z0-9_]*$' THEN
      RETURN 'plan_features.key';
    END IF;
    IF jsonb_typeof(v_entry.value) IS DISTINCT FROM 'string'
       OR (v_entry.value #>> '{}') <> ALL (c_plans) THEN
      RETURN 'plan_features.' || v_entry.key;
    END IF;
  END LOOP;

  -- Every feature the application knows must be named. The browser reads a
  -- feature the map does not name as premium, so a short map would silently
  -- lock those screens for every non-trial company below premium. Reported
  -- after the shape checks above, so a bad value is still named as a bad value.
  -- Keys this build does not know stay valid: that is how a feature is seeded
  -- before the release that gates it.
  v_missing := app_private.plan_features_missing_keys(p_value);
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RETURN 'plan_features.missing.' || v_missing[1];
  END IF;

  RETURN NULL;
END;
$$;

-- ─── The key ────────────────────────────────────────────────────────────────

-- Nothing published until the owner enters the lawyer's text.
INSERT INTO app_private.platform_settings (key, value) VALUES
  ('legal.privacy', $seed_legal_privacy$ {} $seed_legal_privacy$::jsonb);

-- ─── The public read ────────────────────────────────────────────────────────

/*
  What /impressum and /datenschutz render, for anybody, signed in or not.

  The fourteen Impressum fields are named here, one by one, and nothing else
  of the seller is read out: the bank details, the tax number and the invoice's
  sender name stay behind (see the header). Every field comes back as a string,
  '' when the owner has not filled it, so the page's shape never depends on
  what is stored.

  A document its own validator would refuse publishes nothing — the empty
  Impressum, or no privacy text — never a half-read page. Not audited, like
  get_public_config(): nothing here is a platform read, and every value is
  published on a public page anyway.
*/
CREATE OR REPLACE FUNCTION public.get_legal_pages()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- The data protection decision this file's header explains, field by field.
  c_public_fields CONSTANT text[] := ARRAY[
    'legal_name', 'legal_form',
    'street', 'house_number', 'postal_code', 'city',
    'represented_by',
    'contact_email', 'contact_phone',
    'register_court', 'register_number',
    'vat_id',
    'content_responsible_name', 'content_responsible_address'];

  v_seller    jsonb := app_private.platform_setting_value('seller');
  v_privacy   jsonb := app_private.platform_setting_value('legal.privacy');
  v_impressum jsonb := '{}'::jsonb;
  v_field     text;
BEGIN
  IF v_seller IS NULL OR app_private.platform_settings_problem('seller', v_seller) IS NOT NULL THEN
    v_seller := '{}'::jsonb;
  END IF;

  FOREACH v_field IN ARRAY c_public_fields LOOP
    v_impressum := v_impressum || jsonb_build_object(v_field, coalesce(btrim(v_seller ->> v_field), ''));
  END LOOP;

  IF v_privacy IS NULL
     OR v_privacy = '{}'::jsonb
     OR app_private.platform_settings_problem('legal.privacy', v_privacy) IS NOT NULL THEN
    v_privacy := jsonb_build_object('as_of', NULL, 'paragraphs', '[]'::jsonb);
  ELSE
    v_privacy := jsonb_build_object('as_of', v_privacy -> 'as_of', 'paragraphs', v_privacy -> 'paragraphs');
  END IF;

  RETURN jsonb_build_object('impressum', v_impressum, 'privacy', v_privacy);
END;
$$;

-- ─── Ownership ──────────────────────────────────────────────────────────────

-- CREATE OR REPLACE keeps whatever owner a function had, and on the real
-- databases that may be `postgres`, which reaches no app_private helper.
ALTER FUNCTION app_private.platform_settings_problem_legal(text, jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_settings_problem(text, jsonb)       OWNER TO CURRENT_USER;
ALTER FUNCTION public.get_legal_pages()                                 OWNER TO CURRENT_USER;

-- ─── Privileges ─────────────────────────────────────────────────────────────

-- Supabase's default privileges grant EXECUTE on every new function to PUBLIC,
-- anon, authenticated and service_role, so each one is revoked by name. Nobody
-- the API authenticates as holds USAGE on app_private; these REVOKEs are the
-- second wall.
REVOKE ALL ON FUNCTION app_private.platform_settings_problem_legal(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_problem(text, jsonb)       FROM PUBLIC, anon, authenticated, service_role;

-- The legal pages are read before anyone signs in, and by a signed-in visitor
-- whose client sends its JWT instead. Revoked from PUBLIC first, so the grant
-- is exactly these two.
REVOKE ALL ON FUNCTION public.get_legal_pages() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_legal_pages() TO anon, authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_public_fields CONSTANT text[] := ARRAY[
    'city', 'contact_email', 'contact_phone', 'content_responsible_address',
    'content_responsible_name', 'house_number', 'legal_form', 'legal_name',
    'postal_code', 'register_court', 'register_number', 'represented_by',
    'street', 'vat_id'];

  v_role     text;
  v_wrong    text;
  v_seed     jsonb;
  v_seller   jsonb;
  v_full     jsonb;
  v_privacy  jsonb;
  v_answer   jsonb;
  v_src      text;
  v_sig      text;
  v_action   text;
  v_template jsonb;
  v_big      jsonb;
BEGIN
  -- 1. Nobody the API authenticates as reaches the schema or the settings table.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'app_private', 'USAGE')
       OR has_table_privilege(v_role, 'app_private.platform_settings',
                              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '20260921120000 self-check: % reaches app_private', v_role;
    END IF;
  END LOOP;

  -- 2. Every function this file created or replaced: SECURITY DEFINER where it
  --    should be, a pinned search_path, an owner that reaches app_private, and
  --    exactly the stated EXECUTE grants. PUBLIC holds none.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN NOT EXISTS (
                      SELECT 1
                        FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                             WHERE p.oid = to_regprocedure(v.sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                 THEN 'PUBLIC holds EXECUTE'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.anon
                 THEN 'anon EXECUTE should be ' || v.anon
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.service
                 THEN 'service_role EXECUTE should be ' || v.service
             END AS problem
        FROM (VALUES
          -- signature                                                definer anon   authn  service
          ('app_private.platform_settings_problem_legal(text,jsonb)', false,  false, false, false),
          ('app_private.platform_settings_problem(text,jsonb)',       false,  false, false, false),
          ('public.get_legal_pages()',                                true,   true,  true,  false)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260921120000 self-check: %', v_wrong;
  END IF;

  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = 'public.get_legal_pages()'::regprocedure) <> 's' THEN
    RAISE EXCEPTION '20260921120000 self-check: get_legal_pages() must be STABLE — it writes nothing';
  END IF;

  -- 3. The key is seeded empty, at version 1, by nobody; the seller is left as
  --    it was. Every stored document passes its own validator — which also
  --    catches a restatement that dropped the validator of a key another file
  --    added, since that key would now read as unknown.
  IF (SELECT count(*) FROM app_private.platform_settings
       WHERE key = 'legal.privacy' AND version = 1 AND updated_by IS NULL
         AND value = '{}'::jsonb) <> 1 THEN
    RAISE EXCEPTION '20260921120000 self-check: legal.privacy is not seeded as the empty document';
  END IF;

  SELECT string_agg(format('%s: %s', s.key, app_private.platform_settings_problem(s.key, s.value)), ', ')
    INTO v_wrong
    FROM app_private.platform_settings s
   WHERE app_private.platform_settings_problem(s.key, s.value) IS NOT NULL;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260921120000 self-check: a stored setting is refused by its own validator: %', v_wrong;
  END IF;

  -- 4. What every earlier branch refuses, restated so a botched copy of
  --    platform_settings_problem fails here and not on a customer's screen.
  --    First 20260920130000's two lists, as that file checked them.
  v_seed := app_private.platform_setting_value('plan_features');
  IF app_private.platform_settings_problem('plan_features', v_seed) IS NOT NULL
     OR app_private.platform_settings_problem('plan_features', v_seed - 'gehaelter')
          IS DISTINCT FROM 'plan_features.missing.gehaelter'
     OR app_private.platform_settings_problem('plan_features', '{}'::jsonb) IS NULL
     OR app_private.platform_settings_problem('plan_features',
          v_seed || '{"a_feature_of_a_later_release": "basic"}'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION '20260921120000 self-check: the complete-feature-map rule of 20260917120000 did not survive';
  END IF;

  IF app_private.platform_settings_problem('price_book', app_private.platform_setting_value('price_book')) IS NOT NULL
     OR app_private.platform_settings_problem('price_book', '{}'::jsonb) IS DISTINCT FROM 'price_book'
     OR app_private.platform_settings_problem('trial', '{"days": 0}'::jsonb) IS DISTINCT FROM 'trial.days'
     OR app_private.platform_settings_problem('seller', '{}'::jsonb) IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('invoice', '{}'::jsonb) IS DISTINCT FROM 'invoice'
     OR app_private.platform_settings_problem('mail.template.platform_login', '{}'::jsonb) IS DISTINCT FROM 'unknown_key'
     OR app_private.platform_settings_problem('mail.other', '{}'::jsonb) IS DISTINCT FROM 'unknown_key'
     OR app_private.platform_settings_problem('legal.other', '{}'::jsonb) IS DISTINCT FROM 'unknown_key'
     OR app_private.platform_settings_problem(NULL, '{}'::jsonb) IS DISTINCT FROM 'unknown_key' THEN
    RAISE EXCEPTION '20260921120000 self-check: a branch of platform_settings_problem moved';
  END IF;

  v_template := '{"subject": "Ihr Code – El-Professor", "heading": "Willkommen",
                  "paragraphs": ["Hallo {email}, willkommen bei {company}.", "Zweiter Absatz."],
                  "button": "Einladung annehmen"}'::jsonb;
  IF app_private.platform_settings_problem('mail.template.invite_activate', v_template) IS NOT NULL
     OR app_private.platform_settings_problem('mail.template.signup_verify', v_template)
          IS DISTINCT FROM 'mail.template.signup_verify.paragraphs.0'
     OR app_private.platform_settings_problem('mail.template.email_change', v_template)
          IS DISTINCT FROM 'mail.template.email_change'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{subject}', '"Ihr Code {code}"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.subject.code'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{subject}', '"Code 482915"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.subject.code'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{subject}', '"Hallo {email}"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.subject'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{paragraphs}', '["Ihr Code: {code}"]'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.paragraphs.0'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{paragraphs}', '[]'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.paragraphs'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{heading}', '"Zeile\neins"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.heading'
     OR app_private.platform_settings_problem('mail.sender', '{"name": "Support"}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('mail.sender', '{"name": "support@bank.de"}'::jsonb)
          IS DISTINCT FROM 'mail.sender.name'
     OR app_private.platform_settings_problem('mail.sender', '{"name": " El-Professor"}'::jsonb)
          IS DISTINCT FROM 'mail.sender.name'
     OR app_private.platform_settings_problem('feature_flags', '{"new_banner": true}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('feature_flags', '{"new_banner": "yes"}'::jsonb)
          IS DISTINCT FROM 'feature_flags.new_banner'
     OR app_private.platform_settings_problem('feature_flags', '{"New Banner": true}'::jsonb)
          IS DISTINCT FROM 'feature_flags.key' THEN
    RAISE EXCEPTION '20260921120000 self-check: a mail or flag validator of 20260920130000 no longer refuses what it must';
  END IF;

  -- Then the seller's eleven fields, the trial and the invoice, as 20260919120000
  -- checked them. The seller now reaches platform_settings_problem_3_10 through
  -- the new validator, so these are the rules that path must not have lost.
  v_seller := app_private.platform_setting_value('seller');
  IF app_private.platform_settings_problem('seller', v_seller) IS NOT NULL
     OR app_private.platform_settings_problem('seller', v_seller - 'bic') IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('seller', v_seller || '{"country": "Deutschland"}'::jsonb)
          IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('seller', '[]'::jsonb) IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_seller, '{postal_code}', '42651'::jsonb)) IS DISTINCT FROM 'seller.postal_code'
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_seller, '{name}', '""'::jsonb)) IS DISTINCT FROM 'seller.name'
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_seller, '{city}', '"Solingen\nNRW"'::jsonb)) IS DISTINCT FROM 'seller.city'
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_seller, '{city}', to_jsonb(repeat('x', 201)))) IS DISTINCT FROM 'seller.city'
     OR app_private.platform_settings_problem('trial', '{"days": 366}'::jsonb) IS DISTINCT FROM 'trial.days'
     OR app_private.platform_settings_problem('trial', '{"days": 14, "weeks": 2}'::jsonb) IS DISTINCT FROM 'trial'
     OR app_private.platform_settings_problem('trial', '{"days": 1}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('invoice',
          jsonb_set(app_private.platform_setting_value('invoice'), '{number_prefix}', '"inv-x"'::jsonb))
          IS DISTINCT FROM 'invoice.number_prefix'
     OR app_private.platform_settings_problem('invoice',
          jsonb_set(app_private.platform_setting_value('invoice'), '{number_digits}', '0'::jsonb))
          IS DISTINCT FROM 'invoice.number_digits' THEN
    RAISE EXCEPTION '20260921120000 self-check: a rule of 20260919120000 (seller, trial, invoice) did not survive';
  END IF;

  -- Every other key still shares the 16384-byte bound: only legal.privacy has
  -- one of its own.
  v_big := jsonb_build_object('a_flag', true, 'padding_is_not_a_flag', repeat('x', 17000));
  IF app_private.platform_settings_problem('feature_flags', v_big) IS DISTINCT FROM 'value_size'
     OR app_private.platform_settings_problem('seller', v_seller || jsonb_build_object('legal_name', repeat('x', 17000)))
          IS DISTINCT FROM 'value_size' THEN
    RAISE EXCEPTION '20260921120000 self-check: the shared size bound no longer applies to every other key';
  END IF;

  -- 5. The new rules, at their edges. The seller first: the nine fields are
  --    optional, follow the eleven's rules, and two of them are checked for
  --    what they claim to be.
  v_full := v_seller || '{"legal_name": "Muster GmbH", "legal_form": "GmbH",
                          "represented_by": "Erika Muster", "contact_email": "info@example.com",
                          "contact_phone": "+49 (0)212 123-45/6", "register_court": "Amtsgericht Wuppertal",
                          "register_number": "HRB 12345", "content_responsible_name": "Erika Muster",
                          "content_responsible_address": "Hauptstraße 1, 42651 Solingen"}'::jsonb;
  IF app_private.platform_settings_problem('seller', v_full) IS NOT NULL
     OR app_private.platform_settings_problem('seller', v_seller || '{"legal_name": ""}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('seller', v_full - 'bic') IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('seller', v_full || '{"country": "Deutschland"}'::jsonb)
          IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('seller', jsonb_set(v_full, '{legal_name}', '42'::jsonb))
          IS DISTINCT FROM 'seller.legal_name'
     OR app_private.platform_settings_problem('seller', jsonb_set(v_full, '{represented_by}', '"A\nB"'::jsonb))
          IS DISTINCT FROM 'seller.represented_by'
     OR app_private.platform_settings_problem('seller', jsonb_set(v_full, '{register_number}', to_jsonb(repeat('x', 201))))
          IS DISTINCT FROM 'seller.register_number'
     OR app_private.platform_settings_problem('seller', jsonb_set(v_full, '{contact_email}', '"info at example"'::jsonb))
          IS DISTINCT FROM 'seller.contact_email'
     OR app_private.platform_settings_problem('seller', jsonb_set(v_full, '{contact_phone}', '"Ruf an!"'::jsonb))
          IS DISTINCT FROM 'seller.contact_phone'
     OR app_private.platform_settings_problem('seller', jsonb_set(v_full, '{contact_phone}', '"+4"'::jsonb))
          IS DISTINCT FROM 'seller.contact_phone'
     -- the eleven still come first: a shape error is named as a shape error
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_full - 'bic', '{contact_email}', '"x"'::jsonb)) IS DISTINCT FROM 'seller' THEN
    RAISE EXCEPTION '20260921120000 self-check: the seller''s Impressum fields are not judged as this file states';
  END IF;

  -- Then the privacy text.
  v_privacy := '{"as_of": "2026-09-21",
                 "paragraphs": ["Verantwortlich:\nMuster GmbH\nHauptstraße 1", "Zweiter Absatz."]}'::jsonb;
  IF app_private.platform_settings_problem('legal.privacy', '{}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('legal.privacy', v_privacy) IS NOT NULL
     OR app_private.platform_settings_problem('legal.privacy', NULL) IS DISTINCT FROM 'value_size'
     OR app_private.platform_settings_problem('legal.privacy', '[]'::jsonb) IS DISTINCT FROM 'legal.privacy'
     OR app_private.platform_settings_problem('legal.privacy', v_privacy - 'as_of') IS DISTINCT FROM 'legal.privacy'
     OR app_private.platform_settings_problem('legal.privacy', v_privacy || '{"title": "x"}'::jsonb)
          IS DISTINCT FROM 'legal.privacy'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{as_of}', '"2026-02-30"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.as_of'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{as_of}', '"21.09.2026"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.as_of'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{as_of}', '"1999-12-31"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.as_of'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{as_of}', '"2028-02-29"'::jsonb))
          IS NOT NULL
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs}', '[]'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs}', '"Text"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs,1}', '"<b>fett</b>"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs.1'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs,1}', '"Tab\there"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs.1'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs,1}', '"Eins\n\nZwei"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs.1'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs,0}', '" \n "'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs.0'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs,0}', to_jsonb(repeat('x', 4001))))
          IS DISTINCT FROM 'legal.privacy.paragraphs.0'
     OR app_private.platform_settings_problem('legal.privacy',
          jsonb_build_object('as_of', '2026-09-21', 'paragraphs', to_jsonb(array_fill('x'::text, ARRAY[301]))))
          IS DISTINCT FROM 'legal.privacy.paragraphs' THEN
    RAISE EXCEPTION '20260921120000 self-check: the privacy validator does not refuse what it must';
  END IF;

  -- The bound is the privacy text's own, and a document at it still fits the
  -- audit row platform_settings_put writes: audit_write refuses a before or
  -- after value above 32768 bytes, and the put wraps the value with its version.
  v_big := jsonb_build_object('as_of', '2026-09-21',
             'paragraphs', to_jsonb(array_fill(repeat('ä', 1000), ARRAY[15])));
  IF octet_length(v_big::text) <= 16384 OR octet_length(v_big::text) > 32000
     OR app_private.platform_settings_problem('legal.privacy', v_big) IS NOT NULL
     OR octet_length(jsonb_build_object('version', 2147483647, 'value', v_big)::text) > 32768 THEN
    RAISE EXCEPTION '20260921120000 self-check: a privacy text of % bytes is refused, or would not fit its audit row',
      octet_length(v_big::text);
  END IF;
  v_big := jsonb_build_object('as_of', '2026-09-21',
             'paragraphs', to_jsonb(array_fill(repeat('ä', 1000), ARRAY[17])));
  IF app_private.platform_settings_problem('legal.privacy', v_big) IS DISTINCT FROM 'value_size' THEN
    RAISE EXCEPTION '20260921120000 self-check: a privacy text of % bytes passes the 32000-byte bound',
      octet_length(v_big::text);
  END IF;

  -- 6. Who may write and read the key: settings.manage — owner only — and
  --    settings.read for owner and read_only. Billing holds settings.read for
  --    the prices alone.
  IF app_private.platform_setting_write_capability('legal.privacy') IS DISTINCT FROM 'settings.manage'
     OR app_private.platform_setting_is_pricing('legal.privacy')
     OR app_private.platform_settings_readable('billing', 'legal.privacy')
     OR app_private.platform_settings_readable('support', 'legal.privacy')
     OR NOT app_private.platform_settings_readable('owner', 'legal.privacy')
     OR NOT app_private.platform_settings_readable('read_only', 'legal.privacy') THEN
    RAISE EXCEPTION '20260921120000 self-check: the authority over legal.privacy is not the one plan 3.A states';
  END IF;

  -- 7. The public answer: exactly two parts, exactly the fourteen fields, every
  --    one the stored value trimmed or '', and no privacy text while none is
  --    stored. The bank details, the tax number and the invoice's sender name
  --    are not keys of it.
  v_answer := public.get_legal_pages();
  IF app_private.settings_object_keys(v_answer) IS DISTINCT FROM ARRAY['impressum', 'privacy']
     OR app_private.settings_object_keys(v_answer -> 'impressum') IS DISTINCT FROM c_public_fields
     OR EXISTS (SELECT 1 FROM jsonb_each(v_answer -> 'impressum') e
                 WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'string'
                    OR e.value #>> '{}' IS DISTINCT FROM coalesce(btrim(v_seller ->> e.key), ''))
     OR (v_answer -> 'impressum') ?| ARRAY['name', 'tax_number', 'bank_name', 'iban', 'bic', 'account_holder']
     OR v_answer -> 'privacy' IS DISTINCT FROM '{"as_of": null, "paragraphs": []}'::jsonb THEN
    RAISE EXCEPTION '20260921120000 self-check: get_legal_pages() does not answer the published fields and nothing else: %',
      v_answer;
  END IF;

  -- 8. Neither settings RPC was redefined, so both still carry the per-actor cap
  --    and their audit write; and platform_audit_record still refuses to forge a
  --    settings row. Category 'read': a 'settings' call would be refused on the
  --    category before the action allow-list — the rule this pins — is consulted.
  FOREACH v_sig IN ARRAY ARRAY['public.platform_settings_get(text)',
                               'public.platform_settings_put(text,jsonb,integer)'] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig);
    IF v_src !~ 'platform_settings_rate_limited' OR v_src !~ 'audit_write' THEN
      RAISE EXCEPTION '20260921120000 self-check: % has lost its cap or its audit row', v_sig;
    END IF;
  END LOOP;

  FOREACH v_action IN ARRAY app_private.platform_settings_audit_actions() LOOP
    BEGIN
      PERFORM public.platform_audit_record('read', v_action, 'ok');
      RAISE EXCEPTION '20260921120000 self-check: platform_audit_record accepts the forbidden action %', v_action;
    EXCEPTION
      WHEN invalid_parameter_value THEN NULL;   -- 22023: the refusal this pins
    END;
  END LOOP;
END $$;
