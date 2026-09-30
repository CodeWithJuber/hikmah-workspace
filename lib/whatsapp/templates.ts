/** Message templates and the 24h session-window rule.
 *
 * WhatsApp's rule, enforced in code: inside 24h of the user's last inbound
 * message the business may send free-form (session) messages; outside the
 * window only Meta-approved templates may go out. An unapproved or unknown
 * template name never sends outside the window — an unknown stays unknown.
 */

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type TemplateStatus = 'approved' | 'pending' | 'rejected';

export type TemplateRecord = {
  name: string;
  language: string;
  category: string;
  body: string;
  variableCount: number;
  status: TemplateStatus;
};

export type SendKind = 'session' | 'template';

/** The window is open when the user wrote to us within the last 24h. */
export function withinSessionWindow(lastInboundAt: string | null, nowMs: number): boolean {
  if (!lastInboundAt) return false;
  const at = Date.parse(lastInboundAt);
  if (Number.isNaN(at)) return false;
  return nowMs - at < SESSION_WINDOW_MS;
}

export class WhatsAppTemplateError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'WhatsAppTemplateError';
    this.status = status;
  }
}

/** Look up a template by name and (optionally) language. */
export function findTemplate(
  templates: TemplateRecord[],
  name: string,
  language?: string,
): TemplateRecord | undefined {
  return templates.find((t) => t.name === name && (!language || t.language === language));
}

/** Fill {{1}}..{{n}} placeholders; throws when a parameter is missing. */
export function renderTemplate(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (match, group) => {
    const index = Number(group) - 1;
    const value = params[index];
    if (value === undefined) {
      throw new WhatsAppTemplateError(
        `Template needs parameter {{${group}}} but only ${params.length} were given.`,
        400,
      );
    }
    return value;
  });
}

/**
 * Decide which kind of message may go out. Returns the kind, or throws the
 * 403 the route turns into an honest refusal.
 */
export function gateMessageKind(args: {
  windowOpen: boolean;
  templateName: string | null;
  templates: TemplateRecord[];
  templateLanguage?: string;
  templateParams?: string[];
}): { kind: SendKind; template: TemplateRecord | null } {
  const { windowOpen, templateName, templates } = args;
  if (!templateName) {
    if (!windowOpen) {
      throw new WhatsAppTemplateError(
        'No session is open: the 24h window has passed, so only an approved template may be sent.',
        403,
      );
    }
    return { kind: 'session', template: null };
  }
  const template = findTemplate(templates, templateName, args.templateLanguage);
  if (!template) {
    throw new WhatsAppTemplateError(`No template named "${templateName}".`, 404);
  }
  if (template.status !== 'approved' && !windowOpen) {
    throw new WhatsAppTemplateError(
      `Template "${templateName}" is ${template.status}, not approved — it cannot go out outside the session window.`,
      403,
    );
  }
  renderTemplate(template.body, args.templateParams ?? []);
  return { kind: 'template', template };
}
