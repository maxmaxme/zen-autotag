// TypeSafe Jev — a decision model: a Choice question returns one of the given
// options with a probability for each and a calibrated confidence.
// https://docs.typesafe.ai/api
const URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_OPTIONS = 255;

export interface Option {
  id: string;
  /** What the model reads: the category's readable name. */
  name: string;
  /** Optional words for names that don't explain themselves (an emoji…). */
  hint?: string;
}

export interface Choice {
  id: string;
  confidence: number;
  /** All options, most likely first. */
  ranked: { id: string; probability: number }[];
}

export class JevError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

export async function classify(token: string, state: unknown, options: readonly Option[]): Promise<Choice> {
  if (options.length === 0 || options.length > MAX_OPTIONS) {
    throw new JevError(0, `need 1..${MAX_OPTIONS} options, got ${options.length}`);
  }
  // Keys must be unique; two categories can share a name under different parents.
  const keyToId = new Map<string, string>();
  const criteria: Record<string, string | null> = {};
  for (const o of options) {
    let key = o.name;
    for (let n = 2; keyToId.has(key); n++) {
      key = `${o.name} (${n})`;
    }
    keyToId.set(key, o.id);
    criteria[key] = o.hint?.trim() || null;
  }

  const res = await fetch(URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state,
      questions: {
        category: {
          type: 'choice',
          instructions: 'Which of my categories does this transaction belong to?',
          criteria,
        },
      },
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new JevError(res.status, `TypeSafe ${res.status}: ${body.slice(0, 200)}`);
  }
  const answer = (
    JSON.parse(body) as {
      answers?: { category?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } };
    }
  ).answers?.category;
  const id = answer?.choice ? keyToId.get(answer.choice) : undefined;
  if (!id || typeof answer?.confidence !== 'number') {
    throw new JevError(res.status, `TypeSafe: unexpected answer ${body.slice(0, 200)}`);
  }
  const ranked = Object.entries(answer.probabilities ?? {})
    .map(([key, probability]) => ({ id: keyToId.get(key) ?? '', probability }))
    .filter((r) => r.id)
    .sort((a, b) => b.probability - a.probability);
  return { id, confidence: answer.confidence, ranked };
}
