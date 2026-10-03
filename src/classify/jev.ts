// TypeSafe System One API — https://docs.typesafe.ai/api
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
/** API limit for options in one Choice question. */
export const MAX_OPTIONS = 255;

/** One option the classifier may pick: an opaque id, a name, and the user's hint. */
export interface ClassifyOption {
  id: string;
  name: string;
  hint: string;
}

export interface ClassifyResult {
  id: string;
  confidence: number;
}

export interface Classifier {
  /** Which of `options` this order belongs to, judged from the store and its line items. */
  classify(input: { store: string; items: readonly string[] }, options: readonly ClassifyOption[]): Promise<ClassifyResult>;
}

export class JevError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

/**
 * TypeSafe's Jev answers a Choice question with a probability per option and
 * a calibrated confidence — it can only pick one of the options given. The
 * options are the user's own categories (name + their hint), so nothing about
 * what they spend on lives in this code.
 */
export class JevClassifier implements Classifier {
  private readonly token: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { token: string; model?: string; fetch?: typeof fetch }) {
    this.token = opts.token;
    this.model = opts.model ?? 'jev-latest';
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async classify(
    input: { store: string; items: readonly string[] },
    options: readonly ClassifyOption[],
  ): Promise<ClassifyResult> {
    if (options.length === 0 || options.length > MAX_OPTIONS) {
      throw new JevError(0, `need 1..${MAX_OPTIONS} options, got ${options.length}`);
    }
    // Option keys are what the model reads, so use the readable name; make it unique.
    const keyToId = new Map<string, string>();
    const criteria: Record<string, string | null> = {};
    for (const o of options) {
      let key = o.name;
      for (let n = 2; keyToId.has(key); n++) {
        key = `${o.name} (${n})`;
      }
      keyToId.set(key, o.id);
      criteria[key] = o.hint.trim() || null;
    }

    const res = await this.fetchImpl(TYPESAFE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        state: { store: input.store, items: input.items },
        questions: {
          category: {
            type: 'choice',
            instructions: 'Which spending category does this delivery order belong to?',
            criteria,
          },
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new JevError(res.status, `TypeSafe ${res.status}: ${text.slice(0, 300)}`);
    }
    const answer = (JSON.parse(text) as { answers?: { category?: { choice?: string; confidence?: number } } })
      .answers?.category;
    const id = answer?.choice ? keyToId.get(answer.choice) : undefined;
    if (!id || typeof answer?.confidence !== 'number') {
      throw new JevError(res.status, `TypeSafe: unexpected answer ${text.slice(0, 300)}`);
    }
    return { id, confidence: answer.confidence };
  }
}
