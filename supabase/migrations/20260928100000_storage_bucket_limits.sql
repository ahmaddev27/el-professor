/*
  # Two public buckets: one that should not be public, and one that must be

  Measured on production and staging on 28.09.2026, read-only, before anything
  here was written.

  ## `document-templates` becomes private

  It is public on both databases, with no size limit and no MIME allow-list, and
  it holds two PDFs. **No code reaches it.** `src/` contains not one reference to
  the bucket; only three migrations from April 2026 mention it, all of them
  policy work. Its four policies key on `owner = auth.uid()` and every object has
  `owner IS NULL`, so there is no authenticated route to those files either — the
  only way to them today is the public URL.

  `public = false` is therefore the whole fix, and it breaks nothing that works:
  a bucket nothing reads cannot stop being read. What it ends is the unauthenticated
  route to two documents that name a private individual.

  The files themselves are left alone. The flag is ours; deleting a customer's
  document is not.

  ## `company-logos` stays public, and stops accepting SVG

  This one is public on purpose: `CompanySettingsContext` builds every logo URL
  with `getPublicUrl`, and the Mietwagenauftrag prints it. It cannot be closed.

  What it must not do is keep accepting **`image/svg+xml`**. An SVG is a document,
  not a picture: served inline with that content type it executes whatever script
  it carries, and this bucket is served from the API origin. Uploading is gated on
  `is_company_admin()`, so today any company administrator can place a script that
  runs on `api.elprofessor.eu`.

  **The bound, stated as narrowly as it was established.** The application stores
  its Supabase session in the *app* origin's localStorage, so a script on the API
  origin does not read it by simply being there. What it certainly gets is
  execution on a trusted domain — a phishing surface, and same-origin footing
  against whatever that origin does hold. Whether it can be carried further was
  not established, and is not the reason for this change: a bucket that serves
  customer-supplied script has no defensible reason to.

  Measured state: 7 objects, `image/jpeg`, `image/png` and `image/svg+xml`, the
  largest 233,308 bytes, **two of them SVG** and belonging to two different
  companies. Those two stay: they are customers' logos, presumably benign, and
  removing them blanks a logo the customer uploaded. Stopping the next one is this
  migration's job; what to do about the two is the owner's, and it is written up
  in HANDOFF.md.

  `allowed_mime_types` gates uploads only — it does not retro-reject what is
  already stored, which is exactly why the two existing files are unaffected and
  why the owner still has a decision to make.

  The size limit is 2 MiB: an order of magnitude above the largest logo anyone has
  uploaded, and in the same style as the three buckets that already carry one
  (`fahrtenbuch-files` 50 MiB, `salary-receipts` and `stundennachweise-pdfs`
  10 MiB each). `image/webp` is kept because `SettingsPage` already offers it.

  No policy is touched. No object is touched. Both changes are one column each.
*/

UPDATE storage.buckets
   SET public = false
 WHERE id = 'document-templates';

UPDATE storage.buckets
   SET file_size_limit   = 2097152,  -- 2 MiB; the largest logo on production is 233 KiB
       allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp']
 WHERE id = 'company-logos';

DO $selfcheck$
DECLARE
  v_public   boolean;
  v_limit    bigint;
  v_types    text[];
  v_svg      int;
BEGIN
  -- 1. document-templates is closed, if it exists here at all. The RLS kit's
  --    fixture is a --schema=public dump and carries no buckets of its own, so
  --    every check below is written to pass on a database that has none.
  SELECT public INTO v_public FROM storage.buckets WHERE id = 'document-templates';
  IF v_public IS NOT NULL AND v_public THEN
    RAISE EXCEPTION '20260928100000 self-check: document-templates is still public';
  END IF;

  -- 2. company-logos stays public. Closing it would blank every logo in the app
  --    and in the Mietwagenauftrag, silently, because getPublicUrl keeps
  --    answering a URL that then 400s.
  SELECT public, file_size_limit, allowed_mime_types
    INTO v_public, v_limit, v_types
    FROM storage.buckets WHERE id = 'company-logos';

  IF v_public IS NOT NULL THEN
    IF NOT v_public THEN
      RAISE EXCEPTION '20260928100000 self-check: company-logos was closed; getPublicUrl would answer a dead URL';
    END IF;

    -- 3. and it no longer accepts a document that executes.
    IF v_types IS NULL OR 'image/svg+xml' = ANY (v_types) THEN
      RAISE EXCEPTION '20260928100000 self-check: company-logos still accepts image/svg+xml';
    END IF;

    IF v_limit IS NULL OR v_limit <> 2097152 THEN
      RAISE EXCEPTION '20260928100000 self-check: company-logos has no 2 MiB limit (%)', v_limit;
    END IF;

    -- 4. the limit must not refuse a logo somebody already uploaded, or the next
    --    time they edit their settings the re-upload fails with no explanation.
    SELECT count(*) INTO v_svg
      FROM storage.objects
     WHERE bucket_id = 'company-logos'
       AND (metadata ->> 'size')::bigint > v_limit;
    IF v_svg > 0 THEN
      RAISE EXCEPTION '20260928100000 self-check: % existing logo(s) exceed the new size limit', v_svg;
    END IF;
  END IF;

  -- 5. Nothing here may have touched an object. Counted rather than asserted,
  --    because a migration that deletes a customer's file is the one mistake this
  --    file could make that nobody would notice until a screen went blank.
  SELECT count(*) INTO v_svg FROM storage.objects WHERE bucket_id = 'document-templates';
  IF v_svg NOT IN (0, 2) THEN
    RAISE EXCEPTION '20260928100000 self-check: document-templates holds % objects, expected 0 here or 2 on the live databases', v_svg;
  END IF;

  RAISE NOTICE '20260928100000: document-templates closed; company-logos limited to png/jpeg/webp at 2 MiB';
END
$selfcheck$;
