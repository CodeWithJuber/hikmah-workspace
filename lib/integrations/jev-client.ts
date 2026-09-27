/** Safe TypeSafe System One adapter. JEV returns typed decisions, not prose. */
type JevQuestion = {
  id: string;
  type: 'choice' | 'score' | 'noul';
  prompt: string;
  options?: string[];
};
type JevAnswer = {
  id: string;
  value: string | number | boolean | null;
  probability?: number;
};
type JevResponse = {
  answers: JevAnswer[];
  model?: string;
  usage?: { inputTokens?: number };
};
type JevClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

const secretPattern = /(sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._-]{12,})/i;
const safeUrl = (value: string) => value.replace(/\/$/, '');

export async function systemOne(
  state: Record<string, unknown>,
  questions: JevQuestion[],
  options: JevClientOptions = {},
): Promise<JevResponse | null> {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey || !questions.length) return null;
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await fetcher(
      `${safeUrl(options.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai')}/v1/systemone`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: options.model ?? 'jev-latest', state, questions }),
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as Partial<JevResponse>;
    if (!Array.isArray(payload.answers) || JSON.stringify(payload).match(secretPattern))
      return null;
    const allowed = new Map(questions.map((question) => [question.id, question]));
    const answers = payload.answers.filter((answer): answer is JevAnswer => {
      const question = allowed.get(answer?.id);
      if (!question) return false;
      if (
        answer.probability !== undefined &&
        (typeof answer.probability !== 'number' || answer.probability < 0 || answer.probability > 1)
      )
        return false;
      if (question.type === 'choice' && !question.options?.includes(String(answer.value)))
        return false;
      if (
        question.type === 'score' &&
        (typeof answer.value !== 'number' || answer.value < 0 || answer.value > 1)
      )
        return false;
      return true;
    });
    return {
      answers,
      model: typeof payload.model === 'string' ? payload.model : undefined,
      usage: payload.usage,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
