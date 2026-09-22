#!/usr/bin/env node
/**
 * The proof that batch 4 changed how its screens look and nothing they do.
 *
 *   node design-harness/batch4/logic-identity.mjs            base = merge-base with origin/staging
 *   node design-harness/batch4/logic-identity.mjs --base <ref> [--verbose]
 *
 * Three checks, all against the base commit's text:
 *
 * 1. Untouched. The files that decide who may see what — App.tsx's gates and
 *    SignInRoute, AuthContext (googleSignInRefusal, the sign-in branches),
 *    SuperAdminContext, PlanContext, every module in src/lib (otpClient,
 *    adminGate's rememberedPanelPath, googleSignIn's one-time marker,
 *    authProviderSettings, oauthAccountClient), the OTP hand-off hook and the
 *    plan and pricing utilities — are byte-identical.
 *
 * 2. Verbatim blocks. For every converted file, the blocks listed below — its
 *    state, effects, queries, handlers and redirects — appear in the new file
 *    exactly as they stood, as one contiguous substring each. A block is named
 *    by its first and last line in the base file, so the list survives a
 *    rebase that moves line numbers.
 *
 * 3. Call sites. Every call the screen makes — to AuthContext, the OTP client,
 *    the session hand-off, manage-users, the database, the router — is
 *    extracted from the base file with its full argument list and must appear
 *    in the new file with the same text. This catches a call that moved out of
 *    a verbatim block into the markup (a button's onClick) and was retyped.
 *
 * `--verbose` prints, per file, the base lines outside every block: what the
 * conversion removed or rewrote, which should all be markup and styling.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;

const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const base = baseArg ?? git('merge-base', 'HEAD', 'origin/staging').trim();
const lf = text => text.replace(/\r\n/g, '\n');
const baseText = path => lf(git('show', `${base}:${path}`));
const workText = path => lf(readFileSync(join(root, path), 'utf8'));

// ─── 1. Untouched ────────────────────────────────────────────────────────────

const UNTOUCHED = [
  'src/App.tsx',
  'src/contexts/AuthContext.tsx',
  'src/contexts/SuperAdminContext.tsx',
  'src/contexts/PlanContext.tsx',
  'src/contexts/AppConfigContext.tsx',
  'src/contexts/CompanySettingsContext.tsx',
  'src/lib',
  'src/hooks',
  'src/utils/planState.ts',
  'src/utils/pricing.ts',
  'src/utils/backup.ts',
  'src/utils/excelExport.ts',
  'src/types',
  'supabase',
];

// ─── 2. Verbatim blocks, per file ────────────────────────────────────────────
// Each block is named by its first and last line as they read in the base file
// (trailing space ignored). `last` is the first such line at or after `first` —
// or, with `after`, the first one after the line `after`, for a closing `  };`
// that would otherwise match an earlier handler's.

const block = (first, last, after) => ({ first, last, after });
/** One line on its own: a block that is its own first and last line. */
const line = text => block(text, text);
/**
 * A condition that decides what is shown, found in the base and in the new
 * file with its indentation and line breaks ignored — markup around it moves,
 * the test itself must not change.
 */
const expression = text => ({ expression: text });

const BLOCKS = {
  'src/components/LoginForm.tsx': [
    // Imports that stayed; the rest were markup's (the icons, LanguageSwitcher).
    line("import { useAuth, BLOCK_MESSAGE_KEYS } from '../contexts/AuthContext';"),
    line("import { useTranslation } from '../contexts/LanguageContext';"),
    line("import GoogleButton from './auth/GoogleButton';"),
    // toErrorKey, isUnconfirmedEmail, the state, the notice effect, handleSubmit.
    block('/**', '  };', '  const handleSubmit = async (e: React.FormEvent) => {'),
  ],
  'src/components/auth/GoogleButton.tsx': [
    // Imports, GoogleMark, the settings read and the press: everything but the markup.
    block("import React, { useEffect, useState } from 'react';", '  };', '  const press = async () => {'),
  ],
  'src/components/auth/OtpCodeInput.tsx': [
    block("import React, { useEffect, useId, useRef } from 'react';", "import type { AuthSurface } from './authStyles';"),
    block('export interface OtpCodeInputProps {', '  };', '  const handleFocus = (index: number, event: React.FocusEvent<HTMLInputElement>) => {'),
  ],
  'src/components/auth/OtpChallenge.tsx': [
    block("import React, { useEffect, useId, useRef, useState } from 'react';", "import OtpCodeInput from './OtpCodeInput';"),
    // Props, verify, resend, and the derived recipient / verifyDisabled / resendDisabled / describedBy.
    block('export interface OtpChallengeProps {', "  const describedBy = hint === null ? alertId : `${hintId} ${alertId}`;"),
  ],
  'src/components/auth/NoticeBox.tsx': [
    block("  const Icon = tone === 'error' ? AlertCircle : CheckCircle2;", "  const role = announce ? (tone === 'error' ? 'alert' : 'status') : undefined;"),
  ],
  'src/components/LanguageSwitcher.tsx': [
    block('  const { language, setLanguage, t } = useTranslation();', '  }, [isOpen]);'),
    line('  const active = LANGUAGES.find(l => l.code === language);'),
    line('                onClick={() => { setLanguage(option.code); setIsOpen(false); }}'),
  ],
  'src/pages/ForgotPasswordPage.tsx': [
    block("import React, { useState } from 'react';", "import OtpChallenge from '../components/auth/OtpChallenge';"),
    block('type Challenge = { email: string; cooldownSeconds: number; notice: OtpNotice };', '  };', '  const handleVerified = async (result: OtpVerifySuccess): Promise<OtpVerifyFailure | void> => {'),
  ],
  'src/pages/VerifyEmailPage.tsx': [
    block("import React, { useState } from 'react';", "import OtpChallenge from '../components/auth/OtpChallenge';"),
    block('type Challenge = { email: string; cooldownSeconds: number; notice: OtpNotice | null };', '  };', '  const handleFailure = (result: OtpVerifyFailure): boolean => {'),
  ],
  'src/pages/SetPasswordPage.tsx': [
    block("import React, { useEffect, useState } from 'react';", "import EmphasizedText from '../components/auth/EmphasizedText';"),
    // MIN_LEN, the session and profile read, the platform-role question, handleSubmit.
    block('const MIN_LEN = 8;', '  };', "      setTimeout(() => navigate('/', { replace: true }), 1200);"),
  ],
  'src/pages/InviteAcceptPage.tsx': [
    block("import React, { useState } from 'react';", "import OtpChallenge from '../components/auth/OtpChallenge';"),
    block('/**', '  };', '  const handleVerified = async (result: OtpVerifySuccess): Promise<OtpVerifyFailure | void> => {'),
  ],
  'src/components/signup/plans.ts': [
    // Every field but the per-tier colour, which only the old cards read.
    block('export interface PlanDef {', '  highlight: boolean;'),
    line('  features: TranslationKey[];'),
    ...['basic', 'advanced', 'premium'].map(id => line(`    id: '${id}',`)),
    line("    features: ['nav.overview', 'nav.belege', 'nav.fahrer', 'nav.cars', 'nav.umsaetze', 'nav.fixkosten', 'nav.bargeldbestand'],"),
    line("    features: ['signup.plan.everythingInBasic', 'nav.werkstatt', 'nav.abrechnung', 'nav.notes', 'locked.feature.rollenNutzer'],"),
    line("    features: ['signup.plan.everythingInAdvanced', 'nav.salaries', 'nav.documents', 'locked.feature.stundennachweis'],"),
    line("export const planDef = (plan: Plan): PlanDef => PLANS.find(entry => entry.id === plan) ?? PLANS[0];"),
  ],
  'src/components/signup/PlanSelection.tsx': [
    block("import React, { useState } from 'react';", "import { PLANS, planDef } from './plans';"),
    // PricePreview's figures (not the tier colour, the one line dropped).
    block('const PricePreview: React.FC<{', '  const fleetPct = fleetDiscountPercent(priceBook, carLimit);'),
    block('  // current_price that was passed to edge fn = bp.finalTotal', '  const finalPrice = discount ? discount.final_price : bp.finalTotal;'),
    // The figures the price box prints, each an expression in the markup.
    expression('{fmtPrice(bp.baseMonthly)}'),
    expression('{fleetPct > 0 && ('),
    expression('-{fmtPrice(bp.baseMonthly - bp.monthlyAfterFleet)} €'),
    expression("-{fmtPrice(billingCycle === 'yearly' ? bp.monthlyAfterFleet * 12 - bp.yearlyTotal : 0)} €"),
    expression('-{fmtPrice(discount.discount_amount)} €'),
    expression('{fmtPrice(finalPrice)} €'),
    expression('{fmtPrice(finalPrice / 12)} €'),
    expression("{t('signup.price.driverLimitNote', { count: carLimit * 4 })}"),
    // The discount check: its state and the call to validate-discount-code.
    block('const DiscountCodeInput: React.FC<{', '  };', '  const handleApply = async () => {'),
    expression('if (applied) {'),
    expression("{loading ? '…' : t('signup.discount.apply')}"),
    // PlanSelection's props, hooks, trial date and breakdown (not selectedPlanDef).
    block('interface PlanSelectionProps {', '  const { priceBook, trialDays } = useAppConfig();'),
    block('  const trialEndDate = new Date();', '  const breakdown = calcPricing(priceBook, plan, carLimit, billingCycle);'),
    expression("{t('signup.cars.driverLimit', { count: carLimit * 4 })}"),
    expression('{fleetDiscountPercent(priceBook, carLimit) > 0 && ('),
    expression('-{priceBook.yearly_discount_percent}%'),
    expression('{showTrialCallout && ('),
  ],
  'src/pages/SignupPage.tsx': [
    block("import { Plan } from '../contexts/PlanContext';", "import OtpChallenge from '../components/auth/OtpChallenge';"),
    block("import PlanSelection from '../components/signup/PlanSelection';", "type Step = 'plan' | 'company' | 'account' | 'verify';"),
    // Steps, state, company-signup, the hand-off, the failure branch, the tier.
    block("const STEPS: Step[] = ['plan', 'company', 'account', 'verify'];", '  const selectedPlanDef = planDef(selectedPlan);'),
    expression("{step === 'verify' && ("),
    expression("{step === 'plan' && ("),
    expression("{step === 'company' && ("),
    expression("{step === 'account' && ("),
    expression('{verifiedWithoutSession ? ('),
    expression("aria-current={step === s ? 'step' : undefined}"),
    expression('{i < stepIndex ? <Check size={12} aria-hidden="true" /> : i + 1}'),
    expression('{i < STEPS.length - 1 &&'),
    expression("{t('signup.continueWith', { plan: selectedPlanDef.name })}"),
    expression("{t('signup.summaryLead', { days: trialDays })}"),
    expression("cycle: billingCycle === 'yearly' ? t('signup.billing.yearlyAdj') : t('signup.billing.monthlyAdj'),"),
  ],
  'src/pages/CompleteRegistrationPage.tsx': [
    block("import { useAuth } from '../contexts/AuthContext';", "import NoticeBox from '../components/auth/NoticeBox';"),
    // The doc, the component, register, discard, leaveToLogin and the waiting page.
    block("import PendingApprovalPage from './PendingApprovalPage';", '        <PendingApprovalPage onSignOut={leaveToLogin} />'),
    expression("{googleSignInIntent?.from === 'invite' && ("),
    expression('{error && <NoticeBox tone="error" announce>{error}</NoticeBox>}'),
    expression('{dead ? ('),
    expression('{!dead && ( confirmDiscard ? ('),
    expression('{!dead && ('),
    expression("t('gsignup.subtitle', { email: user?.email ?? '' })"),
  ],
  'src/pages/AuthCallbackPage.tsx': [
    block("import React, { useEffect, useState } from 'react';", "import { callbackFailureView } from '../lib/oauthErrors';"),
    // The fragment error, the Google marker, the session poll and both redirects.
    block("type CallbackType = 'recovery' | 'invite' | 'signup' | 'magiclink' | 'email_change' | string;", '  }, [navigate, t]);'),
    expression('{!fromGoogle && ('),
    expression("{fromGoogle ? t('auth.signIn') : t('signup.callback.title')}"),
  ],
  'src/components/UserManagement.tsx': [
    block("import { useAuth } from '../contexts/AuthContext';", "import { supabase } from '../lib/supabase';"),
    block("import { exportTableToExcel } from '../utils/excelExport';", "import { inviteCreateFailure, resendInviteOutcome } from '../lib/accountFunctionResponses';"),
    // UserData, the form's props, the form's roles read, reset, submit and its closed state.
    block('interface UserData {', '  if (!isOpen) return null;'),
    expression('{!user && ('),
    expression('{!formData.use_temp_password ? ('),
    expression('{role.name} {role.description && `- ${role.description}`}'),
    expression("{loading ? t('common.saving') : t('common.save')}"),
    // Who may work the screen, the state, and every manage-users call with its body.
    block('const UserManagement: React.FC = () => {', '  };', '  const handleResendInvite = async (userId: string) => {'),
    block('  const handleExport = () => {', '  };'),
    // The badges' order and the role's stored value; the early returns.
    expression('if (mustChangePassword) {'),
    expression("if (status === 'inactive') {"),
    expression("if (status === 'pending_invite') {"),
    expression("const roleName = user.role_name || user.role || 'viewer';"),
    expression("const roleKey = (user.role || 'viewer').toLowerCase();"),
    expression('if (authLoading) {'),
    expression('if (!canManageUsers) {'),
    expression("const readContext = companyScope.kind === 'view';"),
    expression("t(readContext ? 'users.readOnlyTitle' : 'users.accessDenied')"),
    expression("t(readContext ? 'users.readOnlyBody' : 'users.adminOnly')"),
    expression('{!readContext && ('),
    expression("t('users.yourRole', { role: profile?.role || t('users.roleNone') })"),
    expression('if (loading) {'),
    // The figures and which row offers what, at each width.
    expression('users.filter(u => u.email_confirmed_at).length'),
    expression("users.filter(u => u.role === 'admin').length"),
    expression("users.filter(u => u.role === 'viewer').length"),
    expression('{users.length === 0 ? ('),
    expression("{user.status === 'pending_invite' && ("),
    expression("{user.status === 'active' && user.email !== 'support@yamobility.de' && ("),
    expression("{user.status === 'inactive' && ("),
    expression("{user.email !== 'support@yamobility.de' && ("),
    expression("user.full_name || t('common.unknown')"),
    expression('ID: {user.id.slice(0, 8)}...'),
    expression('Badge(user.status, user.must_change_password)'),
    expression('Badge(user.status)'),
    expression("editingUser ? t('users.editUser') : t('users.newUser')"),
    expression('{resetPasswordUser && ('),
    expression('{resetPasswordSuccess ? ('),
    expression('{resetPasswordError &&'),
    expression("showResetPassword ? 'text' : 'password'"),
  ],
  'src/pages/UsersPage.tsx': [
    line("  const [activeTab, setActiveTab] = useState<'users' | 'backups'>('users');"),
    expression("{activeTab === 'users' && <UserManagement />}"),
    expression("{activeTab === 'backups' && <BackupManagement />}"),
  ],
  'src/components/BackupManagement.tsx': [
    // The table list, the state, and the backup of the session's company.
    block("import { useState } from 'react';", "import type { TranslationKey } from '../i18n';"),
    block('// Holds TranslationKeys: this list is module-level and t() is a hook value.', '  };'),
    expression("{lastBackupTime ? lastBackupTime : t('bill.backup.never')}"),
    expression('{isLoading ? ('),
  ],
  'src/components/RolesManagement.tsx': [
    line("import { supabase } from '../lib/supabase';"),
    line("import { Role, RolePermission, RoleWithPermissions } from '../types/role';"),
    line("import RoleModal from './RoleModal';"),
    line("import { useToast } from '../contexts/ToastContext';"),
    line("import { useSuperAdmin } from '../contexts/SuperAdminContext';"),
    line("import { useTranslation } from '../contexts/LanguageContext';"),
    // The scope, the roles read, save, edit, the system-role refusal, delete, the summary.
    block('const RolesManagement: React.FC = () => {', '  };', '  const getPermissionsSummary = (permissions: RolePermission[]) => {'),
    expression('if (loading) {'),
    expression('{!readOnly && ('),
    expression("{role.description || '-'}"),
    expression('{getPermissionsSummary(role.permissions)}'),
    expression('role.is_system ? ('),
    expression('{roles.length > 0 && ('),
    expression("t('users.roles.deleteConfirm', { name: roleToDelete?.name ?? '' })"),
    expression('existingPermissions={selectedRole?.permissions}'),
  ],
  'src/components/RoleModal.tsx': [
    line("import { Role, RolePermission, PAGE_DEFINITIONS } from '../types/role';"),
    line("import { useTranslation } from '../contexts/LanguageContext';"),
    // The props, the one-time initialisation, the scroll lock, both toggle rules,
    // the submit, handleClose and the permission count.
    block('interface RoleModalProps {', '  const enabledCount = Object.values(permissionMap).filter(p => p.can_view || p.can_edit).length;'),
    expression("{role ? t('users.roles.edit') : t('users.roles.createNew')}"),
    expression("tPlural({ one: 'users.roles.areasSelected.one', other: 'users.roles.areasSelected.other' }, enabledCount)"),
    expression('{validationError &&'),
    expression('{role?.is_system && ('),
    expression('const canView = permissionMap[page.key]?.can_view || false;'),
    expression('const canEdit = permissionMap[page.key]?.can_edit || false;'),
    expression('const isLast = idx === PAGE_DEFINITIONS.length - 1;'),
    expression("{isSubmitting ? t('common.saving') : t('common.save')}"),
  ],
  'src/pages/RolesPage.tsx': [
    line("import RolesManagement from '../components/RolesManagement';"),
  ],
  'src/pages/SettingsPage.tsx': [
    block("import { useCompanySettings, resolveLogoUrl } from '../contexts/CompanySettingsContext';", "import { useTranslation } from '../contexts/LanguageContext';"),
    // The form state, the save, the logo upload and removal, Zurücksetzen.
    block('const SettingsPage: React.FC = () => {', '  };', '  const handleReset = () => {'),
    expression('if (loading) {'),
    // The logo's fallback when it cannot be loaded: the same handler, word for word.
    expression("console.warn(t('settings.logoLoadFailed'), logoPreview);"),
    expression("(e.currentTarget as HTMLImageElement).style.display = 'none';"),
    expression('const placeholder = e.currentTarget.nextElementSibling as HTMLElement;'),
    expression("if (placeholder) placeholder.style.display = 'flex';"),
    expression('{logoPreview && ('),
    expression("{uploading ? t('settings.uploading') : t('settings.uploadLogo')}"),
    expression('{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => ('),
    // The preview column's conditions.
    expression('{formData.slogan && ('),
    expression('{(formData.street || formData.city) && ('),
    expression('{formData.street} {formData.house_number}'),
    expression('{formData.street && <br />}'),
    expression('{formData.postal_code} {formData.city}'),
    expression('{(formData.email || formData.phone) && ('),
    expression('{formData.iban && ('),
    expression('{(formData.vat_id || formData.tax_number) && ('),
    expression('{formData.vat_id && ('),
    expression('{formData.tax_number && ('),
  ],
  'src/pages/ActivationPage.tsx': [
    block("import { useAuth } from '../contexts/AuthContext';", "import type { TranslationKey } from '../i18n';"),
    // The countdown's state and ticking (its colour and its expired word moved to tokens).
    block("type SubmitState = 'idle' | 'loading' | 'success' | 'error';", '  }, [seconds]);'),
    block('  const mins = Math.floor(remaining / 60);', '  const secs = remaining % 60;'),
    expression('if (remaining <= 0) {'),
    expression('remaining < 30 ?'),
    expression('remaining < 60 ?'),
    // The preview, the attempts block, redeem_activation_code, both refreshes, the redirect.
    block('const ActivationPage: React.FC = () => {', '  const subInactive = !isSubscriptionActive;'),
    // The status word: the same three answers in the same order; the two that
    // were German literals ('Aktiv', 'Inaktiv') now come from the dictionary.
    expression('const subStatusLabel = isSubscriptionActive ?'),
    expression("(effectiveSubscriptionStatus === 'expired' ? t('activation.expiredShort') :"),
    expression("if (submitState === 'success') {"),
    expression('{expiryDisplay && ('),
    expression("format(new Date(expiryDisplay), 'dd.MM.yyyy', { locale: de })"),
    expression('{displayName && ('),
    expression("{submitState === 'error' && errorMsg && ("),
    expression('{isBlocked && ('),
    expression('{code.length === 6 && ('),
    expression('{previewLoading ? ('),
    expression(') : preview ? ('),
    expression('<CodeCountdown seconds={preview.seconds_remaining} />'),
    expression('{DURATION_LABELS[preview.duration_type] ? t(DURATION_LABELS[preview.duration_type]) : preview.duration_type}'),
    expression("{submitState === 'loading' ? ("),
  ],
  'src/pages/CompanyBillingPage.tsx': [
    block("import React, { useState, useEffect, useCallback } from 'react';", "import { subscriptionIsActive } from '../utils/planState';"),
    block("import { format, differenceInDays } from 'date-fns';", "import type { TranslationKey } from '../i18n';"),
    // DURATION_LABELS, both row types, fmtDate, the reads, whose subscription, every figure.
    block('// Map keys are the stored `subscription_duration_type` values and must not be', '    : null;', "    ? (() => { try { return format(new Date(subscriptionExpiresAt), 'dd. MMMM yyyy', { locale: de }); } catch { return null; } })()"),
    block('  const aboStatusLabel =', '  const hasHistory = history.length > 0;'),
    // The tone is the old colour pick's order.
    expression('subActive ? '),
    expression('subExpired ? '),
    expression('if (loading) {'),
    expression('{subActive && subExpiry && ('),
    expression('{daysRemaining !== null && ('),
    expression('daysRemaining <= 7 ?'),
    expression('{subExpired && subExpiry && ('),
    expression('{!subActive &&'),
    expression('{subActive && ('),
    expression('{subStarted &&'),
    expression('{subExpiry &&'),
    expression('{durLabel &&'),
    expression('{lastCodeLast4 &&'),
    expression('••{lastCodeLast4}'),
    expression('{!subActive && subExpired && ('),
    expression('{!subActive && !subExpired && !hasHistory && ('),
    expression('{!subActive && !subExpired && hasHistory && ('),
    expression('{history.length === 0 ? ('),
    // Each history row's state, as the old table body worked it out.
    expression("const isCurrentActive = subActive && idx === 0 && companyDetail?.last_activation_code_id === row.id;"),
    expression('const appliedExpiry = row.applied_subscription_expires_at;'),
    expression('const isPastPeriod = appliedExpiry ? new Date(appliedExpiry) <= new Date() : false;'),
    expression("? (() => { try { return format(new Date(row.used_at), 'dd.MM.yyyy HH:mm', { locale: de }); } catch { return '-'; } })()"),
    expression('? (DURATION_LABELS[row.duration_type] ? t(DURATION_LABELS[row.duration_type]) : row.duration_type)'),
    expression('{fmtDate(row.applied_subscription_started_at)}'),
    expression('{fmtDate(row.applied_subscription_expires_at)}'),
    expression("{row.code_last4 ? `••${row.code_last4}` : '••••'}"),
    expression('if (isCurrentActive) {'),
    expression('} else if (isPastPeriod) {'),
  ],
  // The takeovers: their logic is the hooks they read; what each says and
  // what its button does is checked by the call and attribute checks.
  'src/pages/AccountBlockedPage.tsx': [
    block("import { useAuth, BLOCK_MESSAGE_KEYS, BlockReason } from '../contexts/AuthContext';", "import { useTranslation } from '../contexts/LanguageContext';"),
    block('/**', '  const { t } = useTranslation();'),
  ],
  'src/pages/PendingApprovalPage.tsx': [
    block("import { useAuth } from '../contexts/AuthContext';", "import { useTranslation } from '../contexts/LanguageContext';"),
    block('interface PendingApprovalPageProps {', '  const { t } = useTranslation();'),
  ],
  'src/pages/RejectedPage.tsx': [
    block("import { useAuth } from '../contexts/AuthContext';", "import { useTranslation } from '../contexts/LanguageContext';"),
    block('const RejectedPage: React.FC = () => {', '  const { t } = useTranslation();'),
    expression('{rejectionReason && ('),
  ],
  'src/pages/CompanySuspendedPage.tsx': [
    block("import { useAuth } from '../contexts/AuthContext';", "import { useTranslation } from '../contexts/LanguageContext';"),
    block('const CompanySuspendedPage: React.FC = () => {', '  const { t } = useTranslation();'),
  ],
};

// ─── 4. Attributes that behave ───────────────────────────────────────────────
// A field's `required`, a button's `disabled={…}`, a form's `onSubmit={…}`: the
// behaviour that lives in markup. Every one in the base must be in the new file
// with the same text. `type="button"` is exempt — the design-system Button
// defaults to it — and so are the per-file moves listed in MOVED_ATTRIBUTES.

const BEHAVIOUR_ATTRIBUTES = [
  'onClick', 'onSubmit', 'onChange', 'onKeyDown', 'onPaste', 'onFocus', 'onBack', 'onVerified', 'onFailure',
  'onResendFailure', 'onError', 'onSave', 'onClose', 'onConfirm', 'onComplete', 'onApplied', 'onRemoved',
  'onPlanChange', 'onCarLimitChange', 'onBillingCycleChange', 'onDiscountChange', 'onSignOut', 'onToggleView',
  'onToggleEdit', 'disabled', 'value', 'checked', 'type', 'minLength', 'maxLength', 'pattern', 'inputMode',
  'autoComplete', 'accept', 'to', 'href', 'id', 'name', 'min', 'max', 'step', 'purpose', 'email', 'from',
  'selection', 'labelKey', 'hintKey', 'initialCooldownSeconds', 'initialNotice', 'hint', 'reason',
];
const BARE_BOOLEANS = ['required', 'autoFocus', 'noValidate', 'replace', 'divider'];

/** Attribute texts in the base that the new file may lack, with the reason. */
const SUPPORT_LINK_MOVED = {
  'href="mailto:support@el-professor.de"':
    'drawn by components/auth/AccountStatusPage.tsx, the four takeovers\' shared frame, with the same address',
};
const MOVED_ATTRIBUTES = {
  'src/components/UserManagement.tsx': {
    'type={confirmModal.type}':
      'the legacy modal\'s type now picks the dialog by the same value: ConfirmDialog for "confirm", MessageDialog for the rest',
    'onClick={(e) => e.stopPropagation()}':
      'the reset dialog\'s panel kept a click from reaching its backdrop; the Radix Dialog does that itself',
  },
  'src/components/RolesManagement.tsx': {
    'type="confirm"': 'the legacy modal\'s confirm type is the ConfirmDialog it became, with the same onConfirm, onClose and labels',
  },
  'src/components/RoleModal.tsx': {
    'onClick={(e) => e.stopPropagation()}':
      'the panel kept a click from reaching its backdrop; the Radix Dialog does that itself',
    "onFocus={e => { e.currentTarget.style.borderColor = 'rgba(6,182,212,0.5)'; }}":
      'a focus colour painted by hand on the two fields (with its onBlur twin); the fields show the design system\'s focus outline instead',
  },
  'src/pages/ActivationPage.tsx': {
    "onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}":
      'a focus colour painted by hand on the code field (with its onBlur twin); the field shows the design system\'s focus outline instead',
  },
  'src/pages/AccountBlockedPage.tsx': SUPPORT_LINK_MOVED,
  'src/pages/PendingApprovalPage.tsx': SUPPORT_LINK_MOVED,
  'src/pages/RejectedPage.tsx': SUPPORT_LINK_MOVED,
  'src/pages/CompanySuspendedPage.tsx': SUPPORT_LINK_MOVED,
};

function attributeTexts(text) {
  const found = [];
  const pattern = new RegExp(`\\s(${BEHAVIOUR_ATTRIBUTES.join('|')})=`, 'g');
  for (const match of text.matchAll(pattern)) {
    const start = match.index + 1;
    const valueStart = start + match[1].length + 1;
    const opener = text[valueStart];
    let end = valueStart;
    if (opener === '"' || opener === "'") {
      end = text.indexOf(opener, valueStart + 1) + 1;
    } else if (opener === '{') {
      let depth = 0;
      let quote = '';
      for (let i = valueStart; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
          if (char === '\\') i += 1;
          else if (char === quote) quote = '';
          continue;
        }
        if (char === '"' || char === "'" || char === '`') quote = char;
        else if (char === '{') depth += 1;
        else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
    } else {
      continue;
    }
    found.push(text.slice(start, end));
  }
  return found;
}

const bareCount = (text, name) => [...text.matchAll(new RegExp(`\\s${name}(?=[\\s/>])(?!\\s*=)`, 'g'))].length;

// ─── 3. Call sites ───────────────────────────────────────────────────────────

const CALLS = [
  /\bsignIn\(/g, /\bsignOut\(/g, /\bcompleteSignIn\(/g, /\brequestOtp\(/g, /\bverifyOtp\(/g,
  /\bsetAuthNotice\(/g, /\bclearAuthNotice\(/g, /\brefreshProfile\(/g, /\brefreshSubscription\(/g,
  /\brefreshPlan\(/g, /\brefreshSettings\(/g, /\bupdateSettings\(/g, /\bregisterOauthCompany\(/g,
  /\bdiscardOauthAccount\(/g, /\bstartGoogleSignIn\(/g, /\bloadAuthProviderSettings\(/g,
  /\bnavigate\(/g, /\bfetch\(/g, /\bsupabase\s*\.\s*(?:from|rpc)\(/g, /\.auth\s*\.\s*\w+\(/g,
  /\.storage\s*\.\s*from\(/g, /\bexportTableToExcel\(/g, /\bcreateAndDownloadBackup\(/g,
  /\bwindow\.history\.replaceState\(/g, /\bshowToast\(/g, /\bshowError\(/g, /\bsuccess\(t\(/g,
  /\bsetConfirmModal\(/g, /\bonSave\(/g, /\bonVerified\(/g, /\bonFailure\?\.\(/g, /\bonResendFailure\?\.\(/g,
  /\bonError\?\.\(/g, /\(onSignOut \?\? signOut\)\(/g, /\bleaveToLogin\(/g, /\bfetchPreview\(/g, /\bloadData\(/g,
  /\bloadUsers\(/g, /\bfetchRoles\(/g,
];

/** The call starting at `start`, through its balanced closing parenthesis. */
function callText(text, start) {
  const open = text.indexOf('(', start);
  if (open < 0) return text.slice(start, start + 40);
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    // A comment inside the arguments may hold an apostrophe ("validation's").
    if (char === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i <= 0) break;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

const squash = text => text.replace(/\s+/g, ' ').trim();

// ─── Run ─────────────────────────────────────────────────────────────────────

let failures = 0;
const fail = message => {
  failures += 1;
  console.log(`  FAIL ${message}`);
};

console.log(`base ${base.slice(0, 12)}\n`);
console.log('1. untouched');
for (const path of UNTOUCHED) {
  try {
    git('diff', '--quiet', base, '--', path);
    console.log(`  ok   ${path}`);
  } catch {
    fail(`${path} differs from the base`);
  }
}

console.log('\n2. verbatim blocks and 3. call sites');
for (const [path, blocks] of Object.entries(BLOCKS)) {
  const before = baseText(path);
  const after = workText(path);
  const lines = before.split('\n').map(line => line.replace(/\s+$/, ''));
  const covered = new Array(lines.length).fill(false);
  let blockFailures = 0;

  let expressions = 0;
  for (const { first, last, after: afterLine, expression: condition } of blocks) {
    if (condition !== undefined) {
      expressions += 1;
      if (!squash(before).includes(squash(condition))) {
        fail(`${path}: condition "${condition}" not found in the base`);
        blockFailures += 1;
      } else if (!squash(after).includes(squash(condition))) {
        fail(`${path}: condition "${condition}" is not in the new file`);
        blockFailures += 1;
      }
      continue;
    }
    const from = lines.indexOf(first);
    const afterIndex = afterLine === undefined ? from : lines.findIndex((text, index) => index >= from && text === afterLine);
    const to = from < 0 || afterIndex < 0 ? -1 : lines.findIndex((text, index) => index >= afterIndex && text === last);
    if (from < 0 || to < 0) {
      fail(`${path}: block "${first.trim()}" … "${last.trim()}" not found in the base`);
      blockFailures += 1;
      continue;
    }
    const verbatim = before.split('\n').slice(from, to + 1).join('\n');
    for (let i = from; i <= to; i += 1) covered[i] = true;
    if (!after.includes(verbatim)) {
      fail(`${path}: lines ${from + 1}–${to + 1} ("${first.trim()}") are not verbatim in the new file`);
      blockFailures += 1;
    }
  }

  // Calls: every call in the base, argument list included, must be in the new file.
  const afterSquashed = squash(after);
  const missing = [];
  let calls = 0;
  for (const pattern of CALLS) {
    for (const match of before.matchAll(pattern)) {
      const text = callText(before, match.index);
      calls += 1;
      if (!afterSquashed.includes(squash(text))) missing.push(text.split('\n')[0]);
    }
  }
  for (const text of missing) fail(`${path}: call not found in the new file: ${text}`);

  // Attributes: every behaving attribute in the base, text and all, is in the new file.
  const moved = MOVED_ATTRIBUTES[path] ?? {};
  const attributes = attributeTexts(before).filter(text => text !== 'type="button"');
  const lostAttributes = attributes.filter(text => !afterSquashed.includes(squash(text)) && !(text in moved));
  for (const text of lostAttributes) fail(`${path}: attribute not found in the new file: ${text.split('\n')[0]}`);
  for (const [text, reason] of Object.entries(moved)) console.log(`       moved ${text} — ${reason}`);
  const lostBooleans = BARE_BOOLEANS.filter(name => bareCount(after, name) < bareCount(before, name) && !(name in moved));
  for (const name of lostBooleans) {
    fail(`${path}: \`${name}\` appears ${bareCount(before, name)}× in the base, ${bareCount(after, name)}× in the new file`);
  }

  const coveredCount = covered.filter(Boolean).length;
  const ok = !blockFailures && !missing.length && !lostAttributes.length && !lostBooleans.length;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${path}: ${blocks.length} blocks, ${coveredCount} of ${lines.length} base lines verbatim; ` +
      `${calls - missing.length}/${calls} calls; ${attributes.length - lostAttributes.length}/${attributes.length} attributes`,
  );
  if (verbose) {
    let start = -1;
    for (let i = 0; i <= lines.length; i += 1) {
      const outside = i < lines.length && !covered[i] && lines[i].trim() !== '';
      if (outside && start < 0) start = i;
      if (!outside && start >= 0) {
        console.log(`         outside ${start + 1}–${i}: ${lines[start].trim().slice(0, 90)}`);
        start = -1;
      }
    }
  }
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} failures`);
process.exitCode = failures === 0 ? 0 : 1;
