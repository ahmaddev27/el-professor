# Audit findings — El-Professor

Produced by a 259-agent review on 2026-09-08. Every finding below survived an
adversarial refutation pass; findings rated high also survived a three-lens panel
(exploitability, blast radius, existing mitigation) requiring a majority to stand.

**71 confirmed** — 0 critical, 30 high, 31 medium, 10 low.
136 raw findings were produced; 65 were refuted and dropped.

> Surviving adversarial review is evidence, not proof. Each fix still needs its own
> validation against the rule it is meant to preserve.

---

## High (30)

### 1. Any authenticated company member can UPDATE their own companies row, self-granting plan tier, subscription status, expiry and approval

- **Severity** high · **Category** `authorization-bypass` · **Verifier votes** 4
- **Location** `supabase/migrations/20260422163649_20260422000003_rls_company_isolation_part2.sql:708`

**Evidence**

```
CREATE POLICY "Company admins can update their company"
  ON companies FOR UPDATE TO authenticated
  USING (id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (id = get_user_company_id() OR is_user_super_admin());
```

**Failure scenario**

The policy name says "Company admins" but the predicate contains no admin/role check at all: it is satisfied by ANY authenticated user whose user_profiles.company_id equals the row's id. Later migrations bolt paywall/lifecycle columns onto that same row and never re-scope the policy: 20260501170528 adds `plan`, 20260621022852 adds `approval_status text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending','approved','rejected','suspended'))`, 20260621024101 adds `subscription_status` / `subscription_expires_at`, 20260531103227 adds `subscription_car_limit`. No BEFORE UPDATE guard trigger exists on companies (grep for `TRIGGER.*companies` across all 144 migrations returns only indexes). These are exactly the columns the app reads as its authorization source: AuthContext.tsx:158 selects `approval_status, rejection_reason, subscription_status, subscription_expires_at` to drive the pending/rejected/suspended full-page takeover and SubscriptionGuard, and PlanContext.tsx:177 selects `plan, status, trial_start, trial_end, subscription_car_limit, billing_cycle` to drive PlanGate. So a Fahrer- or viewer-level employee of any tenant can issue, with only the public anon key and their own JWT, `PATCH /rest/v1/companies?id=eq.<own company>` with {plan:'premium', subscription_status:'active', subscription_expires_at:'2099-01-01', trial_end:'2099-01-01', subscription_car_limit:999, approval_status:'approved'} and permanently unlock every paid tier, defeat the Abo-Aktivieren gate, and undo a super admin's suspension. This is deliberately locked down everywhere else: 20260607125649 restricts company_subscriptions and subscription_invoices writes to `is_user_super_admin()`, 20260621114909 gates update_company_subscription_manual on super admin, and 20260621024136 makes redeem_activation_code the sanctioned upgrade path — all of it bypassed by writing companies directly.

**Recommendation**

Split the companies UPDATE policy: keep a narrow policy for user-editable profile fields and add a BEFORE UPDATE trigger (mirroring enforce_user_profile_privilege_guard in 20260430082323) that raises unless auth.uid() is a super admin whenever plan, approval_status, subscription_status, subscription_started_at, subscription_expires_at, subscription_duration_type, subscription_car_limit, billing_cycle, trial_start, trial_end or status changes. Force all subscription changes through the existing SECURITY DEFINER RPCs.

---

### 2. The "Plan endgültig löschen" button hard-DELETEs an applied planning run directly, bypassing delete_or_archive_monthly_planning_run and cascade-destroying the finalization record and the manual-exception audit

- **Severity** high · **Category** `data-loss` · **Verifier votes** 3
- **Location** `src/components/MonatsplanungAppliedRuns.tsx:226`

**Evidence**

```
const { error } = await supabase
        .from('company_planning_runs')
        .delete()
        .eq('id', deleteTarget.id)
        .eq('company_id', companyId);

// rendered unconditionally on every row (line 576-583), and the list is
// filtered to applied runs only (line 147):
//   setRuns(list.filter(r => r.status === 'applied'));
//   <button onClick={onDelete} ... title="Plan endgültig löschen">
```

**Failure scenario**

delete_or_archive_monthly_planning_run (20260612060122:211-265) is a SECURITY DEFINER RPC written precisely to prevent this: it counts referencing trips and, when v_ref_cnt > 0, only sets status='archived' instead of deleting. The UI never calls it. Because company_planning_runs carries an open DELETE policy for any company member (20260606101343:64-66 "delete_own_planning_runs" USING company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid())), the direct delete succeeds. Concrete sequence: an operator finalizes March, downloads the Stundennachweise, sends them to the Steuerberater, then clicks "Plan endgültig löschen" on that same still-applied run. Postgres then cascades: planning_finalizations.planning_run_id is `uuid NOT NULL REFERENCES company_planning_runs(id) ON DELETE CASCADE` (20260616120915:11) so the record proving the ~10 pre-flight checks passed is erased; monthly_planning_manual_exceptions.planning_run_id is likewise ON DELETE CASCADE (20260612034932:19) so every audited Dienstzeit/Tageslimit/Monatslimit bypass is erased; and fahrtenbuch_trips.assignment_planning_run_id is ON DELETE SET NULL (20260612034932:9) so all ~thousands of March trips silently lose their run linkage. The trips keep their reassigned drivers (assigned_driver_id is not touched and is not revertible — the immutability trigger blocks nothing here, but there is no stored original assignment to restore). The company is left with documents already filed with the authorities and no surviving record of which planning run produced them or which statutory constraints were manually overridden. A single confirmation dialog is the only gate, and any company member — not just an admin — can do it via the REST API regardless of the UI.

**Recommendation**

Replace the direct .delete() in handleDeleteRun with supabase.rpc('delete_or_archive_monthly_planning_run', { p_run_id: deleteTarget.id }) and surface the returned action ('archived' vs 'deleted') to the user, and drop or narrow the "delete_own_planning_runs" RLS policy so the RPC is the only deletion path. Also fix useFahrtenbuch.deleteImport (src/hooks/useFahrtenbuch.ts:276-281), which deletes planning runs by import_id the same way.

---

### 3. Any self-registered user can set role='admin' on their own profile via signUp user_metadata, satisfying both the client isAdmin gate and the manage-users edge function's only authorization check

- **Severity** high · **Category** `privilege-escalation` · **Verifier votes** 4
- **Location** `supabase/migrations/20260426211314_fix_handle_new_user_trigger_rls_bypass.sql:43`

**Evidence**

```
handle_new_user (the CURRENT definition — this migration is the last one to replace it) copies the role straight out of attacker-controlled signup metadata:

  INSERT INTO user_profiles (user_id, email, full_name, role, status, invited_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'viewer'),
    ...

src/contexts/AuthContext.tsx:327-334 shows the app itself calling the public endpoint with caller-supplied metadata:
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName || '' },

src/contexts/AuthContext.tsx:386 derives the whole client authorization model from that column:
  const isAdmin = profile?.role === 'admin';
and src/App.tsx:195-198 registers Users/Roles/Billing/Settings on it:
  {isAdmin && <Route path="users"    element={<PlanGate feature="rollen_nutzer"><UsersPage /></PlanGate>} />}

supabase/functions/manage-users/index.ts:73 uses the same column as its ONLY authorization gate:
    if (callerProfile?.role !== 'admin' && !callerProfile?.is_super_admin) {
      throw new Error('Access denied: Only administrators can manage users')
    }

The BEFORE-INSERT hardening trigger (supabase/migrations/20260430082323_harden_user_profiles_privilege_escalation.sql:58-60) explicitly does not apply
```

**Failure scenario**

An attacker takes VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY out of the shipped JS bundle and calls the public signup endpoint with supabase.auth.signUp({ email, password, options: { data: { role: 'admin' } } }). handle_new_user writes user_profiles.role='admin' (company_id NULL). The privilege guard trigger is bypassed because auth.uid() is NULL in the signup context. The attacker now holds a JWT whose profile passes the manage-users authorization check at line 73 — the only server-side authorization the user-management API has — and chains into finding #2 (full cross-tenant user dump plus password reset of the super admin). role/role_id can no longer be changed after the fact (the guard blocks that), but it never has to be: it is set to 'admin' at creation time.

**Recommendation**

Never derive privileges from raw_user_meta_data. Hard-code role 'viewer' and company_id NULL in handle_new_user, and have company-signup / manage-users set the real role afterwards with the service key. Additionally, stop treating user_profiles.role as an authorization source in the edge function without a company context (see finding #2).

---

### 4. manage-users edge function treats a NULL caller company_id as 'no restriction': it dumps every tenant's users and lets a null-company admin reset the super admin's password

- **Severity** high · **Category** `tenant-isolation` · **Verifier votes** 4
- **Location** `supabase/functions/manage-users/index.ts:99`

**Evidence**

```
LIST (lines 93-109) skips the tenant filter entirely when callerCompanyId is falsy:
      let profileQuery = supabaseAdmin
        .from('user_profiles')
        .select('*, roles:role_id(id, name, description)')
        .in('user_id', userIds)

      // Super admins see all users; company admins see only their company
      if (!isSuperAdmin && callerCompanyId) {
        profileQuery = profileQuery.eq('company_id', callerCompanyId)
      }
      const { data: profiles } = await profileQuery
      const visibleUserIds = new Set(profiles?.map(p => p.user_id) ?? [])
      const usersWithProfiles = users.users
        .filter(u => isSuperAdmin || visibleUserIds.has(u.id))
The returned rows include id, email, full_name, role, company_id and is_super_admin (lines 113-122).

RESET PASSWORD (lines 366-386) — the same null-vs-null comparison passes:
      if (!isSuperAdmin) {
        const { data: targetProfile } = await supabaseAdmin
          .from('user_profiles').select('company_id').eq('user_id', body.user_id).maybeSingle()
        if (targetProfile?.company_id !== callerCompanyId) {
          throw new Error('Access denied: Cannot manage users from another company')
        }
      }
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(body.user_id, {
        password: body.password,
      })
Identical null-vs-null guards at lines 253, 307 and 410 (u
```

**Failure scenario**

An account with role='admin' and company_id NULL (trivially obtained via finding #1) calls GET /functions/v1/manage-users/list: because callerCompanyId is NULL the tenant filter is skipped and the response is every user of every fleet operator — email, full name, role, company_id, is_super_admin, auth user id. The attacker picks the row with is_super_admin=true (company_id NULL) and calls POST /manage-users/reset-password with that user_id and a password of their choice; `targetProfile?.company_id !== callerCompanyId` evaluates null !== null → false, so the service-role client rewrites the super admin's password. The attacker logs in as super admin and reads/writes every tenant's Fahrtenbuch, Stundennachweise and salary data (RLS grants `OR is_user_super_admin()` on every table). The same null-vs-null hole lets them DELETE the super admin's auth user (line 410).

**Recommendation**

Reject the request outright when !isSuperAdmin && !callerCompanyId ('no company context'), for every endpoint including /list and /resend-invite. Compare companies only after both sides are proven non-null, and add the missing company check to /resend-invite.

---

### 5. Role-based write restrictions (viewer / creator / canEdit / canDelete) exist only in React; RLS grants every authenticated company member full INSERT/UPDATE/DELETE on all payroll tables

- **Severity** high · **Category** `client-only-authz` · **Verifier votes** 4
- **Location** `src/contexts/AuthContext.tsx:386`

**Evidence**

```
src/contexts/AuthContext.tsx:386-389, 422-432 — the entire write model is computed in the browser:
  const isAdmin = profile?.role === 'admin';
  const isCreator = profile?.role === 'creator' || isAdmin;
  const isViewer = profile?.role === 'viewer' && !isAdmin && !isCreator;
  const canCreate = isAdmin || isCreator;
  ...
  const canEdit = (createdBy?: string | number) => {
    if (isAdmin) return true;
    if (!createdBy) return false;
    return profile?.id === String(createdBy);
  };

Consumers enforce it only in the handler, e.g. src/components/FixedCostsManagement.tsx:68-71:
    if (!canCreate) {
      showError('Keine Berechtigung', 'Nur Administratoren und Ersteller können Fixkosten hinzufügen');
      return;
    }
and src/components/IncomeManagement.tsx:209-212 (identical pattern), src/components/DriversManagement.tsx:334-335 (`onClick={() => canDelete(driver) && handleDelete(driver.id)} disabled={!canDelete(driver)}`).

The database has no matching rule — supabase/migrations/20260422163649_20260422000003_rls_company_isolation_part2.sql:107-114 and :130-141 are role-agnostic:
CREATE POLICY "Company users can update drivers"
  ON drivers FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());
CREATE POLICY "Company users can insert fixed_costs"
  ON fixed_costs FOR INSERT TO au
```

**Failure scenario**

A fleet operator invites a bookkeeper as role='viewer' so they can look but not touch. That user opens the browser console on the running app (the supabase client is already authenticated) and runs `await supabase.from('drivers').update({ salary_ratio: 0.9 }).eq('id', '<driver-uuid>')` or `await supabase.from('salaries').delete().eq('company_id', '<own company>')`. RLS accepts both — the only thing that ever said no was the disabled button. Salary ratios feed `(Umsatz + Aktionen) × driver.salary_ratio`, so the change silently alters the Brutto figures that go to the Steuerberater, with no audit trail of who did it.

**Recommendation**

Move the role decision into the database: extend get_user_company_id() with a get_user_role() helper and require `get_user_role() IN ('admin','creator')` in the INSERT/UPDATE/DELETE policies of the business tables (or route writes through SECURITY DEFINER RPCs that check the role). Keep the client checks as UX only.

---

### 6. Any company member can UPDATE any colleague's user_profiles row; the privilege guard covers only is_super_admin/company_id/role, so a viewer can lock the company admin out

- **Severity** high · **Category** `client-only-authz` · **Verifier votes** 4
- **Location** `supabase/migrations/20260422163649_20260422000003_rls_company_isolation_part2.sql:670`

**Evidence**

```
CREATE POLICY "Users can update company profiles"
  ON user_profiles FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR company_id = get_user_company_id()
    OR is_user_super_admin()
  )
  WITH CHECK ( ... same ... );

The column-level guard (supabase/migrations/20260430082323_harden_user_profiles_privilege_escalation.sql:94-121) protects only three things — is_super_admin, company_id and role/role_id:
    IF COALESCE(NEW.is_super_admin,false) IS DISTINCT FROM COALESCE(OLD.is_super_admin,false) AND NOT caller_is_super THEN ...
    IF NEW.company_id IS DISTINCT FROM OLD.company_id AND NOT caller_is_super THEN ...
    IF (NEW.role_id IS DISTINCT FROM OLD.role_id OR NEW.role IS DISTINCT FROM OLD.role) AND NOT caller_is_super AND NOT ( caller_role_text = 'admin' ... )
Nothing guards `status`, `must_change_password`, `email` or `full_name`.

Those columns are load-bearing for login: src/contexts/AuthContext.tsx:192-195
      const status = profileData.status as string;
      if (status === 'inactive') return 'user_inactive';
      if (status === 'suspended') return 'user_suspended';
      if (status === 'deactivated') return 'user_deactivated';
and src/App.tsx:79-81 forces /set-new-password on must_change_password. In the UI these fields are changed only through the admin-only UsersPage → manage-users edge function (src/components/UserManagement.tsx:636-641, endp
```

**Failure scenario**

A disgruntled 'viewer' employee opens the console and runs `await supabase.from('user_profiles').update({ status: 'deactivated' }).eq('company_id', '<their own company>')`. RLS allows it (same company), and the privilege guard ignores `status`. Every colleague including the company admin is now refused at login by checkProfileAccess ('Ihr Benutzerkonto wurde deaktiviert') — the whole tenant is locked out of its own payroll system during the Stundennachweis deadline, and only a super admin can undo it. The same call with `{ must_change_password: true }` traps everyone on /set-new-password.

**Recommendation**

Restrict the UPDATE policy to `user_id = auth.uid() OR is_user_super_admin()` and let admins change colleagues' rows only through the manage-users edge function; alternatively extend enforce_user_profile_privilege_guard() so that status / must_change_password on a row other than the caller's own can be changed only by a company admin or super admin.

---

### 7. Deleting a Fahrtenbuch import cascade-destroys every trip, planning run, finalization and Ausgleichsstunden row of an already-finalized payroll month, with no DB-level guard

- **Severity** high · **Category** `cascade-destroys-payroll-records` · **Verifier votes** 4
- **Location** `supabase/migrations/20260605082340_create_fahrtenbuch_trips_and_immutability.sql:21`

**Evidence**

```
Schema (20260605082340_create_fahrtenbuch_trips_and_immutability.sql:20-21):
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  import_id             uuid NOT NULL REFERENCES fahrtenbuch_imports(id) ON DELETE CASCADE,

Live client (src/hooks/useFahrtenbuch.ts:273-286):
  const deleteImport = useCallback(async (importId: string) => {
    if (!companyId) return;
    const { error: planErr } = await supabase
      .from('company_planning_runs')
      .delete()
      .eq('import_id', importId)
      .eq('company_id', companyId);
    if (planErr) throw planErr;
    const { error } = await supabase
      .from('fahrtenbuch_imports')
      .delete()
      .eq('id', importId)
      .eq('company_id', companyId);

The deleted planning run in turn cascades: planning_finalizations.planning_run_id ... ON DELETE CASCADE (20260616120915_create_planning_finalizations.sql:11), planning_run_adjustments.planning_run_id ... ON DELETE CASCADE (20260616125855_create_planning_run_adjustments.sql:5), monthly_planning_manual_exceptions.planning_run_id ... ON DELETE CASCADE (20260612034932_add_phase5_apply_tracking_and_exceptions.sql:19). Nothing is ON DELETE RESTRICT and no trigger checks for an existing finalization.
```

**Failure scenario**

An operator re-imports a corrected XLSX for a month that was already applied AND finalized (Stundennachweise already sent to the Steuerberater). In FahrtenbuchImportModal the duplicate-month overlay offers "Ersetzen", which calls onDeleteImport -> useFahrtenbuch.deleteImport (src/components/FahrtenbuchImportModal.tsx:731-733). The single click deletes the company_planning_runs row, which cascades away planning_finalizations (the proof that statutory documents were generated), monthly_planning_manual_exceptions (the audit of every bypassed Dienstzeit/Tageslimit constraint) and planning_run_adjustments (Ausgleichsstunden euro amounts); deleting the import row then cascades away every fahrtenbuch_trips row of that month. The confirmation text only warns 'inklusive Fahrten und Planentwürfe'. The month's statutory source data and its audit chain are irrecoverably gone, while stored Stundennachweis PDFs (saved_stundennachweise.pdf_storage_path) remain in Storage pointing at trips that no longer exist.

**Recommendation**

Change fahrtenbuch_trips.import_id and the run-scoped audit/finalization FKs to ON DELETE RESTRICT, and add a BEFORE DELETE trigger (or a SECURITY DEFINER delete RPC) on fahrtenbuch_imports / company_planning_runs that refuses when a planning_finalizations row exists for the affected run. Deletion of a finalized month should require an explicit archive/supersede path, not a cascade.

---

### 8. Saved-plan Fahrtenbuch re-export loads trips with no pagination — PostgREST's 1000-row cap silently truncates the exported statutory XLSX

- **Severity** high · **Category** `unbounded-select` · **Verifier votes** 4
- **Location** `src/components/HistoricalWorkingHoursWizard.tsx:10128`

**Evidence**

```
// Fetch original trips from DB
      const { data: tripRows } = await supabase
        .from('fahrtenbuch_trips')
        .select('*')
        .eq('import_id', plan.import_id ?? '')
        .order('source_row_index', { ascending: true });

      const trips = (tripRows ?? []) as FahrtenbuchTrip[];

...
      await reExportFahrtenbuchFromSavedPlan({ trips, ... });

// and in reExportFahrtenbuchFromSavedPlan (line 9411-9413):
    const totalCols = range.e.c - range.s.c + 1;
    const totalRows = 1 + rowEntries.length;   // rowEntries := trips.map(...)
```

**Failure scenario**

Every other trip loader in the codebase paginates (`src/pages/CompanyPlannerPage.tsx:60-77`, `src/utils/monatsplanungXlsxExport.ts:83-103`, `src/components/HistoricalWorkingHoursWizard.tsx:277-291` all use `.range(offset, offset+1000-1)` in a `while(true)` loop). This one does not. A normal monthly Fahrtenbuch import is several thousand rides. `downloadSavedPlan` therefore receives exactly the first 1000 rows, `reExportFahrtenbuchFromSavedPlan` builds `newWs['!ref']` from `totalRows = 1 + rowEntries.length`, and the user downloads a 'corrected Fahrtenbuch' containing 1000 rides instead of e.g. 6300. There is no error, no warning, and no row-count assertion anywhere on this path — the operator hands a silently truncated statutory ride log to the Steuerberater and, ultimately, to German authorities. The XLSX is well-formed, so the loss is undetectable without manually recounting rows against the original import.

**Recommendation**

Reuse the existing paginated helper `fetchAllTrips(companyId, importId)` at HistoricalWorkingHoursWizard.tsx:277 instead of the single unbounded select, and add an assertion that the fetched row count equals the import's stored trip count before writing the workbook. The supporting index already exists (`idx_fahrtenbuch_trips_source_row ON fahrtenbuch_trips (import_id, source_row_index)`), so pagination costs nothing extra.

---

### 9. Wizard driver auto-population reads fahrtenbuch_trips unbounded and unordered — drivers appearing after the first 1000 rides are silently dropped from the Arbeitsstunden plan

- **Severity** high · **Category** `unbounded-select` · **Verifier votes** 4
- **Location** `src/components/HistoricalWorkingHoursWizard.tsx:9942`

**Evidence**

```
useEffect(() => {
    if (!selectedImportId || allDrivers.length === 0) return;
    supabase.from('fahrtenbuch_trips').select('original_driver_name,original_driver_id')
      .eq('import_id', selectedImportId).eq('is_canceled', false)
      .then(({ data }) => {
        const seen = new Map<string, string>();
        for (const r of (data ?? []) as { original_driver_name: string; original_driver_id: string | null }[]) {
          if (r.original_driver_id && !seen.has(r.original_driver_id)) seen.set(r.original_driver_id, r.original_driver_name);
        }
```

**Failure scenario**

No `.range()` and no `.order()`. PostgREST returns at most 1000 rows, in whatever physical order the heap yields — which for an append-only import table is roughly insert order, i.e. the beginning of the month. A driver who starts mid-month, or who only drives in the last week, has no trip in the first 1000 rows, so `seen` never contains his id, no `WzDriverConfig` is created for him, and he is absent from the entire hist_working_hours pipeline: no vehicle blocks assigned, no Stundennachweis rows, no hours in the Lohnart totals. This is exactly the class of defect the product exists to prevent — a driver's statutory time record simply does not get produced, with no error shown. The distinct-driver set is also derivable without reading every trip.

**Recommendation**

Either paginate this select the same way `fetchAllTrips` does, or (better) replace it with a `SECURITY INVOKER` RPC that does `SELECT DISTINCT original_driver_id, original_driver_name FROM fahrtenbuch_trips WHERE import_id = $1 AND is_canceled = false` server-side — one small result set, served by `idx_fahrtenbuch_trips_import`, instead of shipping thousands of rows to the browser.

---

### 10. checkStructuredNote builds note windows in UTC but compares them against local-clock block timestamps, so an exclude_from_plan note misses the first 1–2 hours of its own day and falsely covers the same hours of the following day

- **Severity** high · **Category** `hard-constraint-bypass` · **Verifier votes** 4
- **Location** `src/utils/monatsplanungPhase3.ts:489`

**Evidence**

```
// line 488-492
/** Parse a YYYY-MM-DD date string into UTC midnight ms. Returns NaN on failure. */
function parseDateMs(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

// line 540-556 (inside checkStructuredNote)
    const noteRangeStart = parseDateMs(noteStartDate);
...
      if (note.is_full_day || !note.start_time || !note.end_time) {
        // Full-day: entire calendar day
        noteIntervalStart = dateMs;
        noteIntervalEnd = dateMs + MS_PER_DAY;

// line 570 — the block side of the comparison
      if (bStartMs < noteIntervalEnd && bEndMs > noteIntervalStart) {

// bStartMs/bEndMs come from line 285-290:
function blockStartMs(b: Phase1VehicleBlock): number {
  return b.actual_start_ms != null ? b.actual_start_ms : parseLocalIsoMs(b.block_start_datetime);
}

// and monatsplanungPhase1.ts:303 sets actual_start_ms from a LOCAL-time Date:
//   actual_start_ms: curStart.getTime(),
// built by monatsplanungPhase1.ts:122-131 parseDt() -> new Date(y, m-1, d, hh, mm)  // local ctor
```

**Failure scenario**

Browser TZ Europe/Berlin (UTC+2 in July). Driver has a driver_notes row note_type='sick', note_planning_behavior='exclude_from_plan', is_full_day=true, start_date=end_date='2025-07-14'. A vehicle block runs 2025-07-14 00:30–02:00 local, so actual_start_ms=2025-07-13T22:30Z and actual_end_ms=2025-07-14T00:00Z. The note interval is [2025-07-14T00:00Z, 2025-07-15T00:00Z). The test `bEndMs > noteIntervalStart` is `00:00Z > 00:00Z` = false, so checkStructuredNote returns null and the greedy pass assigns the block to a driver who is documented sick that day. Verified numerically with `TZ=Europe/Berlin node`: overlap? false. The Section-E apply gate does not catch it either — src/utils/driverNoteValidation.ts:44 findBlockingNote uses the identical `Date.UTC` construction (parseDateUtcMs) against the same local-epoch ride timestamps — so the plan applies and the exported Stundennachweis/Fahrtenbuch show a driver working during recorded Krankheit. The same skew fires in the opposite direction: a block on 2025-07-15 00:30–02:00 local IS reported as a hard note_constraint rejection (verified: true) even though the note ended the previous day, permanently blocking a legitimate assignment.

**Recommendation**

Build note day boundaries in the same clock as the block timestamps: replace `Date.UTC(y, m-1, d)` in parseDateMs (phase3) and parseDateUtcMs (driverNoteValidation.ts) with `new Date(y, m-1, d).getTime()`, and derive the per-day cursor by incrementing the local date (new Date(y, m-1, d+i)) rather than adding a fixed 86_400_000 ms, so DST transition days keep 23h/25h lengths.

---

### 11. Finalized Stundennachweis PDF hard-codes Feiertag and Weihnachten to 0,00, so holiday hours vanish from the statutory document

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 4
- **Location** `src/components/FinalizePlanningModal.tsx:719`

**Evidence**

```
FinalizePlanningModal.tsx:717-731 (the PDF row builder used for every downloadable Stundennachweis):
          rows.push({
            date, weekday: WDAY_SHORT[dow],
            isSat: dow === 6, isSun, isHol: false,
            ...
            sonntag:       minsToDecStr(daySon),
            feiertag:      '0,00',
            weihnachten:   '0,00',
          });

The reviewed preview computes exactly these fields from the company's Bundesland — MonatsplanungStundennachweisPreview.tsx:827-866:
  const isHol = isHoliday(dateStr, bundesland);
  ...
  const sunMin  = isSun && !isHol ? totalMin : 0;
  const holMin  = isHol ? totalMin : 0;
  const isXmas = (date.getMonth() === 11 && (date.getDate() === 25 || date.getDate() === 26)) || (date.getMonth() === 4  && date.getDate() === 1);
  ...
    feiertag:      minsToHHMM(holMin),
    weihnachten:   minsToHHMM(xmasMin),
and loads it at MonatsplanungStundennachweisPreview.tsx:1416-1424 ('7. Company Bundesland for public holiday calculation' -> company_settings.state), backed by src/utils/germanHolidays.ts whose header states it is the 'Single source of truth for: Monatsplanung Stundennachweis Preview, Stundennachweis PDF export, Salary calculation (Feiertag premium)'.
```

**Failure scenario**

A driver works 8h on 3. Oktober (or 25./26.12., or 1. Mai). In the Stundennachweis Preview the operator sees Feiertag 8:00 (and Weihnachten 8:00 for 25.12.), and the Feiertagszuschlag 125% is included in the expected Brutto. The operator then clicks 'Finale Dokumente erstellen' and downloads the per-driver PDFs from the modal: the Feiertag and Weihnachten columns read 0,00 for every day of the month, and the totals row (fmtDec(minsToDecimal(totals.feiertag)) in stundennachweisPdfExport.ts:401-402) reads 0,00 as well. The document handed to the Steuerberater and to the authorities understates tax-free holiday premium hours, and contradicts the preview the operator approved.

**Recommendation**

Reuse the preview's row builder (buildPdfRows/buildPdfDayRow + isPublicHoliday with the company's Bundesland) in FinalizePlanningModal instead of the second, simplified implementation, or at minimum load company_settings.state and compute isHol/feiertag/weihnachten the same way. Two independent Stundennachweis generators for the same run must not exist.

---

### 12. A transfer applied from the preview embedded inside the finalize modal invalidates the finalization, yet the modal keeps serving Stundennachweis PDFs from the pre-transfer snapshot while the Fahrtenbuch XLSX is re-queried live

- **Severity** high · **Category** `stale-documents` · **Verifier votes** 4
- **Location** `src/components/FinalizePlanningModal.tsx:1144`

**Evidence**

```
FinalizePlanningModal.tsx:1144-1156 renders the transfer-capable preview from inside the 'done' state and passes no invalidation callback:
      {showStundenPreview && (
        <MonatsplanungStundennachweisPreview
          run={{ id: run.id, company_id: run.company_id, ... }}
          onClose={() => setShowStundenPreview(false)}
        />
      )}
(MonatsplanungStundennachweisPreview declares `onTransferApplied?: (runId: string) => void` at line 56 — it is simply not supplied here.)

That preview writes trips and marks the finalization stale, MonatsplanungStundennachweisPreview.tsx:3204-3241:
    for (const tripId of tripIds) { const { data, error } = await supabase.rpc('reassign_fahrtenbuch_trip', {...}); ... }
    ...
    void supabase.from('planning_finalizations')
      .update({ is_stale: true, stale_reason: 'Transfer nach Finalisierung angewendet', stale_at: new Date().toISOString() })
      .eq('planning_run_id', runId).eq('is_stale', false);

Back in the parent modal nothing re-runs: the per-driver buttons still call handleDownloadStunden(d) with `driver.pdfData` captured in the snapshot state (FinalizePlanningModal.tsx:836-857, 1064-1077), while handleRedownload re-reads the database (FinalizePlanningModal.tsx:820-828 -> exportAppliedRunXlsx -> monatsplanungXlsxExport.ts:88-97 `fetchAllTrips(run.company_id, run.import_id)`).
```

**Failure scenario**

Operator finalizes March, then clicks 'Stundennachweis Preview anzeigen' in the green done panel, sees a Gehaltsabweichung and applies a transfer of 4 trips from driver A to driver B, closes the preview. The modal still shows 'Finale Dokumente erstellt'. He clicks 'Fahrtenbuch herunterladen' (fresh DB read -> the 4 trips now name driver B) and then the per-driver Stundennachweis buttons (in-memory snapshot -> those 4 trips' hours are still in A's PDF and missing from B's). The two documents that the modal's own header promises come 'aus demselben Daten-Snapshot' now disagree, and the Stundennachweis hours no longer reconcile with the Fahrtenbuch the accountant receives. The is_stale flag set in the DB has no effect on this already-open modal.

**Recommendation**

Pass `onTransferApplied` from FinalizePlanningModal to the embedded preview and, on that signal, drop `snapshot`/`finalizationId`, hide all download buttons and force `runChecks()` again (state 'checking'). Also `await` the planning_finalizations update in the preview and surface its error instead of `void`-ing it.

---

### 13. The finalized Stundennachweis uses a different minute model than the reviewed preview: no 30-minute minimum shift and gap-excluding compression, so the same driver-month yields two different Grundlohn totals

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 4
- **Location** `src/components/FinalizePlanningModal.tsx:704`

**Evidence**

```
FinalizePlanningModal.tsx:690-713 — compression widens the displayed window but sums the constituent durations:
            const a2 = dayBlocks[bestIdx], b2 = dayBlocks[bestIdx + 1];
            dayBlocks.splice(bestIdx, 2, {
              ...
              block_start_ms: a2.block_start_ms,
              block_end_ms: Math.max(a2.block_end_ms, b2.block_end_ms),
              duration_minutes: a2.duration_minutes + b2.duration_minutes,
            ...
          const dayGrund = dayBlocks.reduce((s, b2) => s + b2.duration_minutes, 0);

The preview recomputes minutes from the merged interval instead (gap included) — MonatsplanungStundennachweisPreview.tsx:766-800: 'Step 3: convert back to DisplaySegment (recompute minutes + night buckets from the actual merged timestamps for accuracy)' with `seg_minutes: Math.floor((m.endMs - m.startMs) / 60000)`.

And the preview pays a statutory minimum per shift that the modal has no equivalent of — MonatsplanungStundennachweisPreview.tsx:183 `const MIN_STUNDENNACHWEIS_SHIFT_MINUTES = 30;` / :361 `const paidDurationMinutes = Math.max(actualDurationMinutes, MIN_STUNDENNACHWEIS_SHIFT_MINUTES);` / :544 `g.total_minutes += b.paid_duration_minutes;`. FinalizePlanningModal builds its blocks at :576-598 with `duration_minutes: Math.floor((span.eMs - span.sMs) / 60000)` and never applies a minimum.
```

**Failure scenario**

Driver has four separate shifts on 12.03. — 06:00-10:00, 12:00-14:00, 16:00-18:00, 20:00-22:00 — plus eight 10-minute single-ride blocks spread over the month. The preview PDF reports the 12.03. row as three shifts whose merged window minutes are counted (10h incl. the absorbed 12:00-14:00 gap) and credits 8 x 30 = 240 min for the short blocks; the finalize modal's PDF reports 10h of window (von 06:00 / bis 14:00 in Schicht 1) but only 8h in the Grundlohn column, and 8 x 10 = 80 min for the short blocks. The delivered final Stundennachweis therefore shows fewer hours than the reconciliation/Brutto figures the operator validated, and its own von/bis window contradicts its hours column on any compressed day — the exact inconsistency an auditor looks for.

**Recommendation**

Have the finalization reuse the preview's block/segment pipeline (paid_duration_minutes + splitBlockForDisplay + mergeAndCompressDisplaySegments) as the single source of truth for the PDF rows, rather than a second, subtly different implementation in the modal.

---

### 14. Sonntag hours are attributed by the block's trip_date instead of by the actual clock hours, so cross-midnight work lands on the wrong day

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 4
- **Location** `src/components/FinalizePlanningModal.tsx:716`

**Evidence**

```
Blocks are grouped and dated by trip_date, FinalizePlanningModal.tsx:548-563:
        finIntervals.push({ sMs, eMs, driverId: t.assigned_driver_id, ..., serviceDate: t.trip_date });
      ...
        const key = `${iv.driverId}|${iv.serviceDate}`;
and Sunday minutes are then charged wholesale to that date — :669-670
        const [by, bm, bd] = b.service_date.split('-').map(Number);
        if (new Date(by, bm - 1, bd).getDay() === 0) d.sundayMinutes += b.duration_minutes;
and in the PDF row — :712-729
          const isSun = dow === 0;
          const dayGrund = dayBlocks.reduce((s, b2) => s + b2.duration_minutes, 0);
          const daySon  = isSun ? dayGrund : 0;
            bis1: dayBlocks[0] ? msToHHMM(dayBlocks[0].block_end_ms)   : '',

The preview instead slices every block at local midnight before attributing premiums — MonatsplanungStundennachweisPreview.tsx:656-663 ('Split a ShiftBlock at calendar-day boundaries for Stundennachweis display') and :550-554 'Use split segments so sunday/holiday minutes are assigned to the correct date' with `if (isSundayLocal(seg.display_date)) g.sunday_minutes += seg.seg_minutes;`.
```

**Failure scenario**

A Saturday night ride starts 23:20 and ends 00:50 on Sunday (a single fahrtenbuch_trips row with trip_date = Saturday; resolveActualRideWindow adds a day to the end, FinalizePlanningModal.tsx:546-547). The finalized PDF puts all 90 minutes on the Saturday row with 'bis 00:50' and Sonntag 0,00, while the preview correctly reports 50 minutes of Sunday work. The mirror case — a shift that starts Sunday 21:00 and runs to Monday 06:00 — books all 9 hours as Sonntag, including the Monday 04:00-06:00 hours that no longer qualify. Sunday premium hours (50% tax-free) are understated in one direction and overstated in the other in the document sent to the accountant, and the day row shows a 'bis' time that belongs to the following calendar day.

**Recommendation**

Split finBlocks at local midnight (reuse splitBlockForDisplay) before building rows, key the rows on the segment's calendar date, and derive Sonntag/Feiertag minutes per segment rather than from the block's trip_date.

---

### 15. Regular-driver block assignment is never written to the exported Fahrtenbuch or the hour summary — every non-shifted ride keeps its imported original driver, so drivers blow past their target hours

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 4
- **Location** `src/components/HistoricalWorkingHoursWizard.tsx:4178`

**Evidence**

```
// handleExportFahrtenbuch, line 4169-4196 — `s` is ONLY a shiftMap (Inhaber-shifted) entry
        const s = trip ? shiftMap.get(trip.id) : undefined;
        ...
          if (s) {
            // Patch only the allowed columns; every other cell is cloned verbatim
            if (c === wsDriverCol  && wsDriverCol  >= 0)
              { cell.t = 's'; cell.v = ownerDriverName; delete cell.w; }
          ...
          if (!s && trip && noteReassignments.has(trip.id)) {
            if (c === wsDriverCol && wsDriverCol >= 0) {
              cell.t = 's'; cell.v = noteReassignments.get(trip.id)!; delete cell.w;

// buildDriverHourSummary, line 8955-8959 — hours are credited to the IMPORTED driver
    const driverRaw = noteDriver
      ?? (trip.assigned_driver_name !== 'Inhaber' ? trip.assigned_driver_name : resolvedOwnerName)
      ?? resolvedOwnerName
      ?? trip.original_driver_name;

// FahrtenbuchImportModal.tsx line ~666 — assigned_driver_name at import IS the original driver
        assigned_driver_name: driverMatch?.matchedDriverName ?? rawDriver,
```

**Failure scenario**

assignRegularDriversToVehicleBlocks (called at line 10313) enforces every driver's targetTotalSec and Lohnart buckets and returns `p2.assignments`. That result is displayed, and then used only to derive `surplusBlocks`; it is never applied to a trip, never persisted (the wizard issues no `fahrtenbuch_trips` write and no `reassign_fahrtenbuch_trip` RPC — the only supabase writes are `historical_reconciliations*` at 10186-10214), and never patched into the XLSX. Concretely: driver A has a 100 h target but 180 h of rides in the imported Fahrtenbuch. The engine assigns A exactly 100 h worth of blocks (possibly blocks originally driven by B and C) and leaves other blocks in surplus. The exported XLSX still shows A on all 180 h of his own rides, and buildDriverHourSummary — the input to the Stundennachweis hours and to computeFinalSalaryCents — credits all 180 h to A. A's statutory time record and salary are 80 h over the target the whole planning step was built to respect, and the corrected Fahrtenbuch does not reconcile with the Steuerberater figures.

**Recommendation**

Apply `p2.assignments` when building the export: map blockId -> rides -> final driver and patch the Fahrername column for regular-assigned rides too (or feed buildFinalBlockAssignmentSnapshot, which already does this correctly in step 1 of historicalWorkingHoursCleanEngine.ts line 2074-2090), and resolve the hour-summary driver from that same snapshot rather than from trip.assigned_driver_name.

---

### 16. computeFinalSalaryCents pays the base hourly wage only for daytime seconds — night and pure-night shifts receive the 25/40 % surcharge with no base pay

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 4
- **Location** `src/components/HistoricalWorkingHoursWizard.tsx:9013`

**Evidence**

```
const r = row.hourlyCents / 3600; // cents per second
  const basePayCents    = Math.round(row.baseSec    * r);
  const night25PayCents = Math.round(row.night25Sec * r * 0.25);
  const night40PayCents = Math.round(row.night40Sec * r * 0.40);
  const sundayPayCents  = Math.round(row.sundaySec  * r * 0.50);
  const holidayPayCents = Math.round(row.holidaySec * r * 1.00);
  const finalSalaryCents = basePayCents + night25PayCents + night40PayCents + sundayPayCents + holidayPayCents;

// historicalWorkingHoursCleanEngine.ts line 54-58 — baseSec EXCLUDES night hours
  baseSec: number;       // 1000 Std (06:00–20:00, non-night)
  night25Sec: number;    // 1500 N25% (04:00–06:00 and 20:00–00:00)
  night40Sec: number;    // 1501 N40% (00:00–04:00)
```

**Failure scenario**

computeLohnartSeconds fills baseSec only from the 06:00-20:00 window (historicalWorkingHoursCleanEngine.ts lines 138-149); `totalSec` is computed but never used here. A driver on a 20:00-04:00 shift (8 h) at 15,00 €/h gets baseSec=0, night25Sec=4 h, night40Sec=4 h, so finalSalaryCents = 4h*15*0.25 + 4h*15*0.40 = 39,00 € instead of 120,00 € + 39,00 € surcharge — 2,6 paid hours for 8 worked. The surcharge percentages themselves confirm the intent (`night25Pay (25% surcharge)` in the doc comment at line 9002), i.e. they are meant to sit on top of a base wage that is never paid for night seconds. This figure feeds validateFinalSalaryRanges (line 9088), which is a hard export gate wired at line 4312 (`if (salaryError) { exportReadyCallbackRef.current?.(false, salaryError); return; }`), so night-heavy drivers are reported as 'unter Mindestgehalt' and block the export, and any figure that does pass is understated.

**Recommendation**

Pay the base wage on all worked seconds and treat the night/Sunday/holiday buckets purely as surcharges: basePayCents = round(row.totalSec * r), keeping the existing surcharge terms. Also reconcile the two conflicting meanings of Lohnart 1000 — the wizard sets targetBaseSec1000 === targetTotalSec (line 10295-10301, 'Base total IS the total limit') while computeLohnartSeconds defines baseSec as daytime-only.

---

### 17. Historical Arbeitsstunden salary pays the base hourly wage only for 06:00–20:00 hours; all night hours receive the surcharge but no Grundlohn

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 4
- **Location** `src/components/HistoricalWorkingHoursWizard.tsx:9014`

**Evidence**

```
computeFinalSalaryCents (HistoricalWorkingHoursWizard.tsx:9013-9019):
  const r = row.hourlyCents / 3600; // cents per second
  const basePayCents    = Math.round(row.baseSec    * r);
  const night25PayCents = Math.round(row.night25Sec * r * 0.25);
  const night40PayCents = Math.round(row.night40Sec * r * 0.40);
  const sundayPayCents  = Math.round(row.sundaySec  * r * 0.50);
  const holidayPayCents = Math.round(row.holidaySec * r * 1.00);
  const finalSalaryCents = basePayCents + night25PayCents + night40PayCents + sundayPayCents + holidayPayCents;

row.baseSec comes from computeLohnartSeconds, where it is explicitly the DAYTIME-ONLY slice (historicalWorkingHoursCleanEngine.ts:55 and :141-151):
  baseSec: number;       // 1000 Std (06:00–20:00, non-night)
  ...
  baseSec += msOverlap(startMs, endMs, baseStart, baseEnd) / 1000;   // baseStart = dMs+6h, baseEnd = dMs+20h

The wizard's own target semantics say the opposite (HistoricalWorkingHoursWizard.tsx:10430):
  // Base total IS the total limit; N25/N40/Sunday/Feiertag are sub-buckets inside it
  targetBaseSec1000:   c.targetBaseH    * 3600,
```

**Failure scenario**

A night driver at 15,00 €/h works one 8 h shift 20:00–04:00. computeLohnartSeconds returns baseSec = 0, night25Sec = 4 h (20:00–24:00), night40Sec = 4 h (00:00–04:00). computeFinalSalaryCents then yields 0 € Grundlohn + 15,00 € (25% on 4 h) + 24,00 € (40% on 4 h) = 39,00 € for an 8-hour shift instead of 120,00 € + 39,00 € = 159,00 €. The same value is rendered as the 'Gesamt' row of the Lohnart table (line 9268) and as '1000 Std (Grundlohn)' hours = row.baseSec/3600 (line 9255), and it feeds buildFinalSalaryRangeSummary, so every night-heavy driver is reported as 'below_min' and the operator adjusts the plan to hit a target computed from a salary that is short by the entire base wage of all 20:00–06:00 hours.

**Recommendation**

Decide one meaning for Lohnart 1000 and use it everywhere. Since targetBaseH is read from the Steuerberater's Lohnabrechnung line 1000 (= all paid hours), pay the base on total worked seconds: basePayCents = Math.round((row.baseSec + row.night25Sec + row.night40Sec) * r) (equivalently row.totalSec * r), keeping night25/night40/sunday/holiday as surcharge-only buckets. Then make assignRegularDriversToVehicleBlocks compare the same aggregate against targetBaseSec1000 instead of the daytime-only bl.baseSec (historicalWorkingHoursCleanEngine.ts:997).

---

### 18. Monatsplanung Brutto applies the 40% night rate to the 25% bucket and pays no premium at all for the 00:00–04:00 (Lohnart 1501) minutes

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 4
- **Location** `src/components/MonatsplanungStundennachweisPreview.tsx:501`

**Evidence**

```
computeNightBuckets (MonatsplanungStundennachweisPreview.tsx:216-231) makes the two buckets deliberately disjoint:
  const n23 = minutesInBucket(startMs, endMs, 23, 24);
  const n00 = minutesInBucket(startMs, endMs, 0, 4);
  const n04 = minutesInBucket(startMs, endMs, 4, 6);
  const nNachtarbeit = n23 + n04;  // excludes the 00:00–04:00 bucket

calcExpectedBrutto (line 501) then charges the 40% rate against that 25% bucket and never references nacht0bis4_minutes:
  cents += (seg.nachtarbeit_minutes * hourlyRate * 100 * PREM_NIGHT) / 60;   // PREM_NIGHT = 0.40 (line 179)

Same in calcShiftBrutto (line 2607) and in the XLSX 'Monatssummen' sheet (line 1102), whose header literally reads 'Nachtzuschlag 40% €' (line 1090) and has no 00:00–04:00 column at all:
  const nachtZuschlag = rate != null ? Math.round(g.nachtarbeit_minutes / 60 * rate * PREM_NIGHT * 100) / 100 : null;

grep for nacht0bis4 in this file shows it is only ever displayed, never multiplied by a rate.
```

**Failure scenario**

Driver at 14,00 €/h, one 22:00–06:00 shift. Buckets: n23 = 60 min, n00_04 = 240 min, n04_06 = 120 min, so nachtarbeit_minutes = 180 and nacht0bis4_minutes = 240. Correct premium = 180/60*14*0.25 + 240/60*14*0.40 = 10,50 € + 22,40 € = 32,90 €. The code computes 180/60*14*0.40 = 16,80 € — the four core night hours (the highest-premium ones) are paid at 0%. expected_brutto is written to saved_stundennachweise.calculated_salary (line 1708), shown as 'Brutto erwartet' (line 2226) and drives the Gehaltsabweichung/transfer analysis (line 2698), so the tool moves shifts between drivers to close a deviation that is itself miscomputed, and the PDF reports Nacht-0–4 hours that no Brutto figure ever pays.

**Recommendation**

Split the rate: introduce PREM_NIGHT_25 = 0.25 for nachtarbeit_minutes and PREM_NIGHT_40 = 0.40 for nacht0bis4_minutes, and add the missing nacht0bis4 term to calcExpectedBrutto (line 501), calcShiftBrutto (line 2607) and the Monatssummen sheet (line 1102), adding a 'Nacht 0–4 h / Zuschlag 40% €' column so the sheet's components still sum to Brutto.

---

### 19. Sunday and Feiertag premiums are cumulated for holidays that fall on a Sunday, and Ostersonntag is wrongly listed as a national holiday

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 4
- **Location** `src/utils/historicalWorkingHoursCleanEngine.ts:155`

**Evidence**

```
computeLohnartSeconds (historicalWorkingHoursCleanEngine.ts:152-156) adds the full day overlap to BOTH buckets, with no exclusivity:
    const dayOverlap = msOverlap(startMs, endMs, dMs, nextDayMs);
    ...
    if (isSunday)  sundaySec  += dayOverlap / 1000;
    if (isHoliday) holidaySec += dayOverlap / 1000;

and computeFinalSalaryCents (HistoricalWorkingHoursWizard.tsx:9017-9019) sums both:
  const sundayPayCents  = Math.round(row.sundaySec  * r * 0.50);
  const holidayPayCents = Math.round(row.holidaySec * r * 1.00);
  const finalSalaryCents = basePayCents + night25PayCents + night40PayCents + sundayPayCents + holidayPayCents;

getGermanNationalHolidays additionally puts Easter Sunday into the set (historicalWorkingHoursCleanEngine.ts:100), although it is a statutory holiday only in Brandenburg — and the sibling module src/utils/germanHolidays.ts:102-105 correctly omits it:
  for (const dt of [easterSunday, goodFriday, easterMonday, ascension, whitMonday]) {

The Monatsplanung PDF path in the same product encodes the exclusivity explicitly (MonatsplanungStundennachweisPreview.tsx:844):
  const sunMin  = isSun && !isHol ? totalMin : 0;
```

**Failure scenario**

25.12.2022 fell on a Sunday. A driver at 15,00 €/h works 8 h that day: sundaySec = holidaySec = 28800, so the salary is 120,00 € base + 60,00 € Sunday + 120,00 € Feiertag = 300,00 € instead of 240,00 €. The same happens on 01.01.2023, 01.05.2022, 03.10.2021 — and unconditionally every year on Easter Sunday, which is not a holiday outside Brandenburg but is in this set, so an ordinary Sunday is billed at 150% surcharge. The inflated figure is what the wizard reconciles against the Steuerberater's Brutto, so the plan can never balance. The identical cumulation exists in MonatsplanungStundennachweisPreview.tsx:502-506 and :552-553 (expected_brutto adds PREM_SUN and PREM_HOLIDAY for the same minutes) while that file's own PDF excludes Sunday on holidays — so the exported PDF and the Brutto it is filed with disagree.

**Recommendation**

Make the buckets exclusive in computeLohnartSeconds: `if (isHoliday) holidaySec += dayOverlap/1000; else if (isSunday) sundaySec += dayOverlap/1000;` (holiday supersedes Sunday, matching MonatsplanungStundennachweisPreview.tsx:844), remove easterSunday from the set in getGermanNationalHolidays, and apply the same else-if in groupByDriver/calcExpectedBrutto.

---

### 20. Nachtarbeit window starts at 23:00 in the monthly pipeline but at 20:00 in the historical engine — 20:00–23:00 carries no night premium on the Stundennachweis

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 3
- **Location** `src/components/MonatsplanungStundennachweisPreview.tsx:217`

**Evidence**

```
MonatsplanungStundennachweisPreview.tsx:216-231:
  const n23 = minutesInBucket(startMs, endMs, 23, 24);
  const n00 = minutesInBucket(startMs, endMs, 0, 4);
  const n04 = minutesInBucket(startMs, endMs, 4, 6);
  // Nachtarbeit = 23:00–00:00 plus 04:00–06:00 only.
  const nNachtarbeit = n23 + n04;

The other live engine uses 20:00 for the same Lohnart (historicalWorkingHoursCleanEngine.ts:56 and :137-140):
  night25Sec: number;    // 1500 N25% (04:00–06:00 and 20:00–00:00)
  ...
  const n25lStart = dMs + 20 * 3600000;
  const n25lEnd   = nextDayMs;

The 23:00 value flows straight into the statutory document: buildPdfDayRow line 842 `const nachtarbeitMin = segments.reduce((s, x) => s + x.nachtarbeit_minutes, 0)` → PDF 'Nachtarbeit' column and saved_stundennachweise.nachtarbeit_min (line 1698).
```

**Failure scenario**

A driver works 20:00–04:00. The historical Arbeitsstunden pipeline books 4 h into Lohnart 1500 (20:00–24:00); the monthly Monatsplanung pipeline books 1 h (23:00–24:00) for the identical shift. Three hours per evening shift — roughly 60 h/month for a full-time night driver — are missing from the 'Nachtarbeit' column of the Stundennachweis and from expected_brutto, so two documents produced by the same product for the same driver disagree, and the tax-free night surcharge (§3b EStG defines Nachtarbeit as 20:00–06:00) is understated on the copy that reaches the accountant.

**Recommendation**

Change the late-night bucket in computeNightBuckets to minutesInBucket(startMs, endMs, 20, 24) so both pipelines use the statutory 20:00–06:00 night window, keeping 00:00–04:00 in its own 40% bucket, and re-check any stored saved_stundennachweise rows generated with the 23:00 boundary.

---

### 21. salaries.amount_due is written once at row creation and never refreshed, so the DB-computed payment_status / remaining_balance are derived from a stale salary figure and mark drivers as fully paid while money is still owed

- **Severity** high · **Category** `stale-money-basis` · **Verifier votes** 4
- **Location** `src/components/SalariesManagement.tsx:161`

**Evidence**

```
Written only on INSERT — src/components/SalaryDetailsModal.tsx:100-110 (auto-fires on opening the modal):
      const { data, error } = await supabase.from('salaries').insert({
        driver_id: salary.driver_id,
        period_start: salary.period_start,
        period_end: salary.period_end,
        calc_revenue: salary.revenue,
        calc_tips: salary.tips,
        amount_due: salary.amount_due,

and src/components/SalariesManagement.tsx:233-244 — no UPDATE anywhere in src/ ever sets amount_due.

The DB trigger derives everything from that frozen column — supabase/migrations/20260402044152_fix_salary_payment_calculation_use_netto_or_amount_due.sql:
  SELECT COALESCE(netto_salary, amount_due, 0) INTO salary_total
  FROM salaries WHERE id = COALESCE(NEW.salary_id, OLD.salary_id);
  ...
  ELSIF payments_total >= salary_total THEN
    new_status := 'paid';
    new_remaining := 0;

and the UI then prefers that stale status over its own fresh computation — src/components/SalariesManagement.tsx:136-161:
      const totalSalary = Number(existingSalary?.netto_salary || amountDue);   // fresh, from live income
      const remainingAmount = Math.max(0, totalSalary - totalPaidAmount);      // fresh
      ...
        remaining_balance: remainingAmount,
        payment_status: existingSalary?.payment_status || calculatedPaymentStatus,  // STALE wins

Downstream consumers read the stale
```

**Failure scenario**

On 8 April an admin opens the Gehaltsabrechnung details for driver X while only week 1 of April's Umsatz has been imported (1.000 EUR, ratio 0.5). ensureSalaryExists inserts a salaries row with amount_due = 500,00. The rest of April's Fahrtenbuch/Umsatz is imported later, so the live figure becomes 3.000,00. The admin records a 500,00 EUR cash payment. The trigger reads the frozen amount_due = 500, sees payments_total 500 >= 500, and writes payment_status='paid', remaining_balance=0. Consequences: (a) the salary table row now renders the green "Bezahlt" badge (SalariesManagement.tsx:565-570, driven by the stale payment_status at line 161) while the very same row's Restbetrag column shows 2.500,00 EUR (line 561, driven by the fresh remainingAmount) — two contradictory numbers in one row; (b) calcSalaryAlerts filters on payment_status, so 2.500 EUR of genuinely unpaid salary vanishes from the Overview page's unpaid-salary alerts entirely; (c) calcOverviewMetrics sums the frozen amount_due, so `profit = umsatz - salaryTotal - totalCosts` overstates company profit by 2.500 EUR; (d) driverSalaryPdf.ts:224-225 prints "Bezahlt: 500,00 / Restbetrag: 0,00" on the document given to the driver.

**Recommendation**

Recompute and persist amount_due (and re-run the status trigger) whenever the salary is viewed or income for the period changes — e.g. UPSERT amount_due in ensureSalaryExists/calculateSalaries instead of INSERT-only, and add an `AFTER INSERT/UPDATE/DELETE ON income` trigger (or an explicit `recalc_salary(salary_id)` RPC) that refreshes total_paid/remaining_balance/payment_status. Until then, SalariesManagement.tsx:161 must not prefer the stored payment_status: use `calculatedPaymentStatus` so the badge and the Restbetrag column at least agree.

---

### 22. Receipt date-range filter drops every receipt dated on the last day (Sunday) of the selected business week/month

- **Severity** high · **Category** `date-boundary-money` · **Verifier votes** 4
- **Location** `src/components/ReceiptList.tsx:110`

**Evidence**

```
const receiptDate = new Date(receipt.date);
let matchesDate = true;
if (activeDateRange) {
  matchesDate =
    receiptDate >= activeDateRange.start &&
    receiptDate <= activeDateRange.end;
}

// activeDateRange comes from weekCalculations (line 73-99):
const weeksForMonth = useMemo((): WeekOfMonth[] => { ... return getBusinessWeeksForMonth(getMonth(d), getYear(d)); }
...
if (week) return { start: week.firstDay, end: week.lastDay };
return getBusinessMonthRange(month0, year);
```

**Failure scenario**

`receipt.date` is a Postgres `date` column passed through verbatim (`date: r.date` in src/hooks/useDatabase.ts:317), so it is the string "2026-03-08". `new Date("2026-03-08")` is parsed by JS as UTC midnight = 2026-03-08 01:00 **local** in Germany (CET/CEST, UTC+1/+2). But `week.lastDay` is produced by weekCalculations.ts:82 `addDays(monday, 6)` from `new Date(year, month, 1)`, i.e. **local** midnight 2026-03-08 00:00:00. Therefore receiptDate (01:00) > end (00:00) and the comparison is false. Select month März 2026 + "Woche 1" (02.03–08.03): a Beleg dated 08.03.2026 is silently excluded from the list, from `totalExpenses` / `totalVat19` (lines 144-145), from the PDF summary handed to the Steuerberater (`onDownloadPdf(sortedReceipts, …)` line 194) and from the Excel export. The same happens for the whole-month view: the business month April 2026 ends 03.05.2026, so every Beleg dated 03.05.2026 disappears from "April". Only the custom From/To range is unaffected, because there both sides are parsed as UTC. Verified with node: `new Date('2026-03-08') <= new Date(2026,2,8)` → false in any timezone east of UTC.

**Recommendation**

Compare on the same representation instead of mixing UTC-parsed and local-constructed Dates: filter with `receipt.date >= format(activeDateRange.start,'yyyy-MM-dd') && receipt.date <= format(activeDateRange.end,'yyyy-MM-dd')` (plain ISO string comparison, which is what AbrechnungPage and TrinkgeldQuittungModal already do before hitting Supabase), or parse the receipt date with `parseISO`/`new Date(y, m-1, d)` so it lands on local midnight.

---

### 23. Werkstatt-Checks store the 1..5 business-week-of-month index in a column constrained UNIQUE(car_id, week_number, year), so at most 5 checks per car per year can be saved

- **Severity** high · **Category** `week-numbering-collision` · **Verifier votes** 4
- **Location** `src/components/WerkstattCheckModal.tsx:147`

**Evidence**

```
const checkData = {
  car_id: carId,
  week_number: selectedWeek,
  year: selectedMonth.getFullYear(),
  check_date: selectedDate,
...
} catch (error: any) {
  if (error.message.includes('duplicate key')) {
    showToast('Für dieses Fahrzeug wurde bereits ein Check in dieser Woche erstellt', 'error');

// selectedWeek is the business-week INDEX inside the month (1..5):
//   WerkstattCheckModal.tsx:54  return getWeekNumberForDate(new Date(check.check_date));
//   weekCalculations.ts:111-123 getWeekNumberForDate -> index of the Monday within its business month

// supabase/migrations/20260302053813_create_werkstatt_checks_system.sql:34,46
  week_number integer NOT NULL CHECK (week_number >= 1 AND week_number <= 53),
  ...
  UNIQUE(car_id, week_number, year)
```

**Failure scenario**

The schema's `week_number` is dimensioned for ISO weeks (CHECK 1..53) and the uniqueness rule "one check per car per week per year" assumes that. The UI instead writes `getWeekNumberForDate(...)`, which is the ordinal of the week inside its business month and never exceeds 5, and the month is not stored anywhere in the key. Record a check for car B-XY-123 in Woche 1 of März 2026 (02.03–08.03); then in April try to record the mandatory check for Woche 1 of April 2026 (06.04–12.04): the insert is (same car_id, week_number=1, year=2026) → unique violation → the user sees "Für dieses Fahrzeug wurde bereits ein Check in dieser Woche erstellt" and the check cannot be saved at all. After roughly the first five weeks of a year, no further Werkstatt-Check can ever be recorded for that vehicle, and the statutory weekly inspection log silently stops.

**Recommendation**

Either persist an unambiguous key — store `check_date`'s week Monday (or the ISO week from `getWeekNumber()`, which weekCalculations.ts already exports) — and change the constraint to UNIQUE(car_id, week_monday) / UNIQUE(car_id, iso_week, iso_year); or add the business month to the key: UNIQUE(car_id, year, month, week_number). Also derive `year` from the week's Monday rather than `selectedMonth.getFullYear()`, so the Dec/Jan boundary week does not change identity depending on which month the user was browsing.

---

### 24. The finalized Stundennachweis PDF has no holiday awareness at all — Feiertag hours are hard-coded to 0,00 and holiday rows are never shaded

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 4
- **Location** `src/components/FinalizePlanningModal.tsx:730`

**Evidence**

```
The per-driver PDF rows built inside runChecks() hard-code every holiday field:

711:          const dow = date.getDay();
712:          const isSun = dow === 0;
...
719:            isSat: dow === 6, isSun, isHol: false,
...
729:            sonntag:       minsToDecStr(daySon),
730:            feiertag:      '0,00',
731:            weihnachten:   '0,00',

and totals never accumulate feiertag/weihnachten:
733:          totals.grundlohn   += dayGrund;
734:          totals.nachtarbeit += dayNacht;
735:          totals.nacht04     += dayN04;
736:          totals.sonntag     += daySon;

The file imports no holiday utility at all (imports at lines 16-43 contain no germanHolidays / isPublicHoliday), unlike MonatsplanungStundennachweisPreview.tsx:29 `import { isPublicHoliday } from '../utils/germanHolidays';`. These rows are handed straight to the shared renderer at line 848-858 (`rows: driver.pdfData.rows, totals: driver.pdfData.totals`), which shades holidays only via `row.isHol ? C_HOL : ...` (stundennachweisPdfExport.ts:342) and prints the 'F' marker only when `row.isHol` (line 359).
```

**Failure scenario**

A driver works 8 h on 03.10.2026 (Tag der Deutschen Einheit) and on 25.12.2026. The Finalize modal passes all ten pre-flight checks and the user downloads the finalized Stundennachweis via 'Download' in the done state. The PDF shows those days as ordinary white rows with Feiertag 0,00 and Weihn./1. Mai 0,00, and the Feiertag / Weihnachten totals are 0,00 for the whole month. The Feiertagszuschlag (100% steuerfrei) and the Weihnachts/1.-Mai bucket are entirely absent from the document handed to the Steuerberater, so the driver is underpaid and the statutory record contradicts the Preview PDF for the same month, which does compute holidays (isHoliday(dateStr, bundesland), line 827 of MonatsplanungStundennachweisPreview.tsx).

**Recommendation**

Import isPublicHoliday from utils/germanHolidays, resolve the company's Bundesland the same way MonatsplanungStundennachweisPreview does, and set isHol / feiertag / weihnachten (and exclude holiday minutes from the Sonntag bucket, matching buildPdfDayRow's `isSun && !isHol` rule) before building the finalized rows. Better: have FinalizePlanningModal reuse buildPdfRows from the preview rather than maintaining a second, divergent row builder.

---

### 25. Finalized Stundennachweis assigns Sonntag premium by the block's service_date instead of by the calendar minutes, so cross-midnight Sunday work loses its 50% Zuschlag

- **Severity** high · **Category** `payroll-math` · **Verifier votes** 4
- **Location** `src/components/FinalizePlanningModal.tsx:716`

**Evidence**

```
Blocks are keyed by trip_date and may legitimately run past midnight (line 547: `if (eMs <= sMs) eMs += 86400000;`), yet the whole block's minutes are attributed to the service date's weekday:

709:          const [sy, sm, sd] = serviceDate.split('-').map(Number);
710:          const date = new Date(sy, sm - 1, sd);
711:          const dow = date.getDay();
712:          const isSun = dow === 0;
713:          const dayGrund = dayBlocks.reduce((s, b2) => s + b2.duration_minutes, 0);
...
716:          const daySon  = isSun ? dayGrund : 0;

The same bug feeds the DriverSummary:
669:        const [by, bm, bd] = b.service_date.split('-').map(Number);
670:        if (new Date(by, bm - 1, bd).getDay() === 0) d.sundayMinutes += b.duration_minutes;

MonatsplanungStundennachweisPreview solves this correctly by splitting each block at local midnight before deciding the premium (splitBlockForDisplay, lines 660-707, then `isSun && !isHol ? totalMin : 0` at line 844 on per-calendar-day segments).
```

**Failure scenario**

Driver Y drives Sat 20.06.2026 22:00 to Sun 21.06.2026 02:30 (270 min, one merged block, service_date = 2026-06-20). In the finalized PDF the whole 4,50 h is written on the Saturday row (Von 22:00 / Bis 02:30) and daySon = 0, so the 150 minutes actually worked on Sunday earn no Sonntagszuschlag (Lohnart 1510, +50%). The mirror case is worse: a Sun 22:00 to Mon 02:00 block puts all 240 min into the Sonntag column, granting the 50% premium to 120 Monday minutes. The same month exported from the Preview screen produces different Sonntag totals, and only one of the two can be right.

**Recommendation**

Split each finBlock at local midnight (the same way splitBlockForDisplay does) before attributing Grundlohn/Sonntag/Feiertag, and emit one PDF row per calendar day rather than per service_date. As above, the durable fix is to make FinalizePlanningModal call the preview's buildPdfRows instead of duplicating the logic.

---

### 26. Note-overlap checks mix local-epoch block timestamps with UTC-midnight note windows, shifting every exclusion window by 1-2 hours

- **Severity** high · **Category** `timezone-arithmetic` · **Verifier votes** 4
- **Location** `src/utils/monatsplanungPhase3.ts:529`

**Evidence**

```
// monatsplanungPhase3.ts:488-491 — note days are built as UTC midnight
function parseDateMs(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}
// :529-530,540-541,574-575 — compared against block ms
  const bStartMs = blockStartMs(block);
  const bEndMs = blockEndMs(block);
  const noteRangeStart = parseDateMs(noteStartDate);
  ...
  if (bStartMs < noteIntervalEnd && bEndMs > noteIntervalStart) { ... reason: 'note_constraint' ... }
// :285-286 — but blockStartMs prefers actual_start_ms
function blockStartMs(b: Phase1VehicleBlock): number {
  return b.actual_start_ms != null ? b.actual_start_ms : parseLocalIsoMs(b.block_start_datetime);
}
// planningQualityChecks.ts:113-117 — actual_start_ms is a LOCAL-time epoch, not UTC
export function parseFullDatetimeMs(raw: string): number | null { ... const ms = new Date(cleaned).getTime(); ... }
// src/utils/driverNoteValidation.ts:44-46 vs :269-272 — identical mismatch in the preview's gate
function parseDateUtcMs(d: string): number { ... return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
export function parseLocalDatetime(s: string): number { ... return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime(); }
```

**Failure scenario**

Driver D has a full-day `exclude_from_plan` note (Krank) for 2025-07-15, and a vehicle block whose rides resolve from raw_data_json to 15.07.2025 00:00-02:00 local (CEST, UTC+2) — a normal night block. actual_start_ms = 2025-07-14T22:00Z, actual_end_ms = 2025-07-15T00:00Z, while the note window is [2025-07-15T00:00Z, 2025-07-16T00:00Z). `bEndMs > noteIntervalStart` is false, so no overlap is detected: Phase 3 assigns the sick driver, and MonatsplanungAssignmentPreview's Section E gate (same arithmetic via driverNoteValidation.ts) shows no violation, so the block is applied and exported. The mirror case is a false positive: a block on 16.07. 00:00-01:00 local maps to 15.07. 22:00-23:00Z, is reported as violating the 15.07. note, and permanently disables "Plan anwenden" with "Fahrer-Notizen in ausgewählten Platzierungen verletzt" for a legitimate plan.

**Recommendation**

Pick one epoch convention and use it on both sides. Since actual_start_ms/actual_end_ms are local-time epochs (planningQualityChecks.parseFullDatetimeMs), build the note day boundaries with `new Date(y, m-1, d).getTime()` instead of `Date.UTC(...)` in both monatsplanungPhase3.parseDateMs and driverNoteValidation.parseDateUtcMs — and fix driverNoteValidation.parseLocalDatetime/monatsplanungPhase3.parseLocalIsoMs, which currently disagree with each other despite the same name.

---

### 27. The two live Bundesland parsers resolve the same company_settings.state to different Bundesländer, so the two Stundennachweis generators pay different Feiertagszuschlag

- **Severity** high · **Category** `holiday-divergence` · **Verifier votes** 4
- **Location** `src/utils/germanHolidays.ts:16`

**Evidence**

```
germanHolidays.ts:11-37 (normaliseBundesland) matches only exact lowercase literals:
  if (s === 'bw') return 'BW';
  if (s === 'by' || s === 'bavaria') return 'BY';
  ...
  if (s === 'st' || s === 'sachsen-anhalt') return 'ST';
  return '';

StundennachweisPage.tsx:49-76 uses prefix matching over an ordered alias map:
  const BUNDESLAND_ALIASES: Record<string, string> = {
    'BW': 'BW', 'BADEN': 'BW', 'WÜRTTEMBERG': 'BW',
    'BY': 'BY', 'BAYER': 'BY',
    ...
    'SN': 'SN', 'SACHSEN': 'SN', 'ST': 'ST', 'SACHSEN-A': 'ST',
  };
  function parseBundesland(raw) {
    const up = raw.trim().toUpperCase();
    if (up.length <= 3) return BUNDESLAND_ALIASES[up] ?? null;
    for (const [prefix, code] of Object.entries(BUNDESLAND_ALIASES)) {
      if (up.startsWith(prefix)) return code;
    }
    return null;
  }
```

**Failure scenario**

company_settings.state = "Bayern" (the natural German value; the app stores free text). Executed both parsers: germanHolidays.normaliseBundesland("Bayern") -> "" (neither 'by' nor 'bavaria'); StundennachweisPage.parseBundesland("Bayern") -> "BY". For 19.06.2025 (Fronleichnam) the /stundennachweis page marks the day isHol and books every minute as Feiertag (StundennachweisPage.tsx:342 `const feiertag = row.isHol ? total : 0;`, +125% per the header comment at line 28), while MonatsplanungStundennachweisPreview.tsx:553 `if (isHoliday(seg.display_date, bundesland)) g.holiday_minutes += seg.seg_minutes;` gets false and books 0 Feiertag minutes for the same driver on the same day. Same divergence for "Baden-Württemberg" and "Mecklenburg-Vorpommern" (both -> "" vs BW/MV). "Sachsen-Anhalt" is worse: germanHolidays -> "ST" but parseBundesland -> "SN", because 'SACHSEN' is enumerated before 'SACHSEN-A' and startsWith wins first — so an ST company gets Sachsen's Buß- und Bettag and loses Heilige Drei Könige (06.01.), again with opposite results in the two documents.

**Recommendation**

Delete parseBundesland/BUNDESLAND_ALIASES from StundennachweisPage.tsx and import normaliseBundesland from germanHolidays.ts, after extending normaliseBundesland to the real free-text values (bayern, baden-württemberg, mecklenburg-vorpommern, …) using longest-prefix-wins rather than insertion order. One parser, one holiday module, for every Stundennachweis producer.

---

### 28. germanHolidays.ts is missing Reformationstag entirely, omits BW from Allerheiligen, and grants Buß- und Bettag to Thüringen — diverging from the other live holiday table

- **Severity** high · **Category** `holiday-divergence` · **Verifier votes** 4
- **Location** `src/utils/germanHolidays.ts:113`

**Evidence**

```
germanHolidays.ts:107-136 — the complete Bundesland section (no 31 October anywhere in the file):
  if (bl === 'NW' || bl === 'BW' || bl === 'BY' || bl === 'HE' || bl === 'RP' || bl === 'SL') {
    set.add(utcDateStr(utcOffset(easter, +60)));            // Fronleichnam
  }
  if (bl === 'NW' || bl === 'BY' || bl === 'RP' || bl === 'SL' || bl === 'ST' || bl === 'TH') {
    if (bl === 'NW' || bl === 'BY' || bl === 'RP' || bl === 'SL') {
      add(year, 11, 1);                                     // Allerheiligen — BW absent
    }
  }
  ...
  if (bl === 'SN' || bl === 'TH') {                         // Buß- und Bettag — TH is not entitled

StundennachweisPage.tsx:149-155:
  // Reformationstag — BB, HB, HH, MV, NI, SN, ST, SH, TH
  if (['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'].includes(bl))
    h.add(fmt(new Date(year, 9, 31)));
  // Allerheiligen — BW, BY, NW, RP, SL
  if (['BW', 'BY', 'NW', 'RP', 'SL'].includes(bl))
    h.add(fmt(new Date(year, 10, 1)));
```

**Failure scenario**

Company in Niedersachsen (state = "Niedersachsen", which both parsers resolve to NI), driver worked 8h on 31.10.2025 (Reformationstag, statutory in NI). /stundennachweis books 8h Feiertag at +125%; the Monatsplanung Stundennachweis (MonatsplanungStundennachweisPreview.tsx:505/553 -> germanHolidays.isPublicHoliday) books 0h Feiertag, because germanHolidays.ts never adds 31 October for any Bundesland — nine of sixteen Bundesländer lose the premium. Mirror cases: a Baden-Württemberg company loses Allerheiligen (01.11.) in the Monatsplanung document but gets it in /stundennachweis; a Thüringen company is *paid* a Feiertagszuschlag on Buß- und Bettag by germanHolidays.ts:130 although Thüringen abolished it as a public holiday, while /stundennachweis correctly does not.

**Recommendation**

Make germanHolidays.ts the single table and correct it: add Reformationstag for BB/HB/HH/MV/NI/SN/ST/SH/TH, add BW to Allerheiligen, restrict Buß- und Bettag to SN, and add the BE Frauentag / BB Ostersonntag / TH Weltkindertag entries that only StundennachweisPage currently has. Then delete the local getHolidaysForYear in StundennachweisPage.tsx.

---

### 29. Salary calculation loads the income table unpaginated, so PostgREST's silent 1000-row cap can zero out a driver's revenue and that zero is then written into the salaries table

- **Severity** high · **Category** `silent-truncation` · **Verifier votes** 4
- **Location** `src/components/SalariesManagement.tsx:77`

**Evidence**

```
supabase.from('salaries').select('*').eq('company_id', companyId).order('period_start', { ascending: false }),
        supabase.from('income').select('*').eq('company_id', companyId).order('date', { ascending: false })
      ]);

      const [salariesData, incomesData] = await Promise.race([dataPromises, timeoutPromise]) as any;

      if (salariesData.error) throw salariesData.error;
      if (incomesData.error) throw incomesData.error;
```

**Failure scenario**

The only failure detection here is the `error` field, which a truncated response does not set: Supabase caps a query at 1000 rows (the reason trip loading elsewhere in this codebase uses `while (true)` + `.range()` batch loops). The income table holds ~4 rows per driver per week (umsatz, aktionen, trinkgeld, bargeld), so a 20-driver fleet crosses 1000 rows in roughly three months and the query is not date-filtered. Ordered `date desc`, the 1000 returned rows cover only the most recent weeks. An admin then selects an older Abrechnungszeitraum: `calculateSalaries` (line 105) filters `incomes` by `income.date >= periodStart && <= periodEnd`, finds nothing, and computes revenue 0, tips 0, amount_due 0 — displayed as a normal 0,00 € row with no warning. Clicking "Als bezahlt markiert" runs handleStatusChange, which inserts `calc_revenue: salary.revenue, calc_tips: salary.tips, amount_due: salary.amount_due` (lines 236-238) — persisting a fabricated 0 € salary record for a driver who actually earned money, and then shows the green success toast "Gehalt für X wurde aktualisiert". The same unpaginated pattern feeds the money dashboard at src/pages/OverviewPage.tsx:297, which additionally has no `.order()` at all and drops the error entirely (`const { data } = ...; setIncomes(data || [])`), so an outright failed query renders 0,00 € Umsatz/Gewinn as if it were real.

**Recommendation**

Page the income query with `.range()` batches like `fetchAllRows` in useFahrtenbuch.ts, or scope it with `.gte('date', periodStart).lte('date', periodEnd)`. Detect truncation explicitly (a full 1000-row page means more data exists) and refuse to compute or persist a salary from a truncated set; in OverviewPage, check `error` and render a German error state instead of zeros.

---

### 30. Fahrtenbuch import inserts trips in 200-row batches with no rollback: a mid-loop failure leaves a 'confirmed' import whose row_count lies about how many trips actually exist

- **Severity** high · **Category** `partial-import-data-corruption` · **Verifier votes** 4
- **Location** `src/hooks/useFahrtenbuch.ts:256`

**Evidence**

```
const batchSize = 200;
    for (let i = 0; i < params.trips.length; i += batchSize) {
      const batch = params.trips.slice(i, i + batchSize).map(t => ({
        ...t,
        import_id: importId,
        company_id: companyId,
      }));
      const { error: tripErr } = await supabase
        .from('fahrtenbuch_trips')
        .insert(batch);
      if (tripErr) throw tripErr;
    }

    await fetchImports();
    return importId;

// contrast: the import ROW itself is carefully cleaned up on failure (lines 235-248)
//   if (importErr) { await supabase.storage...remove([storagePath]); throw importErr; }
//   if (!importRow.storage_path) { ...remove(...); await supabase.from('fahrtenbuch_imports').delete().eq('id', importId); ... }
```

**Failure scenario**

A 9,000-row October Fahrtenbuch is imported. The fahrtenbuch_imports row is written first with status 'confirmed' and row_count = 9000 (lines 217-233). At batch 23 (~row 4,600) the JWT is refreshed / the connection drops / one row violates a column constraint, so `throw tripErr` escapes createImport. Nothing deletes the import row or the ~4,600 already-inserted trips (fahrtenbuch_trips is append-only and has no UPDATE/DELETE path from the client). FahrtenbuchImportModal.doImport only shows a red 'Import fehlgeschlagen' toast (line 749). The month now shows an import labelled '9000 Fahrten' in the import list (the duplicate-warning UI at line 1163 prints imp.row_count) while only half the trips exist. If the operator retries, the duplicate warning appears and 'Zusätzlich importieren' or a second footer click adds a full second copy on top of the half copy, so the same rides exist once and twice in the same month. Planning, Stundennachweis hours and Abrechnung are then computed on a silently truncated (or partly doubled) month; the FinalizePlanningModal trip-count check compares against apply_summary_json, not against row_count, so it does not catch it.

**Recommendation**

Insert trips first into a staging step or, preferably, move the whole import behind a single SECURITY DEFINER RPC that inserts the import row and all trips in one transaction. Failing that, wrap the batch loop in try/catch and on any error delete the inserted trips (`.delete().eq('import_id', importId)`), delete the import row and remove the uploaded storage object before rethrowing, and only flip status to 'confirmed' after the last batch succeeds.

---

## Medium (31)

### 31. company-signup writes an unvalidated body-supplied discount_code_id onto the new company and never records a redemption, so used_count and max_redemptions are never enforced

- **Severity** medium · **Category** `payment-bypass` · **Verifier votes** 1
- **Location** `supabase/functions/company-signup/index.ts:134`

**Evidence**

```
const body: SignupRequest = await req.json();   // line 39 — no auth header read at all
...
if (body.discount_code_id) {
  companyInsert.active_discount_code_id  = body.discount_code_id;      // line 135
  companyInsert.active_discount_usage_mode = body.discount_usage_mode ?? null;  // line 136
  companyInsert.active_discount_started_at = now.toISOString();       // line 137
}
...
const { data: company, error: companyError } = await supabaseAdmin
  .from("companies")
  .insert(companyInsert)   // line 148, service-role client from line 33
```

**Failure scenario**

This function runs under the service-role key with no JWT (it is the public signup endpoint, called from SignupPage.tsx:276 with only a Content-Type header). It copies `discount_code_id` and `discount_usage_mode` straight from the request body into `companies` without re-reading `discount_codes` to confirm the id exists, is `active`, is within `valid_from`/`valid_until`, matches the chosen `plan`/`billing_cycle`/`car_limit`, or is still under `max_redemptions` — every one of those checks lives only in validate-discount-code, which the attacker simply skips. It also never inserts into `discount_code_redemptions` and never calls `increment_discount_used_count` (only apply-discount-code does that, and grepping src/ shows apply-discount-code is invoked from nowhere). So a curl POST carrying any discount UUID — an expired one, a `basic`-only one applied to `premium`, or an `audience_type='multiple'` code whose `max_redemptions` was long ago exhausted — creates a company permanently flagged as holding that discount, while `discount_codes.used_count` stays at 0 forever and the redemption table stays empty. The Steuerberater/invoicing side then bills against a discount the company was never entitled to, and no audit row exists to reconstruct what happened.

**Recommendation**

Re-resolve the code server-side inside company-signup by `discount_code_id` and re-run the full eligibility ladder (active, date window, plan, billing_cycle, min/max cars, audience, usage_mode, max_redemptions) against the plan/car_limit actually being inserted; drop the discount silently rather than trusting the body. Then insert the `discount_code_redemptions` row and increment `used_count` in the same transaction that creates the company (an RPC), so the enforcement data the validator reads is actually produced.

---

### 32. manage-users /resend-invite performs no tenant check, letting any company admin act on any user in any other company

- **Severity** medium · **Category** `tenant-isolation` · **Verifier votes** 1
- **Location** `supabase/functions/manage-users/index.ts:331`

**Evidence**

```
if (method === 'POST' && path.includes('/resend-invite')) {
  const body: ResendInviteRequest = await req.json()

  const { data: userData } = await supabaseAdmin.auth.admin.getUserById(body.user_id)
  if (!userData.user) throw new Error('User not found')

  const appOrigin = req.headers.get('origin') || req.headers.get('referer')?.replace(/\/$/, '') || ''
  const { error: resetError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery',
    email: userData.user.email!,
    options: appOrigin ? { redirectTo: `${appOrigin}/auth/callback` } : undefined,
  })
  if (resetError) throw resetError

  await supabaseAdmin
    .from('user_profiles')
    .update({ invited_at: new Date().toISOString() })
    .eq('user_id', body.user_id)      // line 348 — no company_id filter
```

**Failure scenario**

Every sibling handler in this file (/update line 246, /activate-deactivate line 300, /reset-password line 366, /delete line 403) guards with `if (!isSuperAdmin) { ...targetProfile.company_id !== callerCompanyId -> deny }`. /resend-invite has no such block. An admin of company A — a legitimate paying customer — takes any `user_id` (user ids are exposed to every admin through /list for their own company, and are otherwise guessable only by leak, but the endpoint also confirms existence: an unknown id throws 'User not found' while a valid foreign id returns success, giving a cross-tenant existence oracle) and POSTs it. The service-role client then (a) writes `invited_at` on a `user_profiles` row belonging to company B or to a platform super admin, corrupting company B's user-management screen, and (b) generates a fresh GoTrue recovery token for that account, which invalidates any reset link the real user is in the middle of using — a repeatable denial of password recovery against any account on the platform. `redirectTo` is built from the attacker-controlled `Origin` header (CORS is `*`, line 5), so wherever the project's redirect allowlist is permissive the generated callback points at the attacker's origin. Note the DB-level backstop does not apply here: migration 20260430082323_harden_user_profiles_privilege_escalation.sql line 59 returns early when `auth.uid() IS NULL`, which is exactly the service-role case, so the edge function is the only control.

**Recommendation**

Apply the same guard the other five handlers use before touching the target: load `user_profiles.company_id` for `body.user_id` and reject unless `isSuperAdmin || targetProfile?.company_id === callerCompanyId` (with an explicit null-check, see the related finding). Also stop deriving `redirectTo` from the `Origin`/`Referer` header — use a server-side constant.

---

### 33. Policies named "Company admins can ..." contain no admin predicate, so any company member can rewrite company_settings legal data and role definitions

- **Severity** medium · **Category** `authorization-bypass` · **Verifier votes** 1
- **Location** `supabase/migrations/20260422163649_20260422000003_rls_company_isolation_part2.sql:545`

**Evidence**

```
CREATE POLICY "Company admins can update company_settings"
  ON company_settings FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

-- same pattern at line 572 (roles insert), 576 (roles update), 611/621/638 (role_permissions)
```

**Failure scenario**

App.tsx registers these screens for admins only — line 198 `{isAdmin && <Route path="settings" element={<SettingsPage />} />}` and line 196 `{isAdmin && <Route path="roles" ... />}` — but that gate is client-side routing over a direct-to-Supabase SPA, and the matching RLS policies check only company membership, never `role`/`role_id`/is_super_admin. company_settings holds `legal_company_name`, `owner_name` and `tax_number` (20260402053937 lines 29, 43, 46), which CompanySettingsContext feeds into the generated Stundennachweis and Fahrtenbuch documents. A non-admin employee can therefore `PATCH /rest/v1/company_settings?company_id=eq.<own>` and silently change the Steuernummer or legal company name that is printed on statutory paperwork submitted to the Steuerberater and to authorities, with no audit trail. The same gap lets any member DELETE and re-INSERT the company's role_permissions rows (the exact sequence RolesManagement.tsx:70-88 performs) and rename or delete non-system roles.

**Recommendation**

Add an admin predicate to these policies, e.g. `AND EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND (role = 'admin' OR is_super_admin))`, consistent with how fahrtenbuch_imports/fahrtenbuch_trips DELETE (20260605082259:54-62) and notification_settings INSERT/UPDATE (20260502121504:59-80) already gate on role.

---

### 34. Super-admin 'view as company' never reaches any query — effectiveCompanyId is consumed by no data path, so support staff see their own (empty) company under the customer's name

- **Severity** medium · **Category** `super-admin-impersonation` · **Verifier votes** 1
- **Location** `src/contexts/SuperAdminContext.tsx:50`

**Evidence**

```
The context computes the id correctly:
  const isViewingAsCompany = isSuperAdmin && activeCompany !== null;
  const activeCompanyId = activeCompany?.id ?? null;
  const effectiveCompanyId = isViewingAsCompany ? activeCompanyId : companyId;
but a repo-wide grep for useSuperAdmin/effectiveCompanyId shows the context is consumed only by Sidebar.tsx:52, UserMenu.tsx:10, CompaniesPage.tsx:919 and SuperAdminDashboard.tsx:244 — all for display or for calling enterCompany. (MonatsplanungStundennachweisPreview.tsx:1293 declares its own unrelated local `const effectiveCompanyId = dbg.db_company_id || dbg.selected_run_company_id_prop;` and does not import the context — contrary to CLAUDE.md's claim.)

Entering a company navigates straight into the normal pages (src/pages/SuperAdminDashboard.tsx:820):
  onClick={() => { enterCompany(c as any); navigate('/overview'); }}
and those pages read the OWN company id from AuthContext (src/pages/OverviewPage.tsx:254, 293-297):
  const { isSuperAdmin, companyId } = useAuth();
  ...
  const { data } = await supabase.from('fixed_costs').select('id, description, amount').eq('company_id', companyId);
  const { data } = await supabase.from('income').select('*').eq('company_id', companyId);
Super admins have no company_id (supabase/migrations/20260422163251...:120 backfills only `is_super_admin = false`; PlanContext.tsx:156 branches on `if (!companyId) { i
```

**Failure scenario**

Support clicks 'Unternehmen öffnen' on Taxi Müller GmbH in the super-admin dashboard and lands on /overview. The sidebar says 'Taxi Müller GmbH — Super Admin Ansicht', but every query ran as `.eq('company_id', null)`, so Umsatz, Gewinn, Belege, Fahrer and TÜV warnings all render as 0/empty. Support tells the customer their month is empty, or 'fixes' it by creating a receipt — src/hooks/useDatabase.ts:364 inserts `company_id: companyId` (null), which the INSERT policy `WITH CHECK (company_id = get_user_company_id())` rejects, producing an unexplained failure. Should a super admin ever be given a company_id, the same write would land in the wrong tenant instead of failing.

**Recommendation**

Either wire effectiveCompanyId through the data layer (a single hook that every page uses instead of useAuth().companyId, with writes blocked while isViewingAsCompany), or remove the enter-company affordance until it is wired — a support view that silently shows a different tenant's data under the customer's name is worse than no view.

---

### 35. Company/user suspension and soft-delete are enforced only on the password sign-in path — an existing session survives revocation across reloads, and the Google button skips the check entirely

- **Severity** medium · **Category** `auth-revocation` · **Verifier votes** 1
- **Location** `src/contexts/AuthContext.tsx:307`

**Evidence**

```
AuthContext.tsx:297-320 — checkProfileAccess() is called from exactly one place, signIn():

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return { error };
      if (data.user) {
        const blockReason = await checkProfileAccess(data.user.id);

It is NOT called on session restore (AuthContext.tsx:237-249):

        if (existingSession) {
          if (isSessionExpired()) { ... } else {
            updateLastActivity();
            setSession(existingSession);
            setUser(existingSession.user);
            setupSessionTimer();
            await loadUserProfile(existingSession.user.id);

...nor in onAuthStateChange (AuthContext.tsx:258-274), nor in signInWithGoogle (AuthContext.tsx:341-360, which only calls supabase.auth.signInWithOAuth and returns).

loadUserProfile (AuthContext.tsx:156-166) reads only approval_status, never companies.status or user_profiles.status:

          .select('approval_status, rejection_reason, subscription_status, subscription_expires_at')

But suspension writes the OTHER columns — src/pages/CompaniesPage.tsx:960-963:

      const { error } = await supabase.from('companies').update({ status: 'suspended', updated_at: now }).eq('id', company.id);
      if (error) throw error;
      await supabase.from('user_profiles').update({ status: 'suspended' }).eq('company_id', company.id).neq(
```

**Failure scenario**

A super admin suspends "Taxi Müller GmbH" from CompaniesPage (sets companies.status='suspended', user_profiles.status='suspended'; approval_status stays 'approved'). The company's admin has the app open in a tab. Nothing happens. They press F5: initAuth restores the persisted session from localStorage['receipt-app-auth'], never calls checkProfileAccess, and loadUserProfile reads approval_status='approved' — so App.tsx:143-151 renders no CompanySuspendedPage and SubscriptionGuard passes. They retain full read/write on fahrtenbuch_trips, company_planning_runs, and Stundennachweis generation for the suspended tenant. Even after the browser session is cleared, they simply click "Mit Google anmelden" (LoginForm.tsx:100) — signInWithGoogle never calls checkProfileAccess — and are back in. The only path that blocks them is email+password, which they never need to use.

**Recommendation**

Stop treating status as a UI concern. (a) Make get_user_company_id() return NULL unless the caller's user_profiles.status='active' AND the owning company's status/approval_status are usable, so RLS revokes access at the database. (b) Call checkProfileAccess (or an equivalent SECURITY DEFINER RPC) in initAuth on session restore and on every onAuthStateChange with a session, not just in signIn. (c) Have loadUserProfile select companies.status and user_profiles.status and gate on them in App.tsx. (d) On suspend/archive/delete, revoke the users' refresh tokens via auth.admin.signOut so live sessions actually die.

---

### 36. Any authenticated user can rewrite `status` and `must_change_password` on their own profile and on every colleague's profile — defeating the must-change-password gate and enabling lockout of the company admin

- **Severity** medium · **Category** `privilege-escalation` · **Verifier votes** 1
- **Location** `supabase/migrations/20260422163649_20260422000003_rls_company_isolation_part2.sql:670`

**Evidence**

```
supabase/migrations/20260422163649_20260422000003_rls_company_isolation_part2.sql:670-681:

  CREATE POLICY "Users can update company profiles"
    ON user_profiles FOR UPDATE TO authenticated
    USING (
      user_id = auth.uid()
      OR company_id = get_user_company_id()
      OR is_user_super_admin()
    )
    WITH CHECK ( ...same three predicates... );

No admin predicate — a 'viewer' satisfies `company_id = get_user_company_id()` for every row in the tenant. The column-level guard added later, supabase/migrations/20260430082323_harden_user_profiles_privilege_escalation.sql:94-121, covers only four columns:

    IF COALESCE(NEW.is_super_admin,false) IS DISTINCT FROM COALESCE(OLD.is_super_admin,false) AND NOT caller_is_super THEN RAISE EXCEPTION ...
    IF NEW.company_id IS DISTINCT FROM OLD.company_id AND NOT caller_is_super THEN RAISE EXCEPTION ...
    IF (NEW.role_id IS DISTINCT FROM OLD.role_id OR NEW.role IS DISTINCT FROM OLD.role) ... RAISE EXCEPTION ...

`status` and `must_change_password` are unguarded. The client already performs exactly this write — src/pages/SetPasswordPage.tsx:77-90:

            .update({ status: 'active', activated_at: new Date().toISOString(), must_change_password: false })
            .eq('user_id', user.id);
  ...
            .update({ must_change_password: false })
            .eq('user_id', user.id);

and the only thing enforcing the fla
```

**Failure scenario**

(a) Lockout/tampering: a 'viewer' in Taxi Müller GmbH opens the devtools console and runs `supabase.from('user_profiles').update({status:'deactivated'}).eq('email','chef@taxi-mueller.de')`. RLS allows it (same company_id), the trigger allows it (status is unguarded). At the owner's next login, checkProfileAccess returns 'user_deactivated' and the company admin is locked out of their own payroll system with no self-service recovery. (b) Temp-password bypass: manage-users/index.ts:385 sets `must_change_password: true` after an admin resets a password. The recipient runs `supabase.from('user_profiles').update({must_change_password:false}).eq('user_id', myId)` and keeps the admin-chosen temporary password indefinitely; nothing server-side ever re-checks the flag, so the credential the admin transmitted over chat/e-mail stays valid forever.

**Recommendation**

Extend enforce_user_profile_privilege_guard() to cover `status` and `must_change_password`: allow a non-super caller to change them only on their own row, and only in the allowed direction (pending_invite -> active on a genuine invite; must_change_password true -> false only when auth.jwt() shows the password was just updated). Better: move the SetPasswordPage post-update to a SECURITY DEFINER RPC and split the RLS UPDATE policy into a self-row policy and an admin-only cross-user policy (`caller_role_text = 'admin'`), instead of the current blanket company_id match.

---

### 37. AuthCallbackPage reads the callback `type` from a URL fragment that the Supabase client may already have consumed, silently sending invite/recovery users into the app without setting a password

- **Severity** medium · **Category** `auth-flow` · **Verifier votes** 1
- **Location** `src/pages/AuthCallbackPage.tsx:30`

**Evidence**

```
src/pages/AuthCallbackPage.tsx:16-30 reads the fragment inside a React effect:

    const hash = window.location.hash || '';
    const search = window.location.search || '';
    const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : '');
    ...
    const type: CallbackType = getParam('type') ?? '';

and branches on it at lines 52-56:

            if (type === 'recovery' || type === 'invite') {
              navigate('/auth/set-password', { replace: true });
            } else {
              navigate('/', { replace: true });
            }

But the client is created at module load with detectSessionInUrl enabled — src/lib/supabase.ts:

      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'receipt-app-auth',

supabase-js consumes the fragment and strips it from the URL as part of that initialization, which begins on import — i.e. before this component mounts. There is no fallback: nothing re-derives the intent from the profile (`status === 'pending_invite'`), which SetPasswordPage.tsx:30-35 shows is available.
```

**Failure scenario**

An admin invites a new dispatcher via manage-users (which generates a type=recovery link, supabase/functions/manage-users/index.ts:~215). On a browser/timing where the client has already stripped the fragment by the time the effect runs, `type` is '' and the user is routed to '/' instead of '/auth/set-password'. Their user_profiles.status stays 'pending_invite' and must_change_password is false, so MustChangePasswordGuard does not intervene — they browse the tenant's payroll data on a one-time link-derived session but never set a password, and once that session expires (20 min idle, or the refresh token) they can never log in again and the admin has to re-issue the invite.

**Recommendation**

Do not depend on the fragment surviving. Capture the fragment synchronously at module load in main.tsx (before the supabase client import) or, simpler, decide the destination from server state: after the session appears, read user_profiles.status/must_change_password and route to /auth/set-password whenever status === 'pending_invite' or must_change_password is true, using `type` only as a hint.

---

### 38. IncomeManagement writes created_by as parseInt() of a UUID, destroying the audit trail on every income row

- **Severity** medium · **Category** `type-mismatch` · **Verifier votes** 1
- **Location** `src/components/IncomeManagement.tsx:267`

**Evidence**

```
src/components/IncomeManagement.tsx:262-269
      return {
        description: rowDescription,
        amount,
        type,
        driver_name: batchForm.driver_name,
        date: batchForm.date,
        week: batchForm.week,
        trip_count: tripCount,
        created_by: parseInt(profile.id),

src/contexts/AuthContext.tsx:9
  id: string;

supabase/migrations/20251008100001_fix_income_table_created_by.sql:25
  created_by text,

supabase/migrations/20251012000000_implement_role_based_access.sql:224-229
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'income' AND column_name = 'created_by'
    ) THEN
      ALTER TABLE income ADD COLUMN created_by uuid REFERENCES auth.users(id) DEFAULT auth.uid();
    END IF;
```

**Failure scenario**

`income.created_by` is `text` in the effective schema: 20251008100001 DROPs and recreates income with `created_by text`, and the later 'ensure created_by is UUID' block at 20251012000000:224 is guarded by IF NOT EXISTS on the column name, so it never runs. `profile.id` is the user_profiles UUID (AuthContext.tsx:9 declares it `string`). `parseInt('a3f2b1c4-...')` returns NaN, which JSON.stringify serializes as `null`; for a UUID that begins with digits (e.g. '3f2a...') it returns the integer 3, which the text column stores as '3'. So every income row an admin creates through the Wocheneingabe form records its author as NULL or as a meaningless one- or two-digit string. Given income rows are the input to the Abrechnung and the driver salary calculation, there is no way to attribute or dispute a wrong figure after the fact, and any future policy or report keyed on `created_by` will match nothing. Note the same object also cannot use auth.uid() as a default, because an explicit value is supplied.

**Recommendation**

Write `created_by: profile.user_id` (the auth.users UUID) or omit the field entirely so the column default applies, and add a migration converting `income.created_by` to `uuid` with a backfill from user_profiles once the garbage values are cleaned up.

---

### 39. Overview and Statistics load the entire income history with SELECT * and filter by month in JS — the 1000-row cap makes the dashboard's Umsatz/Gewinn figures wrong

- **Severity** medium · **Category** `unbounded-select` · **Verifier votes** 1
- **Location** `src/pages/OverviewPage.tsx:297`

**Evidence**

```
const loadIncomes = async () => {
    const { data } = await supabase.from('income').select('*').eq('company_id', companyId);
    setIncomes(data || []);
  };

// ...and the month filter happens only client-side, line 338-339:
  const currentMetrics = calcPeriodMetrics(incomes, salaries, receipts, fixedCosts, monthStart, monthEnd);
  const prevMetrics    = calcPeriodMetrics(incomes, salaries, receipts, fixedCosts, prevStart, prevEnd);

// same pattern in src/components/ReceiptStatistics.tsx:51-56 and
// src/components/SalariesManagement.tsx:77 (income .select('*') .eq('company_id') .order('date'))
```

**Failure scenario**

`income` carries one row per driver per day per type (`umsatz` / `aktionen` / `bargeld` / `trinkgeld`). A 10-car fleet with ~25 drivers produces >2000 income rows per month, so the table passes 1000 rows within the first month of use. PostgREST then returns only 1000 of them; `OverviewPage.tsx:297` has no `.order()` at all, so which 1000 is arbitrary. `calcPeriodMetrics` sums whatever subset arrived, and the Overview dashboard displays an understated Umsatz and a correspondingly wrong Gewinn for the selected month — silently, with no truncation signal. `ReceiptStatistics.tsx:51` has the identical bug; `SalariesManagement.tsx:77` at least orders by date desc, so it loses the *oldest* rows instead of arbitrary ones.

**Recommendation**

Push the month window into the query — `.gte('date', monthStart).lte('date', monthEnd)` — for both the current and previous month (the component already computes `monthStart`/`monthEnd`/`prevStart`/`prevEnd`), and add the composite index from the next finding so the range scan is cheap. Where a full history really is needed, paginate with `.range()` like the trip loaders do.

---

### 40. Daily and one-vehicle-per-day caps are keyed on the block's START date, so hours worked after midnight are charged to the previous calendar day and never counted against the following day's limit

- **Severity** medium · **Category** `payroll-math` · **Verifier votes** 1
- **Location** `src/utils/monatsplanungPhase3.ts:370`

**Evidence**

```
function checkDaily(state: DriverPlanState, block: Phase1VehicleBlock): RejectedCandidate | null {
  if (state.driver.employment_type === 'company_owner') return null;
  const maxMin = Math.round(state.effective_max_daily_hours * 60);
  const used = state.daily_minutes.get(block.service_date) ?? 0;
  if (used + block.duration_minutes > maxMin) {

// line 1300-1303 — the whole block duration is booked on the start date only
    winner.daily_minutes.set(
      block.service_date,
      (winner.daily_minutes.get(block.service_date) ?? 0) + block.duration_minutes,
    );

// line 79-81 — the day key for one_vehicle_per_day is also the start date
function startDayKey(b: { block_start_datetime: string }): string {
  return b.block_start_datetime.slice(0, 10);
}

// monatsplanungPhase1.ts:281 — service_date IS the start date
//   const serviceDate = dateStrLocal(curStart);
```

**Failure scenario**

Driver with max_daily_hours = 8 (480 min). Phase 1 emits block A on vehicle X, 2025-07-14 21:00 → 2025-07-15 01:30 (270 min, service_date '2025-07-14'), block B 2025-07-14 08:00–11:00 (180 min, same day), block C on vehicle Y 2025-07-15 06:00–10:30 (270 min) and block D 2025-07-15 12:00–15:30 (210 min). daily_minutes['2025-07-14'] = 450 ≤ 480 and daily_minutes['2025-07-15'] = 480 ≤ 480, so checkDaily accepts every block and the validation pass at line 1610 (`for (const mins of state.daily_minutes.values()) if (mins > maxMin) dailyViolations++`) reads the same map and reports daily_max_violations = 0. The driver is actually planned for 9.5 h inside calendar day 2025-07-15 (01:30 tail of A + C + D), 1.5 h over the configured cap, and drives two different vehicles on 2025-07-15 while multiple_vehicles_per_day_violations stays 0 because block A is keyed to 07-14. The plan therefore passes Phase 3 status 'Validierung OK', applies, and the Stundennachweis for 2025-07-15 shows an over-limit day that no check ever flagged.

**Recommendation**

Split a block's duration across the local calendar days it actually spans when accumulating daily_minutes (and when building the one_vehicle_per_day day map): derive per-day minutes from blockStartMs/blockEndMs against local midnight boundaries instead of booking `duration_minutes` wholesale under `service_date`. Apply the same split in reAddBlockToState/uncommitFromState so repair and undo stay balanced.

---

### 41. A driver with a configured salary range but no planning_hourly_rate is scored as brutto 0 forever, pinning them at the maximum priority 1_000_000 for every block in the month

- **Severity** medium · **Category** `assignment-fairness` · **Verifier votes** 1
- **Location** `src/utils/monatsplanungPhase3.ts:1229`

**Evidence**

```
// line 1229-1233 — no rate => 0, not null
  const bruttoEstimator = (state: DriverPlanState): number => {
    const hourlyRate = state.driver.planning_hourly_rate;
    if (hourlyRate == null || hourlyRate <= 0) return 0;
    return (state.monthly_minutes / 60) * hourlyRate;
  };

// line 669-683 — 0 is treated as a real brutto, so gapFraction saturates at 1
  const currentBrutto = expectedBruttoFn ? expectedBruttoFn(state) : null;
  if (minSal != null && maxSal != null && currentBrutto != null) {
    if (currentBrutto < minSal) {
      const gap = minSal - currentBrutto;
      const gapFraction = Math.min(1, gap / Math.max(minSal, 1));
      const blockContrib = expectedBruttoFn
        ? expectedBruttoFn({ ...state, monthly_minutes: state.monthly_minutes + block.duration_minutes }) - currentBrutto
        : 0;
      const projectedBrutto = currentBrutto + blockContrib;
      const overshootPenalty = projectedBrutto > maxSal ? (projectedBrutto - maxSal) * 500 : 0;
      salaryScore = Math.round(600_000 + gapFraction * 400_000) - overshootPenalty;
```

**Failure scenario**

Driver F has planning_target_salary = 2000 (which src/components/MonatsplanungDriverPool.tsx:75-82 copies into planning_min_salary and planning_max_salary) and planning_hourly_rate = null — a reachable state because driverMissing() at MonatsplanungDriverPool.tsx:118-123 does not list planning_hourly_rate as a required field. For every block: currentBrutto = 0, gapFraction = min(1, 2000/2000) = 1, blockContrib = 0, overshootPenalty = 0, so salaryScore = 1_000_000 constant — it never decays as F accumulates hours, because the estimator ignores monthly_minutes when the rate is null. F therefore outscores every colleague with a real rate (whose score drops below 1_000_000 after their first block) and outscores the Inhaber band, and takes every block they are eligible for until their daily/monthly caps saturate. The month's hours pile onto one driver, colleagues stay below their Mindestgehalt, and the resulting Brutto distribution will not reconcile with the Steuerberater's figures. The final summary hides the symptom: line 1720 counts drivers_below_min only `if (minSal != null && maxSal != null && brutto > 0)`, so F is silently excluded from the very counter that would show the imbalance.

**Recommendation**

Have bruttoEstimator return `null` (not 0) when planning_hourly_rate is missing so scoreDriver falls into the hour-based branch at line 702-707, and add planning_hourly_rate to driverMissing() in MonatsplanungDriverPool.tsx so the pool warns before Phase 3 runs.

---

### 42. vehicle_switch_buffer_minutes is sent in the apply payload but never persisted, so the finalization 'Fahrzeugwechsel zu kurz' gate always uses the hardcoded 30-minute default

- **Severity** medium · **Category** `settings-loss` · **Verifier votes** 1
- **Location** `supabase/migrations/20260612073535_add_monatslimit_exception_to_planning.sql:90`

**Evidence**

```
-- apply_monthly_planning_run builds settings_json from ONE key only:
    jsonb_build_object(
      'block_separator_minutes', (p_payload->>'block_separator_minutes')::int
    ),

-- but the client sends the buffer (src/components/MonatsplanungAssignmentPreview.tsx:596-598):
        one_vehicle_per_driver_day: oneVehiclePerDriverDay,
        vehicle_switch_buffer_minutes: vehicleSwitchBufferMinutes,
        vehicle_blocks_count: blocks.length,

-- and finalization reads it back out of settings_json (src/components/FinalizePlanningModal.tsx:203-209):
      // Falls back to the default if not stored (older runs).
      const settingsJson = run.settings_json ?? {};
      const storedBuffer = settingsJson['vehicle_switch_buffer_minutes'];
      const MIN_CAR_SWITCH_GAP_MINUTES: number =
        (typeof storedBuffer === 'number' && storedBuffer >= 0)
          ? storedBuffer
          : DEFAULT_CAR_SWITCH_GAP_MINUTES;   // src/components/FinalizePlanningModal.tsx:47 => 30
```

**Failure scenario**

The planner exposes a free 0-240 minute buffer input (src/pages/CompanyPlannerPage.tsx:568-577). A depot where drivers swap cars in the same yard sets 'Fahrzeugwechsel-Puffer' to 10. Phase 3 (assignBlocksPhase3, called with vehicleSwitchBufferMinutes at MonatsplanungAssignmentPreview.tsx:520) and the Phase-4 quality gate (MonatsplanungAssignmentPreview.tsx:336, 384) both accept a 12-minute vehicle switch, so 'Plan anwenden' unlocks and the apply RPC succeeds. Because settings_json never receives the key, FinalizePlanningModal falls through to 30 and reports 'Fahrzeugwechsel zu kurz' for that same switch. Finalization has no override (CLAUDE.md: 'There is no override'), so the month can never be finalized and no statutory document can ever be produced for it - the operator's only escape is to re-plan at >=30, silently discarding their configured policy. The comment 'Falls back to the default if not stored (older runs)' shows the read side expected a stored value that no run has ever written. min_block_duration_minutes, max_block_duration_minutes and one_vehicle_per_driver_day are dropped by the same jsonb_build_object, so no applied run is reproducible from its stored settings.

**Recommendation**

Add the missing keys to settings_json in both apply_monthly_planning_run and replace_monthly_planning_run (vehicle_switch_buffer_minutes, min_block_duration_minutes, max_block_duration_minutes, one_vehicle_per_driver_day), or simply store `p_payload` minus change_rows/manual_exceptions. Until settings are guaranteed, FinalizePlanningModal should surface which buffer it used rather than silently defaulting.

---

### 43. replace_monthly_planning_run never checks the old run's status and takes no lock, so two replaces of the same old run leave two 'applied' runs, one with zero trips linked

- **Severity** medium · **Category** `concurrent-replace` · **Verifier votes** 1
- **Location** `supabase/migrations/20260612073535_add_monatslimit_exception_to_planning.sql:245`

**Evidence**

```
SELECT id, company_id, import_id, month, year, status, applied_at
  INTO v_old
  FROM company_planning_runs
  WHERE id = p_old_run_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'replace_monthly_planning_run: old run not found';
  END IF;
  IF v_old.company_id <> v_company THEN ... END IF;
  IF v_old.import_id <> v_import_id OR v_old.month <> v_month OR v_old.year <> v_year THEN ... END IF;

  UPDATE company_planning_runs
  SET status = 'replaced', updated_at = v_now
  WHERE id = p_old_run_id;

  UPDATE fahrtenbuch_trips
  SET assignment_planning_run_id = NULL, updated_at = v_now
  WHERE company_id = v_company
    AND import_id = v_import_id
    AND assignment_planning_run_id = p_old_run_id;

-- v_old.status is selected into the record and then never tested; no FOR UPDATE, no advisory lock,
-- and no re-check that p_old_run_id is still the newest applied run for the period.
```

**Failure scenario**

Two admins of the same company (or one admin in two tabs) both open the planner for 03/2026, both click 'Plan anwenden', both get the already_applied response naming run X (handleApply -> applyResult.planning_run_id, MonatsplanungAssignmentPreview.tsx:637), and both click 'Bestehende Planung ersetzen' (MonatsplanungAssignmentPreview.tsx:774-780), which passes that same stale X as p_old_run_id (line 697). Transaction 1: marks X 'replaced', detaches its N trips, inserts run Y with status='applied', relinks all N trips to Y, writes apply_summary_json.updated_trips = N. Transaction 2 then runs: X still exists and its company/import/month/year still match, and its status is not examined, so it proceeds - the detach UPDATE now matches 0 rows (the trips point at Y), and it inserts run Z with status='applied' and relinks all N trips to Z. Result: Y and Z are both status='applied' with applied_at set for 03/2026, so MonatsplanungAppliedRuns.tsx:147 lists both as 'Aktiv'. Y's stored apply_summary_json claims updated_trips = N, but zero trips carry assignment_planning_run_id = Y, so opening Y's Stundennachweis yields 'Keine zugewiesenen Fahrten' (MonatsplanungStundennachweisPreview.tsx:1366-1373) while the run still advertises N applied trips. Nothing rolls this back and nothing in the UI says which of the two 'Aktiv' plans is real.

**Recommendation**

Reject the replace when `v_old.status <> 'applied'` (and when a newer applied run for the same company/month/year already exists), and take `SELECT ... FROM company_planning_runs WHERE id = p_old_run_id FOR UPDATE` plus a per-company/month advisory lock at the top of both RPCs so the check-then-insert cannot interleave.

---

### 44. Applied-run deletion bypasses the purpose-built archive RPC and cascade-destroys the manual-exception and finalization audit trail

- **Severity** medium · **Category** `audit-data-loss` · **Verifier votes** 1
- **Location** `src/components/MonatsplanungAppliedRuns.tsx:225`

**Evidence**

```
const { error } = await supabase
        .from('company_planning_runs')
        .delete()
        .eq('id', deleteTarget.id)
        .eq('company_id', companyId);

-- while supabase/migrations/20260612060122_add_replace_and_archive_planning_run_rpcs.sql:211-250 defines
-- exactly the guard this bypasses, and grep shows it is called from nowhere in src/:
CREATE OR REPLACE FUNCTION public.delete_or_archive_monthly_planning_run(p_run_id uuid)
...
  IF v_ref_cnt > 0 THEN
    UPDATE company_planning_runs SET status = 'archived', updated_at = v_now WHERE id = p_run_id;
    RETURN jsonb_build_object('action', 'archived', 'referenced_trips', v_ref_cnt);
  END IF;

-- the FKs that make the raw DELETE destructive:
-- 20260612034932:19  planning_run_id uuid NOT NULL REFERENCES company_planning_runs(id) ON DELETE CASCADE
-- 20260616120915:11  planning_run_id uuid NOT NULL REFERENCES company_planning_runs(id) ON DELETE CASCADE
-- 20260612034932:9   assignment_planning_run_id uuid REFERENCES company_planning_runs(id) ON DELETE SET NULL
```

**Failure scenario**

An operator uses the 'Monatsplanung endgültig löschen' action on a finalized 03/2026 run to clean up the list. The raw DELETE succeeds (the archive RPC that would have downgraded it to status='archived' because trips still reference it is never invoked). Postgres then cascades: every monthly_planning_manual_exceptions row for that run - the statutory justification for each Dienstzeit-/Tageslimit-/Monatslimit-Ausnahme, with its confirmed_by and confirmed_at - is deleted, and the planning_finalizations row recording who finalized the month and the driver_summary_json snapshot is deleted with it. Meanwhile the ~N fahrtenbuch_trips rows only get assignment_planning_run_id set to NULL and keep assigned_driver_id, assigned_driver_name, assignment_block_id, assignment_reason and plausibility_status='planned_reassignment'. Because fahrtenbuch_trips has no UPDATE RLS policy at all (CLAUDE.md) those orphan values cannot be read back or cleared by any code path, and the documents already handed to the Steuerberater now have no record in the system of why any override was granted. There is no confirmation text warning that anything outside the run row is affected.

**Recommendation**

Call `supabase.rpc('delete_or_archive_monthly_planning_run', { p_run_id })` instead of the direct .delete(), render its `action` ('archived' vs 'deleted') back to the user, and refuse deletion outright when a planning_finalizations row exists. The RPC should additionally clear assigned_driver_*/assignment_block_id/assignment_reason on any trip it orphans, or explicitly refuse.

---

### 45. CandidateWindow.vehicleFree is evaluated at the window start but the block is placed later inside the window, so the block-level vehicle guard checks the wrong interval

- **Severity** medium · **Category** `overlap-detection` · **Verifier votes** 1
- **Location** `src/components/HistoricalWorkingHoursWizard.tsx:2664`

**Evidence**

```
// runInhaberFreeWindowSearch, line 2663-2666 — flag computed for [w.startMs, w.startMs + dur]
        const slotEnd = w.startMs + dur * 1000;
        const vehicleFree = !vIntervals.some(vi => vi.start < slotEnd && vi.end > w.startMs);

// Section D, line 3113-3117 — but the block is actually placed at cw.startMs + pufferVorMs
        const pufferVorMs        = availableSlackMs > 0 ? availableSlackMs - targetPufferNachMs : 0;
        const proposedStart      = cw.startMs + pufferVorMs;
        const proposedEnd        = proposedStart + blockDurMs;
        ...
        if (!cw.vehicleFree) continue;

// Section E, line 3338-3342 — the validation re-reads the same stale flag
    for (const sp of selected) {
      if (!sp.chosen.cw.vehicleFree) {
        vehicleExistingConflicts.push(`${sp.block.vehicle}: …${sp.block.blockId.slice(-6)}`);
```

**Failure scenario**

Free window FW = 06:00-18:00 on vehicle B-XY-123, owner block duration 4 h. availableSlack = 8 h, targetPufferNach = max(1h, 4h) = 4 h, pufferVor = 4 h, so proposedStart = 10:00 and proposedEnd = 14:00. vehicleFree was computed for [06:00, 10:00], which is genuinely free, so the flag is true — even though a regular driver's block occupies B-XY-123 from 10:00 to 14:00, exactly where the owner block lands. Section D accepts the candidate (`if (!cw.vehicleFree) continue` passes) and Section E's vehicleExistingConflicts reports zero. The only remaining defence is the ride-level check, which is disabled by the parser defect above; with both failing, the owner block is exported on a vehicle another driver is driving.

**Recommendation**

Compute vehicle availability against the actual placement interval [proposedStart, proposedEnd] inside the Section D scoring loop instead of carrying a flag computed at cw.startMs, and have Section E re-verify against that interval rather than re-reading chosen.cw.vehicleFree.

---

### 46. Buß- und Bettag resolves to 23 November itself whenever 23 November is a Wednesday, shifting the holiday by seven days

- **Severity** medium · **Category** `holiday-calendar` · **Verifier votes** 1
- **Location** `src/utils/germanHolidays.ts:133`

**Evidence**

```
src/utils/germanHolidays.ts:130-135:
  if (bl === 'SN' || bl === 'TH') {
    // Buß- und Bettag — Wednesday before 23 November
    const nov23 = new Date(Date.UTC(year, 10, 23));
    const bbt = new Date(nov23.getTime() - ((nov23.getUTCDay() + 4) % 7) * 86400000);
    set.add(utcDateStr(bbt));
  }

When 23 November is itself a Wednesday, getUTCDay() === 3 and (3 + 4) % 7 === 0, so zero days are subtracted and the function returns 23 November. Executing the same expression for 2016-2035 yields 2022-11-23 and 2033-11-23; the statutory dates are 2022-11-16 and 2033-11-16 (the last Wednesday strictly before 23 November). All other years are correct.

The same block also applies the holiday to 'TH'; Buß- und Bettag is a public holiday only in Sachsen.
```

**Failure scenario**

A Saxon operator generating the November 2022 Stundennachweis gets no Feiertag hours for 16.11.2022 (drivers lose the 125% tax-free surcharge for that day) and Feiertag hours wrongly reported for 23.11.2022 (a surcharge claimed for an ordinary working Wednesday). isPublicHoliday feeds MonatsplanungStundennachweisPreview.tsx:845/1106, so both the exported PDF's Feiertag column and the Feiertagszuschlag in expected_brutto are wrong for two days that month. Thuringian operators get a Feiertag premium on a day that is not a holiday there at all, every year.

**Recommendation**

Subtract a full week when the modulo is zero, e.g. `const back = ((nov23.getUTCDay() + 4) % 7) || 7;` so the result is always strictly before 23 November, and drop 'TH' from the condition (Buß- und Bettag is SN-only). While in this function, note that Reformationstag (31 October) is missing for BB, MV, SN, ST, TH, HB, HH, NI and SH.

---

### 47. Payroll split adds Bankgehalt on top of a Bargehalt that already equals the whole salary when "Brutto in Lohnabrechnung" is left blank, overstating the driver's payout by the full net amount in the exported PDF and image

- **Severity** medium · **Category** `payroll-split-math` · **Verifier votes** 1
- **Location** `src/components/SalaryDetailsModal.tsx:57`

**Evidence**

```
src/components/SalaryDetailsModal.tsx:55-61
  const payrollGross = payrollData.payroll_gross_amount ?? 0;
  const payrollNet   = payrollData.payroll_net_amount ?? 0;
  const cashSalary   = calculatedSalaryTotal - payrollGross;
  const bankSalary   = payrollNet;
  const totalNetPayout = cashSalary + bankSalary;

  const hasPayrollData = payrollData.payroll_gross_amount != null || payrollData.payroll_net_amount != null;

src/components/SalaryDetailsModal.tsx:487-489 (props handed to the exported card)
                brutto={payrollData.payroll_gross_amount}
                nettoBank={payrollData.payroll_net_amount}
                cashSalary={hasPayrollData ? cashSalary : null}

src/utils/driverSalaryPdf.ts:142-147 (the signed PDF)
  if (hasPayroll) {
    const gross = payrollGrossAmount ?? 0;
    const net   = payrollNetAmount ?? 0;
    const cash  = cashSalaryAmount ?? (calculatedSalaryTotal - gross);
    const bank  = bankSalaryAmount ?? net;
    const total = totalNetPayout ?? (cash + bank);

src/components/DriverSalarySummaryCard.tsx:193-201
  const hasPayroll = brutto != null && brutto > 0;
  ...
  const totalNetPayout = nettoBankVal + cashVal;
  // Restgehalt = Gesamt Netto Auszahlung - Bereits gezahltes Gehalt
  const restgehalt = totalNetPayout - alreadyPaidSalary;
```

**Failure scenario**

Driver's calculated salary is 3.000,00 EUR. In "Lohnabrechnung & Auszahlung" the admin fills only "Netto laut Lohnabrechnung / Bankgehalt" = 1.400,00 EUR and leaves "Brutto in Lohnabrechnung" empty (a natural order of entry, since the Brutto often arrives later from the Steuerberater). payrollGross falls back to 0, so cashSalary = 3000 - 0 = 3000, bankSalary = 1400, totalNetPayout = 4400. hasPayrollData is true (net is non-null), so cashSalary=3000 is passed on. driverSalaryPdf.ts:142 gates on `payrollGrossAmount != null || payrollNetAmount != null`, so the PDF prints "Bargehalt 3.000,00 EUR / Bankgehalt 1.400,00 EUR / Gesamt Netto Auszahlung 4.400,00 EUR" directly under "Berechnetes Fahrer-Gehalt 3.000,00 EUR", with signature lines at the bottom. DriverSalarySummaryCard shows "Restgehalt 4.400,00 EUR" (it renders restgehalt unconditionally even though hasPayroll is false and it suppresses the "Gesamt Netto Auszahlung" row). Meanwhile the same modal's Details tab shows "Restbetrag 3.000,00 EUR" (line 67). The driver is handed a signed document claiming 1.400,00 EUR more than he is owed. Even with Brutto correctly filled (2.000), the two tabs still disagree by gross-minus-net: Details says 3.000 - paid, Summary/PDF say (3000-2000)+1400 = 2.400 - paid.

**Recommendation**

Make the split a single validated decomposition of one total: require Brutto before any split is displayed or exported (mirror the card's `brutto != null && brutto > 0` gate in SalaryDetailsModal.hasPayrollData and in driverSalaryPdf.hasPayroll), and derive Bargehalt as `calculatedSalaryTotal - bankSalary` (net basis) rather than `- payrollGross` (gross basis) so that Bargehalt + Bankgehalt always reconciles to calculatedSalaryTotal. Suppress "Restgehalt" on the card whenever `hasPayroll` is false, and assert `Math.abs(cash + bank - calculatedSalaryTotal) < 0.01` before allowing PDF/PNG export.

---

### 48. WerkstattPage fetches checks with a stale `weeks` array, so the list is empty on load and shows the previous month after navigating

- **Severity** medium · **Category** `stale-state` · **Verifier votes** 1
- **Location** `src/pages/WerkstattPage.tsx:51`

**Evidence**

```
useEffect(() => {
    const weeksOfMonth = getWeeksOfMonth(selectedMonth);
    setWeeks(weeksOfMonth);
    const today = new Date();
    if (today.getMonth() === selectedMonth.getMonth() && today.getFullYear() === selectedMonth.getFullYear()) {
      setSelectedWeek(getWeekNumberForDate(today));
    } else {
      setSelectedWeek(1);
    }
  }, [selectedMonth]);

  useEffect(() => { loadChecks(); }, [selectedMonth, selectedWeek]);
...
  const loadChecks = async () => {
    try {
      setLoading(true);
      const weekData = weeks.find(w => w.weekNumber === selectedWeek);
      if (!weekData) { setChecks([]); return; }
```

**Failure scenario**

`loadChecks` closes over the `weeks` state but `weeks` is not in the effect's dependency array, and `weeks` is filled by a *different* effect that runs in the same commit. On mount `weeks` is `[]`, so `weekData` is undefined and the page renders "keine Checks". The first effect then sets weeks and calls `setSelectedWeek(getWeekNumberForDate(today))`; whenever that value equals the initial state `1`, React bails out on that setter and the deps `[selectedMonth, selectedWeek]` are unchanged, so `loadChecks` is never re-run — the page permanently shows zero Werkstatt-Checks until the user manually touches a control. Today (08.09.2026, Monday of the week = 07.09, week 1 of September) is exactly such a day. The same stale-closure hits month navigation: with week 1 selected in September, clicking "next month" re-runs `loadChecks` (selectedMonth changed) while `weeks` is still September's, so the query uses `.gte('check_date','2026-09-07').lte('check_date','2026-09-13')` and September's checks are displayed under the "Oktober 2026" header; because selectedWeek stays 1, no corrected fetch follows.

**Recommendation**

Derive the active week range instead of storing it: compute `const weeks = useMemo(() => getWeeksOfMonth(selectedMonth), [selectedMonth])` and add `weeks` to the fetching effect's dependency array (or pass the resolved `weekData` into `loadChecks` as an argument), so the query can never run against a previous month's range.

---

### 49. NotesPage week filter matches only the 1..5 week index and the calendar year, so it shows and exports notes from other months

- **Severity** medium · **Category** `business-week-filter` · **Verifier votes** 1
- **Location** `src/pages/NotesPage.tsx:408`

**Evidence**

```
} else if (filterMode === 'week') {
      const noteWeek = getWeekNumberForDate(new Date(note.note_date));
      const noteYear = new Date(note.note_date).getFullYear();
      matchesDate = noteWeek === selectedWeek && noteYear === selectedMonth.getFullYear();
    } else if (filterMode === 'month') {
      const noteMonth = new Date(note.note_date).getMonth();
      const noteYear  = new Date(note.note_date).getFullYear();
      matchesDate = noteMonth === selectedMonth.getMonth() && noteYear === selectedMonth.getFullYear();
```

**Failure scenario**

`getWeekNumberForDate` returns the ordinal of the week inside *its own* business month (1..5), so "Woche 2" exists in every month. The predicate never compares the month. Select März 2026 and "Woche 2 (09.03 - 15.03)": a note dated 12.01.2026 (week 2 of January) and one dated 09.02.2026 (week 2 of February) both satisfy `noteWeek===2 && noteYear===2026` and are listed under the March week — and are written into the XLSX, since `handleExportXlsx` exports `filteredNotes` verbatim (line 307). The converse also fails at the year boundary: a note dated 01.01.2026 belongs to the business week whose Monday is 29.12.2025 (business month Dezember 2025, week 5), but `noteYear` is the *calendar* year 2026 while `selectedMonth.getFullYear()` is 2025, so while viewing Dezember 2025 / Woche 5 that note is hidden. The two branches are also inconsistent with each other: `filterMode==='month'` uses the calendar month while `filterMode==='week'` uses business weeks, so the union of the week options does not equal the month view.

**Recommendation**

Compare full week identity rather than an index: `const noteMonday = getWeekMonday(parseISO(note.note_date))` and match it against `weeks.find(w => w.weekNumber === selectedWeek).firstDay` by `getTime()`. For the month branch, use `isDateInBusinessMonth(...)` so the month filter and the week filter agree on the same business calendar.

---

### 50. Fahrtenbuch export writes Excel date/time serials as unformatted numbers, so dates and times appear as 45717 / 0,3451 in the delivered sheet

- **Severity** medium · **Category** `number-format-loss` · **Verifier votes** 1
- **Location** `src/utils/fahrtenbuchExport.ts:142`

**Evidence**

```
src/components/FahrtenbuchImportModal.tsx:429-430
        // raw: true → keep numeric values (dates as serials, times as fractions)
        const wb = XLSX.read(data, { type: 'array', raw: true, cellDates: false });
...
        const json: RawRow[] = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true, range: headerRowIdx });
src/components/FahrtenbuchImportModal.tsx:675-677 (stored verbatim)
          raw_data_json:        Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, v ?? null])
          ),

src/utils/fahrtenbuchExport.ts:140-153
  const rows = ordered.map(trip => {
    const raw = (trip.raw_data_json ?? {}) as Record<string, unknown>;
    return columns.map(col => {
      if (col === driverCol) { ... }
      const val = raw[col];
      if (val === null || val === undefined) return '';
      return val;
    });
  });
  const data = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(data);

src/utils/monatsplanungXlsxExport.ts:183-187 + 288-297 (same defect on the finalization export)
function cellValue(v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return String(v);
}
...
    const row: (string | number | boolean | null)[] = headers.map(h => cellValue(raw[h]));
```

**Failure scenario**

A Fahrtenbuch XLSX whose 'Datum der Fahrt' / 'Uhrzeit des Fahrtbeginns' cells are real Excel date-time cells (the case the importer explicitly targets: `raw:true, cellDates:false` keeps them as serial 45717 and fraction 0.3451388…). Those raw numbers are persisted in `raw_data_json` and handed back to `aoa_to_sheet`, which emits `{t:'n', v:45717}` with no `z` number format. The exported 'corrected Fahrtenbuch' — the document that goes to the Steuerberater and to German authorities — shows `45717` and `0,345138888888889` in every date and time column instead of `01.03.2025` and `08:17`, while the original file showed formatted dates. Neither exporter carries the source cell's numFmt, and the header-equality guard in exportAppliedRunXlsx (line 396-406) only compares headers, so nothing blocks the download.

**Recommendation**

Persist the source cell's number format (or at minimum the column-level numFmt from the original sheet) at import time and re-apply it as `ws[addr].z` after `aoa_to_sheet`, or store both the raw value and the formatted string `w` and emit typed cells. The monatsplanung path already loads the original file metadata via `fahrtenbuch_imports`; the 1:1 byte-patch approach (patch only the Fahrername cell in the original XLSX) avoids the problem entirely.

---

### 51. Trip pagination for the export orders by a non-unique key across separate range() queries, so rows can be duplicated or dropped past 1000 trips

- **Severity** medium · **Category** `data-loss` · **Verifier votes** 1
- **Location** `src/hooks/useFahrtenbuch.ts:139`

**Evidence**

```
src/hooks/useFahrtenbuch.ts:91-104
async function fetchAllRows<T>(buildQuery: (from: number, to: number) => ...): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await buildQuery(offset, offset + BATCH_SIZE - 1);
    ...
    if (rows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return all;
}

src/hooks/useFahrtenbuch.ts:139-155
      const result = await fetchAllRows<FahrtenbuchTrip>((from, to) => {
        let q = supabase
          .from('fahrtenbuch_trips')
          .select('*')
          .eq('company_id', companyId)
          .order('trip_date', { ascending: true })
          .order('start_time', { ascending: true, nullsFirst: false })
          .range(from, to);
        if (importId) q = q.eq('import_id', importId);
        return q;
      });

(compare src/utils/monatsplanungXlsxExport.ts:94-97, which does add the unique `source_row_index` as the leading sort key)
```

**Failure scenario**

A month with more than 1000 rides — normal for a multi-vehicle taxi fleet — is fetched as several independent LIMIT/OFFSET queries. The sort key `(trip_date, start_time)` is not unique: several vehicles routinely start a ride in the same minute on the same day, and PostgreSQL's sort is not stable, so ties may be ordered differently between the query that returns rows 0-999 and the query that returns rows 1000-1999. A tied row sitting on the page boundary is then returned twice or not at all. The resulting array is fed straight into `exportFahrtenbuch` from FahrtenbuchTripsView.tsx:191-199, producing a statutory Fahrtenbuch with a duplicated ride and a missing ride — and the corresponding revenue counted twice / not at all in the totals shown above the table (FahrtenbuchTripsView.tsx:120-124).

**Recommendation**

Append the unique `source_row_index` (and `id`) as final ORDER BY keys so the sort is a total order, exactly as `fetchAllTrips` in monatsplanungXlsxExport.ts:94-96 does, or switch to keyset pagination on `(trip_date, start_time, id)`.

---

### 52. Finalized PDF ignores the 30-minute minimum shift duration that the Preview and archived PDFs apply, so the same driver-month yields two different Grundlohn totals

- **Severity** medium · **Category** `payroll-math` · **Verifier votes** 1
- **Location** `src/components/FinalizePlanningModal.tsx:588`

**Evidence**

```
FinalizePlanningModal pays the raw span:
588:            duration_minutes: Math.floor((span.eMs - span.sMs) / 60000),

MonatsplanungStundennachweisPreview floors every block at 30 minutes and pays that:
183:const MIN_STUNDENNACHWEIS_SHIFT_MINUTES = 30;
361:      const paidDurationMinutes = Math.max(actualDurationMinutes, MIN_STUNDENNACHWEIS_SHIFT_MINUTES);
362:      const paidEndMs = span.startMs + paidDurationMinutes * 60000;
377:        paid_duration_minutes: paidDurationMinutes,

and it is paid_duration_minutes / paid_end_ms that buildPdfRows and handleSaveStundennachweise use (lines 662, 1694). Both PDFs are produced from the same trips, carry the same title 'Stundennachweis', and are offered to the user in the same workflow (FinalizePlanningModal.tsx:848, MonatsplanungStundennachweisPreview.tsx:914/1648).
```

**Failure scenario**

Driver Z has 20 short standalone blocks in a month (single trips of 8-15 minutes each, e.g. airport shuttles). The Preview PDF and the archived record in saved_stundennachweise pay 20 x 30 = 600 minutes for them; the finalized PDF downloaded from FinalizePlanningModal pays roughly 20 x 11 = 220 minutes. The two Stundennachweise for the same driver and month differ by about 6,3 h of Grundlohn. Whichever document the Steuerberater receives determines the payroll figure, and the app gives no indication that the other one exists or disagrees.

**Recommendation**

Apply MIN_STUNDENNACHWEIS_SHIFT_MINUTES in FinalizePlanningModal's finBlock construction (or, preferably, export a single shared block-builder + buildPdfRows used by both screens) so that exactly one definition of paid minutes exists. Until then, at minimum have the finalization pre-flight compare its own per-driver totals against the preview's and fail the gate on any mismatch.

---

### 53. useDatabase falls into a permanent phantom "offline" mode where writes are silently discarded and confirmed as successful

- **Severity** medium · **Category** `silent-data-loss` · **Verifier votes** 1
- **Location** `src/hooks/useDatabase.ts:171`

**Evidence**

```
// useDatabase.ts:25-40,68-76 — any probe error/timeout latches isConnected=false forever
  const { data, error } = await withTimeout(supabase.from('receipts').select('id').limit(1), 5000);
  ...
  } catch (error) { ... setIsConnected(false); }

// useDatabase.ts:171-175 — write path when "not connected": returns a fake row, persists NOTHING
  const addDriver = async (name, salaryRatio = 0.5, personalnummer?, gender?, planning?): Promise<Driver> => {
    if (!isConnected) {
      const newDriver: Driver = { id: Date.now().toString(), name, salary_ratio: salaryRatio, personalnummer, gender: gender ?? null };
      return newDriver;
    }

// useDatabase.ts:245-249 / 341-346 / 396-400 / 426-430 — delete/update/addReceipt are no-ops in the same mode
  const deleteDriver = async (id: string): Promise<void> => { if (!isConnected) { return; } ... }
  const addReceipt = async (receipt) => { if (!isConnected) { const newReceipt = {...receipt, id: Date.now().toString()}; return newReceipt; } ... }

// src/pages/FahrerPage.tsx:70-79 — caller reports success because nothing threw
  await driverActions.delete(id);
  await loadData();
  success('Fahrer gelöscht', 'Der Fahrer wurde erfolgreich entfernt');
```

**Failure scenario**

On a slow mobile connection the 5-second withTimeout on the mount probe (`supabase.from('receipts').select('id').limit(1)`) rejects, so isConnected stays false; `reconnect` is exported but called by nothing in src/, so the flag never recovers without a full page reload. From that point on: BelegePage and FahrerPage show an empty list (getDrivers/getReceipts read localStorage keys 'drivers'/'receipts' that no code in the repo ever writes, so they always return []), the operator re-enters a Beleg, `addReceipt` returns a fake `{id: Date.now()}` object without touching Supabase, the modal closes normally, and deleting shows the green toast "Beleg gelöscht — Der Beleg wurde erfolgreich entfernt" while the row is still in the database. The receipt is gone (never persisted), the delete never happened, and the operator has explicit UI confirmation of the opposite. The same figures later feed Abrechnung/Tankenquote.

**Recommendation**

Remove the localStorage fallback entirely. On a connection failure, surface a hard error state and make every write path throw (never return a synthetic row or silently return void) so the calling page's catch/showError branch runs instead of its success toast. If an offline mode is genuinely wanted, it must queue writes and mark them as unsynced — never report success for a write that was dropped.

---

### 54. Finalization pre-flight loads trips with .range() pagination and no ORDER BY, so the statutory gate runs on a non-deterministic row set

- **Severity** medium · **Category** `pagination-correctness` · **Verifier votes** 1
- **Location** `src/components/FinalizePlanningModal.tsx:248`

**Evidence**

```
let offset = 0;
      while (true) {
        const { data, error: tErr } = await supabase
          .from('fahrtenbuch_trips')
          .select('id, trip_date, start_time, end_time, assigned_driver_id, assigned_driver_name, assignment_block_id, car_identifier, is_canceled, raw_data_json')
          .eq('company_id', companyId)
          .eq('assignment_planning_run_id', run.id)
          .range(offset, offset + BATCH - 1);
        if (tErr) throw new Error(...);
        allTrips.push(...(data ?? []));
        if ((data?.length ?? 0) < BATCH) break;
        offset += BATCH;
      }

// the very next checks assume the assembled set is exactly the DB set:
      results.push({ label: 'Fahrten-Anzahl', ok: expectedCount === null || nonCanceled.length === expectedCount, ... });   // :266-272
      for (const t of allTrips) { if (idSet.has(t.id)) dups.push(t.id); idSet.add(t.id); }                                   // :277-280
      results.push({ label: 'Keine doppelten Trip-IDs', ok: dups.length === 0, detail: `${dups.length} Duplikate` });        // :281-285
```

**Failure scenario**

A month with more than 1000 assigned trips (normal for a fleet) needs 2+ round trips. Each `.range()` call is an independent SELECT with LIMIT/OFFSET and no ORDER BY, so PostgreSQL gives no stable row order between them (plan flips between index scan and bitmap heap scan as OFFSET grows, and synchronize_seqscans starts sequential scans at varying positions). A row returned in both pages makes the "Keine doppelten Trip-IDs" check report duplicates and blocks finalization permanently — CLAUDE.md documents there is no override, so the operator cannot produce the Stundennachweise at all for a database that is perfectly fine. A row skipped instead makes `nonCanceled.length` fall short of apply_summary_json.updated_trips ("Fahrten-Anzahl" fails), or, when one page repeats a row and drops another, the counts cancel out and checks 5-9 (missing driver, missing block, max-3-Schichten, Fahrzeugwechsel) silently run over a trip set that contains a phantom duplicate and is missing a real shift.

**Recommendation**

Add a deterministic total ordering to the paginated query, e.g. `.order('id', { ascending: true })` as the final sort key (the sibling loops in MonatsplanungStundennachweisPreview.tsx:1332, CompanyPlannerPage.tsx:63 and HistoricalWorkingHoursWizard.tsx:280 order only by trip_date/start_time, which is also non-unique and needs the same tiebreaker). Better still, fetch with a keyset cursor on `id` rather than OFFSET.

---

### 55. Driver-note fetch swallows its error, leaving the exclude_from_plan map empty — the hard note_constraint and the apply gate both fail open

- **Severity** medium · **Category** `fail-open-fetch` · **Verifier votes** 1
- **Location** `src/components/MonatsplanungAssignmentPreview.tsx:162`

**Evidence**

```
const [driverNotesMap, setDriverNotesMap] = useState<Map<string, StructuredNote[]>>(new Map());
  useEffect(() => {
    if (!companyId) return;
    ...
    supabase
      .from('driver_notes')
      .select('id, driver_id, note_type, note_text, note_planning_behavior, is_full_day, start_date, end_date, note_date, start_time, end_time')
      .eq('company_id', companyId)
      .eq('note_planning_behavior', 'exclude_from_plan')
      .or(`start_date.lte.${lastDay},end_date.gte.${firstDay},note_date.gte.${firstDay}`)
      .then(({ data }) => {                       // <- error is destructured away, no .catch, no error state
        const map = new Map<string, StructuredNote[]>();
        for (const note of (data ?? [])) { ... }
        setDriverNotesMap(map);
      });
  }, [companyId, month, year]);

// the same map is the ONLY source for the hard constraint and for the apply gate:
  const r = assignBlocksPhase3(blocks, selectedDrivers, { ..., driverNotesMap, ... });   // :520
  const hasNoteViolations = sectionENoteViolations.length > 0;                            // :2134
  const canApply = phase3Ok && phase4Ok && !hasOpen && !hasViolations && !hasQualityBlockers && !hasNoteViolations && ...;  // :2135
```

**Failure scenario**

The driver_notes SELECT fails once (network blip, RLS denial, a bad `.or()` filter string) — `data` is null, `error` is discarded, and driverNotesMap stays an empty Map with no spinner, warning or retry. `assignBlocksPhase3` then receives an empty map, so `checkStructuredNote` (monatsplanungPhase3.ts:526-527, `if (!notes || notes.length === 0) return null`) never fires the hard `note_constraint`, and a driver who has a Krank/Urlaub note for 15.07. is assigned that day's vehicle blocks. Because Section E's gate reads the same empty map, `hasNoteViolations` is false, the UI paints the green "Fahrer-Notizen OK" badge at line 2561-2573, "Plan anwenden" enables, and the run is committed and exported into the Stundennachweis showing a sick driver as having worked. The failure is indistinguishable from "this company has no exclusion notes".

**Recommendation**

Capture `{ data, error }`, keep a `notesLoaded`/`notesError` state, and treat "notes not loaded" as a blocking condition in `canApply` (and refuse to run Phase 3) rather than as "no notes". A compliance constraint must fail closed.

---

### 56. Buß- und Bettag is computed on two different dates by the two live holiday tables; both are wrong in some years

- **Severity** medium · **Category** `holiday-divergence` · **Verifier votes** 1
- **Location** `src/utils/germanHolidays.ts:132`

**Evidence**

```
germanHolidays.ts:130-135:
  if (bl === 'SN' || bl === 'TH') {
    const nov23 = new Date(Date.UTC(year, 10, 23));
    const bbt = new Date(nov23.getTime() - ((nov23.getUTCDay() + 4) % 7) * 86400000);
    set.add(utcDateStr(bbt));
  }

StundennachweisPage.tsx:157-161:
  if (bl === 'SN') {
    const nov23 = new Date(year, 10, 23);
    const bbt   = add(nov23, -(((nov23.getDay() + 4) % 7) + 1)); // last Wed before Nov 23
    h.add(fmt(bbt));
  }
```

**Failure scenario**

Ran both expressions for 2022-2027. They never agree: 2025 -> germanHolidays 2025-11-19 (Mi) vs StundennachweisPage 2025-11-18 (Di); 2024 -> 2024-11-20 vs 2024-11-19; 2023 -> 2023-11-22 vs 2023-11-21. StundennachweisPage's extra `+1` always lands on a Tuesday, so for a Sachsen company the /stundennachweis document books the whole of 18.11.2025 as Feiertag (+125%) and books 19.11.2025 — the actual Buß- und Bettag — as an ordinary Tuesday, while the Monatsplanung Stundennachweis does the opposite. germanHolidays is additionally wrong whenever 23 November is itself a Wednesday: for 2022 it returns 2022-11-23 instead of the correct 2022-11-16 (a `% 7` result of 0 must mean "go back a full week").

**Recommendation**

Keep one implementation and make it `nov23 - (((dow + 4) % 7) || 7)` days, i.e. strictly the last Wednesday *before* 23 November, and delete the other.

---

### 57. A failed trip batch during Fahrtenbuch import leaves a partially populated import in the database whose row_count still claims the full trip count

- **Severity** medium · **Category** `partial-write` · **Verifier votes** 1
- **Location** `src/hooks/useFahrtenbuch.ts:256`

**Evidence**

```
const batchSize = 200;
    for (let i = 0; i < params.trips.length; i += batchSize) {
      const batch = params.trips.slice(i, i + batchSize).map(t => ({
        ...t,
        import_id: importId,
        company_id: companyId,
      }));
      const { error: tripErr } = await supabase
        .from('fahrtenbuch_trips')
        .insert(batch);
      if (tripErr) throw tripErr;
    }
```

**Failure scenario**

A 3,000-row monthly Fahrtenbuch is imported as 15 batches. The import row is created first with `row_count: params.trips.length` (line 226) and batches 1-8 insert fine; batch 9 fails (network blip, a constraint violation on one malformed row, RLS/JWT expiry mid-import — the session is 20 min). `throw tripErr` aborts the loop. Unlike the earlier failure paths in this same function, which explicitly clean up (lines 237, 245-246), nothing removes the import row or the 1,600 already-inserted trips. FahrtenbuchImportModal.doImport catches and shows "Import fehlgeschlagen", so the user retries — but the truncated import is now a permanent, selectable row that renders as "3000 Fahrten" everywhere it is listed (FahrtenbuchImportModal.tsx:1163, FahrtenbuchTripsView.tsx:265, CompanyPlannerPage.tsx:479). If the user later plans against that import, blocks are built from 1,600 of 3,000 trips; every downstream figure — Arbeitsstunden, Nacht-/Sonntagszuschläge, Brutto — is short by ~47%, and none of FinalizePlanningModal's pre-flight checks catch it because they compare trips against `apply_summary_json`, which was itself derived from the truncated set. Only the Brutto-Gehälter path validates against row_count (HistoricalReconciliationWizard.tsx:1116).

**Recommendation**

On any batch failure, delete the trips already written for that import_id, delete the fahrtenbuch_imports row and remove the uploaded storage object before rethrowing — or write the import through an RPC that inserts header and trips in one transaction. Additionally, verify the actual inserted count against row_count before marking the import `status: 'confirmed'`.

---

### 58. Driver-notes query drops its error, so a salary-transfer can be validated as "gültig" and written even when the target driver is note-blocked (Krank/Urlaub/Frei)

- **Severity** medium · **Category** `swallowed-error` · **Verifier votes** 1
- **Location** `src/components/MonatsplanungStundennachweisPreview.tsx:3127`

**Evidence**

```
const { data } = await supabase
        .from('driver_notes')
        .select('driver_id, note_planning_behavior, is_full_day, start_date, end_date, note_date, start_time, end_time')
        .in('driver_id', driverIds)
        .eq('note_planning_behavior', 'exclude_from_plan');
      if (cancelled || !data) return;
```

**Failure scenario**

`error` is never destructured or checked; on failure PostgREST returns data === null and the effect returns silently, leaving `driverNotesMap` an empty Map. validateTransfer's Check 0 (line 2876) reads `driverNotesMap.get(suggestion.target_driver_id) ?? []`, finds nothing, and never sets hardFail — so a transfer to a driver who has an `exclude_from_plan` note (sick leave / vacation) is scored `gueltig`, the Anwenden button is enabled, and `confirmApply`'s re-validation at line 3188 uses the same empty map, so the guard cannot fire. The RPC loop then reassigns real trips to a driver who was provably not working. The same hole opens without any error at all: the map is populated asynchronously while suggestions render immediately, so a user clicking a suggestion before the fetch resolves gets the identical unguarded path. Result: a Stundennachweis and corrected Fahrtenbuch sent to the tax accountant showing a driver on documented sick leave driving shifts — and because fahrtenbuch_trips is append-only with no UPDATE RLS policy, undoing it requires another RPC round.

**Recommendation**

Destructure `{ data, error }`; on error set an explicit German error state and force every transfer suggestion to `pruefung_erforderlich` (as validateTransfer already does for incomplete driver data at line 2871) rather than treating "no notes loaded" as "no notes exist". Also block the Anwenden button until the notes fetch has resolved.

---

### 59. parseMoney mangles German amounts that use a thousands separator or a single decimal digit, writing 1.000x-too-small trip amounts

- **Severity** medium · **Category** `german-amount-parsing` · **Verifier votes** 1
- **Location** `src/components/FahrtenbuchImportModal.tsx:311`

**Evidence**

```
function parseMoney(raw: CellValue): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return Math.round(raw * 100) / 100;
  const s = String(raw).trim();
  if (!s || s === '\\N') return 0;
  // Handle German decimal comma: "41,93" → "41.93"
  const cleaned = s.replace(/[^\d,.-]/g, '').replace(/,(\d{2})$/, '.$1');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}
```

**Failure scenario**

Verified by running the function: '1.234,56' -> 1.23, '2.480,00' -> 2.48, '1.234' -> 1.23, '41,9' -> 41, '12,5' -> 12, '5,255' -> 5. The thousands dot is never stripped, so `,(\d{2})$` turns '2.480,00' into '2.480.00' and parseFloat stops at the second dot; and a comma followed by anything other than exactly two digits is left as a comma, where parseFloat truncates at it. Any XLSX/CSV whose Preis/Trinkgeld column is exported as text (which is why the string branch exists at all) therefore stores price_amount = 2.48 instead of 2480.00, or 12.00 instead of 12.50. price_amount feeds cash_amount/online_amount at lines 644-648, which feed Umsatz and the salary formula (Umsatz + Aktionen) x salary_ratio and the weekly Abrechnung cash balance. The amounts are immutable after import, and the step-4 preview only shows the first 10 rows, so the error is invisible unless one of those ten happens to be affected.

**Recommendation**

Parse German numbers explicitly: if the string contains a comma, strip all dots as thousands separators and replace the comma with a dot (`s.replace(/\./g,'').replace(',','.')`) regardless of how many digits follow it; if it contains only dots, decide by digit-group shape. Additionally, reject rather than silently zero/truncate unparseable money cells and report them in ParseStats.

---

### 60. Driver auto-matching uses bidirectional substring matching and marks the first hit as confirmed, permanently attributing a month's rides to the wrong driver

- **Severity** medium · **Category** `driver-identity-mismatch` · **Verifier votes** 1
- **Location** `src/components/FahrtenbuchImportModal.tsx:505`

**Evidence**

```
const matches: DriverMatch[] = names.map(name => {
      const norm = normalise(name);
      const found = drivers.find(d =>
        normalise(d.name) === norm ||
        normalise(d.name).includes(norm) ||
        norm.includes(normalise(d.name))
      );
      return {
        importedName: name,
        matchedDriverId: found?.id || null,
        matchedDriverName: found?.name || name,
        confirmed: !!found,
      };
    });

// normalise strips everything but [a-z0-9] (line 142-144), so "Ali Y." -> "aliy"
// step-2 gate: canGoNext() -> driverMatches.every(d => d.confirmed)  (line 495)
```

**Failure scenario**

A company has drivers 'Ali' (the Inhaber) and 'Ali Yildirim'. The import file contains 'Ali Yildirim'; `norm.includes(normalise(d.name))` is true for 'Ali', and Array.find returns whichever of the two appears first in the drivers array (load order, not specificity). The match is written with confirmed: true, so step 2 renders it with a green check and 'Weiter' is immediately enabled — an operator clicking through sees a confirmed-looking mapping. Every one of Ali Yildirim's rides is stored with original_driver_id = Ali's id and original_driver_name from the file. original_driver_id is one of the columns protected by protect_fahrtenbuch_immutable_fields, so it can never be corrected; the whole month must be deleted and re-imported. Until then the Stundennachweis and salary for both drivers are wrong. The same defect exists for plates in buildCarMatches (line 534, `normalise(c.plate).includes(norm)` plus unconditional `confirmed: true`), which maps 'B-AB 123' onto the car 'B-AB 1234'.

**Recommendation**

Only auto-confirm exact normalised matches. Treat substring hits as suggestions with confirmed: false so the step-2 gate forces a human decision, and when more than one driver satisfies the predicate, leave the match unset and show all ambiguous candidates instead of taking the first.

---

### 61. Receipt OCR amount regex cannot span a German thousands separator, so a 2.480,00 EUR total is captured as 480,00 with high confidence and no uncertainty warning

- **Severity** medium · **Category** `ocr-amount-misparse` · **Verifier votes** 1
- **Location** `src/utils/receiptOcr.ts:144`

**Evidence**

```
// Amount format: 25,32 or 25.32
const AMOUNT_RE = /\b(\d{1,4}[,\.]\d{2})\b/g;

function parseRawAmount(raw: string): number | null {
  // German: 25,32 → 25.32; English: 25.32 → 25.32
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const n = parseFloat(normalized);
  if (isNaN(n) || n <= 0 || n >= 10000) return null;
  return Math.round(n * 100) / 100;
}
```

**Failure scenario**

Verified by running the regex: on the line 'Summe EUR 2.480,00' the only match is '480,00' — the leading '2.' can never be part of the capture because \d{1,4}[,.]\d{2} plus the trailing \b cannot cross the thousands dot. That candidate then scores +100 (TOTAL_LABEL_RE on the same line) +70 (EUR on the same line) plus the position bonus, far above CONFIDENT = 50 (line 637), so extractReceiptData returns amount = 480 with amountConfidence 100 and no 'Unsicher:' prefix (lines 651-658). ReceiptModal.applyExtracted writes it straight into formData.expense and shows '480,00' in the amount field with the green 'Felder automatisch ausgefüllt' message (ReceiptModal.tsx:280-283, 258-262). A four-figure Beleg (Werkstatt/Reparatur under the 'Other' category) is saved 2.000 EUR short; the receipt then flows into the Excel/PDF export handed to the Steuerberater and into the cash-expense side of the Abrechnung balance.

**Recommendation**

Widen AMOUNT_RE to accept grouped German amounts (e.g. /\b(\d{1,3}(?:\.\d{3})+,\d{2}|\d{1,5}[,\.]\d{2})\b/) and keep parseRawAmount's dot-stripping for the comma case; additionally, when a matched amount is immediately preceded by `\d\.` in the source line, force the candidate to the uncertain band so the UI asks the user to check it.

---

## Low (10)

### 62. company-logos is a public bucket with no allowed_mime_types and no file_size_limit; the INSERT policy only pins the first path segment, so any tenant admin can host arbitrary public content on the vendor's Supabase domain

- **Severity** low · **Category** `storage-upload-validation` · **Verifier votes** 1
- **Location** `supabase/migrations/20260402070500_create_company_logos_storage.sql:18`

**Evidence**

```
-- 20260402070500_create_company_logos_storage.sql:18-20 (bucket created WITHOUT file_size_limit / allowed_mime_types)
INSERT INTO storage.buckets (id, name, public)
VALUES ('company-logos', 'company-logos', false)
ON CONFLICT (id) DO NOTHING;

-- 20260507193515_make_company_logos_bucket_public.sql:23-25
UPDATE storage.buckets
SET public = true
WHERE id = 'company-logos';

-- 20260507193515_make_company_logos_bucket_public.sql:36-48 (only the folder prefix and the role are checked; nothing constrains extension, mime type or size)
CREATE POLICY "Company admins can upload own company logo"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid() LIMIT 1
    )
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin')
    )
  );

// src/pages/SettingsPage.tsx:137-147 — the ONLY type/size validation is client-side
const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'];
if (!validTypes.includes(file.type)) { showError('Ungültiger Dateityp', ...); return; }
if (file.size > 5 * 1024 * 1024) { showError('Datei zu groß', ...); return; }

// src/pages/SettingsPage.tsx:160-168 — upload with caller-chosen contentType
.upload(filePath, fi
```

**Failure scenario**

Any authenticated user whose user_profiles.role is 'admin' (every customer's own company admin) skips the React UI and POSTs directly to the Storage REST API: POST /storage/v1/object/company-logos/<their-own-company-uuid>/invoice-update.html with Content-Type: text/html and a 200 MB body. Both server-side gates pass — the folder segment equals their own company_id and their role is 'admin' — because the bucket declares no allowed_mime_types and no file_size_limit, and SettingsPage.tsx's checks never run. Because migration 20260507193515 flipped the bucket to public and dropped the SELECT policy, the file is then served unauthenticated and inline at https://<project>.supabase.co/storage/v1/object/public/company-logos/<uuid>/invoice-update.html with the attacker-chosen Content-Type. Result: a phishing/malware page (or an SVG with an inline <script>) hosted on the SaaS vendor's own supabase.co domain, plus unbounded storage/egress billing, with only a customer-level admin account required.

**Recommendation**

Set allowed_mime_types := ARRAY['image/png','image/jpeg','image/webp'] and file_size_limit := 5242880 on the company-logos bucket (as was already done for stundennachweise-pdfs), and additionally constrain the object name in the INSERT/UPDATE WITH CHECK (e.g. name ~ '^[0-9a-f-]{36}/logo\.(png|jpe?g|webp)$'). Drop image/svg+xml from the accepted list in SettingsPage.tsx:138 — SVG is an active-content format and cannot be safely served from a public bucket.

---

### 63. UserManagement logs the new-user creation payload — including the admin-chosen plaintext password — to the production console

- **Severity** low · **Category** `credential-logging` · **Verifier votes** 1
- **Location** `src/components/UserManagement.tsx:418`

**Evidence**

```
// src/components/UserManagement.tsx:416-418
const handleAddUser = async (userData: { email: string; password?: string; full_name: string; role: string; use_temp_password?: boolean }) => {
  try {
    console.log('🔄 Starting user creation process...', userData);

// ...the same `userData` object is what is sent as the request body at line 435:
      body: JSON.stringify(userData),

// src/components/UserManagement.tsx:327-333 — the caller's own identity is logged too
console.log('UserManagement - Auth State:', { user: currentUser?.email, isAdmin, profile: profile?.role, authLoading });

// No import.meta.env.DEV guard exists anywhere in src/components/UserManagement.tsx,
// and vite.config.ts does not drop console statements from the production build.
```

**Failure scenario**

A company admin uses Benutzerverwaltung to create an employee with a temporary password (use_temp_password = true, password = 'Sommer2026!'). Line 418 serializes the whole userData object to the browser console, so the new account's email and its plaintext password sit in the DevTools log of the production app. Because the temp-password flow deliberately does not email a link (manage-users/index.ts only calls generateLink when !useTempPassword), that password is a live credential for an account with a real role in the tenant. Any browser extension with console/log access, any crash-reporter or session-replay tool that captures console output, and anyone reading the screen during a shared session obtains working login credentials for another user.

**Recommendation**

Delete the `userData` argument from the console.log at src/components/UserManagement.tsx:418 (log only a non-secret correlation value such as the role, or nothing at all), and do the same for the auth-state dump at line 327. Credentials must never be passed to console.* regardless of build mode.

---

### 64. activation_codes.code_hash has no UNIQUE constraint, codes are generated with Math.random() and no collision check, and redemption resolves the hash with an unfiltered LIMIT 1

- **Severity** low · **Category** `missing-unique-constraint` · **Verifier votes** 1
- **Location** `supabase/migrations/20260621024048_create_activation_codes_system.sql:41`

**Evidence**

```
Only a non-unique index exists (20260621024048_create_activation_codes_system.sql:41):
  CREATE INDEX IF NOT EXISTS idx_activation_codes_code_hash  ON activation_codes(code_hash);

Generation draws a 6-digit code with no uniqueness check before insert (supabase/functions/generate-activation-code/index.ts:79-83, 106-110):
    const rawCode = Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0");
    const codeHash = await sha256hex(rawCode);
    ...
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from("activation_codes").insert(insertRow).select("id").single();

Redemption picks an arbitrary matching row with no status/expiry filter (20260621120417_fix_redeem_rpc_write_applied_fields.sql:58-73):
  SELECT * INTO v_code FROM activation_codes WHERE code_hash = v_code_hash LIMIT 1;
  ...
  IF v_code.status = 'used' THEN ... RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde bereits verwendet.');
```

**Failure scenario**

Codes live in a 10^6 space and every historical row is retained (used, revoked and expired rows are only soft-hidden by delete_activation_code/hide_activation_code). Once a few thousand codes have been issued, a newly generated code eventually collides with an old one; the insert succeeds because no UNIQUE constraint exists. The customer types the freshly issued code, redeem_activation_code's `WHERE code_hash = ... LIMIT 1` returns the older row (row order is not defined and the query has no status/expires_at filter), and the customer is told 'Aktivierungscode wurde bereits verwendet' or 'Aktivierungscode gehört nicht zu diesem Unternehmen'. The real code expires 2 minutes after issue (index.ts:87), so the paying company is locked out of activating its subscription until an admin manually issues another code — and if the stale row happens to be an active one belonging to a different company, the wrong company's code is consumed.

**Recommendation**

Add a partial unique index `ON activation_codes(code_hash) WHERE status = 'active'`, have the edge function retry generation on unique violation (and use crypto.getRandomValues instead of Math.random), and constrain the redeem lookup to `WHERE code_hash = ... AND status = 'active' AND expires_at > now()` before falling back to the diagnostic 'already used' messages.

---

### 65. A migration titled "harden_security_definer_functions" re-opens direct client UPDATE on the append-only fahrtenbuch_trips table

- **Severity** low · **Category** `data-integrity` · **Verifier votes** 1
- **Location** `supabase/migrations/20260607124839_harden_security_definer_functions_and_storage.sql:228`

**Evidence**

```
-- ─── 5. Add missing fahrtenbuch_trips UPDATE policy ─────────────────────────
-- Needed for plan apply operations that update mutable fields directly.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='fahrtenbuch_trips' AND cmd='UPDATE'
  ) THEN
    CREATE POLICY "fahrtenbuch_trips_update" ON fahrtenbuch_trips
      FOR UPDATE TO authenticated
      USING (company_id IN (
        SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
      ))
      WITH CHECK (company_id IN (
        SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
      ));
  END IF;
END $$;

-- this directly contradicts the invariant the table was created with,
-- supabase/migrations/20260605082340_create_fahrtenbuch_trips_and_immutability.sql:160-163:
--   -- UPDATE: blocked for regular clients.
--   -- The RPC uses SECURITY DEFINER and bypasses RLS.
--   -- This policy is intentionally absent — no direct UPDATE is allowed.
--   -- (Absence of an UPDATE policy means no UPDATE is permitted under RLS.)
-- and note the DELETE policy on the same table (20260605082340:166-174) does gate on role='admin';
-- this UPDATE policy gates on nothing but company membership.

-- the audit row is written only inside the RPC:
-- 20260605082427_create_fahrtenbuch_audit_and_reassign_rpc.sql:167  INSERT INTO fahrtenbuch_assignment_audit (
-- 2026
```

**Failure scenario**

Any authenticated user of a company — including a 'viewer', who is denied DELETE by the role-gated delete policy — issues `supabase.from('fahrtenbuch_trips').update({ assigned_driver_id: X, assigned_driver_name: 'X' }).eq('id', tripId)`. The immutability trigger protect_fahrtenbuch_immutable_fields does not list assigned_driver_id/assigned_driver_name/assignment_reason/assignment_note among its protected columns, so the write succeeds. No fahrtenbuch_assignment_audit row is created (that INSERT lives only inside reassign_fahrtenbuch_trip), and company_planning_runs.apply_summary_json is not updated. The next Stundennachweis attributes those hours to the wrong driver — a statutory time record handed to the Steuerberater and to authorities — with no audit trail showing the change, and FinalizePlanningModal's apply_summary_json trip-count reconciliation cannot detect it because the row count is unchanged.

**Recommendation**

Drop the fahrtenbuch_trips_update policy (`DROP POLICY IF EXISTS "fahrtenbuch_trips_update" ON fahrtenbuch_trips;`) in a new migration, restoring the documented invariant that reassign_fahrtenbuch_trip / apply_monthly_planning_run are the only mutation paths. If a direct UPDATE path is genuinely needed later, extend the immutability trigger to also reject changes to assigned_driver_* unless a session flag set by the RPC is present, so the audit row can never be skipped.

---

### 66. Non-idempotent unguarded UPDATE grants every 'inactive' company an active subscription on any chain re-run

- **Severity** low · **Category** `non-idempotent-migration` · **Verifier votes** 1
- **Location** `supabase/migrations/20260621024101_add_subscription_fields_to_companies.sql:12`

**Evidence**

```
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'inactive'
    CHECK (subscription_status IN ('inactive','active','expired','suspended')),
  ADD COLUMN IF NOT EXISTS subscription_started_at   timestamptz,
  ...

-- Backfill: all companies that currently exist get subscription_status = 'active'
-- so they are NOT locked out after this migration.
UPDATE companies SET subscription_status = 'active' WHERE subscription_status = 'inactive';

-- the ADD COLUMN clauses are all IF NOT EXISTS (i.e. written to be re-runnable) but the
-- UPDATE has no one-shot guard, no created_at cutoff, and no `AND subscription_started_at IS NULL`.
-- New tenants are created with exactly this value by the signup path:
--   supabase/functions/company-signup/index.ts:124  approval_status: "pending",
--   supabase/functions/company-signup/index.ts:131  subscription_status: "inactive",
-- and the gate that consumes it is client-side only:
--   src/contexts/AuthContext.tsx:408  .select('subscription_status, subscription_expires_at, approval_status, rejection_reason')
```

**Failure scenario**

This project demonstrably applies schema SQL by hand — the repo root carries apply_salaries_migration.sql and apply_cash_balance_migration.sql, byte-identical copies of chain migrations kept for manual pasting. Anyone re-running this file (rebuilding staging, repairing a drifted supabase_migrations history, or pasting it to add the columns to a second environment) at a moment when N signed-up-but-unpaid companies sit at subscription_status='inactive' flips all N to 'active' in one statement, with subscription_started_at and subscription_expires_at left NULL. SubscriptionGuard in App.tsx then stops forcing /abo-aktivieren and every one of those tenants gets the full paid product for free, with no record of which rows were changed.

**Recommendation**

Guard the backfill so it can only ever affect pre-existing rows, e.g. `UPDATE companies SET subscription_status = 'active' WHERE subscription_status = 'inactive' AND created_at < '2026-06-21';`, or gate the whole statement on the column having just been created (capture `IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='companies' AND column_name='subscription_status')` before the ALTER and only backfill in that branch). Then audit production for companies with subscription_status='active' and subscription_started_at IS NULL.

---

### 67. IncomeManagement writes income.created_by as parseInt() of a UUID, destroying row ownership and permanently disabling edit/delete for non-admins

- **Severity** low · **Category** `schema-drift` · **Verifier votes** 1
- **Location** `src/components/IncomeManagement.tsx:267`

**Evidence**

```
// src/components/IncomeManagement.tsx:257-269
const rows = amounts.map(({ type, amount }) => {
  ...
  return {
    description: rowDescription,
    amount,
    type,
    driver_name: batchForm.driver_name,
    date: batchForm.date,
    week: batchForm.week,
    trip_count: tripCount,
    created_by: parseInt(profile.id),      // <-- profile.id is a uuid string
    company_id: companyId,
  };
});

// src/contexts/AuthContext.tsx:422-432
const canEdit = (createdBy?: string | number) => {
  if (isAdmin) return true;
  if (!createdBy) return false;
  return profile?.id === String(createdBy);
};

// consumed at src/components/IncomeManagement.tsx:1132 / :1141
//   {canEdit(income.created_by) && ( ... )}
//   {canDelete(income.created_by) && ( ... )}

// the schema chain says both of these are wrong:
//   supabase/migrations/20250930122526_raspy_cliff.sql:21  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),   (user_profiles)
//   supabase/migrations/20251008100001_fix_income_table_created_by.sql:24  created_by text,
// the bigint world the component codes against exists only in an out-of-chain root script:
//   Pro/fix_income_update_policy.sql:  ALTER TABLE income ADD COLUMN created_by_bigint bigint;
//                                      ALTER TABLE income DROP COLUMN created_by;
//                                      ALTER TABLE income RENAME COLUMN created_by_bigint TO created_b
```

**Failure scenario**

A non-admin user (role 'creator') records a week's Bargeld/Umsatz/Trinkgeld. profile.id is a UUID such as 'a3f19c2e-...'; parseInt('a3f19c2e-...') is NaN, and JSON.stringify(NaN) is null, so every row is inserted with created_by = null. Back in the list, canEdit(null) hits `if (!createdBy) return false` and both the edit and delete buttons are hidden forever — the user cannot correct their own typo'd Umsatz row and must call an admin. For the minority of UUIDs that begin with digits (e.g. '123e4567-...') parseInt yields 123, which is stored but can never equal String(profile.id), so the buttons are hidden there too. Either way ownership of every income row — the table that feeds the salary formula (Umsatz + Aktionen) x salary_ratio — is silently lost.

**Recommendation**

Write `created_by: profile.id` (the UUID string) and confirm the live income.created_by column type; if production really is bigint (per fix_income_update_policy.sql) add a chain migration converting it back to uuid/text with a documented backfill, and delete the contradictory root-level fix_income_*.sql scripts so the chain is the single source of truth.

---

### 68. validateClone validates the entire plan absolutely rather than the delta, so any constraint the coverage pass deliberately relaxed makes every subsequent Austausch-Reparatur simulation fail and blames an unrelated driver

- **Severity** low · **Category** `repair-engine` · **Verifier votes** 1
- **Location** `src/utils/monatsplanungPhase3.ts:930`

**Evidence**

```
// trySimulatedPlan, line 927-933 — accepts only if the WHOLE clone has zero violations
  const clone = cloneStates(realStates);
  const r = planFn(clone);
  if (!r.ok) return { ...r, rejection: r.reason };
  const val = validateClone(clone, selectedSet, options);
  if (val.violations !== 0) {
    return { ok: false, reason: r.reason, ..., rejection: `Repair attempt rejected: ${val.firstDetail}` };
  }

// validateClone, line 893-899 — counts pre-existing daily/monthly overruns anywhere in the plan
    const maxMin = Math.round(state.effective_max_daily_hours * 60);
    if (state.driver.employment_type !== 'company_owner') {
      for (const mins of state.daily_minutes.values()) {
        if (mins > maxMin) { v++; note(`Tageslimit ${state.driver_name}`); }
      }

// but the coverage pass at line 1353-1378 intentionally omits checkDaily and the Dienstzeit half of checkWindow
      const hardChecks: Array<RejectedCandidate | null> = [
        (() => { /* weekday only */ })(),
        checkStructuredNote(driver, u, opts.driverNotesMap),
        checkNote(driver, u),
        checkOverlap(state, u),
        checkVehicleSwitch(state, u, opts.vehicleSwitchBufferMinutes),
        checkMonthly(state, u),
        opts.oneVehiclePerDriverDay && driver.employment_type !== 'company_owner' ? checkOneVehiclePerDay(state, u) : null,
      ];
```

**Failure scenario**

The passes run in the order repair -> coverage -> Austausch. If the coverage pass places even one block on driver X over X's Tageslimit or outside X's Dienstzeit (its whole purpose — assignment_reason 'Deckungspass (entspannte Dienstzeit)' at line 1403), driverStates now permanently carries at least one violation. Every later Austausch-Reparatur attempt calls trySimulatedPlan (line 1492), whose validateClone walks all drivers and returns violations >= 1 regardless of whether the simulated donor swap itself is legal, so `result.ok` is false for every candidate driver and every donor block. austausch_summary.resolved is stuck at 0, blocks that a legal Inhaber donor swap could have covered stay in `unassigned`, and austausch_log.reason reported to the user reads e.g. 'Repair attempt rejected: Tageslimit Müller' — naming a driver who has nothing to do with the attempted swap. This is exactly the situation the Austausch pass exists for, since afterCoverage only holds blocks the coverage pass could not place.

**Recommendation**

Make trySimulatedPlan compare against a baseline: run validateClone on the unmodified realStates once before planFn and reject only when the clone's violation count exceeds the baseline (or restrict validateClone to the drivers the plan actually touched), so a deliberately relaxed coverage assignment cannot veto unrelated repairs.

---

### 69. Notes / Hinweise section silently loses content: the page-break estimate ignores text wrapping and the overflow page has no pagination of its own

- **Severity** low · **Category** `export-truncation` · **Verifier votes** 1
- **Location** `src/utils/stundennachweisPdfExport.ts:846`

**Evidence**

```
The height estimate counts unwrapped logical lines:
846:      const totalNotesH = NOTE_TITLE_H + NOTE_PADDING + noteLines.length * NOTE_LINE_H + NOTE_PADDING;
...
853:      if (totalNotesH > availableH) {
854:        pdf.addPage();
855:        ny = MT + 4;

but rendering wraps each logical line into an unbounded number of physical lines, and `ny` is never checked against the page height again — there is no second addPage() anywhere in the loop:
868:      for (const line of noteLines) {
...
873:        const wrapped = pdf.splitTextToSize(line, maxLineW) as string[];
874:        for (const wl of wrapped) {
875:          pdf.text(wl, ML + 2, ny);
876:          ny += NOTE_LINE_H;
877:        }
878:      }

noteLines is easily long: warnings expand to a summary line plus up to 15 items per critical group plus 5 per target/note group (lines 812-841), on top of one line per driver note (line 809).
```

**Failure scenario**

A month with 12 driver notes whose note_text is a full sentence (each wrapping to 2-3 physical lines at TW-4 = 186 mm and 7.5 pt) plus a critical warning group of 15 items produces ~30 logical lines but ~60 physical lines. totalNotesH is computed as 10+4+30*5.5+4 = 183 mm, which correctly triggers the page break, but on page 2 rendering starts at ny = 16 mm and runs to 16 + ~60*5.5 = 346 mm — past the 297 mm A4 page. jsPDF draws the excess outside the media box, so roughly the last 15-20 lines (including the tail of the 'Generierungswarnungen' list, e.g. uncovered Fahrtenbuch trips) vanish from the PDF with no error and no '... weitere' marker. The archive PDF regenerated later from DocumentsPage (exportSavedPDF, line 88) loses exactly the same lines.

**Recommendation**

Pre-wrap every note line with pdf.splitTextToSize before computing totalNotesH so the estimate matches what is drawn, and add a bottom-of-page guard inside the render loop (`if (ny > PH - MB - NOTE_LINE_H) { pdf.addPage(); ny = MT + 4; }`) so the section paginates across as many pages as it needs.

---

### 70. OverviewPage discards every query error, rendering failed loads as €0,00 revenue, salaries and costs

- **Severity** low · **Category** `swallowed-error` · **Verifier votes** 1
- **Location** `src/pages/OverviewPage.tsx:296`

**Evidence**

```
const loadFixedCosts = async () => {
    const { data } = await supabase.from('fixed_costs').select('id, description, amount').eq('company_id', companyId);
    setFixedCosts(data || []);
  };
  const loadIncomes = async () => {
    const { data } = await supabase.from('income').select('*').eq('company_id', companyId);
    setIncomes(data || []);
  };
  const loadSalaries = async () => {
    const { data } = await supabase.from('salaries').select('*').eq('company_id', companyId);
    setSalaries(data || []);
  };
// ... and loadData only console.errors:
    } catch (err) {
      console.error('Error loading data:', err);
    } finally { setLoading(false); }
// the results go straight into the displayed money:
  const currentMetrics = calcPeriodMetrics(incomes, salaries, receipts, fixedCosts, monthStart, monthEnd);   // :339
  const prevMetrics    = calcPeriodMetrics(incomes, salaries, receipts, fixedCosts, prevStart, prevEnd);      // :340
```

**Failure scenario**

The `income` select fails (RLS change, transient 5xx, expired token during a refresh). `error` is destructured away, `data` is null, so `setIncomes([])` runs. The spinner clears normally and the dashboard renders Umsatz €0,00, Gewinn = minus the fixed costs, a -100% delta versus last month, and `generateInsights` produces alarm text derived from those zeros — all indistinguishable from a genuinely empty month. The operator sees a fabricated loss for the month with no error indication anywhere in the UI.

**Recommendation**

Destructure `error` in each loader, throw on it so `loadData`'s catch runs, and render an explicit error state (or the existing toast) instead of falling through to zeros. `data || []` must be reserved for a genuinely empty result set.

---

### 71. AbrechnungPage month/view switching has no request cancellation, so a slow response can overwrite a newer one

- **Severity** low · **Category** `race-condition` · **Verifier votes** 1
- **Location** `src/pages/AbrechnungPage.tsx:79`

**Evidence**

```
useEffect(() => {
    if (viewMode === 'weekly') {
      loadWeeklyData();
    } else if (viewMode === 'monthly') {
      loadMonthlyData();
    }
  }, [selectedYear, selectedMonth, viewMode]);   // no cleanup, no ignore flag, no AbortController

  const loadWeeklyData = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase.rpc('get_weekly_abrechnung', { p_year: selectedYear, p_month: selectedMonth });
      if (error) throw error;
      setWeeklyData(data || []);                                   // unconditionally wins
      const uniqueDrivers = Array.from(new Set(data?.map((d: WeeklyAbrechnung) => d.driver_name) || []));
      setDrivers(uniqueDrivers as string[]);
      const uniqueWeeks = Array.from(new Set(data?.map((d: WeeklyAbrechnung) => d.week_number) || []));
      setAvailableWeeks((uniqueWeeks as number[]).sort((a, b) => a - b));
    } catch (error: any) { showToast('error', ...); } finally { setLoading(false); }
  };
```

**Failure scenario**

Only the table body is gated by `loading` (renderWeeklyView:481, renderMonthlyView:626) — the month/year/view controls stay clickable. The operator steps from März to April to Mai; three `get_weekly_abrechnung` calls are in flight and the RPC for März returns last. `setWeeklyData` from the März call overwrites the Mai data, while the header and the empty-state text render from `selectedMonth` = Mai (line 494: `Keine Daten für ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`). The page then shows März's Bargeld / ausgegebene Bargeld / Bar zurück per driver labelled as Mai — and `handleShare`/`handleDownload` renders exactly that mislabelled card as a shareable image for the driver. The first response also clears the spinner while later calls are still running.

**Recommendation**

Guard the effect: `let ignore = false; ... if (!ignore) setWeeklyData(...); return () => { ignore = true; };`, or track a request id/AbortController and drop responses that are not the latest. Apply the same guard to loadMonthlyData and to the `load` callback in MonatsplanungStundennachweisPreview.tsx:1228-1436, which has the same unguarded shape.

---

## Coverage gaps identified by the completeness critics

Three critics examined what the audit did NOT cover. Their gaps are grounded in
file:line evidence and represent work still outstanding.

### Critic 1

Coverage of the *reported* attack surface was strong on `manage-users`, `company-signup`, the part2 RLS file, `AuthContext`/`SuperAdminContext`, and the storage bucket for logos. But the audit's security sweep stopped at the four edge functions that were already on the known-issues list. Three of the seven Deno functions (`validate-discount-code`, `update-income-weeks`, `generate-activation-code`) produced no finding at all, and `validate-discount-code` is a service-role function with literally zero auth check — the same class of defect as the two already-known ones, in a function nobody named. Beyond that, three trust boundaries were never modelled: (a) the activation-code system's *read-only* oracle, which sidesteps the rate limiter that the redeem path carefully implements; (b) whether the four tables that have no `CREATE TABLE` in the chain also have no RLS in the chain — `saved_stundennachweise` has neither, and it holds the statutory payroll documents; (c) parameter validation inside the planning `SECURITY DEFINER` RPCs, which is asymmetric — `reassign_fahrtenbuch_trip` validates driver tenancy, `apply_monthly_planning_run` does not. Finally, the `SECURITY DEFINER` + `search_path` posture was assessed only where a migration is *titled* "harden…"; the two functions every RLS policy in the codebase actually depends on were skipped by that hardening and by the audit. All five gaps are grounded in files I opened.

**Three edge functions were never opened — `validate-discount-code` is an unauthenticated service-role endpoint**

`supabase/functions/validate-discount-code/index.ts` lines 36-44 build a client with `SUPABASE_SERVICE_ROLE_KEY` and then go straight to `const body: ValidateRequest = await req.json();` — there is no `Authorization` header read, no `auth.getUser()`, no tenant check, and CORS is `Access-Control-Allow-Origin: "*"` (line 5). Any anonymous caller can POST `{code, plan, billing_cycle, car_limit, current_price, company_id}` with an arbitrary `company_id` and receive `{valid, discount_code_id, discount_type, discount_value, usage_mode, final_price}` (lines 162-172). That is (1) an unlimited offline-speed enumeration oracle over the whole `discount_codes` table, (2) a disclosure of another tenant's `single`-audience code binding via the `ALREADY_USED` vs `OK` branch at lines 99-115, and (3) the exact input the already-known body-trusting `apply-discount-code` needs — the two chain into free/steeply-discounted subscriptions with no account required. The other two unopened functions are also live surface: `update-income-weeks/index.ts` lines 100-147 lets ANY authenticated user (no role check, no admin gate) rewrite `week` and `description` on every `income` row in their company — `income.week` is the key the whole Abrechnung/salary aggregation buckets on; and `generate-activation-code/index.ts` lines 98-104 copies body-supplied `company_id`, `target_email`, `custom_days` and `custom_expires_at` onto the row with no validation that the company exists or that the expiry is sane.

_How to investigate:_ Read all of `supabase/functions/validate-discount-code/index.ts`, `supabase/functions/update-income-weeks/index.ts` and `supabase/functions/generate-activation-code/index.ts` end to end. For each, answer: does it read `Authorization` at all; does it use the service-role key; which body fields reach a DB write unvalidated. Then diff `validate-discount-code` against `generate-activation-code` lines 40-70, which shows the correct pattern (anon-key client + `auth.getUser()` + `is_super_admin` lookup) that `validate-discount-code` omits entirely. Note that there is no `supabase/config.toml`, so `verify_jwt` cannot be assumed for any of them.

**`preview_activation_code` is an unrate-limited brute-force oracle that bypasses `redeem_activation_code`'s attempt limiter**

`supabase/migrations/20260621120417_fix_redeem_rpc_write_applied_fields.sql` lines 44-54 implement a real rate limiter on redemption: 10 failed rows in `activation_code_attempts` within 15 minutes blocks further tries. But `supabase/migrations/20260621110309_create_preview_activation_code_rpc.sql` lines 30-64 resolve the *same* `sha256(code)` over the *same* `activation_codes` table and return `{status, expires_at, duration_type, seconds_remaining}` — with no `activation_code_attempts` insert and no attempt counting anywhere in the function, and `GRANT EXECUTE ... TO authenticated` (line 71). Codes are 6 digits (`generate-activation-code/index.ts` line 79-81) and, because `company_id`/`target_email` are only set when supplied (lines 98-99), an unbound code passes the binding checks at preview lines 48-54 for any tenant. A single authenticated trial account can sweep the 10^6 space through `preview_activation_code` until it gets `success: true`, then spend exactly one `redeem_activation_code` call — never touching the 10-attempt budget — and grant its own company a `1_jahr` subscription. This is a rate-limit-bypass-by-sibling-endpoint, distinct from the already-listed `code_hash` uniqueness / `Math.random` finding.

_How to investigate:_ Read `20260621110309_create_preview_activation_code_rpc.sql` next to `20260621120417_fix_redeem_rpc_write_applied_fields.sql` lines 36-121 and confirm the preview path writes no attempt row. Then check `20260621024048_create_activation_codes_system.sql` for the RLS on `activation_code_attempts` and whether anything else (a trigger, a Postgres-level limit) throttles preview. Also confirm from the UI caller which screen invokes `preview_activation_code` and whether it is reachable pre-subscription (i.e. from `/abo-aktivieren` behind `SubscriptionGuard`).

**`saved_stundennachweise` has no `ENABLE ROW LEVEL SECURITY` and no policy anywhere in the 144-migration chain, and the client deletes from it by id with no company filter**

The known issue is only that `saved_stundennachweise` is never `CREATE TABLE`d. The unexamined consequence is worse: grepping all 144 files, the table appears only in four `ALTER TABLE ... ADD COLUMN` migrations (`20260606052133`, `20260607014742`, `20260609051549`, `20260621014517`) — there is no `ALTER TABLE saved_stundennachweise ENABLE ROW LEVEL SECURITY` and not one `CREATE POLICY` on it, while `20260422163649_..._rls_company_isolation_part2.sql` policies 14 other business tables. Its tenant isolation therefore exists only as unversioned dashboard state that nobody can review or restore. The client assumes RLS is doing the work: `src/pages/DocumentsPage.tsx` line 247 is `await supabase.from('saved_stundennachweise').delete().eq('id', deleteConfirmId);` and lines 266-270 are `.delete().in('id', ids)` — neither carries `.eq('company_id', companyId)`, unlike the read at line 156-159 which does. If RLS is off or permissive on that table, a guessed/leaked UUID deletes another operator's archived statutory Stundennachweis, and the archive list itself becomes cross-tenant readable. `companies` is in the same position (no `ENABLE ROW LEVEL SECURITY` in the chain, only policies).

_How to investigate:_ Run `grep -rn saved_stundennachweise supabase/migrations/` and confirm the four ALTERs are the whole story. Then enumerate every `CREATE TABLE` in the chain against every `ENABLE ROW LEVEL SECURITY` to find any other table in the same state. Against the live database, `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('saved_stundennachweise','companies','drivers','receipts')` plus `pg_policies` for those tables settles it. Finally audit every client write to `saved_stundennachweise` (`DocumentsPage.tsx` 247/266, `GenerateStundennachweisModal.tsx` 414/778, `StundennachweisPage.tsx` 3619, `MonatsplanungStundennachweisPreview.tsx` 1715) for a missing `company_id` predicate.

**`apply_monthly_planning_run` / `replace_monthly_planning_run` accept driver identity from the request payload with no tenancy or name/id consistency check**

`supabase/migrations/20260605082427_create_fahrtenbuch_audit_and_reassign_rpc.sql` lines 137-147 show the intended contract — before writing an assignment it verifies `EXISTS (SELECT 1 FROM drivers WHERE id = p_new_driver_id AND company_id = v_caller_company)`. The two RPCs that write the *entire month* skip that check: `supabase/migrations/20260612073535_add_monatslimit_exception_to_planning.sql` lines 100-131 (and the identical loop at lines 298-328 in `replace_monthly_planning_run`) take `v_driver_id := NULLIF(v_row->>'driver_id','')::uuid` and `assigned_driver_name = v_row->>'driver_name'` straight from `p_payload->'change_rows'` and write them onto trips, guarded only by `WHERE id = v_trip_id AND company_id = v_company`. `fahrtenbuch_trips.assigned_driver_id` is `uuid REFERENCES drivers(id)` (`20260605082340_...sql` line 34) with no company component, so another tenant's driver UUID satisfies the FK, and `assigned_driver_name` is free text bound to nothing. A crafted apply payload (the whole plan is computed client-side and posted in one call) writes a foreign or fabricated driver name onto statutory trips; the Stundennachweis and corrected Fahrtenbuch are generated from `assigned_driver_name`, and `monthly_planning_manual_exceptions` (lines 133-159) records the same unvalidated `driver_id`/`driver_name` as the audit trail. No confirmed finding examines parameter validation inside these two RPCs — the existing ones cover only locking/status on replace and the unpersisted buffer minutes.

_How to investigate:_ Read `20260612073535_add_monatslimit_exception_to_planning.sql` in full (both function bodies) and diff its validation steps against `20260605082427_create_fahrtenbuch_audit_and_reassign_rpc.sql` lines 104-147. Check whether `import_id`, `month` and `year` in the payload are validated against `fahrtenbuch_imports` for the caller's company (they are used raw at lines 17-19 and inserted at 74-95). Then check the caller `src/components/MonatsplanungAssignmentPreview.tsx` `handleApply()` to see exactly what the client is trusted to assemble, and whether any DB constraint or trigger would catch a cross-company `assigned_driver_id`.

**The RLS predicate helpers `get_user_company_id()` / `is_user_super_admin()` are SECURITY DEFINER with no `SET search_path`, and the migration titled "harden_security_definer_functions" skipped them**

`supabase/migrations/20260422163649_20260422000003_rls_company_isolation_part2.sql` lines 11-33 define both helpers as `LANGUAGE sql STABLE SECURITY DEFINER` with **no** `SET search_path`, bodies referencing `user_profiles` unqualified. These two functions are the isolation predicate for essentially every policy in the file — if their name resolution can be influenced (a shadowing relation earlier in the effective `search_path`, including `pg_temp`), the function returns an attacker-chosen `company_id` or `true` for super-admin and *every* tenant boundary in the product opens at once. `supabase/migrations/20260607124839_harden_security_definer_functions_and_storage.sql` demonstrates the team knows the fix — it adds `SET search_path TO 'public','pg_catalog'` to seven functions (lines 11-255) — but it never touches these two, and it recreates `public.enforce_driver_limit()` at line 179 *without* the setting. Functions added after that hardening regressed again: `20260621114909_create_update_company_subscription_manual_rpc.sql` (the super-admin subscription override, whose only authorization is an unqualified `SELECT is_super_admin FROM user_profiles`) and the three `20260621114853_create_activation_code_management_rpcs.sql` functions all lack `SET search_path`. No confirmed finding covers the search_path posture of any definer function.

_How to investigate:_ Enumerate every `SECURITY DEFINER` body in `supabase/migrations/` and list which lack `SET search_path`; cross-check against the live catalog with `SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND p.proconfig IS NULL`. Then establish reachability for this deployment: what `search_path` PostgREST sets per request, and whether the `authenticated` role retains `CREATE` on `schema public` (Supabase's default grants historically include it) — that determines whether the hazard is exploitable today or only latent. Also confirm whether the hardening migration's own `enforce_driver_limit()` rewrite dropped a setting an earlier definition had.

### Critic 2

Coverage of the *monthly* pipeline (Phase 1/3/4, FinalizePlanningModal, the clean engine, germanHolidays.ts) is genuinely deep. But the audit's money/statutory coverage is shaped by which files it opened, and it left three entire live document-producing surfaces untouched — `src/pages/StundennachweisPage.tsx` (3,985 lines, routed at `/stundennachweis`), `src/components/HistoricalReconciliationWizard.tsx` + `src/utils/shiftBlockEngine.ts` (the live Brutto-Gehälter pipeline, 3,315 lines), and the Ausgleichsstunden adjustment subsystem. Each of those carries its *own* premium-rate table, its *own* German holiday table and its *own* Bundesland parser, so the "two live holiday tables diverge" finding actually understates the problem by half. Separately, every premium finding in the audit is an *internal consistency* finding (module A disagrees with module B); nobody checked any of the four tables against the statute (§3b EStG) they claim to implement, and no code anywhere models ArbZG or MiLoG limits. Five concrete gaps below.

**src/pages/StundennachweisPage.tsx — the standalone, target-salary-driven Stundennachweis generator (live route, zero findings)**

This 3,985-line page is registered in src/App.tsx:192 (`<Route path="stundennachweis" element={<PlanGate feature="dokumente"><StundennachweisPage /></PlanGate>} />`), persists to `saved_stundennachweise`, and exports the statutory PDF via `stundennachweisPdfExport` and Excel via `fahreruebersichtExport` — yet the entire audit produced not one finding on it. It contains a THIRD, materially different Lohnart model that flatly contradicts the invariant CLAUDE.md declares ("1500 and 1501 are mutually exclusive — 1500 = nightSec − night0to4Sec"): lines 26-33 define `const PREM_NIGHT = 0.40; // 1501: 20:00–06:00 +40%` with NO 1500 bucket at all, and `salaryInCents` (line ~544-546) applies it to every night minute: `totalCents += (nightMins * hourlyRateCents * Math.round(PREM_NIGHT * 100)) / (60 * 100);`. The clean engine (historicalWorkingHoursCleanEngine.ts:57-58) splits the same minutes 25%/40%. A 22:00–06:00 shift therefore yields a Brutto here that is ~15% higher than the same shift in the Monatsplanung pipeline, on a document that goes to the same Steuerberater. It also carries a THIRD `parseBundesland` (line ~68) and a THIRD inline `getHolidaysForYear` (line 98) whose Bundesland assignments differ again from germanHolidays.ts (e.g. Ostersonntag only for BB, Frauentag for BE, Weltkindertag for TH, Fronleichnam excluding SN/TH, Buß- und Bettag only for SN). And `salaryInCents` line 548 suppresses the Sunday premium whenever `row.isHol` is true (`if (row.isSun && !row.isHol)`), so a Sunday that is also a holiday silently loses the 50% Sonntagszuschlag. Worst of all, this page does not read Fahrtenbuch data at all: the `Plan generator` at lines ~700-900 SYNTHESIZES shift times from a target salary using seeded pools (`dayStartPoolsRaw`, `nightStartPoolRaw`, `NIGHT_OVERLAP_FRACTION = 0.5`) — it fabricates a statutory time record to hit a euro figure. Nobody assessed that.

_How to investigate:_ Open src/pages/StundennachweisPage.tsx end to end (it is large — read it in ~400-line slices rather than grepping). (1) Diff its PREM_NIGHT/PREM_SUN/PREM_HOLIDAY model against `computeLohnartSeconds` in src/utils/historicalWorkingHoursCleanEngine.ts and against the Monatsplanung Brutto code in MonatsplanungStundennachweisPreview.tsx; construct one concrete driver-month (e.g. 20 shifts 22:00–06:00, one on a Sunday, one on 25.12) and hand-compute the Brutto under each of the three models to quantify the euro divergence. (2) Diff its `getHolidaysForYear`/`parseBundesland` (lines 68-165) against src/utils/germanHolidays.ts and the clean engine's table, per Bundesland. (3) Trace the `salaryInCents` Sunday/holiday branch and confirm the Sunday-on-holiday suppression against §3b EStG. (4) Trace where the generated rows land: `saved_stundennachweise` insert, `exportStundennachweisAsPdf`, `exportFahreruebersichtToExcel` — and determine whether anything on the page marks the output as synthetic, or whether it is indistinguishable from a Fahrtenbuch-derived record.

**The Brutto-Gehälter pipeline: src/components/HistoricalReconciliationWizard.tsx + src/utils/shiftBlockEngine.ts (live from CompanyPlannerPage.tsx, zero findings)**

CLAUDE.md names this as a third live pipeline and it is reached from src/pages/CompanyPlannerPage.tsx, yet no dimension opened it. It contains a FOURTH premium table and a FOURTH holiday table, and I found two concrete money defects in ~30 minutes of reading. (a) HistoricalReconciliationWizard.tsx:55-60 declares `nachtarbeit: 0.25, nacht04: 0.25 (ADDITIONAL on top), sonntag: 0.50, feiertag: 1.00` — 00:00–04:00 therefore accrues 25+25 = 50% (above the §3b EStG 40% tax-free ceiling and above every other module's model), and Feiertag pays 100% where StundennachweisPage pays 125%. (b) `getHolidaysForYear(y)` at line 155 takes NO Bundesland parameter and returns only the 9 nationwide holidays, so a Bavarian or NRW fleet loses Fronleichnam, Allerheiligen and Heilige Drei Könige entirely from Feiertagszuschlag. (c) `nightMinsForSeg` (line 173) computes `seg1 = max(0, min(absTo, 24*60) − max(f, 20*60))` and `seg2` only over the 24:00–30:00 window — the 00:00–06:00 portion of a shift that does NOT cross midnight is unreachable, so a driver working 02:00–06:00 is credited 0 Nachtarbeit minutes (while `night0to4MinsForSeg` still credits 120 min), losing the 25% base night surcharge on 4 hours. (d) `buildDriverPdfRows` line ~418 does `const schichten = merged.slice(0, 3)` and then accumulates `gl += dur` over `schichten` only — the 3-shift compression that CLAUDE.md says "must not alter stored minutes, premium buckets, or Brutto figures" here silently DELETES the 4th block's minutes from Grundlohn, Nachtarbeit, Sonntag and Feiertag totals and from the PDF.

_How to investigate:_ Read src/components/HistoricalReconciliationWizard.tsx lines 50-500 and src/utils/shiftBlockEngine.ts in full (1,024 lines). Build a fixture driver-month containing: a 02:00–06:00 non-cross-midnight shift, a day with four separate ride blocks, a Fronleichnam date for a BY company, and a 00:00–04:00 shift — then run `buildDriverPdfRows` mentally or in a scratch script and compare the PdfTotals against a hand-computed §3b-correct figure. Also confirm whether `mergeBlocksIfNeeded` is expected to guarantee ≤3 blocks (if it does not, slice(0,3) is unconditional data loss). Check what `groupRidesIntoBlocks` does with `is_canceled` trips. Finally, verify whether the resulting totals are what gets persisted into `historical_reconciliations` / `ausgleich_stunden_milli` (supabase/migrations/20260627074743).

**§3b EStG conformance of the surcharge rates themselves — nobody compared any module against the statute, only modules against each other**

Every premium finding in the audit is of the form "module A disagrees with module B". None establishes which one is legally right, so a fix could converge all four tables on a wrong value. The app has four live rate models: StundennachweisPage (night flat 40% 20:00–06:00, Sonntag 50%, Feiertag 125%), the clean engine (25% for 04:00–06:00 + 20:00–00:00, 40% for 00:00–04:00), the Monatsplanung preview, and HistoricalReconciliationWizard (25% + 25% additive, Feiertag 100%). §3b EStG says: 25% for 20:00–06:00; 40% for 00:00–04:00 **only when the shift began before 00:00** (a shift that starts at 01:00 gets 25%, not 40% — no module implements that precondition); 50% Sonntag; 125% Feiertag; **150%** for 25.12, 26.12 and 1. Mai; 125% for 24.12 and 31.12 from 14:00 — StundennachweisPage.tsx line 30 explicitly says "Weihnachten / 1. Mai — tracked separately in display, same as Feiertag rate", i.e. 125% where the law says 150%, on a document whose whole point is the Steuerberater's tax-free split. §3b Abs. 3 also attaches Sunday/holiday premiums to the calendar day the **shift began**, so 00:00–04:00 of Monday after Sunday work is still Sunday-premium — the audit's several cross-midnight findings assumed the opposite rule in at least one direction. And the tax-free surcharge is capped at a 50 €/h Grundlohn basis (§3b Abs. 2), which no module enforces.

_How to investigate:_ Build one authoritative §3b rate/window table as a reference document, then diff all four implementations against it: StundennachweisPage.tsx:26-33 and its `salaryInCents`; historicalWorkingHoursCleanEngine.ts `computeLohnartSeconds` (lines ~50-120 and the 1500/1501 split); the Brutto path in MonatsplanungStundennachweisPreview.tsx; HistoricalReconciliationWizard.tsx:53-60. For each divergence state the euro impact on a single 8h Sunday-night shift crossing into 25.12. Specifically check for (a) any implementation of the "shift began before midnight" precondition on the 40% bucket, (b) any 150% Weihnachten/1.-Mai rate, (c) any 50 €/h Grundlohn cap, (d) which calendar day a cross-midnight Sunday/holiday shift is attributed to in each module.

**No statutory working-time or minimum-wage limit is modelled anywhere in the product**

`grep -rn "Mindestlohn|MiLoG|12\.82|minimum_wage"` over src/ returns ZERO hits; `grep -rni "ruhezeit|arbzg|rest_period"` returns one unrelated line (StundennachweisPage.tsx:1806). The Stundennachweis is precisely the document MiLoG §17 requires, and the finalization gate in FinalizePlanningModal.tsx implements ~10 checks — none of them statutory. Phase 3's `daily_max_exceeded` / `monthly_max_exceeded` are per-driver *configured* caps and are explicitly **bypassable** via a manual exception (CLAUDE.md's own hard/bypassable list), so nothing prevents the app from planning, finalizing and exporting a month that documents an ArbZG violation to the authorities: (a) ArbZG §5 requires an 11-hour uninterrupted Ruhezeit between shifts — the only inter-block guard in the codebase is `MIN_VEHICLE_SWITCH_BUFFER_MINUTES` (30 or 60 min), and it is a *vehicle* constraint, so a driver can end at 23:30 on day D and be assigned a 05:00 start on D+1 with no complaint; (b) ArbZG §3 caps the working day at 10h absolute (8h average over 6 months) — never checked; (c) MiLoG sets a minimum wage floor, but `planning_hourly_rate` and `hourly_rate` are free-form numerics with no floor validation, so a Stundennachweis can be produced at 8 €/h; (d) §11 ArbZG Sunday-employment rules are never modelled at all.

_How to investigate:_ Enumerate the actual pre-flight check list in src/components/FinalizePlanningModal.tsx (search for the check-definition array / `checks.push`) and the reject-reason union in src/utils/monatsplanungPhase3.ts, then map each against ArbZG §3/§5/§11 and MiLoG §§1,17. Confirm empirically whether any code path computes a gap between a driver's LAST block of day D and their FIRST block of day D+1 (search monatsplanungPhase3.ts and monatsplanungRepairPass.ts for cross-day driver-gap logic, not vehicle-gap logic). Check every write path for `hourly_rate` / `planning_hourly_rate` (DriversManagement.tsx, the DB columns in supabase/migrations) for any lower bound. Report as a gate-completeness finding: which specific statutory limit can be violated end-to-end with all ~10 finalization checks green.

**The Ausgleichsstunden adjustment subsystem — the only mechanism that reconciles app hours to the Steuerberater's Brutto — was never opened**

CLAUDE.md flags Ausgleichsstunden as a load-bearing invariant, and the audit produced nothing on it. Concrete problems I confirmed: (1) `supabase/migrations/20260616125855_create_planning_run_adjustments.sql` creates `planning_run_adjustments` with indexes on `planning_run_id` and `company_id` but **no UNIQUE constraint on (planning_run_id, driver_id, adjustment_type)**, and `applyAusgleich` in MonatsplanungStundennachweisPreview.tsx:3247 does a bare `.insert(...)` with no upsert and no prior-row check — while `applyAllAusgleich` (line ~3288) filters only on the client-side `adjustmentMap`. Two clicks, or a stale map, inserts a second row; the consumer at line 1522-1533 SUMS all adjustments into `expected_brutto`, so the driver's reconciled Brutto is inflated by the full Ausgleich amount a second time. (2) `applyAusgleich`/`removeAusgleich` change the Brutto the finalized Stundennachweis is built from, but only the *transfer* path sets `is_stale` (line 3239 is the file's ONLY `is_stale: true` write) — adding or deleting an Ausgleich after finalization silently leaves `planning_finalizations.is_stale = false`, so the already-issued statutory document stays marked valid while the figures behind it moved. (3) `neededHours = Math.round((missingAmount / dev.hourly_rate) * 100) / 100` divides by the BASE hourly rate while `missingAmount` is a gap in premium-inclusive Brutto, and the sibling implementation (HistoricalReconciliationWizard.tsx:997-998) deliberately keeps euros cent-exact and rounds the hours for display only — so the hours printed on the Stundennachweis do not multiply out to the euros. (4) Nobody verified the stated invariant that Ausgleichsstunden are always Lohnart 1000 with no premium and never reach the Fahrtenbuch export.

_How to investigate:_ Read src/components/MonatsplanungStundennachweisPreview.tsx lines 1400-1560 (adjustment load + expected_brutto folding) and 3100-3400 (apply/remove/applyAll), plus HistoricalReconciliationWizard.tsx lines 980-1060 and the `ausgleich_stunden_milli` column in supabase/migrations/20260627074743_create_historical_reconciliation_tables.sql. Then: (a) model a double-apply and trace the euro impact through `bruttoTotal = Math.round((bruttoBase + ausgleich) * 100) / 100` at line 1111; (b) confirm no finalization-invalidation path exists for adjustment insert/delete by grepping every `is_stale` write in src/; (c) verify against the base-vs-premium-rate question whether `dev.target - dev.actual` is premium-inclusive; (d) grep `stundennachweisPdfExport.ts` and the Fahrtenbuch exporters for adjustment rows to confirm the Lohnart-1000-only / never-in-Fahrtenbuch invariant actually holds.

### Critic 3

Coverage of the *logic* and *authz* dimensions was thorough, but the operational dimension was examined almost exclusively through the lens of "is this SQL statement correct" — never "what happens when this chain is replayed against the live production database", "what happens when the irreversible button is pressed", or "what happens when two admins of the same company work the same month at the same time". The audit produced exactly one migration-operations finding (the non-idempotent subscription UPDATE, rated low) and zero findings about deployment, storage lifecycle, recoverability, or concurrency. Meanwhile the repo contains an unguarded `DROP TABLE IF EXISTS income CASCADE` inside the applied migration chain, a super-admin hard-delete that relies on cascade behaviour defined in a migration file that does not exist in the repo, a delete-then-insert save path for the month's entire Arbeitsstunden plan, and a post-finalization mutation path that silently desynchronises delivered statutory documents. Five concrete gaps below, all grounded in files I opened.

**Replay safety of the 144-file migration chain against the LIVE production database (destructive, non-idempotent DDL/DML)**

The audit checked migrations for correctness but never modelled the operation of applying them. `supabase/migrations/20251008100001_fix_income_table_created_by.sql:15` is an unguarded `DROP TABLE IF EXISTS income CASCADE;` justified by a comment that was only true on the day it was written ("this is safe since it was just created"). `income` is the revenue table that drives Umsatz, Gewinn and every driver's `(Umsatz + Aktionen) × salary_ratio` salary. `20260627142447_add_unique_constraint_company_settings_company_id.sql:3` unconditionally `DELETE`s company_settings rows (the source of the Stundennachweis header/legal data) keeping only one per company by `updated_at`. `20260422163251_..._backfill_company_id_existing_data.sql:40,49-50` hard-codes tenant `bc7e0e4d-6072-42f4-8029-4f0f0304c2c6` and sweeps every `company_id IS NULL` row in receipts/income/drivers/salaries/cars/... into that one tenant — written when the product was single-tenant, still in the chain now that it is multi-tenant. `20251012000000_implement_role_based_access.sql:170,206` drops columns. None of these are wrapped in a "has this already run" guard. CLAUDE.md states the live schema was partly created outside version control, which is exactly the condition that produces a `supabase_migrations.schema_migrations` mismatch and tempts an operator into `supabase db push` / `supabase migration repair` — replaying these statements. There is also no `supabase/config.toml`, no CI config, and no npm script that touches supabase, so nothing in the repo pins how migrations or the 7 edge functions are actually deployed.

_How to investigate:_ Enumerate every statement in `supabase/migrations/*.sql` that is destructive (DROP TABLE/COLUMN, DELETE, TRUNCATE) or non-idempotent-mutating (bare UPDATE), and for each decide whether a second execution is survivable; wrap the survivors in existence guards and neutralise the rest (e.g. replace the `DROP TABLE income CASCADE` body with a no-op guarded on `to_regclass('public.income') IS NULL`). Separately, determine and commit the actual deployment procedure: what applies migrations, what deploys `supabase/functions/*`, and whether the production project's migration-history table matches the repo — the answer decides whether the landmines above are live or inert.

**Irreversible super-admin company hard-delete: unverified cascade, orphaned storage, orphaned auth users, and a retention promise nothing implements**

`src/pages/CompaniesPage.tsx:999-1004` executes `supabase.from('companies').delete().eq('id', company.id)` behind a type-the-name modal, with the sole comment `// CASCADE delete handles all related rows`. That claim is unverifiable from the repo: only 20 tables declare `REFERENCES companies(id)` in `supabase/migrations/`, and the legacy business tables (`receipts`, `drivers`, `income`, `salaries`, `cars`, `fixed_costs`, `cash_transactions`, `werkstatt_checks`) get their `company_id` from a migration that is MISSING — the isolation series ships `..._20260422000001_backfill...` and `..._20260422000003_rls_company_isolation_part2.sql` but there is no `..._000002_...` file anywhere in the directory (I grepped). So the FK/ON DELETE behaviour for exactly the tables holding the payroll data is unknown, and the delete can plausibly fail on RESTRICT (fahrtenbuch_imports.imported_by is `ON DELETE RESTRICT`) or silently orphan rows that RLS then makes invisible forever. Nothing deletes storage: `fahrtenbuch-files` holds the mandatory original statutory XLSX (`src/hooks/useFahrtenbuch.ts:199-211` refuses the import without it), `stundennachweise_pdfs` holds archived statutory PDFs, `company-logos` is a public bucket — none are touched by hard-delete, so the modal's promise that "ALLE zugehörigen Daten werden dauerhaft und unwiderruflich gelöscht" (CompaniesPage.tsx:141-146) is false in the GDPR direction, while the payroll rows may be destroyed in the other. `auth.users` rows also survive. And `softDelete`'s promise that "Die Daten bleiben für 30 Tage erhalten" (CompaniesPage.tsx:137) is implemented by nothing — there is no pg_cron, no scheduled function, no purge job anywhere in `supabase/migrations/`.

_How to investigate:_ Dump the live `pg_constraint`/`information_schema` FK graph for every table carrying `company_id` and compare it against what the repo can prove; write the missing part-1 migration to bring the definitions back under version control. Then decide whether hard-delete should exist at the client at all, or become a SECURITY DEFINER RPC that enumerates dependent tables, removes the three storage prefixes, deletes the auth users, and writes a deletion record — plus reconcile the 30-day retention text with the (absent) job.

**Delete-then-insert persistence of the historical Arbeitsstunden plan — a client-side, non-transactional destroy-before-write**

`src/components/HistoricalWorkingHoursWizard.tsx:10056-10088` saves the month's entire plan by first `await supabase.from('historical_wh_saved_plans').delete().eq(company/month/year/mode)` — with NO error check on the delete — and only then `.insert({...})` the new row. These are two separate HTTP requests from the browser with no transaction. The row being destroyed is the sole persisted record of an entire month's Arbeitsstunden reconstruction (`shift_map_json`, `note_reassignments_json`, `boundary_rows_json`, `driver_configs_json`, `driver_hour_summary_json`) and is what the re-export path replays to regenerate the statutory Fahrtenbuch and Stundennachweise. If the INSERT fails for any reason — tab closed, network drop, RLS, oversized jsonb payload, the `historical_wh_saved_plans_company_month_year_mode_key` unique index (`supabase/migrations/20260704203409_...:23-25`) losing a race with a colleague who saved a second earlier — the user gets `savePlanError` and the previously saved plan is already gone, unrecoverably. The irony is that the migration that added the unique index states its purpose explicitly: "Unique index allows safe upsert semantics on conflict" — the safe path exists and the code does not take it. The audit examined this file heavily (four findings) but only for calculation and pagination defects, never for its write pattern.

_How to investigate:_ Replace the delete+insert with a single `.upsert(..., { onConflict: 'company_id,month,year,mode' })` against the existing unique index, and confirm every column the delete-path relied on is present in the upsert payload. Then sweep the wizard for the same shape: `ensureReconciliation` at HistoricalWorkingHoursWizard.tsx:10185-10196 is a check-then-insert with no unique constraint behind it, and the reconciliation/adjustment tables are written the same way.

**Post-finalization mutation paths that do NOT invalidate the finalization (only the transfer path does)**

Finalization is described as the hard statutory gate, and exactly one code path defends it: `src/components/MonatsplanungStundennachweisPreview.tsx:3237-3241` marks `planning_finalizations.is_stale = true` after a transfer — and even that is a fire-and-forget `void supabase...` whose error is never read, so a failed staleness write leaves a green "Finalisiert" badge over changed data. Ausgleichsstunden are not covered at all: `applyAusgleich` (same file, ~3247-3269) INSERTs into `planning_run_adjustments` and `removeAusgleich` (~3272-3286) hard-DELETEs those rows, both after finalization, and neither touches `planning_finalizations`. There is no database trigger either — grepping `is_stale` across all 144 migrations returns only its column definition (`20260616120915_create_planning_finalizations.sql:18`) and the purge RPC's guard. Ausgleichsstunden are Lohnart 1000 hours that appear on the Stundennachweis and change the driver's Grundlohn, so the concrete failure is: finalize the month, send the PDFs to the Steuerberater, then add or remove an Ausgleich — the archive still reads "Finalisiert", `MonatsplanungAppliedRuns.tsx:524-531` shows the green badge, `purge_old_monthly_planning_runs` still treats the run as protected because `is_stale = false`, and any regenerated document now shows different hours than the one already filed. The delete leaves no audit trail at all (no soft-delete column, no exception row).

_How to investigate:_ Enumerate every write that can occur after `planning_finalizations` exists for a run — `planning_run_adjustments` insert/delete, `reassign_fahrtenbuch_trip`, direct `company_planning_runs` updates, driver rate/salary-range edits that feed the Brutto columns — and decide for each whether it must set `is_stale`. Prefer a DB trigger on `planning_run_adjustments` over another client-side `void` call, and make the existing transfer-path staleness write awaited and error-checked.

**Concurrency between two users of the same company: no locking, no supporting uniqueness, no stale-view detection**

The whole product is a shared-tenant workspace, yet nothing in the client or the database mediates two admins working the same month. `apply_monthly_planning_run` (`supabase/migrations/20260612073535_...:51-70`) enforces the documented "one applied run per company/month/year" invariant with a bare `SELECT ... LIMIT 1` — no `FOR UPDATE`, no advisory lock — and `company_planning_runs` (`20260606101343_...:1-41`) carries no unique index that would backstop it, so two simultaneous "Plan anwenden" clicks both see nothing and both INSERT an `applied` run; the per-trip UPDATE loops then interleave, leaving trips split across two runs while each run's `apply_summary_json.updated_trips` claims the full count — precisely the number the finalization pre-flight later compares against. `fahrtenbuch_imports` likewise has no unique `(company_id, month, year)` (`20260605082259_...:6-21`), so the same month can be imported twice, and `useFahrtenbuch.fetchTrips` in the "Alle" view (`src/hooks/useFahrtenbuch.ts:140-166`, invoked with `undefined` importId from `FahrtenbuchTripsView.tsx:112-114`) loads every company trip and filters by month in JS — double-counting every ride. On the client there is exactly one realtime subscription in the entire app (`src/contexts/CompanySettingsContext.tsx:112-114`); every other page is load-once, so a second user's changes are invisible and full-row writes from stale React state overwrite them last-write-wins. The audit's one adjacent finding covered `replace_monthly_planning_run` only; the apply path, the import path, and the general absence of stale-view detection were never examined.

_How to investigate:_ Add the constraints the invariants already assume — a partial unique index on `company_planning_runs(company_id, month, year) WHERE status = 'applied'`, a unique index on `fahrtenbuch_imports(company_id, month, year)` — and take `pg_advisory_xact_lock(hashtext(company_id||month||year))` at the top of the apply/replace RPCs, then confirm the client renders the resulting 23505/'already_applied' as a clear German message rather than a crash. Separately, inventory which screens two colleagues realistically share (Monatsplanung, Fahrtenbuch import, Gehälter, Einstellungen) and decide per screen between a realtime refresh and an `updated_at` precondition on write.

