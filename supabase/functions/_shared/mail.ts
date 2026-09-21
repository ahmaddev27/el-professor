/**
 * sendMail() for the edge functions.
 *
 * It reads the same SMTP_* settings GoTrue does, so both mailers always deliver
 * to the same place: staging's Mailpit, production's Resend on port 2587.
 *
 * ## Why a small client on Deno.connect
 *
 * The transport was left to a probe. On 15.09.2026 this module ran in
 * supabase/edge-runtime:v1.76.2 user workers, created with an envVars allowlist
 * the way main/index.ts creates them, in a second, throwaway runtime process
 * inside the staging functions container:
 *
 * - it delivered a rendered code mail to staging's Mailpit over plain SMTP,
 *   both without credentials and with AUTH PLAIN;
 * - it completed STARTTLS with smtp.resend.com:2587 against Resend's real
 *   certificate, saw AUTH PLAIN LOGIN offered over TLS, and, sent without
 *   credentials, was refused at MAIL FROM (530) before any message went out;
 * - a send handed to EdgeRuntime.waitUntil finished after its response.
 *
 * Raw SMTP from the runtime works, so the fallback to Resend's HTTP API was not
 * needed. A client this size was preferred to a dependency: no npm download when
 * a worker boots, no Node-compatibility layer under production mail, and its
 * protocol half (smtp-core.ts) is unit-tested against a scripted server. The one
 * path the probe could not take is an authenticated send with production's
 * Resend key; that is the first check after the release.
 *
 * ## Transport security
 *
 * - Port 465: TLS from the first byte.
 * - Any other port: STARTTLS, and a server that does not offer it is refused,
 *   because the SMTP password is the next thing sent.
 * - Host `mailpit`: plain SMTP. That name is staging's catcher on the project
 *   network, which deploy.sh already requires staging to use, and it has no
 *   certificate to offer.
 *
 * The whole exchange gets 10 seconds. A MailError names the failing step and
 * the server's reply code; it never contains an address, a header or the body.
 */
import { buildMimeMessage, isAsciiMailAddress, runSmtpSession, SmtpError, type SmtpConnection } from './smtp-core.ts';

export class MailError extends Error {
  readonly step: string;
  readonly replyCode: number | null;

  constructor(step: string, replyCode: number | null = null, causeName?: string) {
    super(`mail ${step} failed${replyCode === null ? '' : ` (${replyCode})`}${causeName ? ` [${causeName}]` : ''}`);
    this.name = 'MailError';
    this.step = step;
    this.replyCode = replyCode;
  }
}

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * The display name from the `mail.sender` setting (plan 3.10), already
   * validated by parseMailSender. Absent or empty: `SMTP_SENDER_NAME`, as
   * before. The address is never a setting — it stays `SMTP_SENDER`.
   */
  fromName?: string | null;
}

const SEND_TIMEOUT_MS = 10_000;
const STAGING_CATCHER_HOST = 'mailpit';

interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  sender: string;
  senderName: string;
  security: 'implicit' | 'starttls' | 'none';
}

function readSettings(): SmtpSettings {
  const host = Deno.env.get('SMTP_HOST')?.trim() ?? '';
  const port = Number(Deno.env.get('SMTP_PORT')?.trim() || '587');
  const sender = Deno.env.get('SMTP_SENDER')?.trim() ?? '';
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !isAsciiMailAddress(sender)) {
    throw new MailError('config');
  }
  return {
    host,
    port,
    user: Deno.env.get('SMTP_USER') ?? '',
    pass: Deno.env.get('SMTP_PASS') ?? '',
    sender,
    senderName: Deno.env.get('SMTP_SENDER_NAME')?.trim() || 'El-Professor',
    security: port === 465 ? 'implicit' : host === STAGING_CATCHER_HOST ? 'none' : 'starttls',
  };
}

/** A Deno socket as an SmtpConnection. STARTTLS replaces the stream in place. */
class DenoConnection implements SmtpConnection {
  private closed = false;

  constructor(private conn: Deno.Conn, private readonly hostname: string) {}

  read(buffer: Uint8Array): Promise<number | null> {
    return this.conn.read(buffer);
  }

  write(data: Uint8Array): Promise<number> {
    return this.conn.write(data);
  }

  async upgradeToTls(): Promise<void> {
    this.conn = await Deno.startTls(this.conn as Deno.TcpConn, { hostname: this.hostname });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.conn.close();
    } catch {
      // already closed by the peer
    }
  }
}

function toMailError(err: unknown, step: string): MailError {
  if (err instanceof MailError) return err;
  if (err instanceof SmtpError) return new MailError(err.step, err.replyCode);
  // Deno's own errors (ConnectionRefused, TimedOut, InvalidData from a failed
  // TLS handshake) keep their class name; their messages can name the host.
  return new MailError(step, null, err instanceof Error ? err.name : undefined);
}

/** Sends one message to one recipient, or throws MailError. */
export async function sendMail(mail: OutgoingMail): Promise<void> {
  const settings = readSettings();
  if (!isAsciiMailAddress(mail.to)) throw new MailError('invalid_recipient');
  const senderDomain = settings.sender.slice(settings.sender.lastIndexOf('@') + 1);

  let message: string;
  try {
    message = buildMimeMessage({
      fromName: mail.fromName?.trim() || settings.senderName,
      fromAddress: settings.sender,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      date: new Date(),
      messageId: `${crypto.randomUUID()}@${senderDomain}`,
      boundary: `ep_${crypto.randomUUID().replaceAll('-', '')}`,
    });
  } catch (err) {
    throw toMailError(err, 'build');
  }

  // A holder rather than a local, so the timer and the exchange see the same
  // connection even though each only assigns it inside a callback.
  const state: { connection: DenoConnection | null; timedOut: boolean } = { connection: null, timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      state.timedOut = true;
      state.connection?.close();
      reject(new MailError('timeout'));
    }, SEND_TIMEOUT_MS);
  });

  const exchange = (async () => {
    const socket = settings.security === 'implicit'
      ? await Deno.connectTls({ hostname: settings.host, port: settings.port })
      : await Deno.connect({ hostname: settings.host, port: settings.port });
    const connection = new DenoConnection(socket, settings.host);
    state.connection = connection;
    // Deno.connect cannot be cancelled; a socket that arrives after the deadline is closed unused.
    if (state.timedOut) {
      connection.close();
      throw new MailError('timeout');
    }
    await runSmtpSession(connection, {
      clientName: senderDomain,
      security: settings.security,
      upgrade: () => connection.upgradeToTls(),
      auth: settings.user ? { user: settings.user, pass: settings.pass } : null,
      envelopeFrom: settings.sender,
      recipient: mail.to,
      message,
    });
  })();
  // When the deadline wins, the exchange still settles later, against a closed socket.
  exchange.catch(() => {});

  try {
    await Promise.race([exchange, deadline]);
  } catch (err) {
    throw toMailError(err, 'connection');
  } finally {
    clearTimeout(timer);
    state.connection?.close();
  }
}
