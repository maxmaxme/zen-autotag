export interface Notifier {
  failed(error: string, hint: string | null): Promise<void>;
  recovered(): Promise<void>;
}

export class TelegramNotifier implements Notifier {
  private readonly token: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { token: string; chatId: string; fetch?: typeof fetch }) {
    this.token = opts.token;
    this.chatId = opts.chatId;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  failed(error: string, hint: string | null): Promise<void> {
    return this.send(`✗ zen-receipts: run failed.\n${error}${hint ? `\n${hint}` : ''}`);
  }

  recovered(): Promise<void> {
    return this.send('✓ zen-receipts: working again.');
  }

  private async send(text: string): Promise<void> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) {
      throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  }
}

export class NullNotifier implements Notifier {
  async failed(): Promise<void> {}
  async recovered(): Promise<void> {}
}
