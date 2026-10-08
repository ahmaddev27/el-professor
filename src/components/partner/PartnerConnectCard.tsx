/**
 * Connect: the company pastes the token Reidey showed it once.
 *
 * A file of its own rather than more markup in `SettingsPage.tsx`, which sits
 * at 2 inline styles and 6 hard-coded colours in `style-baseline.json`. A new
 * file starts absent from that list, which means zero, and the ratchet keeps it
 * there.
 *
 * ## What the screen must say, and why each sentence is there
 *
 * **That the token is shown once.** Reidey deletes the previous token before
 * minting a new one, so an operator who loses the value has to re-mint and
 * breaks the link they were trying to make. Saying this before the field is
 * the difference between a careful paste and a lost afternoon.
 *
 * **That we never see it again either.** It is sealed on arrival, and the one
 * function that can open it runs as the service role. An operator asking "can
 * you read my token" deserves the real answer.
 *
 * **What a refusal means.** `token_rejected` is final — mint a new one;
 * `partner_unavailable` is worth retrying; `fleet_already_connected` is the one
 * that needs a person, because it means another of this operator's companies
 * already holds that fleet. Collapsing those into "something went wrong" sends
 * them to re-mint a token that was fine.
 *
 * ## The token never touches component state after the request
 *
 * It is read from the field, sent, and the field is cleared. There is no
 * `useState` holding it afterwards and nothing writes it to storage, so it does
 * not sit in a React tree or survive a reload — which is the most a browser can
 * do about a secret it has to handle once.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, Loader2, ShieldCheck } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useCompanyScope } from '../../hooks/useCompanyScope';
import type { TranslationKey } from '../../i18n';
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
} from '../ui';

interface Connection {
  id: string;
  partner: string;
  external_company_name: string | null;
  status: 'pending' | 'active' | 'failed' | 'revoked';
  last_success_at: string | null;
  last_error: string | null;
  connected_at: string;
}

/** The function's stable reasons, against what the operator is told. */
const REASON_KEYS: Record<string, TranslationKey> = {
  token_required: 'partner.connect.error.tokenRequired',
  token_rejected: 'partner.connect.error.tokenRejected',
  partner_unavailable: 'partner.connect.error.partnerUnavailable',
  fleet_unidentified: 'partner.connect.error.fleetUnidentified',
  fleet_already_connected: 'partner.connect.error.fleetAlreadyConnected',
  not_authorized: 'partner.connect.error.notAuthorized',
  seal_key_missing: 'partner.connect.error.notConfigured',
  endpoint_missing: 'partner.connect.error.notConfigured',
  endpoint_unparsable: 'partner.connect.error.notConfigured',
  endpoint_not_https: 'partner.connect.error.notConfigured',
  endpoint_has_credentials: 'partner.connect.error.notConfigured',
  endpoint_private_host: 'partner.connect.error.notConfigured',
  endpoint_unexpected_port: 'partner.connect.error.notConfigured',
  endpoint_has_path: 'partner.connect.error.notConfigured',
};

interface PartnerConnectCardProps {
  companyId: string | null;
}

export function PartnerConnectCard({ companyId }: PartnerConnectCardProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { canEdit } = useCompanyScope();
  // A WriteRight ignores its first argument; the page key is the whole
  // question, and `drivers` is what the edge function asks of the caller.
  const mayConnect = canEdit(undefined, 'drivers');

  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Uncontrolled on purpose: the pasted token is read once, sent, and the input
  // is cleared. Nothing holds it in state afterwards.
  const tokenField = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!companyId) {
      setConnection(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadFailed(false);
    try {
      const { data, error } = await supabase
        .from('partner_connections')
        .select('id, partner, external_company_name, status, last_success_at, last_error, connected_at')
        .eq('company_id', companyId)
        .neq('status', 'revoked')
        .order('connected_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      setConnection(((data ?? [])[0] as Connection | undefined) ?? null);
    } catch {
      // "Not connected" is a claim, and on a failed read it is a false one that
      // would invite the operator to connect a second time.
      setLoadFailed(true);
      setConnection(null);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  const connect = async () => {
    const token = tokenField.current?.value.trim() ?? '';
    if (token === '') {
      showToast('error', t('partner.connect.error.tokenRequired'));
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('partner-connect', {
        body: { token },
      });
      if (error) throw error;
      const answer = data as { ok?: boolean; reason?: string; fleet_name?: string | null };
      if (!answer?.ok) {
        const key = answer?.reason ? REASON_KEYS[answer.reason] : undefined;
        showToast('error', key ? t(key) : t('partner.connect.error.generic'));
        return;
      }
      if (tokenField.current) tokenField.current.value = '';
      showToast('success', answer.fleet_name
        ? t('partner.connect.connectedTo', { name: answer.fleet_name })
        : t('partner.connect.connected'));
      await load();
    } catch {
      showToast('error', t('partner.connect.error.generic'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div role="status" className="flex items-center gap-2 py-4 font-ui text-sm text-fg-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="font-ui space-y-4">
      {loadFailed ? (
        <Alert
          tone="critical"
          title={t('partner.connect.loadFailedTitle')}
          action={<Button variant="secondary" size="sm" onClick={() => void load()}>
            {t('partner.connect.retry')}
          </Button>}
        >
          {t('partner.connect.loadFailedBody')}
        </Alert>
      ) : connection ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={connection.status === 'active' ? 'positive' : 'caution'}>
              <ShieldCheck className="size-3.5" aria-hidden />
              {t(connection.status === 'active'
                ? 'partner.connect.status.active'
                : 'partner.connect.status.pending')}
            </Badge>
            <span className="text-sm text-fg">
              {connection.external_company_name || connection.partner}
            </span>
          </div>
          {connection.last_error ? (
            <Alert tone="caution" title={t('partner.connect.lastErrorTitle')}>
              {connection.last_error}
            </Alert>
          ) : null}
          <p className="text-sm text-fg-muted">{t('partner.connect.replaceHint')}</p>
        </div>
      ) : (
        <Alert tone="brand" role="note" title={t('partner.connect.howTitle')}>
          {t('partner.connect.howBody')}
        </Alert>
      )}

      {mayConnect ? (
        <div className="space-y-3">
          <Field
            label={t('partner.connect.tokenLabel')}
            hint={t('partner.connect.tokenHint')}
            id="partner-connect-token"
          >
            <Input
              id="partner-connect-token"
              ref={tokenField}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('partner.connect.tokenPlaceholder')}
              disabled={busy}
            />
          </Field>
          <Button onClick={() => void connect()} loading={busy} disabled={busy}>
            <Link2 className="size-4" aria-hidden />
            {connection
              ? t('partner.connect.replaceAction')
              : t('partner.connect.action')}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">{t('partner.connect.noPermission')}</p>
      )}
    </div>
  );
}
