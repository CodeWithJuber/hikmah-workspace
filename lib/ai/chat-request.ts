/** Validation for a chat run request.
 *
 * Kept apart from the route so the decisions can be tested as pure functions:
 * what counts as same-origin, what a well-formed run configuration is, and
 * which failures are the caller's fault rather than the provider's. The route
 * is then thin enough to read in one go.
 */

export type ChatRequestBody = {
  baseUrl: string;
  model: string;
  freeOnly: boolean;
  apiKeySecret?: string;
  instructions: string;
  maxSteps?: number;
  /** How much earlier conversation the run may carry, in characters. */
  contextCharacters?: number;
  /** The model's window in tokens, when the provider publishes one. */
  contextWindow?: number;
  disabledTools: string[];
  /** An agent's allowlist over the built-in tools; empty means all of them. */
  enabledTools: string[];
  /** Compare mode: answer a second time with no tools, for contrast. */
  compare?: { model?: string };
  /** Offer `deep_research` this turn: sub-agents fanned out over the question. */
  deepResearch: boolean;
  /** Search the web this turn, whatever the conversation's tool switches say. */
  webSearch: boolean;
  /**
   * This session is incognito: the run must neither read nor write memory,
   * and learning must not capture the exchange. Per turn like deepResearch —
   * a choice made for a question — except the toggle lives on the Memory
   * screen and applies to every turn of the session, not the switches on a
   * composer. Absent means off, the persistent settings decide.
   */
  incognito: boolean;
  /**
   * Why this turn is being sent. `regenerate-message` means the last message is
   * already stored and is being replayed, so the conversation has to be
   * truncated back to it rather than appended to. Anything else is a new turn.
   */
  regenerate: boolean;
  messages: unknown;
};

export class ChatRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ChatRequestError';
    this.status = status;
  }
}

/**
 * A run carries the owner's session cookie, so a request from another origin
 * must not be able to start one. The Origin header is required rather than
 * merely checked: a missing Origin on a state-changing POST is treated as
 * untrusted instead of being waved through.
 */
export function assertSameOrigin(request: Request, expected: string): void {
  const origin = request.headers.get('origin');
  if (!origin || origin !== expected)
    throw new ChatRequestError('Use chat from your signed-in workspace.', 403);
}

/** Upper bound on the tool-calling rounds a single request may ask for. */
export const MAX_ALLOWED_STEPS = 32;

/** Rounds a run gets when nobody says otherwise.
 *
 * Here beside its ceiling rather than in run-agent, because the chat surface's
 * settings need it and importing run-agent from the browser drags the whole
 * server tool tree — node:path included — into the client bundle. */
export const DEFAULT_MAX_STEPS = 12;

/** Validate and normalise the run configuration sent with a turn. */
export function parseChatRequest(raw: unknown): ChatRequestBody {
  if (!raw || typeof raw !== 'object') throw new ChatRequestError('Expected a JSON request body.');
  const body = raw as Record<string, unknown>;

  if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim())
    throw new ChatRequestError('Choose a provider endpoint.');
  if (typeof body.model !== 'string' || !body.model.trim())
    throw new ChatRequestError('Choose a model.');
  if (typeof body.instructions !== 'string' || !body.instructions.trim())
    throw new ChatRequestError('Missing system instructions for this run.');
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    throw new ChatRequestError('Send a message to start the run.');

  // Bounded here as well as in the settings parser: this arrives from the
  // client, and a run that carries a megabyte of history is a bill, not a
  // preference.
  let contextCharacters: number | undefined;
  if (body.contextCharacters !== undefined) {
    if (
      typeof body.contextCharacters !== 'number' ||
      !Number.isInteger(body.contextCharacters) ||
      body.contextCharacters < 2_000 ||
      body.contextCharacters > 400_000
    )
      throw new ChatRequestError('Earlier conversation must be 2,000 to 400,000 characters.');
    contextCharacters = body.contextCharacters;
  }

  // What the provider says this model can hold, so the run can budget history
  // against it instead of a flat number that fitted no model in particular.
  // Bounded because it arrives from the client and only ever shrinks the
  // request: a caller inflating it spends its own window, not ours.
  let contextWindow: number | undefined;
  if (body.contextWindow !== undefined) {
    if (
      typeof body.contextWindow !== 'number' ||
      !Number.isInteger(body.contextWindow) ||
      body.contextWindow < 1_000 ||
      body.contextWindow > 10_000_000
    )
      throw new ChatRequestError('The model context window must be a whole number of tokens.');
    contextWindow = body.contextWindow;
  }

  let maxSteps: number | undefined;
  if (body.maxSteps !== undefined) {
    if (
      typeof body.maxSteps !== 'number' ||
      !Number.isInteger(body.maxSteps) ||
      body.maxSteps < 1 ||
      body.maxSteps > MAX_ALLOWED_STEPS
    )
      throw new ChatRequestError(`Steps must be a whole number from 1 to ${MAX_ALLOWED_STEPS}.`);
    maxSteps = body.maxSteps;
  }

  // A secret *name*, never a key. If a caller sends something that is not a
  // valid name it is dropped rather than forwarded, so a raw key pasted here
  // cannot be used as a credential by accident.
  const apiKeySecret =
    typeof body.apiKeySecret === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.apiKeySecret)
      ? body.apiKeySecret
      : undefined;

  // Absent means the mode is off, which is different from on with no model
  // named — that one falls back to the run's own model, comparing workflows
  // rather than models.
  let compare: { model?: string } | undefined;
  if (body.compare !== undefined && body.compare !== null && body.compare !== false) {
    if (typeof body.compare !== 'object' || Array.isArray(body.compare))
      throw new ChatRequestError('Compare mode is configured with an object.');
    const requested = (body.compare as { model?: unknown }).model;
    if (requested !== undefined && (typeof requested !== 'string' || requested.length > 256))
      throw new ChatRequestError('Choose a valid model to compare against.');
    compare = { model: typeof requested === 'string' ? requested.trim() || undefined : undefined };
  }

  return {
    baseUrl: body.baseUrl.trim(),
    model: body.model.trim(),
    freeOnly: body.freeOnly !== false,
    apiKeySecret,
    instructions: body.instructions,
    maxSteps,
    contextCharacters,
    contextWindow,
    disabledTools: Array.isArray(body.disabledTools)
      ? body.disabledTools.filter((tool): tool is string => typeof tool === 'string')
      : [],
    enabledTools: Array.isArray(body.enabledTools)
      ? body.enabledTools.filter((tool): tool is string => typeof tool === 'string')
      : [],
    // Only the model is taken from the caller, and only as a string. The key,
    // the endpoint and the free-only rule come from the run's own
    // configuration, so the comparison cannot be pointed somewhere else.
    compare,
    // Per turn, like compare: a fan-out is a choice made for a question, not a
    // setting that follows every one.
    deepResearch: body.deepResearch === true,
    // The composer's Search switch, per turn for the same reason.
    webSearch: body.webSearch === true,
    // Session incognito: only an explicit true counts — a mistyped value
    // falls back to the persistent settings, never to a silent opt-out.
    incognito: body.incognito === true,
    // Anything other than the one value that means "replay" is treated as a new
    // turn, so an unrecognised or absent trigger can only ever append — never
    // delete.
    regenerate: body.trigger === 'regenerate-message',
    messages: body.messages,
  };
}
