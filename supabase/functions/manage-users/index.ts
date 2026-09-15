import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsFor, errorResponse, UserError } from '../_shared/http.ts'
import { issueAndSendOtp } from '../_shared/otp.ts'
import { logFailure } from '../_shared/otp-core.ts'

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsFor(req) })
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new UserError('Nicht authentifiziert.', 401)

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) throw new UserError('Nicht authentifiziert.', 401)

    // Load caller's profile: company_id, role, is_super_admin
    const { data: callerProfile } = await supabaseAdmin
      .from('user_profiles')
      .select('role, company_id, is_super_admin')
      .eq('user_id', user.id)
      .single()

    if (callerProfile?.role !== 'admin' && !callerProfile?.is_super_admin) {
      throw new UserError('Keine Berechtigung: Nur Administratoren dürfen Benutzer verwalten.', 403)
    }

    const callerCompanyId: string | null = callerProfile?.company_id ?? null
    const isSuperAdmin: boolean = callerProfile?.is_super_admin ?? false

    // A non-super-admin with no company has no tenant to administer. Previously
    // this state fell through every `if (!isSuperAdmin && callerCompanyId)` check
    // as "no restriction", which turned a company-less 'admin' profile into a
    // de-facto super admin. Deny it outright.
    if (!isSuperAdmin && !callerCompanyId) {
      throw new UserError('Keine Berechtigung: Dieses Administratorkonto ist keinem Unternehmen zugeordnet.', 403)
    }

    // Tenant check for a single target user. Never compares two NULLs as a match:
    // both the caller's and the target's company must be present and identical.
    const assertSameCompany = async (targetUserId: string): Promise<void> => {
      if (isSuperAdmin) return

      const { data: targetProfile } = await supabaseAdmin
        .from('user_profiles')
        .select('company_id')
        .eq('user_id', targetUserId)
        .maybeSingle()

      const targetCompany: string | null = targetProfile?.company_id ?? null

      if (!targetCompany || targetCompany !== callerCompanyId) {
        throw new UserError('Keine Berechtigung: Dieser Benutzer gehört zu einem anderen Unternehmen.', 403)
      }
    }

    const url = new URL(req.url)
    const method = req.method
    const path = url.pathname

    // =========================================================================
    // LIST USERS
    // =========================================================================
    if (method === 'GET' && path.includes('/list')) {
      const { data: users, error } = await supabaseAdmin.auth.admin.listUsers()
      if (error) throw error

      const userIds = users.users.map(u => u.id)

      let profileQuery = supabaseAdmin
        .from('user_profiles')
        .select('*, roles:role_id(id, name, description)')
        .in('user_id', userIds)

      // Super admins see all users; company admins see only their company
      if (!isSuperAdmin) {
        profileQuery = profileQuery.eq('company_id', callerCompanyId)
      }

      const { data: profiles } = await profileQuery

      // Filter auth users to match the profiles visible to this caller
      const visibleUserIds = new Set(profiles?.map(p => p.user_id) ?? [])

      const usersWithProfiles = users.users
        .filter(u => isSuperAdmin || visibleUserIds.has(u.id))
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
            is_super_admin: profile?.is_super_admin || false,
            invited_at: profile?.invited_at || null,
            activated_at: profile?.activated_at || null,
            must_change_password: profile?.must_change_password ?? false,
            created_at: authUser.created_at,
            email_confirmed_at: authUser.email_confirmed_at
          }
        })

      return new Response(JSON.stringify(usersWithProfiles), {
        headers: { ...corsFor(req), 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // =========================================================================
    // CREATE USER
    // =========================================================================
    if (method === 'POST' && path.includes('/create')) {
      const body: CreateUserRequest = await req.json()

      // Determine which company to assign this user to.
      // Super admins can pass a company_id; company admins always use their own.
      const targetCompanyId = isSuperAdmin && body.company_id
        ? body.company_id
        : callerCompanyId

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

      // Create the auth user. The handle_new_user trigger will fire and insert
      // a minimal profile row (no company_id / role_id). We immediately follow
      // up with an upsert that sets all fields correctly.
      const useTempPassword = body.use_temp_password === true
      const password = useTempPassword
        ? (body.password || crypto.randomUUID())
        : (body.password || crypto.randomUUID())

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

      // Upsert the profile — if the trigger already inserted a row we update it,
      // otherwise we create it. This is robust regardless of trigger timing.
      const profileStatus = useTempPassword ? 'active' : 'pending_invite'

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

      return new Response(
        JSON.stringify({
          success: true,
          user: {
            id: newUser.user.id,
            email: newUser.user.email,
            full_name: body.full_name,
            role: body.role,
            role_id: roleId,
            company_id: targetCompanyId,
            status: profileStatus,
            must_change_password: useTempPassword,
          },
          ...(useTempPassword ? {} : { invite: { status: 'sent' } }),
        }),
        { headers: { ...corsFor(req), 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // =========================================================================
    // UPDATE USER
    // =========================================================================
    if (method === 'PUT' && path.includes('/update')) {
      const body: UpdateUserRequest = await req.json()

      // Verify caller can manage this user (same company or super admin)
      await assertSameCompany(body.user_id)

      if (body.email || body.password) {
        const updateData: any = {}
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

      const roleId = roleData?.id || null

      const updateProfileData: any = {
        full_name: body.full_name,
        role: body.role,
        role_id: roleId
      }
      if (body.email) updateProfileData.email = body.email

      const { error: profileError } = await supabaseAdmin
        .from('user_profiles')
        .update(updateProfileData)
        .eq('user_id', body.user_id)

      if (profileError) throw profileError

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsFor(req), 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // =========================================================================
    // ACTIVATE / DEACTIVATE
    // =========================================================================
    if (method === 'POST' && path.includes('/activate-deactivate')) {
      const body: ActivateDeactivateRequest = await req.json()

      await assertSameCompany(body.user_id)

      const updateData: any = { status: body.status }
      if (body.status === 'active') updateData.activated_at = new Date().toISOString()

      const { error: statusError } = await supabaseAdmin
        .from('user_profiles')
        .update(updateData)
        .eq('user_id', body.user_id)

      if (statusError) throw statusError

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsFor(req), 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // =========================================================================
    // RESEND INVITE
    // =========================================================================
    if (method === 'POST' && path.includes('/resend-invite')) {
      const body: ResendInviteRequest = await req.json()

      await assertSameCompany(body.user_id)

      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(body.user_id)
      if (!userData.user?.email) throw new UserError('Benutzer nicht gefunden.', 404)

      // A new code replaces the previous one. The database decides whether the
      // user can still be invited (pending_invite, in a company) and whether the
      // address is cooling down; each refusal carries a reason for the screen.
      const outcome = await issueAndSendOtp({
        purpose: 'invite_activate',
        email: userData.user.email,
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

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsFor(req), 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // =========================================================================
    // RESET PASSWORD (admin sets new temp password)
    // =========================================================================
    if (method === 'POST' && path.includes('/reset-password')) {
      const body: ResetPasswordRequest = await req.json()

      if (!body.password || body.password.length < 8) {
        throw new UserError('Passwort muss mindestens 8 Zeichen lang sein.', 400)
      }

      await assertSameCompany(body.user_id)

      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(body.user_id, {
        password: body.password,
      })
      if (updateError) throw updateError

      const { error: profileError } = await supabaseAdmin
        .from('user_profiles')
        .update({ must_change_password: true, status: 'active' })
        .eq('user_id', body.user_id)

      if (profileError) throw profileError

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsFor(req), 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // =========================================================================
    // DELETE USER
    // =========================================================================
    if (method === 'DELETE' && path.includes('/delete')) {
      const body = await req.json()
      const userId = body.user_id

      await assertSameCompany(userId)

      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId)
      if (deleteError) throw deleteError

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsFor(req), 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    return new Response(
      JSON.stringify({ error: 'Endpoint not found' }),
      { headers: { ...corsFor(req), 'Content-Type': 'application/json' }, status: 404 }
    )

  } catch (error: unknown) {
    // A UserError keeps its text; a GoTrue or Postgres error does not — it names
    // columns and constraints, and this function holds the service-role key.
    return errorResponse(req, error, 'manage-users')
  }
})
