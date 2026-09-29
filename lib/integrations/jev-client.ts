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

/**
 * How long a lane proposal may take before it reads as "unreachable".
 *
 * The lane is advisory — null means the run proceeds exactly as it would have
 * without the preflight — so a slow Jev must never slow the run. Three seconds
 * is ample for one choice question to a small typed model; anything slower is
 * treated the same as a connection failure. The run pipeline already overlaps
 * this wait with the MCP connects (lib/runs/service.ts), so in practice it
 * only costs wall time when Jev is slower than every server handshake.
 * Overridable per call.
 */
export const JEV_DEFAULT_TIMEOUT_MS = 3_000;

export async function systemOne(
  state: Record<string, unknown>,
  questions: JevQuestion[],
  options: JevClientOptions = {},
): Promise<JevResponse | null> {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey || !questions.length) return null;
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS);
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
