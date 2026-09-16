/**
 * Inviting a member of the platform team (plan 3.5).
 *
 * The same shape as a manage-users invitation: the account is created with a
 * random password nobody is told, its profile is written as `pending_invite`,
 * and a six-digit code is mailed. The person enters it at /einladung and sets a
 * password. Platform staff sign in with an address and a password only — no
 * code at sign-in, and never Google (the owner's decision of 16.09.2026).
 *
 * Two things make it different from a company invitation:
 *
 * - The profile has **no company**. `otp_issue` issues `invite_activate` for
 *   such a profile only when the account holds an active staff row
 *   (20260916130010), so the staff row is written before the code is asked for.
 * - The profile's role is `viewer`, the least the product has. Platform rights
 *   come from `app_private.platform_staff` through `platform_can()`, never from
 *   the profile, and a company-less `admin` profile is exactly the state the
 *   privilege guard of 20260916110010 had to close.
 *
 * Authorization is `staff.manage`, asked of the database with the caller's own
 * token, and every path writes its audit row: the attempt before the account is
 * created, then ok or error, and a denied row for a caller who may not.
 * `platform_staff_add` asks for the capability a second time, in the same
 * transaction that writes the row.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsFor, errorResponse, json, UserError } from '../_shared/http.ts'
import { issueAndSendOtp } from '../_shared/otp.ts'
import { logFailure } from '../_shared/otp-core.ts'
import {
  accountIsPlatformStaff,
  auditedPlatformWrite,
  platformCan,
  recordPlatformAudit,
  type PlatformAuditDetails,
  type PlatformAuditSubject,
} from '../_shared/platform-access.ts'
import {
  resolvePlatformStaffRoute,
  STAFF_ROLE_REFUSAL_DE,
  STAFF_ROLE_UNTIL_3_3,
  staffRoleIsAllowed,
} from '../_shared/platform-staff-routes.ts'

interface InviteRequest {
  email: string
  full_name: string
  /** Only 'owner' until plan step 3.3; anything else is refused. */
  role?: string
  note?: string
}

interface ResendRequest {
  user_id: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** What platform_staff_add answers. */
interface StaffAddResult {
  success: boolean
  reason?: string
  error?: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsFor(req) })
  }

  // Set once the caller is authorized, until the audited write takes over its
  // rows: a failure in between — a malformed body included — is recorded as an
  // error of the platform action it interrupted.
  let recordPlatformFailure: (() => Promise<unknown>) | null = null

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new UserError('Nicht authentifiziert.', 401)

    // The caller's own JWT: platform_can, platform_audit_record and
    // platform_staff_add all answer for whoever this token belongs to.
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

    const url = new URL(req.url)
    const route = resolvePlatformStaffRoute(req.method, url.pathname)
    if (!route) return json(req, 404, { error: 'Endpoint not found' })

    const auditTarget: PlatformAuditDetails = {}
    const subject = (): PlatformAuditSubject => ({
      category: route.category,
      action: route.action,
      ...auditTarget,
    })

    if (!(await platformCan(supabaseUser, route.capability))) {
      await recordPlatformAudit(supabaseUser, { ...subject(), outcome: 'denied' })
      throw new UserError('Keine Berechtigung: Nur Inhaber der Plattform dürfen das Plattform-Team verwalten.', 403)
    }

    recordPlatformFailure = () => recordPlatformAudit(supabaseUser, { ...subject(), outcome: 'error' })

    /** A change, between its attempt row and its outcome row. */
    const platformWrite = <T>(mutate: () => Promise<T>): Promise<T> => {
      recordPlatformFailure = null
      return auditedPlatformWrite(supabaseUser, subject(), mutate, { details: () => ({ ...auditTarget }) })
    }

    // =========================================================================
    // INVITE — a new account joins the platform team
    // =========================================================================
    if (route.name === 'invite') {
      const body: InviteRequest = await req.json()
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : ''

      if (!EMAIL_PATTERN.test(email) || fullName.length === 0) {
        throw new UserError('Ungültige Anfrage: E-Mail-Adresse und Name werden benötigt.', 400)
      }
      // Rule of plan step 3.3, applied before anything is created.
      if (!staffRoleIsAllowed(body.role)) {
        throw new UserError(STAFF_ROLE_REFUSAL_DE, 400, 'role_requires_3_3')
      }

      auditTarget.targetType = 'platform_staff'
      // Never the address: the audit log is read by people, and an invitation
      // that was refused should not leave one behind.
      auditTarget.after = { role: STAFF_ROLE_UNTIL_3_3, invite: 'code' }

      const created = await platformWrite(async () => {
        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
          email,
          password: crypto.randomUUID(),
          email_confirm: true,
          user_metadata: { full_name: fullName },
        })

        if (createError) {
          const alreadyRegistered = /already (been )?registered|already exists/i.test(createError.message)
          if (alreadyRegistered) {
            throw new UserError(
              'Diese E-Mail-Adresse ist bereits registriert. Ein bestehendes Konto wird über „Zum Team hinzufügen" aufgenommen.',
              409, 'already_registered')
          }
          throw createError
        }
        if (!newUser.user) throw new Error('createUser returned no user')

        const userId = newUser.user.id
        auditTarget.targetId = userId

        /** Undoes the account when a later step refuses, so a retry is not blocked. */
        const discardAccount = async (): Promise<void> => {
          const { error } = await supabaseAdmin.auth.admin.deleteUser(userId)
          if (error) {
            logFailure('platform-staff', 'discard-after-failed-invite', { user_id: userId }, error)
          }
        }

        // No company, and the least role the product has: platform rights come
        // from platform_staff, and a company-less 'admin' profile is the state
        // the privilege guard closed.
        const { error: profileError } = await supabaseAdmin
          .from('user_profiles')
          .upsert({
            user_id: userId,
            email,
            full_name: fullName,
            role: 'viewer',
            role_id: null,
            company_id: null,
            status: 'pending_invite',
            invited_at: new Date().toISOString(),
            must_change_password: false,
          }, { onConflict: 'user_id' })

        if (profileError) {
          await discardAccount()
          console.error(JSON.stringify({ level: 'error', fn: 'platform-staff',
            step: 'profile-upsert-after-createUser', userId, detail: profileError.message }))
          throw new UserError('Das Konto konnte nicht angelegt werden. Bitte versuchen Sie es erneut.', 500)
        }

        // The staff row, with the caller's own token: platform_staff_add checks
        // staff.manage again and writes its own audit row in the same
        // transaction. It must exist before the code is asked for — otp_issue
        // issues invite_activate for a company-less profile only when the
        // account holds an active staff row.
        const { data: addData, error: addError } = await supabaseUser.rpc('platform_staff_add', {
          p_user_id: userId,
          p_role: STAFF_ROLE_UNTIL_3_3,
          p_note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
        })
        if (addError) {
          await discardAccount()
          throw addError
        }
        const added = addData as StaffAddResult | null
        if (!added?.success) {
          await discardAccount()
          throw new UserError(added?.error ?? 'Das Konto konnte dem Plattform-Team nicht hinzugefügt werden.',
            added?.reason === 'denied' ? 403 : 409, added?.reason)
        }

        // The invitation itself. The account and the staff row exist by now, so
        // a failed send is reported as such and the button retries it, exactly
        // as manage-users does. clientIp is null on purpose: the per-IP limit
        // guards the public endpoints.
        let sent = false
        try {
          const outcome = await issueAndSendOtp({
            purpose: 'invite_activate',
            email,
            clientIp: null,
            actorUserId: user.id,
          })
          sent = outcome.status === 'sent'
          if (!sent) {
            logFailure('platform-staff', 'invite-code-after-createUser',
              { purpose: 'invite_activate', user_id: userId },
              new Error(`invite not sent: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`))
          }
        } catch (inviteError) {
          logFailure('platform-staff', 'invite-code-after-createUser',
            { purpose: 'invite_activate', user_id: userId }, inviteError)
        }
        if (!sent) {
          throw new UserError(
            'Das Konto wurde angelegt, die Einladungs-E-Mail konnte jedoch nicht gesendet werden. Bitte nutzen Sie „Einladung erneut senden".',
            502, 'send_failed')
        }

        return { id: userId, email }
      })

      return json(req, 200, {
        success: true,
        staff: {
          user_id: created.id,
          email: created.email,
          full_name: fullName,
          role: STAFF_ROLE_UNTIL_3_3,
          status: 'pending_invite',
        },
        invite: { status: 'sent' },
      })
    }

    // =========================================================================
    // RESEND INVITE — a new code for a staff member who has not activated yet
    // =========================================================================
    if (route.name === 'resend-invite') {
      const body: ResendRequest = await req.json()
      const userId = body?.user_id

      if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) {
        throw new UserError('Ungültige Anfrage: user_id fehlt oder ist ungültig.', 400)
      }
      auditTarget.targetType = 'platform_staff'
      auditTarget.targetId = userId

      // Only an account that is already on the team. Without this, staff.manage
      // would double as "send a code to any account", which is the invitation
      // route of manage-users and belongs to company_users.manage.
      if (!(await accountIsPlatformStaff(supabaseAdmin, userId))) {
        recordPlatformFailure = null
        await recordPlatformAudit(supabaseUser, { ...subject(), outcome: 'denied' })
        throw new UserError('Dieses Konto gehört nicht zum Plattform-Team.', 404, 'not_staff')
      }

      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId)
      const email = userData.user?.email
      if (!email) throw new UserError('Konto nicht gefunden.', 404)

      await platformWrite(async () => {
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
          throw new UserError('Für dieses Konto ist keine Einladung mehr offen.', 409, 'not_pending')
        }

        await supabaseAdmin
          .from('user_profiles')
          .update({ invited_at: new Date().toISOString() })
          .eq('user_id', userId)
      })

      return json(req, 200, { success: true, invite: { status: 'sent' } })
    }

    recordPlatformFailure = null
    return json(req, 404, { error: 'Endpoint not found' })

  } catch (error: unknown) {
    if (recordPlatformFailure) await recordPlatformFailure()
    // A UserError keeps its text; a GoTrue or Postgres error does not — it names
    // columns and constraints, and this function holds the service-role key.
    return errorResponse(req, error, 'platform-staff')
  }
})
