import type { TypeformForm, TypeformForms, TypeformResponses } from './typeform-types.ts';

const API = 'https://api.typeform.com';
const PAGE_SIZE = 25;
const MAX_BYTES = 1_000_000;
export const TYPEFORM_DELAY_NOTE =
  'Typeform may take up to 30 minutes to make recent submissions available. These are completed responses.';

export class TypeformError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TypeformError';
    this.status = status;
  }
}
export function typeformId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new TypeformError('Choose a valid Typeform form.');
  return value;
}
export function typeformPage(value: unknown = 1): number {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
    throw new TypeformError('Choose a valid page.');
  return page;
}
export function typeformCursor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value))
    throw new TypeformError('This response page has an invalid cursor. Refresh the form.');
  return value;
}
export function typeformToken(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /\s/.test(value.trim()))
    throw new TypeformError('Enter a Typeform personal access token without spaces.');
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new TypeformError('The token contains an invalid character.');
  return value.trim();
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, max = 4000) => (typeof value === 'string' ? value.slice(0, max) : '');
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const array = (value: unknown) => (Array.isArray(value) ? value : []);

function form(value: unknown): TypeformForm {
  const row = record(value);
  const display = text(record(row._links).display, 1000);
  let url: string | undefined;
  try {
    const parsed = new URL(display);
    if (
      parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      (parsed.hostname === 'typeform.com' || parsed.hostname.endsWith('.typeform.com'))
    ) url = parsed.href;
  } catch { /* A display URL is optional. It is never used as an API endpoint. */ }
  return {
    id: typeformId(row.id),
    title: text(row.title, 300) || 'Untitled form',
    ...(text(row.last_updated_at, 40) ? { updatedAt: text(row.last_updated_at, 40) } : {}),
    ...(url ? { url } : {}),
  };
}

/** Fixed official host; no redirects, no caller-supplied URLs, no response cache. */
export function createTypeformClient(
  token: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const key = typeformToken(token);
  const fetchImpl = options.fetchImpl ?? fetch;
  const clean = (value: string) => value.split(key).join('[credential removed]');
  async function request(path: string, query = new URLSearchParams()) {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let response: Response;
    try {
      response = await fetchImpl(`${API}${path}?${query}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      throw new TypeformError(
        signal.aborted ? 'Typeform took too long. Try again.' : 'Could not reach Typeform. Try again.',
        502,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const message = response.status === 401
        ? 'Typeform rejected the saved token. Ask the owner to reconnect it.'
        : response.status === 403
          ? 'The Typeform token needs forms:read and responses:read access to this form.'
          : response.status === 404
            ? 'This form is no longer available in the connected Typeform account.'
            : response.status === 429
              ? 'Typeform is receiving too many requests. Try again shortly.'
              : 'Typeform could not complete this request. Try again.';
      throw new TypeformError(message, response.status === 429 ? 429 : 502);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TypeformError('Typeform returned an empty response.', 502);
    const decoder = new TextDecoder();
    let bytes = 0, body = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES)
          throw new TypeformError('This Typeform page is too large to read safely.', 502);
        body += decoder.decode(part.value, { stream: true });
      }
      return record(JSON.parse(clean(body + decoder.decode())));
    } catch (error) {
      if (error instanceof TypeformError) throw error;
      throw new TypeformError('Typeform returned an unreadable response. Try again.', 502);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async function detail(id: string) {
    const result = await request(`/forms/${typeformId(id)}`);
    if (result.id !== id) throw new TypeformError('Typeform returned a different form.', 502);
    return result;
  }
  return {
    async forms(page = 1): Promise<TypeformForms> {
      page = typeformPage(page);
      const payload = await request('/forms', new URLSearchParams({
        page: String(page), page_size: String(PAGE_SIZE), sort_by: 'last_updated_at', order_by: 'desc',
      }));
      if (!Array.isArray(payload.items)) throw new TypeformError('Typeform returned no form list.', 502);
      return {
        items: payload.items.slice(0, PAGE_SIZE).map(form), page,
        pageCount: count(payload.page_count), total: count(payload.total_items),
      };
    },
    async form(id: string): Promise<TypeformForm> { return form(await detail(id)); },
    async responses(id: string, before?: string): Promise<TypeformResponses> {
      id = typeformId(id);
      const cursor = typeformCursor(before);
      const query = new URLSearchParams({ page_size: String(PAGE_SIZE), response_type: 'completed' });
      if (cursor) query.set('before', cursor);
      const [definition, payload] = await Promise.all([
        detail(id), request(`/forms/${id}/responses`, query),
      ]);
      if (!Array.isArray(payload.items)) throw new TypeformError('Typeform returned no responses list.', 502);
      const questions = new Map<string, string>();
      const collect = (fields: unknown, depth = 0) => {
        if (depth > 4) return;
        for (const raw of array(fields).slice(0, 200)) {
          const field = record(raw);
          questions.set(text(field.id, 100), text(field.title, 500));
          collect(record(field.properties).fields, depth + 1);
        }
      };
      collect(definition.fields);
      const rows = payload.items.slice(0, PAGE_SIZE);
      const items = rows.map((raw) => {
        const row = record(raw);
        return {
          id: text(row.response_id ?? row.token, 200),
          submittedAt: text(row.submitted_at, 40),
          answers: array(row.answers).slice(0, 100).map((rawAnswer) => {
            const answer = record(rawAnswer), field = record(answer.field);
            let value = '[Unsupported answer type]';
            if (['text', 'email', 'url', 'phone_number', 'date'].includes(String(answer.type)))
              value = text(answer[String(answer.type)]);
            else if (answer.type === 'number' && typeof answer.number === 'number') value = String(answer.number);
            else if (answer.type === 'boolean' && typeof answer.boolean === 'boolean') value = answer.boolean ? 'Yes' : 'No';
            else if (answer.type === 'choice') value = text(record(answer.choice).label ?? record(answer.choice).other);
            else if (answer.type === 'choices') value = array(record(answer.choices).labels).slice(0, 100).map((v) => text(v, 200)).join(', ').slice(0, 4000);
            else if (answer.type === 'file_url') value = '[Uploaded file; open in Typeform]';
            return { question: questions.get(text(field.id, 100)) || text(field.ref, 200) || 'Question', value };
          }),
        };
      });
      const last = record(rows.at(-1));
      const next = text(last.token ?? last.response_id, 200);
      return {
        form: form(definition), items, total: count(payload.total_items),
        nextBefore: rows.length === PAGE_SIZE && /^[A-Za-z0-9_-]{1,200}$/.test(next) ? next : null,
        note: TYPEFORM_DELAY_NOTE,
      };
    },
  };
}
