import { describe, expect, it } from 'vitest';
import {
  base64Utf8,
  buildMimeMessage,
  dotStuff,
  encodeHeaderValue,
  formatSmtpDate,
  isAsciiMailAddress,
  runSmtpSession,
  toCrlf,
  wrapBase64,
  type MimeMessageInput,
  type SmtpConnection,
  type SmtpSessionOptions,
} from './smtp-core.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const reply = (code: number, ...lines: string[]) =>
  lines.map((line, i) => `${code}${i === lines.length - 1 ? ' ' : '-'}${line}\r\n`).join('');

/**
 * An SMTP server in memory. `respond` sees each command line the client sent,
 * or '<DATA END>' once a message is complete, and returns the raw reply; null
 * hangs up.
 */
class ScriptedServer implements SmtpConnection {
  readonly commands: string[] = [];
  message: string | null = null;
  upgraded = false;
  private closed = false;
  private inData = false;
  private inbox = '';
  private readonly outbox: Uint8Array[] = [];
  private waiters: (() => void)[] = [];

  constructor(greeting: string, private readonly respond: (command: string) => string | null) {
    this.send(greeting);
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  }

  private send(raw: string | null): void {
    if (raw === null) this.closed = true;
    else this.outbox.push(encoder.encode(raw));
    this.wake();
  }

  async read(buffer: Uint8Array): Promise<number | null> {
    while (this.outbox.length === 0) {
      if (this.closed) return null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    const chunk = this.outbox[0];
    const n = Math.min(buffer.length, chunk.length);
    buffer.set(chunk.subarray(0, n));
    if (n === chunk.length) this.outbox.shift();
    else this.outbox[0] = chunk.subarray(n);
    return n;
  }

  async write(data: Uint8Array): Promise<number> {
    this.inbox += decoder.decode(data);
    for (;;) {
      if (this.inData) {
        const end = this.inbox.indexOf('\r\n.\r\n');
        if (end < 0) break;
        this.message = this.inbox.slice(0, end);
        this.inbox = this.inbox.slice(end + 5);
        this.inData = false;
        this.send(this.respond('<DATA END>'));
        continue;
      }
      const eol = this.inbox.indexOf('\r\n');
      if (eol < 0) break;
      const line = this.inbox.slice(0, eol);
      this.inbox = this.inbox.slice(eol + 2);
      this.commands.push(line);
      const answer = this.respond(line);
      if (line === 'DATA' && answer?.startsWith('354')) this.inData = true;
      this.send(answer);
    }
    return data.length;
  }

  close(): void {
    this.closed = true;
    this.wake();
  }
}

interface ServerScript {
  greeting?: string;
  plaintextExtensions?: string[];
  tlsExtensions?: string[];
  starttlsReply?: string;
  mailFromReply?: string | null;
  rcptReply?: string;
  quitReply?: string | null;
}

function smtpServer(script: ServerScript = {}): ScriptedServer {
  const server: ScriptedServer = new ScriptedServer(
    script.greeting ?? reply(220, 'mail.example.com ESMTP'),
    (command) => {
      if (command === '<DATA END>') return reply(250, '2.0.0 queued');
      const previous = server.commands.at(-2);
      if (previous === 'AUTH LOGIN') return reply(334, 'UGFzc3dvcmQ6');
      if (server.commands.at(-3) === 'AUTH LOGIN') return reply(235, '2.7.0 Authentication successful');
      const verb = command.split(' ')[0].toUpperCase();
      switch (verb) {
        case 'EHLO': {
          const extensions = server.upgraded
            ? (script.tlsExtensions ?? ['AUTH PLAIN LOGIN'])
            : (script.plaintextExtensions ?? ['AUTH PLAIN LOGIN']);
          return reply(250, 'mail.example.com', ...extensions);
        }
        case 'STARTTLS':
          return script.starttlsReply ?? reply(220, '2.0.0 Ready to start TLS');
        case 'AUTH':
          return command === 'AUTH LOGIN' ? reply(334, 'VXNlcm5hbWU6') : reply(235, '2.7.0 Authentication successful');
        case 'MAIL':
          return script.mailFromReply === undefined ? reply(250, '2.1.0 OK') : script.mailFromReply;
        case 'RCPT':
          return script.rcptReply ?? reply(250, '2.1.5 OK');
        case 'DATA':
          return reply(354, 'End data with <CR><LF>.<CR><LF>');
        case 'QUIT':
          return script.quitReply === undefined ? reply(221, '2.0.0 Bye') : script.quitReply;
      }
      return reply(500, '5.5.1 unknown command');
    },
  );
  return server;
}

const MIME_INPUT: MimeMessageInput = {
  fromName: 'El-Professor',
  fromAddress: 'noreply@elprofessor.eu',
  to: 'otp-spike@example.com',
  subject: 'Code zum Zurücksetzen Ihres Passworts – El-Professor',
  text: 'Hallo\nIhr Code:\n048213\n.eine Zeile mit Punkt',
  html: '<p>Grüße</p>\n<p>048213</p>',
  date: new Date('2026-09-14T12:00:00Z'),
  messageId: '5c0e7a52-5b1f-4f55-a9d9-7c3c8f1e2d4b@elprofessor.eu',
  boundary: 'ep_5c0e7a525b1f4f55a9d97c3c8f1e2d4b',
};
const MESSAGE = buildMimeMessage(MIME_INPUT);

const session = (server: ScriptedServer, overrides: Partial<SmtpSessionOptions> = {}) =>
  runSmtpSession(server, {
    clientName: 'elprofessor.eu',
    security: 'none',
    auth: null,
    envelopeFrom: 'noreply@elprofessor.eu',
    recipient: 'otp-spike@example.com',
    message: MESSAGE,
    ...overrides,
  });

describe('runSmtpSession', () => {
  it('sends one message over plain SMTP with AUTH PLAIN, as to staging\'s catcher', async () => {
    const server = smtpServer();
    await session(server, { auth: { user: 'resend', pass: 'pässwort' } });

    expect(server.commands.map((c) => c.replace(/^AUTH PLAIN .+$/, 'AUTH PLAIN <token>'))).toEqual([
      'EHLO elprofessor.eu',
      'AUTH PLAIN <token>',
      'MAIL FROM:<noreply@elprofessor.eu>',
      'RCPT TO:<otp-spike@example.com>',
      'DATA',
      'QUIT',
    ]);
    const token = server.commands[1].slice('AUTH PLAIN '.length);
    expect(Buffer.from(token, 'base64').toString('utf8')).toBe('\u0000resend\u0000pässwort');
    expect(server.message).toBe(MESSAGE.replace(/\r\n$/, ''));
  });

  it('upgrades on STARTTLS and forgets what was offered in plaintext', async () => {
    const server = smtpServer({ plaintextExtensions: ['STARTTLS', 'AUTH PLAIN'], tlsExtensions: ['AUTH LOGIN'] });
    await session(server, {
      security: 'starttls',
      upgrade: async () => {
        server.upgraded = true;
      },
      auth: { user: 'resend', pass: 'secret' },
    });

    expect(server.upgraded).toBe(true);
    expect(server.commands).toEqual([
      'EHLO elprofessor.eu',
      'STARTTLS',
      'EHLO elprofessor.eu',
      'AUTH LOGIN',
      base64Utf8('resend'),
      base64Utf8('secret'),
      'MAIL FROM:<noreply@elprofessor.eu>',
      'RCPT TO:<otp-spike@example.com>',
      'DATA',
      'QUIT',
    ]);
  });

  it('refuses a server that does not offer STARTTLS before any credential is sent', async () => {
    const server = smtpServer({ plaintextExtensions: ['AUTH PLAIN LOGIN'] });
    await expect(session(server, { security: 'starttls', upgrade: async () => {}, auth: { user: 'u', pass: 'secret' } }))
      .rejects.toMatchObject({ name: 'SmtpError', step: 'starttls_unavailable' });
    expect(server.commands).toEqual(['EHLO elprofessor.eu']);
  });

  it('refuses replies that arrived before the TLS handshake', async () => {
    let upgraded = false;
    const server = smtpServer({
      plaintextExtensions: ['STARTTLS'],
      starttlsReply: reply(220, 'Ready') + reply(250, 'injected before TLS'),
    });
    await expect(session(server, { security: 'starttls', upgrade: async () => { upgraded = true; } }))
      .rejects.toMatchObject({ step: 'starttls_injection' });
    expect(upgraded).toBe(false);
  });

  it('refuses AUTH when no mechanism it knows is offered', async () => {
    const server = smtpServer({ plaintextExtensions: ['AUTH CRAM-MD5'] });
    await expect(session(server, { auth: { user: 'u', pass: 'p' } })).rejects.toMatchObject({ step: 'auth_unavailable' });
  });

  it('names the step and reply code of a refusal, never the address', async () => {
    const server = smtpServer({ rcptReply: reply(550, '5.1.1 <otp-spike@example.com> unknown user') });
    const error = await session(server).catch((e: Error) => e);
    expect(error).toMatchObject({ name: 'SmtpError', step: 'rcpt_to', replyCode: 550 });
    expect(String(error)).not.toContain('otp-spike');
  });

  it('counts a server that hangs up instead of answering QUIT as delivered', async () => {
    const server = smtpServer({ quitReply: null });
    await expect(session(server)).resolves.toBeUndefined();
    expect(server.message).not.toBeNull();
  });

  it('fails when the connection closes before the message is accepted', async () => {
    await expect(session(smtpServer({ mailFromReply: null }))).rejects.toMatchObject({ step: 'connection_closed' });
  });

  it('refuses malformed and oversized replies', async () => {
    await expect(session(smtpServer({ greeting: 'hello there\r\n' }))).rejects.toMatchObject({ step: 'reply_malformed' });
    await expect(session(smtpServer({ greeting: 'x'.repeat(3000) }))).rejects.toMatchObject({ step: 'reply_too_long' });
    const endless = reply(220, ...Array.from({ length: 70 }, (_, i) => `line ${i}`));
    await expect(session(smtpServer({ greeting: endless }))).rejects.toMatchObject({ step: 'reply_too_long' });
  });

  it('writes nothing when an address or the client name could smuggle in a command', async () => {
    const server = smtpServer();
    await expect(session(server, { recipient: 'a@example.com>\r\nRCPT TO:<b@example.com' }))
      .rejects.toMatchObject({ step: 'invalid_address' });
    await expect(session(server, { clientName: 'elprofessor.eu\r\nQUIT' }))
      .rejects.toMatchObject({ step: 'invalid_client_name' });
    expect(server.commands).toEqual([]);
  });
});

function headerValue(message: string, name: string): string {
  const lines = message.split('\r\n');
  const start = lines.findIndex((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  const collected = [lines[start].slice(name.length + 1)];
  for (let i = start + 1; /^[ \t]/.test(lines[i]); i++) collected.push(lines[i]);
  return collected.join('\r\n');
}

const decodeWords = (value: string) =>
  value
    .replace(/\?=\r\n =\?/g, '?==?')
    .trim()
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));

function mimeParts(message: string, boundary: string): { headers: string; body: string }[] {
  return message
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((section) => {
      const [headers, body] = section.replace(/^\r\n/, '').split('\r\n\r\n');
      return { headers, body: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') };
    });
}

describe('buildMimeMessage', () => {
  it('writes CRLF lines of at most 78 characters', () => {
    expect(/(?<!\r)\n/.test(MESSAGE)).toBe(false);
    for (const line of MESSAGE.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
  });

  it('carries the headers a transactional mail needs', () => {
    expect(MESSAGE).toContain('From: "El-Professor" <noreply@elprofessor.eu>\r\n');
    expect(MESSAGE).toContain('To: <otp-spike@example.com>\r\n');
    expect(MESSAGE).toContain('Date: Mon, 14 Sep 2026 12:00:00 +0000\r\n');
    expect(MESSAGE).toContain(`Message-ID: <${MIME_INPUT.messageId}>\r\n`);
    expect(MESSAGE).toContain('MIME-Version: 1.0\r\n');
    expect(MESSAGE).toContain('Auto-Submitted: auto-generated\r\n');
    expect(headerValue(MESSAGE, 'Content-Type')).toBe(` multipart/alternative;\r\n boundary="${MIME_INPUT.boundary}"`);
  });

  it('encodes a German subject as UTF-8 words that decode back to it', () => {
    expect(decodeWords(headerValue(MESSAGE, 'Subject'))).toBe(MIME_INPUT.subject);
  });

  it('puts the text and the HTML into base64 parts that decode back to them', () => {
    const [text, html] = mimeParts(MESSAGE, MIME_INPUT.boundary);
    expect(text.headers).toBe('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64');
    expect(text.body).toBe(toCrlf(MIME_INPUT.text));
    expect(html.headers).toBe('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64');
    expect(html.body).toBe(toCrlf(MIME_INPUT.html));
  });

  it('refuses a line break in a header value', () => {
    expect(() => buildMimeMessage({ ...MIME_INPUT, subject: 'Hallo\r\nBcc: someone@example.com' }))
      .toThrow(expect.objectContaining({ step: 'invalid_header' }));
    expect(() => buildMimeMessage({ ...MIME_INPUT, fromName: 'El\nProfessor' }))
      .toThrow(expect.objectContaining({ step: 'invalid_header' }));
  });

  it('refuses a malformed boundary, message id or recipient', () => {
    expect(() => buildMimeMessage({ ...MIME_INPUT, boundary: 'a"b' })).toThrow();
    expect(() => buildMimeMessage({ ...MIME_INPUT, messageId: '<x@y>' })).toThrow();
    expect(() => buildMimeMessage({ ...MIME_INPUT, to: 'nobody' })).toThrow();
  });
});

describe('header and body helpers', () => {
  it('leaves printable ASCII alone, but not an encoded-word lookalike', () => {
    expect(encodeHeaderValue('Ihre Einladung zu El-Professor')).toBe('Ihre Einladung zu El-Professor');
    expect(encodeHeaderValue('=?UTF-8?B?x?=')).toMatch(/^=\?UTF-8\?B\?/);
  });

  it('never splits a character across encoded words', () => {
    const value = 'Grüße 👋 aus Köln – '.repeat(6);
    const words = encodeHeaderValue(value).split('\r\n ');
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      const b64 = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word)![1];
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(b64, 'base64'))).not.toThrow();
    }
    expect(decodeWords(encodeHeaderValue(value))).toBe(value);
  });

  it.each(['anna.schmidt+test@example.com', 'noreply@elprofessor.eu'])('accepts the address %j', (address) => {
    expect(isAsciiMailAddress(address)).toBe(true);
  });

  it.each(['a@b', 'a@b.de>', 'ä@b.de', 'a@b.de\r\n', 'a b@c.de', `${'a'.repeat(250)}@b.de`])(
    'refuses the address %j',
    (address) => {
      expect(isAsciiMailAddress(address)).toBe(false);
    },
  );

  it('stuffs a leading dot on every line', () => {
    expect(dotStuff('.hidden\r\nline\r\n.end')).toBe('..hidden\r\nline\r\n..end');
  });

  it('normalizes line endings, wraps base64 and formats the date in UTC', () => {
    expect(toCrlf('a\nb\r\nc')).toBe('a\r\nb\r\nc');
    expect(wrapBase64('x'.repeat(160)).split('\r\n').map((l) => l.length)).toEqual([76, 76, 8]);
    expect(base64Utf8('ä')).toBe('w6Q=');
    expect(formatSmtpDate(new Date('2026-01-10T23:30:00Z'))).toBe('Sat, 10 Jan 2026 23:30:00 +0000');
  });
});

// ─── Attachments (02.10.2026) ────────────────────────────────────────────────
//
// Added so the weekly Abrechnung can carry its card as a PNG. Every mail before
// this was `multipart/alternative` — a text part and an HTML part, two
// alternatives of one message. An attachment is a different relationship: it sits
// BESIDE the text rather than instead of it, so the message becomes
// `multipart/mixed` with the alternative pair nested inside.
//
// The first assertion is the one that matters most: **with no attachment the
// message is byte-for-byte what it was**, which is what keeps the five templates
// `email-layout.test.ts` pins and every OTP mail untouched.

describe('buildMimeMessage — attachments', () => {
  const base = {
    fromName: 'El-Professor',
    fromAddress: 'noreply@example.com',
    to: 'fahrer@example.com',
    subject: 'Abrechnung',
    text: 'Zusammenfassung',
    html: '<p>Zusammenfassung</p>',
    date: new Date('2026-10-02T12:00:00Z'),
    messageId: 'abc@example.com',
    boundary: 'INNER_0123456789',
  };

  it('with nothing attached, the message is exactly what it always was', () => {
    const withoutKey = buildMimeMessage(base);
    const withEmptyList = buildMimeMessage({ ...base, attachments: [] });
    // An empty list is not an attachment, and an unused mixedBoundary must not
    // change the output either.
    const withUnusedBoundary = buildMimeMessage({
      ...base, attachments: [], mixedBoundary: 'OUTER_0123456789',
    });

    expect(withEmptyList).toBe(withoutKey);
    expect(withUnusedBoundary).toBe(withoutKey);
    expect(withoutKey).toContain('Content-Type: multipart/alternative;');
    expect(withoutKey).not.toContain('multipart/mixed');
  });

  it('nests the alternative pair inside mixed, and closes both', () => {
    const message = buildMimeMessage({
      ...base,
      mixedBoundary: 'OUTER_0123456789',
      attachments: [{ filename: 'abrechnung.png', contentType: 'image/png', content: 'AAAA' }],
    });

    expect(message).toContain('Content-Type: multipart/mixed;');
    expect(message).toContain(' boundary="OUTER_0123456789"');
    expect(message).toContain('Content-Type: multipart/alternative;');
    // The inner pair still closes with its own terminator, inside the outer part.
    expect(message).toContain('--INNER_0123456789--');
    expect(message).toContain('--OUTER_0123456789--');
    // And the inner terminator comes BEFORE the outer one, or the attachment
    // would sit outside the message.
    expect(message.indexOf('--INNER_0123456789--'))
      .toBeLessThan(message.indexOf('--OUTER_0123456789--'));

    expect(message).toContain('Content-Type: image/png; name="abrechnung.png"');
    expect(message).toContain('Content-Disposition: attachment; filename="abrechnung.png"');
  });

  it('refuses one boundary for both levels, which would swallow the attachment', () => {
    // The inner terminator would close the outer part and the file would vanish
    // with no error anywhere — the worst possible failure for a send.
    expect(() => buildMimeMessage({
      ...base,
      mixedBoundary: base.boundary,
      attachments: [{ filename: 'a.png', contentType: 'image/png', content: 'AAAA' }],
    })).toThrow(/invalid_boundary/);
  });

  it('refuses an attachment with no outer boundary at all', () => {
    expect(() => buildMimeMessage({
      ...base,
      attachments: [{ filename: 'a.png', contentType: 'image/png', content: 'AAAA' }],
    })).toThrow(/invalid_boundary/);
  });

  it('refuses a filename or a type that would break out of its header', () => {
    const attach = (over: Record<string, string>) => () => buildMimeMessage({
      ...base,
      mixedBoundary: 'OUTER_0123456789',
      attachments: [{
        filename: 'a.png', contentType: 'image/png', content: 'AAAA', ...over,
      }],
    });

    // A quote closes the header's own quoting; a newline starts a new header.
    expect(attach({ filename: 'a".png' })).toThrow(/invalid_attachment_name/);
    expect(attach({ filename: 'a\r\nBcc: someone@example.com' })).toThrow();
    expect(attach({ filename: '' })).toThrow(/invalid_attachment_name/);
    expect(attach({ contentType: 'image/png; x="y"' })).toThrow(/invalid_attachment_type/);
  });

  it('refuses content that is not base64, rather than sending a corrupt file', () => {
    expect(() => buildMimeMessage({
      ...base,
      mixedBoundary: 'OUTER_0123456789',
      attachments: [{ filename: 'a.png', contentType: 'image/png', content: 'not base64!' }],
    })).toThrow(/invalid_attachment_content/);
  });

  it('folds the base64 to SMTP line length, as the body parts are folded', () => {
    const long = 'A'.repeat(500);
    const message = buildMimeMessage({
      ...base,
      mixedBoundary: 'OUTER_0123456789',
      attachments: [{ filename: 'a.png', contentType: 'image/png', content: long }],
    });
    // No line of the message may exceed what SMTP accepts; the 998-octet limit is
    // the hard one and `wrapBase64` folds well inside it.
    for (const line of message.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
    expect(message).not.toContain(long);
  });

  it('carries more than one attachment, each in its own part', () => {
    const message = buildMimeMessage({
      ...base,
      mixedBoundary: 'OUTER_0123456789',
      attachments: [
        { filename: 'one.png', contentType: 'image/png', content: 'AAAA' },
        { filename: 'two.pdf', contentType: 'application/pdf', content: 'BBBB' },
      ],
    });
    expect(message).toContain('filename="one.png"');
    expect(message).toContain('filename="two.pdf"');
    expect(message.split('--OUTER_0123456789').length - 1).toBe(4); // open, 3 parts
  });
});
