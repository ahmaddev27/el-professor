// Reads the mail staging sends. Staging's GoTrue delivers to Mailpit, which
// keeps every message and delivers none, so a test can wait for a mail to a
// test address and pull the link or code out of it.

interface MessageSummary {
  ID: string;
  Subject: string;
  Created: string;
}

export interface Mail {
  id: string;
  subject: string;
  html: string;
  text: string;
}

export class Mailpit {
  constructor(
    private readonly baseUrl: string,
    private readonly user: string,
    private readonly password: string,
  ) {}

  static fromEnv(): Mailpit {
    return new Mailpit(process.env.E2E_MAILPIT_URL!, process.env.E2E_MAILPIT_USER!, process.env.E2E_MAILPIT_PASS!);
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const auth = Buffer.from(`${this.user}:${this.password}`).toString('base64');
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!response.ok) {
      throw new Error(`Mailpit ${init.method ?? 'GET'} ${path} answered ${response.status}`);
    }
    return response;
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.call('/api/v1/info');
      return true;
    } catch {
      return false;
    }
  }

  private async search(to: string): Promise<MessageSummary[]> {
    const query = encodeURIComponent(`to:"${to}"`);
    const body = (await (await this.call(`/api/v1/search?query=${query}&limit=50`)).json()) as { messages: MessageSummary[] };
    return body.messages ?? [];
  }

  /** Removes every message to this address, so the next wait sees only new mail. */
  async clear(to: string): Promise<void> {
    const ids = (await this.search(to)).map((message) => message.ID);
    if (ids.length > 0) {
      await this.call('/api/v1/messages', { method: 'DELETE', body: JSON.stringify({ IDs: ids }) });
    }
  }

  async waitForMessage(to: string, timeoutMs = 45_000): Promise<Mail> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [latest] = await this.search(to);
      if (latest) {
        const message = (await (await this.call(`/api/v1/message/${latest.ID}`)).json()) as {
          Subject: string;
          HTML: string;
          Text: string;
        };
        return { id: latest.ID, subject: message.Subject, html: message.HTML, text: message.Text };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`No mail to ${to} arrived within ${timeoutMs / 1_000} s`);
  }
}

/** The GoTrue verification link in a mail, with HTML entities decoded. */
export function verifyLinkFrom(html: string): string {
  const match = html.match(/href="([^"]*\/auth\/v1\/verify[^"]*)"/);
  if (!match) throw new Error('The mail contains no /auth/v1/verify link');
  return match[1].replaceAll('&amp;', '&');
}
