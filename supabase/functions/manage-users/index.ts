import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsFor, errorResponse, json, UserError } from '../_shared/http.ts'
import { issueAndSendOtp } from '../_shared/otp.ts'
import { logFailure } from '../_shared/otp-core.ts'
import {
  accountIsPlatformStaff,
  auditedPlatformRead,
  auditedPlatformWrite,
  platformCan,
  platformCanManageAccount,
  platformSupportCompanyId,
  recordPlatformAudit,
  UUID_SHAPE,
  type PlatformAuditDetails,
  type PlatformAuditSubject,
} from '../_shared/platform-access.ts'
import {
  decideAccountTarget,
  decideCreateCompany,
  GOTRUE_PAGE_SIZE,
  MANAGE_USERS_SCOPE_MESSAGES,
  resolveAuthAccounts,
  resolveManageUsersRoute,
  resolveManageUsersScope,
} from '../_shared/manage-users-routes.ts'

interface CreateUserRequest {
  email: string
  full_name: string
  role: string
  company_id?: string
  password?: string
  use_temp_password?: boolean
}

interface UpdateUserRequest {
  user_id: string
  email?: string
  password?: string
  full_name?: string
  role?: string
}

interface ActivateDeactivateRequest {
  user_id: string
  status: 'active' | 'inactive'
}

interface ResendInviteRequest {
  user_id: string
}

interface ResetPasswordRequest {
  user_id: string
  password: string
}

const OTHER_COMPANY_MESSAGE = 'Keine Berechtigung: Dieser Benutzer gehört zu einem anderen Unternehmen.'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsFor(req) })
  }

  // Set once a platform account is authorized, until an audited read or write
  // takes over its rows: a failure in between (a malformed body, a lookup) is
  // recorded as an error of the action it interrupted.
  let recordPlatformFailure: (() => Promise<unknown>) | null = null

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new UserError('Nicht authentifiziert.', 401)

    // The caller's own JWT. The platform RPCs answer for whoever this token
    // belongs to; the service role could not.
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: authHeader } },
      }
    )

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) throw new UserError('Nicht authentifiziert.', 401)

    const { data: callerProfile } = await supabaseAdmin
      .from('user_profiles')
      .select('role, company_id')
      .eq('user_id', user.id)
      .single()

    const url = new URL(req.url)
    const route = resolveManageUsersRoute(req.method, url.pathname)

    // Platform rights come from platform_staff, through the database, never from
    // the profile. A platform account holding the route's capability acts on one
    // company — the one its support session is open on (below); everyone else is
    // a company admin or nobody.
    const isPlatformCaller = await platformCan(supabaseUser, route?.capability ?? 'company_users.manage')

    // What the audit rows name about the target, filled in as a handler learns it.
    const auditTarget: PlatformAuditDetails = {}
    const subject = (): PlatformAuditSubject => ({
      category: route?.category ?? 'write',
      action: route?.action ?? 'manage_users.unknown',
      ...auditTarget,
    })

    // A refusal changes nothing, so its row may be best-effort. The database
    // writes one only for platform staff; for anyone else this records nothing.
    const refusal = async (message: string, reason?: string): Promise<UserError> => {
      recordPlatformFailure = null
      await recordPlatformAudit(supabaseUser, { ...subject(), outcome: 'denied' })
      return new UserError(message, 403, reason)
    }

    if (isPlatformCaller) {
      recordPlatformFailure = () => recordPlatformAudit(supabaseUser, { ...subject(), outcome: 'error' })
    }

    // The one company whose accounts this caller reaches, on every route (plan
    // 3.13a): a company admin's own company, or — for a platform account with
    // no company — the company of its open support session, asked with its own
    // token. No session, a view context, an expired one: no company at all.
    // This function acts with the service role, so the database's confinement
    // of a platform account never reaches it; this is where it is applied.
    const scope = await resolveManageUsersScope({
      isPlatformCaller,
      callerRole: callerProfile?.role ?? null,
      membershipCompanyId: callerProfile?.company_id ?? null,
      supportSessionCompanyId: () => platformSupportCompanyId(supabaseUser),
    })
    if (!scope.ok) {
      throw await refusal(MANAGE_USERS_SCOPE_MESSAGES[scope.refusal], scope.refusal)
    }
    const scopeCompanyId: string = scope.companyId

    /**
     * A change. For platform staff it runs only after its attempt row is
     * written, and its outcome row follows; a company admin's runs as it is.
     */
    const platformWrite = <T>(mutate: () => Promise<T>): Promise<T> => {
      if (!isPlatformCaller) return mutate()
      recordPlatformFailure = null
      return auditedPlatformWrite(supabaseUser, subject(), mutate, { details: () => ({ ...auditTarget }) })
    }

    /** A read. For platform staff its row is written before the response is built. */
    const platformRead = <T>(load: () => Promise<T>, details: (value: T) => PlatformAuditDetails): Promise<T> => {
      if (!isPlatformCaller) return load()
      recordPlatformFailure = null
      return auditedPlatformRead(supabaseUser, subject(), load, { details })
    }

    // The account a route acts on, checked before anything changes (see
    // decideAccountTarget): every caller reaches only the accounts of its scope's
    // company; a company admin never an account with a staff row, and platform
    // staff one with a staff row only with staff.manage. Every route below acts
    // with the service role, so without this a new address or password would let
    // the caller sign in as a platform owner. Returns the target's company, which
    // a platform action records.
    const authorizeAccount = async (targetUserId: unknown): Promise<string | null> => {
      if (typeof targetUserId !== 'string' || !UUID_SHAPE.test(targetUserId)) {
        throw new UserError('Ungültige Anfrage: user_id fehlt oder ist ungültig.', 400)
      }

      const { data: targetProfile, error: targetError } = await supabaseAdmin
        .from('user_profiles')
        .select('company_id')
        .eq('user_id', targetUserId)
        .maybeSingle()
      if (targetError) throw targetError

      const targetCompany: string | null = targetProfile?.company_id ?? null
      auditTarget.companyId = targetCompany
      auditTarget.targetType = 'user'
      auditTarget.targetId = targetUserId

      const decision = await decideAccountTarget({
        isPlatformCaller,
        scopeCompanyId,
        targetCompanyId: targetCompany,
        platformCanManage: () => platformCanManageAccount(supabaseUser, targetUserId),
        targetIsPlatformStaff: () => accountIsPlatformStaff(supabaseAdmin, targetUserId),
      })

      if (decision === 'other_company') {
        throw await refusal(OTHER_COMPANY_MESSAGE, 'other_company')
      }
      if (decision === 'platform_staff_account') {
        throw await refusal('Keine Berechtigung: Konten des Plattform-Teams dürfen nur Inhaber der Plattform verwalten.')
      }
      return targetCompany
    }

    // The role of that name for this company: the company's own role first, a
    // system role (company_id IS NULL) otherwise — the order current_role_permits()
    // resolves a text role in. `company_id.desc` alone would sort the NULL first
    // in PostgreSQL, so nullsFirst: false is what makes "own role first" true.
    // `companyId` is always the caller's scope, never text from the request, so
    // nothing a caller sends reaches the filter string.
    const roleIdFor = async (companyId: string, roleName: string | undefined): Promise<string | null> => {
      const { data: roleData } = await supabaseAdmin
        .from('roles')
        .select('id')
        .eq('name', roleName)
        .or(`company_id.eq.${companyId},company_id.is.null`)
        .order('company_id', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      return roleData?.id ?? null
    }

    // =========================================================================
    // LIST USERS
    // =========================================================================
    if (route?.name === 'list') {
      /*
        The company's profiles decide who is in the answer; GoTrue only fills
        in the two fields that live in auth.users alone.

        It used to run the other way round: `auth.admin.listUsers()` with no
        arguments, which is GoTrue's first page of **50 accounts of the whole
        project**, and the company filter was applied to that page. Above 50
        accounts on the installation a company's own users simply were not in
        it — a 200, a short array, no warning, and the truncated length written
        into the audit row as if it were the whole answer. Driving from
        user_profiles makes the scoped query the authority and removes the
        coupling entirely; resolveAuthAccounts then pages GoTrue and stops as
        soon as every id is resolved, so the ordinary installation still reads
        one page and no call issues one request per account.

        A profile whose auth account is not found is kept rather than dropped.
        Its address is on the profile (sync_user_profile_email copies it,
        whatever changed it), and an account row that has gone missing is a
        state worth seeing on the Benutzer screen — silently omitting it is the
        failure this route already had.
      */
      const { list, incomplete } = await platformRead(async () => {
        const { data: profiles, error: profileError } = await supabaseAdmin
          .from('user_profiles')
          .select('*, roles:role_id(id, name, description)')
          .eq('company_id', scopeCompanyId)
          .order('created_at', { ascending: true })
        if (profileError) throw profileError

        const rows = profiles ?? []
        const resolved = await resolveAuthAccounts(
          rows.map(p => p.user_id as string),
          async (page, perPage) => {
            const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage })
            if (error) throw error
            return data.users
          },
          { perPage: GOTRUE_PAGE_SIZE },
        )
        const authById = new Map(resolved.found.map(u => [u.id, u] as const))

        return {
          incomplete: !resolved.complete,
          list: rows.map(profile => {
            const authUser = authById.get(profile.user_id as string)
            return {
              id: profile.user_id,
              // user_profiles.email is NOT NULL and the sync_user_profile_email
              // trigger keeps it equal to auth.users.email, so a profile whose
              // account could not be resolved still carries its address.
              email: authUser?.email ?? profile.email ?? '',
              full_name: profile?.full_name || authUser?.user_metadata?.full_name || '',
              role: profile?.role || 'viewer',
              role_id: profile?.role_id || null,
              role_name: profile?.roles?.name || profile?.role || 'viewer',
              role_description: profile?.roles?.description || '',
              status: profile?.status || 'active',
              company_id: profile?.company_id || null,
              // A routing hint for the screen, not a right.
              is_super_admin: profile?.is_super_admin || false,
              invited_at: profile?.invited_at || null,
              activated_at: profile?.activated_at || null,
              must_change_password: profile?.must_change_password ?? false,
              created_at: authUser?.created_at ?? profile?.created_at ?? null,
              email_confirmed_at: authUser?.email_confirmed_at ?? null
            }
          }),
        }
      }, (answer) => ({ after: { count: answer.list.length, incomplete: answer.incomplete } }))

      if (incomplete) {
        // Not an error for the caller: the rows are the company's own and they
        // are all here. What could not be completed is the auth half of some of
        // them, and the log is where an operator learns that rather than the
        // screen. The audit row carries the same flag.
        logFailure('manage-users', 'list-auth-accounts-unresolved', {},
          new Error('some profiles of the company have no auth account on the pages read'))
      }

      // A bare array, as it has always been: UserManagement.tsx reads
      // `await response.json()` as the list itself.
      return json(req, 200, list)
    }

    // =========================================================================
    // CREATE USER
    // =========================================================================
    if (route?.name === 'create') {
      const body: CreateUserRequest = await req.json()

      // The new account goes into the caller's scope's company. A company_id in
      // the request may only repeat it: before 3.13a a platform account's was
      // taken as it came, for any company, and a company admin's was ignored.
      const target = decideCreateCompany(scopeCompanyId, body.company_id)
      auditTarget.targetType = 'user'
      if (!target.ok) {
        if (target.refusal === 'invalid_company') {
          throw new UserError('Ungültige Anfrage: company_id ist ungültig.', 400)
        }
        auditTarget.companyId = typeof body.company_id === 'string' ? body.company_id : null
        throw await refusal('Keine Berechtigung: Benutzer können nur im Unternehmen der eigenen Sitzung angelegt werden.', 'other_company')
      }
      const targetCompanyId = target.companyId
      auditTarget.companyId = targetCompanyId

      // Resolve role_id before creating the auth user so we can include it in
      // the upsert.
      const roleId = await roleIdFor(targetCompanyId, body.role)

      const useTempPassword = body.use_temp_password === true
      const password = useTempPassword
        ? (body.password || crypto.randomUUID())
        : (body.password || crypto.randomUUID())
      const profileStatus = useTempPassword ? 'active' : 'pending_invite'
      auditTarget.after = { role: body.role, status: profileStatus, invite: useTempPassword ? 'temp_password' : 'code' }

      const created = await platformWrite(async () => {
        // Create the auth user. The handle_new_user trigger will fire and insert
        // a minimal profile row (no company_id / role_id). We immediately follow
        // up with an upsert that sets all fields correctly.
        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
          email: body.email,
          password,
          email_confirm: true,
          user_metadata: { full_name: body.full_name, role: body.role }
        })

        if (createError) {
          const alreadyRegistered = /already (been )?registered|already exists/i.test(createError.message)
          if (alreadyRegistered) {
            throw new UserError('Diese E-Mail-Adresse ist bereits registriert.', 409)
          }
          throw createError
        }
        if (!newUser.user) throw new Error('createUser returned no user')

        auditTarget.targetId = newUser.user.id

        // Upsert the profile — if the trigger already inserted a row we update it,
        // otherwise we create it. This is robust regardless of trigger timing.
        const { error: profileError } = await supabaseAdmin
          .from('user_profiles')
          .upsert({
            user_id: newUser.user.id,
            email: body.email,
            full_name: body.full_name,
            role: body.role,
            role_id: roleId,
            company_id: targetCompanyId,
            status: profileStatus,
            invited_at: new Date().toISOString(),
            must_change_password: useTempPassword,
          }, { onConflict: 'user_id' })

        if (profileError) {
          // Half-created: the login exists, the profile does not. The admin needs
          // to know not to retry blindly, so this one is a UserError — but the
          // failing constraint stays in the log, reachable by request id.
          console.error(JSON.stringify({ level: 'error', fn: 'manage-users',
            step: 'profile-upsert-after-createUser', userId: newUser.user.id,
            detail: profileError.message }))
          throw new UserError(
            'Das Benutzerkonto wurde angelegt, das Profil konnte jedoch nicht gespeichert werden. Bitte wenden Sie sich an den Support.',
            500)
        }

        // Only invite by code for the email-invite flow (not temp password).
        // Temp-password users log in directly with the password the admin set.
        //
        // The invitation is a six-digit code the employee enters at /einladung;
        // no link in the mail carries a token. clientIp is null on purpose: the
        // per-IP limit guards the public endpoints, and an admin inviting a whole
        // office from one address would trip it. The per-address cooldown and
        // hourly limit still apply.
        if (!useTempPassword) {
          let sent = false
          try {
            const outcome = await issueAndSendOtp({
              purpose: 'invite_activate',
              email: newUser.user.email ?? body.email,
              clientIp: null,
              actorUserId: user.id,
            })
            sent = outcome.status === 'sent'
            if (!sent) {
              logFailure('manage-users', 'invite-code-after-createUser',
                { purpose: 'invite_activate', user_id: newUser.user.id },
                new Error(`invite not sent: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`))
            }
          } catch (inviteError) {
            logFailure('manage-users', 'invite-code-after-createUser',
              { purpose: 'invite_activate', user_id: newUser.user.id }, inviteError)
          }
          if (!sent) {
            // The account and profile exist; only the invitation failed. Say so, and
            // point at the button that retries it, rather than letting the admin
            // create the user again and hit "address already registered".
            throw new UserError(
              'Das Benutzerkonto wurde angelegt, die Einladungs-E-Mail konnte jedoch nicht gesendet werden. Bitte nutzen Sie „Einladung erneut senden".',
              502, 'send_failed')
          }
        }

        return { id: newUser.user.id, email: newUser.user.email }
      })

      return json(req, 200, {
        success: true,
        user: {
          id: created.id,
          email: created.email,
          full_name: body.full_name,
          role: body.role,
          role_id: roleId,
          company_id: targetCompanyId,
          status: profileStatus,
          must_change_password: useTempPassword,
        },
        ...(useTempPassword ? {} : { invite: { status: 'sent' } }),
      })
    }

    // =========================================================================
    // UPDATE USER
    // =========================================================================
    if (route?.name === 'update') {
      const body: UpdateUserRequest = await req.json()

      const targetCompany = await authorizeAccount(body.user_id)
      auditTarget.after = {
        role: body.role ?? null,
        full_name_changed: body.full_name !== undefined,
        email_changed: !!body.email,
        password_changed: !!body.password,
      }

      await platformWrite(async () => {
        if (body.email || body.password) {
          const updateData: { email?: string; password?: string } = {}
          if (body.email) updateData.email = body.email
          if (body.password) updateData.password = body.password
          const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(body.user_id, updateData)
          if (updateError) throw updateError
        }

        // The target's company is the caller's scope (authorizeAccount), so the
        // role comes from that company or the system roles — never from another
        // company that happens to have a role of the same name, which the
        // unscoped lookup before 3.13a could hand back.
        const roleId = await roleIdFor(targetCompany ?? scopeCompanyId, body.role)

        const updateProfileData: Record<string, unknown> = {
          full_name: body.full_name,
          role: body.role,
          role_id: roleId,
        }
        if (body.email) updateProfileData.email = body.email

        const { error: profileError } = await supabaseAdmin
          .from('user_profiles')
          .update(updateProfileData)
          .eq('user_id', body.user_id)

        if (profileError) throw profileError
      })

      return json(req, 200, { success: true })
    }

    // =========================================================================
    // ACTIVATE / DEACTIVATE
    // =========================================================================
    if (route?.name === 'activate-deactivate') {
      const body: ActivateDeactivateRequest = await req.json()

      await authorizeAccount(body.user_id)
      auditTarget.after = { status: body.status }

      await platformWrite(async () => {
        const updateData: Record<string, unknown> = { status: body.status }
        if (body.status === 'active') updateData.activated_at = new Date().toISOString()

        const { error: statusError } = await supabaseAdmin
          .from('user_profiles')
          .update(updateData)
          .eq('user_id', body.user_id)

        if (statusError) throw statusError
      })

      return json(req, 200, { success: true })
    }

    // =========================================================================
    // RESEND INVITE
    // =========================================================================
    if (route?.name === 'resend-invite') {
      const body: ResendInviteRequest = await req.json()

      await authorizeAccount(body.user_id)

      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(body.user_id)
      const email = userData.user?.email
      if (!email) throw new UserError('Benutzer nicht gefunden.', 404)

      await platformWrite(async () => {
        // A new code replaces the previous one. The database decides whether the
        // user can still be invited (pending_invite, in a company) and whether the
        // address is cooling down; each refusal carries a reason for the screen.
        const outcome = await issueAndSendOtp({
          purpose: 'invite_activate',
          email,
          clientIp: null,
          actorUserId: user.id,
        })
        if (outcome.status === 'rate_limited') {
          const seconds = outcome.retryAfterSeconds ?? 60
          throw outcome.reason === 'email_hourly'
            ? new UserError('Für diese Adresse wurden zu viele Einladungen angefordert. Bitte versuchen Sie es in einer Stunde erneut.',
              429, 'email_hourly', { retry_after_seconds: seconds })
            : new UserError(`Bitte warten Sie ${seconds} Sekunden, bevor Sie die Einladung erneut senden.`,
              429, 'cooldown', { retry_after_seconds: seconds })
        }
        if (outcome.status === 'send_failed') {
          throw new UserError('Die Einladungs-E-Mail konnte nicht gesendet werden. Bitte versuchen Sie es in einigen Minuten erneut.',
            502, 'send_failed')
        }
        if (outcome.status !== 'sent') {
          throw new UserError('Für diesen Benutzer ist keine Einladung mehr offen.', 409, 'not_pending')
        }

        await supabaseAdmin
          .from('user_profiles')
          .update({ invited_at: new Date().toISOString() })
          .eq('user_id', body.user_id)
      })

      return json(req, 200, { success: true })
    }

    // =========================================================================
    // RESET PASSWORD (admin sets new temp password)
    // =========================================================================
    if (route?.name === 'reset-password') {
      const body: ResetPasswordRequest = await req.json()

      if (!body.password || body.password.length < 8) {
        throw new UserError('Passwort muss mindestens 8 Zeichen lang sein.', 400)
      }

      await authorizeAccount(body.user_id)
      // Never the password.
      auditTarget.after = { must_change_password: true }

      await platformWrite(async () => {
        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(body.user_id, {
          password: body.password,
        })
        if (updateError) throw updateError

        const { error: profileError } = await supabaseAdmin
          .from('user_profiles')
          .update({ must_change_password: true, status: 'active' })
          .eq('user_id', body.user_id)

        if (profileError) throw profileError
      })

      return json(req, 200, { success: true })
    }

    // =========================================================================
    // DELETE USER
    // =========================================================================
    if (route?.name === 'delete') {
      const body = await req.json()
      const userId = body?.user_id

      const targetCompany = await authorizeAccount(userId)
      auditTarget.before = { company_id: targetCompany }

      await platformWrite(async () => {
        const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId)
        if (deleteError) throw deleteError
      })

      return json(req, 200, { success: true })
    }

    // Nothing was attempted, so nothing is recorded as failed.
    recordPlatformFailure = null
    return json(req, 404, { error: 'Endpoint not found' })

  } catch (error: unknown) {
    if (recordPlatformFailure) await recordPlatformFailure()
    // A UserError keeps its text; a GoTrue or Postgres error does not — it names
    // columns and constraints, and this function holds the service-role key. A
    // platform action whose audit row could not be written lands here too, and
    // answers 500 without having happened.
    return errorResponse(req, error, 'manage-users')
  }
})
