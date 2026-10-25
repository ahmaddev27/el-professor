/*
  Deleting an invoice (owner's request, 21.10.2026).

  The billing screen could cancel an invoice and nothing else: there was no
  delete button and no delete RPC, and a direct DELETE through the table's
  policy is not an option. Since decision D14 (20260924110000) the SELECT policy
  of subscription_invoices is the tenant term alone, and a DELETE that names a
  column reads it, so PostgreSQL applies the SELECT policy to the row first. A
  platform account outside a support session sees no row, so the DELETE removes
  zero rows and PostgREST answers 200. Nothing may delete an invoice that way;
  this function is the one door, as the other billing writes have been since
  20260916130000.

  Two rules, and they are the point of the function:

    1. A paid invoice is never deleted. It is the accounting record of money
       received, and its coverage row is what grants the customer access. The
       operator cancels it instead. The same goes for an invoice that was ever
       marked paid and then re-opened: deleting it would take its payment trail
       with it, because subscription_payment_audit.invoice_id cascades.
    2. Deleting an unpaid invoice withdraws what it granted, in the same
       transaction. subscription_coverage.source_id is not a foreign key (the
       column is shared by five sources), so nothing cascades from the invoice
       to its period and the period would go on admitting the company on the
       word of an invoice that no longer exists. The period is voided with its
       own reason, not the cancel reason: that one is brought back to life when
       the invoice is paid again, and a deleted invoice can never be.

  The refusal for rule 1 is built here rather than by platform_rpc_response, so
  the shared helper is not restated for one sentence. Its audit row is still
  written through platform_rpc_record, as an error row with the reason.

  Number reuse: generate_invoice_number takes max(sequence) + 1 over the
  remaining rows, so deleting the newest invoice of a year frees its number.
  Only an invoice nobody paid can be deleted, so no receipt carries it.
*/

CREATE OR REPLACE FUNCTION public.platform_invoice_delete(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'invoice.delete';
  v_invoice public.subscription_invoices%ROWTYPE;
  v_reason text;
  v_withdrawn timestamptz;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            NULL, 'subscription_invoice', p_invoice_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  SELECT * INTO v_invoice FROM public.subscription_invoices WHERE id = p_invoice_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'subscription_invoice', p_invoice_id::text, NULL, NULL);
  END IF;

  v_reason := CASE
    WHEN v_invoice.status = 'paid' THEN 'invoice_paid'
    WHEN EXISTS (SELECT 1 FROM public.subscription_payment_audit a
                  WHERE a.invoice_id = p_invoice_id AND a.new_status = 'paid') THEN 'invoice_was_paid'
  END;
  IF v_reason IS NOT NULL THEN
    PERFORM app_private.platform_rpc_record('write', c_action, v_reason, v_invoice.company_id,
                                            'subscription_invoice', p_invoice_id::text, NULL,
                                            jsonb_build_object('status', v_invoice.status));
    RETURN jsonb_build_object(
      'success', false,
      'reason',  v_reason,
      'error',   CASE v_reason
                   WHEN 'invoice_paid'
                     THEN 'Eine bezahlte Rechnung kann nicht gelöscht werden. Sie belegt den Zahlungseingang; bitte stattdessen stornieren.'
                   ELSE 'Diese Rechnung wurde bereits als bezahlt erfasst und kann nicht gelöscht werden. Bitte stattdessen stornieren.'
                 END);
  END IF;

  -- What is about to be withdrawn, read first, so the audit row records what
  -- the company lost rather than that it lost something.
  SELECT c.period_end INTO v_withdrawn
    FROM public.subscription_coverage c
   WHERE c.company_id = v_invoice.company_id AND c.source = 'invoice'
     AND c.source_id = p_invoice_id AND c.status = 'active';

  UPDATE public.subscription_coverage
     SET status = 'void', void_reason = 'invoice_deleted'
   WHERE company_id = v_invoice.company_id AND source = 'invoice'
     AND source_id = p_invoice_id AND status <> 'void';

  DELETE FROM public.subscription_invoices WHERE id = p_invoice_id;

  PERFORM app_private.recompute_company_subscription(v_invoice.company_id);

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, v_invoice.company_id,
                                         'subscription_invoice', p_invoice_id::text,
                                         jsonb_build_object('status', v_invoice.status,
                                                            'invoice_number', v_invoice.invoice_number,
                                                            'amount', v_invoice.amount,
                                                            'invoice_month', v_invoice.invoice_month,
                                                            'invoice_year', v_invoice.invoice_year,
                                                            'coverage_period_end', v_withdrawn),
                                         jsonb_build_object('deleted', true,
                                                            'coverage_withdrawn', v_withdrawn IS NOT NULL));
END;
$$;

COMMENT ON FUNCTION public.platform_invoice_delete(uuid) IS
  'Deletes an invoice nobody paid and voids the coverage period it granted, in '
  'one transaction. A paid invoice, or one ever marked paid, is refused: cancel it.';

-- A function created here is owned by the migration role, which can reach
-- app_private; the line keeps it that way on a replay over an older owner.
ALTER FUNCTION public.platform_invoice_delete(uuid) OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.platform_invoice_delete(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_invoice_delete(uuid) TO authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $mig$
DECLARE
  c_sig  CONSTANT text := 'public.platform_invoice_delete(uuid)';
  v_code text;
BEGIN
  IF to_regprocedure(c_sig) IS NULL THEN
    RAISE EXCEPTION '20261021120000 self-check: % is missing', c_sig;
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(c_sig)) THEN
    RAISE EXCEPTION '20261021120000 self-check: % is not SECURITY DEFINER', c_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                  WHERE p.oid = to_regprocedure(c_sig) AND c.setting LIKE 'search_path=%') THEN
    RAISE EXCEPTION '20261021120000 self-check: % has no pinned search_path', c_sig;
  END IF;
  IF has_function_privilege('anon', to_regprocedure(c_sig), 'EXECUTE')
     OR has_function_privilege('service_role', to_regprocedure(c_sig), 'EXECUTE')
     OR NOT has_function_privilege('authenticated', to_regprocedure(c_sig), 'EXECUTE') THEN
    RAISE EXCEPTION '20261021120000 self-check: EXECUTE on % must be authenticated only', c_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure(c_sig)
                    AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
    RAISE EXCEPTION '20261021120000 self-check: the owner of % can reach no app_private helper', c_sig;
  END IF;

  v_code := app_private.function_code(c_sig);
  IF v_code !~ 'platform_rpc_authorize\(\s*''billing\.manage''' THEN
    RAISE EXCEPTION '20261021120000 self-check: % no longer asks billing.manage first', c_sig;
  END IF;
  IF v_code !~ '''invoice_paid''' OR v_code !~ 'new_status\s*=\s*''paid''' THEN
    RAISE EXCEPTION '20261021120000 self-check: % no longer refuses a paid invoice', c_sig;
  END IF;
  IF v_code !~ 'void_reason\s*=\s*''invoice_deleted''' THEN
    RAISE EXCEPTION '20261021120000 self-check: % no longer voids the coverage the invoice granted', c_sig;
  END IF;
  IF v_code !~ 'recompute_company_subscription' THEN
    RAISE EXCEPTION '20261021120000 self-check: % no longer recomputes the company', c_sig;
  END IF;
  IF app_private.companies_set_clauses(c_sig) <> '' THEN
    RAISE EXCEPTION '20261021120000 self-check: % assigns a column of companies; only the recompute may', c_sig;
  END IF;

  RAISE NOTICE '20261021120000 self-check: passed';
END $mig$;
