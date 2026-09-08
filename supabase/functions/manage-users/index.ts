import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

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
    return new Response(null, { status: 200, headers: corsHeaders })
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
    if (!authHeader) throw new Error('No authorization header')

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) throw new Error('Authentication failed')

    // Load caller's profile: company_id, role, is_super_admin
    const { data: callerProfile } = await supabaseAdmin
      .from('user_profiles')
      .select('role, company_id, is_super_admin')
      .eq('user_id', user.id)
      .single()

    if (callerProfile?.role !== 'admin' && !callerProfile?.is_super_admin) {
      throw new Error('Access denied: Only administrators can manage users')
    }

    const callerCompanyId: string | null = callerProfile?.company_id ?? null
    const isSuperAdmin: boolean = callerProfile?.is_super_admin ?? false

    // A non-super-admin with no company has no tenant to administer. Previously
    // this state fell through every `if (!isSuperAdmin && callerCompanyId)` check
    // as "no restriction", which turned a company-less 'admin' profile into a
    // de-facto super admin. Deny it outright.
    if (!isSuperAdmin && !callerCompanyId) {
      throw new Error('Access denied: administrator account is not assigned to a company')
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
        throw new Error('Access denied: Cannot manage users from another company')
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
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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
        throw new Error('Cannot create user: no company context available')
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
        throw new Error(`Failed to create user: ${createError.message}`)
      }
      if (!newUser.user) throw new Error('User creation failed: no user data returned')

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
        // Auth user was created but profile failed — surface the real reason
        throw new Error(`User created in auth but profile save failed: ${profileError.message}`)
      }

      // Only send invite email for the email-invite flow (not temp password).
      // Temp-password users log in directly with the password the admin set.
      if (!useTempPassword) {
        const appOrigin = req.headers.get('origin') || req.headers.get('referer')?.replace(/\/$/, '') || ''
        await supabaseAdmin.auth.admin.generateLink({
          type: 'recovery',
          email: body.email,
          options: appOrigin ? { redirectTo: `${appOrigin}/auth/callback` } : undefined,
        })
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
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
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
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
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
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // =========================================================================
    // RESEND INVITE
    // =========================================================================
    if (method === 'POST' && path.includes('/resend-invite')) {
      const body: ResendInviteRequest = await req.json()

      await assertSameCompany(body.user_id)

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
        .eq('user_id', body.user_id)

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // =========================================================================
    // RESET PASSWORD (admin sets new temp password)
    // =========================================================================
    if (method === 'POST' && path.includes('/reset-password')) {
      const body: ResetPasswordRequest = await req.json()

      if (!body.password || body.password.length < 8) {
        throw new Error('Passwort muss mindestens 8 Zeichen lang sein')
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
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
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
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    return new Response(
      JSON.stringify({ error: 'Endpoint not found' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
    )

  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message || 'An unexpected error occurred' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
