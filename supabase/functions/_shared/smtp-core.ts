/**
 * The protocol and message half of the functions' SMTP client.
 *
 * Nothing here touches a socket, Deno or npm: mail.ts hands in a connection, and
 * vitest drives the same code against a scripted server. What it implements is
 * exactly what sending one transactional message needs and no more:
 *
 *   greeting, EHLO, STARTTLS, EHLO again, AUTH PLAIN or LOGIN, MAIL FROM,
 *   RCPT TO, DATA, QUIT
 *
 * and a multipart/alternative message whose text and HTML parts are base64.
 * Base64 bodies keep every line short and ASCII, so there is no line-length or
 * 8BITMIME question to get wrong, and no body line can start with a dot.
 *
 * Errors carry a step name and the server's reply code, never the reply text or
 * the message. A reply can echo the recipient, and nothing that travels with a
 * code may reach a log.
 */

export class SmtpError extends Error {
  readonly step: string;
  readonly replyCode: number | null;

  constructor(step: string, replyCode: number | null = null) {
    super(replyCode === null ? `smtp ${step} failed` : `smtp ${step} answered ${replyCode}`);
    this.name = 'SmtpError';
    this.step = step;
    this.replyCode = replyCode;
  }
}

/** The byte stream mail.ts provides. `upgrade` swaps the stream for TLS in place. */
export interface SmtpConnection {
  read(buffer: Uint8Array): Promise<number | null>;
  write(data: Uint8Array): Promise<number>;
  close(): void;
}

export interface SmtpSessionOptions {
  /** The EHLO argument: the sender's domain. */
  clientName: string;
  /**
   * `starttls`: upgrade after the first EHLO, and refuse a server that does not
   * offer it. `implicit`: the connection is already TLS (port 465). `none`: only
   * for the staging mail catcher on the project's internal network.
   */
  security: 'starttls' | 'implicit' | 'none';
  /** Replaces the connection's stream with TLS. Required for `starttls`. */
  upgrade?: () => Promise<void>;
  auth?: { user: string; pass: string } | null;
  envelopeFrom: string;
  recipient: string;
  /** The complete message from buildMimeMessage. */
  message: string;
}

export interface SmtpReply {
  code: number;
  lines: string[];
}

const encoder = new TextEncoder();

// Replies are a few short lines. A server that sends megabytes without a line
// break is broken or hostile, and must not grow this worker's memory.
const MAX_REPLY_LINE = 2048;
const MAX_REPLY_LINES = 64;

export class SmtpReplyReader {
  private buffer = '';
  private decoder = new TextDecoder();

  constructor(private readonly connection: SmtpConnection) {}

  /** True when the server sent more than was asked for. */
  hasBufferedInput(): boolean {
    return this.buffer.length > 0;
  }

  /** Forget the plaintext stream after STARTTLS. */
  reset(): void {
    this.buffer = '';
    this.decoder = new TextDecoder();
  }

  async next(): Promise<SmtpReply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (!match) throw new SmtpError('reply_malformed');
      lines.push(match[3] ?? '');
      if (match[2] !== '-') return { code: Number(match[1]), lines };
      if (lines.length >= MAX_REPLY_LINES) throw new SmtpError('reply_too_long');
    }
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return line;
      }
      if (this.buffer.length > MAX_REPLY_LINE) throw new SmtpError('reply_too_long');
      const chunk = new Uint8Array(4096);
      const read = await this.connection.read(chunk);
      if (read === null) throw new SmtpError('connection_closed');
      this.buffer += this.decoder.decode(chunk.subarray(0, read), { stream: true });
    }
  }
}

async function writeAll(connection: SmtpConnection, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const written = await connection.write(data.subarray(offset));
    if (written <= 0) throw new SmtpError('write');
    offset += written;
  }
}

function extensions(ehlo: SmtpReply): string[] {
  // The first line is the server's greeting name; the rest are keywords.
  return ehlo.lines.slice(1).map((line) => line.trim().toUpperCase());
}

function offersStartTls(ehlo: SmtpReply): boolean {
  return extensions(ehlo).some((keyword) => keyword === 'STARTTLS');
}

function authMechanisms(ehlo: SmtpReply): Set<string> {
  const mechanisms = new Set<string>();
  for (const keyword of extensions(ehlo)) {
    const match = /^AUTH[ =](.*)$/.exec(keyword);
    if (match) match[1].split(/\s+/).filter(Boolean).forEach((m) => mechanisms.add(m));
  }
  return mechanisms;
}

const ADDRESS_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * An address this client can put in an envelope as-is: ASCII, no CR/LF, no
 * angle brackets. Anything else (an internationalised address, an injection
 * attempt) is refused rather than encoded.
 */
export function isAsciiMailAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS_PATTERN.test(address);
}

const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** One complete SMTP transaction for one recipient. Resolves once DATA is accepted. */
export async function runSmtpSession(connection: SmtpConnection, options: SmtpSessionOptions): Promise<void> {
  if (!isAsciiMailAddress(options.envelopeFrom) || !isAsciiMailAddress(options.recipient)) {
    throw new SmtpError('invalid_address');
  }
  if (!HOSTNAME_PATTERN.test(options.clientName)) throw new SmtpError('invalid_client_name');

  const reader = new SmtpReplyReader(connection);
  const exchange = async (step: string, line: string | null, accepted: number[]): Promise<SmtpReply> => {
    if (line !== null) await writeAll(connection, encoder.encode(`${line}\r\n`));
    const reply = await reader.next();
    if (!accepted.includes(reply.code)) throw new SmtpError(step, reply.code);
    return reply;
  };

  await exchange('greeting', null, [220]);
  let ehlo = await exchange('ehlo', `EHLO ${options.clientName}`, [250]);

  if (options.security === 'starttls') {
    if (!offersStartTls(ehlo)) throw new SmtpError('starttls_unavailable');
    if (!options.upgrade) throw new SmtpError('starttls_unsupported');
    await exchange('starttls', 'STARTTLS', [220]);
    // Bytes that arrived before the handshake were not protected by it. A
    // client that read them as replies would accept an attacker's answers.
    if (reader.hasBufferedInput()) throw new SmtpError('starttls_injection');
    await options.upgrade();
    reader.reset();
    // The capabilities offered in plaintext are discarded with the plaintext.
    ehlo = await exchange('ehlo', `EHLO ${options.clientName}`, [250]);
  }

  if (options.auth) {
    const mechanisms = authMechanisms(ehlo);
    if (mechanisms.has('PLAIN')) {
      const token = base64Utf8(`\u0000${options.auth.user}\u0000${options.auth.pass}`);
      await exchange('auth', `AUTH PLAIN ${token}`, [235]);
    } else if (mechanisms.has('LOGIN')) {
      await exchange('auth', 'AUTH LOGIN', [334]);
      await exchange('auth', base64Utf8(options.auth.user), [334]);
      await exchange('auth', base64Utf8(options.auth.pass), [235]);
    } else {
      throw new SmtpError('auth_unavailable');
    }
  }

  await exchange('mail_from', `MAIL FROM:<${options.envelopeFrom}>`, [250]);
  await exchange('rcpt_to', `RCPT TO:<${options.recipient}>`, [250, 251]);
  await exchange('data', 'DATA', [354]);
  const body = dotStuff(toCrlf(options.message).replace(/(?:\r\n)+$/, ''));
  await writeAll(connection, encoder.encode(`${body}\r\n.\r\n`));
  await exchange('data_end', null, [250]);

  // The message is accepted at this point. A server that hangs up instead of
  // answering QUIT has still taken it, so this is not a failure.
  try {
    await exchange('quit', 'QUIT', [221]);
  } catch {
    // ignore
  }
}

// ── Message ──────────────────────────────────────────────────────────────────

/**
 * A file sent beside the message.
 *
 * `content` is **already base64** and is never decoded here: the browser produced
 * the PNG, encoded it, and this only has to place it. Decoding it to check it
 * would mean holding the image twice in a worker's memory for no gain, and a
 * corrupt attachment is the sender's defect rather than the transport's.
 */
export interface MimeAttachment {
  filename: string;
  contentType: string;
  /** Base64, unwrapped. `wrapBase64` folds it to the line length SMTP wants. */
  content: string;
}

export interface MimeMessageInput {
  fromName: string;
  fromAddress: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  date: Date;
  /** Without angle brackets: `uuid@domain`. */
  messageId: string;
  boundary: string;
  /**
   * The outer boundary, required only when something is attached. Must differ
   * from `boundary`: one boundary for both levels makes the inner part's
   * terminator close the outer one, and the attachment silently disappears.
   */
  mixedBoundary?: string;
  attachments?: readonly MimeAttachment[];
}

export function base64Utf8(text: string): string {
  let binary = '';
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function wrapBase64(value: string, width = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width) lines.push(value.slice(i, i + width));
  return lines.join('\r\n');
}

export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/** RFC 5321 transparency: a line that starts with a dot gets a second one. */
export function dotStuff(message: string): string {
  return message.replace(/(^|\r\n)\./g, '$1..');
}

/** RFC 5322 date, always in UTC: `Mon, 14 Sep 2026 12:00:00 +0000`. */
export function formatSmtpDate(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

function rejectLineBreaks(value: string): void {
  if (/[\r\n]/.test(value)) throw new SmtpError('invalid_header');
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * A header value safe to send: printable ASCII as-is, anything else as RFC 2047
 * UTF-8 encoded words of at most 75 characters each, folded onto continuation
 * lines. Words split on character boundaries, never inside a multi-byte one.
 */
export function encodeHeaderValue(value: string): string {
  rejectLineBreaks(value);
  if (PRINTABLE_ASCII.test(value) && !value.includes('=?')) return value;
  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const char of value) {
    const bytes = encoder.encode(char).length;
    // 39 bytes -> 52 base64 characters -> a 64-character encoded word, so even
    // the first line, "Subject: " included, stays within RFC 2047's 76.
    if (chunkBytes + bytes > 39) {
      words.push(`=?UTF-8?B?${base64Utf8(chunk)}?=`);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += bytes;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64Utf8(chunk)}?=`);
  return words.join('\r\n ');
}

function formatMailbox(name: string, address: string): string {
  rejectLineBreaks(name);
  if (!isAsciiMailAddress(address)) throw new SmtpError('invalid_address');
  const display = PRINTABLE_ASCII.test(name)
    ? `"${name.replace(/["\\]/g, '\\$&')}"`
    : encodeHeaderValue(name);
  return `${display} <${address}>`;
}

function base64Part(contentType: string, body: string): string[] {
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64Utf8(toCrlf(body))),
  ];
}

/** A complete RFC 5322 message with CRLF line endings, not yet dot-stuffed. */
export function buildMimeMessage(input: MimeMessageInput): string {
  if (!/^[A-Za-z0-9_]{1,70}$/.test(input.boundary)) throw new SmtpError('invalid_boundary');
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(input.messageId)) throw new SmtpError('invalid_message_id');
  if (!isAsciiMailAddress(input.to)) throw new SmtpError('invalid_address');

  const b = input.boundary;
  const attachments = input.attachments ?? [];

  const headers = [
    `From: ${formatMailbox(input.fromName, input.fromAddress)}`,
    `To: <${input.to}>`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${formatSmtpDate(input.date)}`,
    `Message-ID: <${input.messageId}>`,
    'MIME-Version: 1.0',
    // RFC 3834: tells out-of-office responders not to answer a machine.
    'Auto-Submitted: auto-generated',
  ];

  // The text and the HTML are two ALTERNATIVES of one message; a reader picks
  // one. This pair is unchanged whether or not anything is attached.
  const alternative = [
    `--${b}`,
    ...base64Part('text/plain', input.text),
    `--${b}`,
    ...base64Part('text/html', input.html),
    `--${b}--`,
  ];

  if (attachments.length === 0) {
    return [
      ...headers,
      // Folded: with the 35-character boundary mail.ts uses, one line would pass 78.
      'Content-Type: multipart/alternative;',
      ` boundary="${b}"`,
      '',
      ...alternative,
      '',
    ].join('\r\n');
  }

  // An attachment is not an alternative to the text — it sits BESIDE it — so the
  // message becomes `multipart/mixed` with the alternative pair nested inside.
  const mixed = input.mixedBoundary;
  if (!mixed || !/^[A-Za-z0-9_]{1,70}$/.test(mixed)) throw new SmtpError('invalid_boundary');
  // One boundary for both levels would let the inner terminator close the outer
  // part, and the attachment would vanish with no error anywhere.
  if (mixed === b) throw new SmtpError('invalid_boundary');

  const parts: string[] = [
    ...headers,
    'Content-Type: multipart/mixed;',
    ` boundary="${mixed}"`,
    '',
    `--${mixed}`,
    'Content-Type: multipart/alternative;',
    ` boundary="${b}"`,
    '',
    ...alternative,
  ];

  for (const attachment of attachments) {
    // A quote or a line break in a filename breaks out of the header. Rejected
    // rather than stripped: a renamed attachment is a surprise, a refused send is
    // a message the caller can act on.
    rejectLineBreaks(attachment.filename);
    if (!/^[A-Za-z0-9 ._-]{1,120}$/.test(attachment.filename)) {
      throw new SmtpError('invalid_attachment_name');
    }
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(attachment.contentType)) {
      throw new SmtpError('invalid_attachment_type');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content.replace(/\s+/g, ''))) {
      throw new SmtpError('invalid_attachment_content');
    }
    parts.push(
      `--${mixed}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(attachment.content.replace(/\s+/g, '')),
    );
  }

  parts.push(`--${mixed}--`, '');
  return parts.join('\r\n');
}
