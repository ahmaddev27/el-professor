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
  recordPlatformAudit,
  type PlatformAuditDetails,
  type PlatformAuditSubject,
} from '../_shared/platform-access.ts'
import { decideAccountTarget, resolveManageUsersRoute } from '../_shared/manage-users-routes.ts'

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    // the profile. A platform account holding the route's capability acts across
    // companies; everyone else is a company admin or nobody.
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
    const refusal = async (message: string): Promise<UserError> => {
      recordPlatformFailure = null
      await recordPlatformAudit(supabaseUser, { ...subject(), outcome: 'denied' })
      return new UserError(message, 403)
    }

    if (!isPlatformCaller && callerProfile?.role !== 'admin') {
      throw await refusal('Keine Berechtigung: Nur Administratoren dürfen Benutzer verwalten.')
    }

    const callerCompanyId: string | null = callerProfile?.company_id ?? null

    // A company admin with no company has no tenant to administer. This state
    // once fell through every tenant check as "no restriction" and turned a
    // company-less 'admin' profile into a de-facto platform account. Deny it.
    if (!isPlatformCaller && !callerCompanyId) {
      throw await refusal('Keine Berechtigung: Dieses Administratorkonto ist keinem Unternehmen zugeordnet.')
    }

    if (isPlatformCaller) {
      recordPlatformFailure = () => recordPlatformAudit(supabaseUser, { ...subject(), outcome: 'error' })
    }

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
    // decideAccountTarget): a company admin reaches only its own company's users
    // and never an account with a staff row; platform staff reach an account with
    // a staff row only with staff.manage. Every route below acts with the service
    // role, so without this a new address or password would let the caller sign
    // in as a platform owner. Returns the target's company, which a platform
    // action records.
    const authorizeAccount = async (targetUserId: unknown): Promise<string | null> => {
      if (typeof targetUserId !== 'string' || !UUID_PATTERN.test(targetUserId)) {
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
        callerCompanyId,
        targetCompanyId: targetCompany,
        platformCanManage: () => platformCanManageAccount(supabaseUser, targetUserId),
        targetIsPlatformStaff: () => accountIsPlatformStaff(supabaseAdmin, targetUserId),
      })

      if (decision === 'other_company') {
        throw new UserError('Keine Berechtigung: Dieser Benutzer gehört zu einem anderen Unternehmen.', 403)
      }
      if (decision === 'platform_staff_account') {
        throw await refusal('Keine Berechtigung: Konten des Plattform-Teams dürfen nur Inhaber der Plattform verwalten.')
      }
      return targetCompany
    }

    // =========================================================================
    // LIST USERS
    // =========================================================================
    if (route?.name === 'list') {
      const usersWithProfiles = await platformRead(async () => {
        const { data: users, error } = await supabaseAdmin.auth.admin.listUsers()
        if (error) throw error

        const userIds = users.users.map(u => u.id)

        let profileQuery = supabaseAdmin
          .from('user_profiles')
          .select('*, roles:role_id(id, name, description)')
          .in('user_id', userIds)

        // A platform account sees all users; a company admin only its company
        if (!isPlatformCaller) {
          profileQuery = profileQuery.eq('company_id', callerCompanyId)
        }

        const { data: profiles } = await profileQuery

        // Filter auth users to match the profiles visible to this caller
        const visibleUserIds = new Set(profiles?.map(p => p.user_id) ?? [])

        return users.users
          .filter(u => isPlatformCaller || visibleUserIds.has(u.id))
          .map(authUser => {
            const profile = profiles?.find(p => p.user_id === authUser.id)
            return {
              id: authUser.id,
              email: authUser.email,
              full_name: profile?.full_name || authUser.user_metadata?.full_name || '',
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
              created_at: authUser.created_at,
              email_confirmed_at: authUser.email_confirmed_at
            }
          })
      }, (list) => ({ after: { count: list.length } }))

      return json(req, 200, usersWithProfiles)
    }

    // =========================================================================
    // CREATE USER
    // =========================================================================
    if (route?.name === 'create') {
      const body: CreateUserRequest = await req.json()

      // Determine which company to assign this user to.
      // A platform account can pass a company_id; company admins always use their own.
      const targetCompanyId = isPlatformCaller && body.company_id
        ? body.company_id
        : callerCompanyId

      auditTarget.companyId = targetCompanyId
      auditTarget.targetType = 'user'

      if (!targetCompanyId) {
        throw new UserError('Benutzer kann nicht angelegt werden: kein Unternehmen ausgewählt.', 400)
      }

      // Resolve role_id before creating the auth user so we can include it in
      // the upsert. Search by name in the company's own roles first, then
      // fall back to system roles (company_id IS NULL).
      const { data: roleData } = await supabaseAdmin
        .from('roles')
        .select('id, name')
        .eq('name', body.role)
        .or(`company_id.eq.${targetCompanyId},company_id.is.null`)
        .order('company_id', { ascending: false }) // prefer company-scoped over null
        .limit(1)
        .maybeSingle()

      const roleId = roleData?.id ?? null

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

      await authorizeAccount(body.user_id)
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

        const { data: roleData } = await supabaseAdmin
          .from('roles')
          .select('id')
          .eq('name', body.role)
          .maybeSingle()

        const updateProfileData: Record<string, unknown> = {
          full_name: body.full_name,
          role: body.role,
          role_id: roleData?.id || null,
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
