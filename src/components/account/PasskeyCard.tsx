import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, KeyRound, Trash2 } from 'lucide-react';
import { passkeyMessageKey } from '../../lib/passkeyClient';
import { deletePasskey, enrollPasskey, listPasskeys, type PasskeyRecord } from '../../lib/passkeyFlows';
import { proveWithPasskey, proveWithPassword, type ReauthProof } from '../../lib/reauthProof';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { usePasskeysEnabled } from '../../hooks/usePasskeysEnabled';
import { useTranslation } from '../../contexts/LanguageContext';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '../ui';
import type { TranslationKey } from '../../i18n';

/**
 * The account's passkeys on `/mein-konto`: what there is, add one, remove one.
 *
 * It renders **nothing at all** until GoTrue has said passkeys are enabled, and
 * nothing on a browser with no WebAuthn — the same gate as `PasskeyButton`, for
 * the same reasons, and `PasskeyCard.render.test.ts` measures it with the
 * browser capability stubbed on so neither half can cover for the other.
 *
 * It is a card of its own rather than a section inside `AccountPage` because
 * that page is one of the six phase 5 never converted: it draws its own legacy
 * surfaces with inline styles and sits at 33 in `style-baseline.json`. A new
 * file enters the ratchet at 0/0 and the page's count does not move.
 *
 * ## Adding one asks for a re-authentication; removing one does not
 *
 * GoTrue's `POST /passkeys/registration/*` asks only for a session. Taken as
 * shipped that would make adding a passkey the one sensitive change on this page
 * an unattended browser can make — and a passkey is a permanent sign-in
 * credential, so it is a quieter takeover than the password change this page
 * already refuses without a proof. So the proof comes first and **is the bearer
 * the registration call is made with**: the credential is created on a session
 * minted seconds earlier. Either method produces it, which is the point — a
 * person who signs in with a passkey must be able to add a second one. See
 * `lib/reauthProof.ts` for how freshness travels, and why removal is left alone.
 *
 * ## Recovery, which the copy states rather than leaving to be discovered
 *
 * A passkey is bound to the device holding it, so losing the device loses that
 * passkey. **No account in this product can end up with no way in**, and that is
 * a property of the server rather than a promise made here: at v2.190.0 GoTrue
 * has no passkey *signup* route at all — `/passkeys/registration/*` requires an
 * existing session, and `/passkeys/authentication/*` resolves an existing
 * account — so a passkey can only ever be **added to an account that already
 * exists**. Every account in El-Professor is created with a password (company
 * signup, a `manage-users` invitation, a `platform-staff` invitation), so the
 * password and "Passwort vergessen" remain behind every passkey, for company
 * users and platform staff alike. Deleting the last passkey therefore ends
 * passkey sign-in and nothing else; the card says so while there is exactly one,
 * and again on the confirmation.
 *
 * The confirmation is inline rather than a dialog on purpose: the warning is
 * standing information about the account's state, not news, so it belongs in the
 * list beside the thing it describes.
 */

/** GoTrue's `GOTRUE_PASSKEY_MAX_PASSKEYS_PER_USER`. The server enforces it; this only words it. */
const MAX_PASSKEYS = 10;

/** An instant as a German date in the product's own zone, never the viewer's. */
const DATE = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function germanDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? DATE.format(new Date(parsed)) : null;
}

type Notice = { ok: boolean; key: TranslationKey };

const PasskeyCard: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAuth();

  const enabled = usePasskeysEnabled();
  const [rows, setRows] = useState<PasskeyRecord[] | null>(null);
  // A read that failed is stated. An empty list is the claim "this account has
  // no passkey", and a failed read is not evidence for it.
  const [loadFailed, setLoadFailed] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'add-password' | 'add-passkey' | 'remove' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const accessToken = async (): Promise<string | null> => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  };

  const reload = useCallback(async () => {
    const token = await accessToken();
    if (!token) { setLoadFailed(true); return; }
    const result = await listPasskeys(token);
    if (!result.ok) { setLoadFailed(true); return; }
    setLoadFailed(false);
    setRows(result.value);
  }, []);

  // The list is read only once the gate is open: on today's server it never is,
  // so the card issues no request at all.
  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  if (!enabled) return null;

  const add = async (prove: () => Promise<ReauthProof>, which: 'add-password' | 'add-passkey') => {
    setNotice(null);
    setConfirming(null);
    setBusy(which);
    const proof = await prove();
    if (!proof.ok) {
      setBusy(null);
      setNotice({ ok: false, key: proof.messageKey });
      return;
    }
    const result = await enrollPasskey(proof.accessToken);
    if (!result.ok) {
      setBusy(null);
      setNotice({ ok: false, key: passkeyMessageKey(result.failure) });
      return;
    }
    setPassword('');
    await reload();
    setBusy(null);
    setNotice({ ok: true, key: 'passkey.added' });
  };

  const remove = async (passkeyId: string) => {
    setNotice(null);
    setBusy('remove');
    const token = await accessToken();
    if (!token) {
      setBusy(null);
      setNotice({ ok: false, key: 'passkey.error.generic' });
      return;
    }
    const result = await deletePasskey(token, passkeyId);
    setConfirming(null);
    if (!result.ok) {
      setBusy(null);
      setNotice({ ok: false, key: passkeyMessageKey(result.failure) });
      return;
    }
    await reload();
    setBusy(null);
    setNotice({ ok: true, key: 'passkey.removed' });
  };

  const count = rows?.length ?? 0;
  const full = count >= MAX_PASSKEYS;
  const anyBusy = busy !== null;

  // ── Presentation ──────────────────────────────────────────────────────────
  return (
    <Card className="font-ui">
      <CardHeader>
        <div>
          <CardTitle as="h3" className="flex items-center gap-2">
            <KeyRound aria-hidden className="size-4 text-brand-text" />
            {t('passkey.heading')}
          </CardTitle>
          <CardDescription>{t('passkey.subtitle')}</CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {loadFailed ? (
          <Alert tone="critical" role="alert" title={t('passkey.list.failed')}>
            {t('passkey.list.failedHint')}
            <div className="mt-3">
              <Button type="button" variant="secondary" size="sm" onClick={() => { void reload(); }}>
                {t('passkey.list.retry')}
              </Button>
            </div>
          </Alert>
        ) : rows === null ? (
          <p className="text-[13px] text-fg-subtle">{t('common.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-fg-subtle">{t('passkey.list.none')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-control border border-line">
            {rows.map(row => {
              const created = germanDate(row.createdAt);
              const used = germanDate(row.lastUsedAt);
              return (
                <li key={row.id} className="px-3 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-fg">
                        {row.friendlyName ?? t('passkey.unnamed')}
                      </p>
                      <p className="mt-0.5 text-xs text-fg-subtle">
                        {created ? t('passkey.createdOn', { date: created }) : t('passkey.createdUnknown')}
                        {' · '}
                        {used ? t('passkey.lastUsedOn', { date: used }) : t('passkey.neverUsed')}
                      </p>
                    </div>
                    {confirming === row.id ? (
                      <div className="grid grid-cols-[auto_auto] gap-2">
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          disabled={anyBusy}
                          loading={busy === 'remove'}
                          onClick={() => { void remove(row.id); }}
                        >
                          {t('passkey.remove.confirm')}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={anyBusy}
                        onClick={() => { setNotice(null); setConfirming(row.id); }}
                        aria-label={t('passkey.remove.label')}
                      >
                        <Trash2 aria-hidden />
                        {t('passkey.remove.label')}
                      </Button>
                    )}
                  </div>
                  {confirming === row.id && (
                    <p className="mt-2 text-xs text-fg-muted">
                      {rows.length === 1 ? t('passkey.remove.lastWarning') : t('passkey.remove.hint')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* The device is the passkey, so what happens when it is gone is said
            here rather than left to be found out. */}
        <Alert tone="neutral" role="note" title={t('passkey.recovery.title')}>
          {t('passkey.recovery.body')}
        </Alert>

        {full ? (
          <Alert tone="caution" role="status">{t('passkey.full', { n: String(MAX_PASSKEYS) })}</Alert>
        ) : (
          <div className="space-y-3 rounded-control border border-line bg-sunken p-3">
            <p className="text-[13px] font-semibold text-fg">{t('passkey.add.heading')}</p>
            <p className="text-xs text-fg-subtle">{t('passkey.add.proofHint')}</p>
            <Field label={t('account.email.currentPassword')}>
              <Input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={anyBusy || !password}
                loading={busy === 'add-password'}
                onClick={() => { void add(() => proveWithPassword(user?.email ?? '', password), 'add-password'); }}
              >
                {t('passkey.add.withPassword')}
              </Button>
              {/* Only once there is a passkey to assert with: without one this
                  could not succeed, and the password field beside it is the way. */}
              {count > 0 && user?.id && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={anyBusy}
                  loading={busy === 'add-passkey'}
                  onClick={() => { void add(() => proveWithPasskey(user.id), 'add-passkey'); }}
                >
                  {t('passkey.add.withPasskey')}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* `Alert` rather than a hand-drawn box, so the fill and the text come
            from the pairs tokens.contrast.test.ts already holds to 4.5:1. */}
        {notice && (
          <Alert
            tone={notice.ok ? 'positive' : 'critical'}
            role={notice.ok ? 'status' : 'alert'}
            icon={notice.ok ? CheckCircle2 : AlertCircle}
          >
            {t(notice.key)}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

export default PasskeyCard;
