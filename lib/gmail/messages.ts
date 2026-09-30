/** Building and reading mail bytes for the Gmail API.
 *
 * The API takes a base64url-encoded RFC 2822 message on send, and returns its
 * own nested payload structure on read. Both directions live here as pure
 * functions, so the client stays a thin HTTP wrapper and every encoding edge
 * has a unit test.
 */

/** base64url without padding, as the Gmail API expects. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function base64UrlDecode(raw: string): Uint8Array {
  // The API sometimes returns standard base64; accept both.
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(normalized, 'base64'));
}

export type OutgoingMail = {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string | null;
};

/**
 * Build the raw RFC 2822 message for `users.messages.send`.
 *
 * Headers are folded to 78 columns and non-ASCII text is RFC 2047-encoded,
 * so a subject in any script survives the trip. The body goes out as
 * text/plain UTF-8 quoted-printable.
 */
export function buildRawMessage(mail: OutgoingMail): string {
  const encodeWord = (text: string): string => {
    if (/^[\x20-\x7e]*$/.test(text)) return text;
    return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
  };
  const fold = (name: string, value: string): string => {
    const line = `${name}: ${value}`;
    if (line.length <= 78) return line;
    // Fold on spaces; encoded words are kept whole.
    const words = value.split(' ');
    const lines: string[] = [];
    let current = `${name}:`;
    for (const word of words) {
      if ((current + ' ' + word).length > 78) {
        lines.push(current);
        current = ' ' + word;
      } else {
        current += ' ' + word;
      }
    }
    lines.push(current);
    return lines.join('\r\n');
  };
  const lines = [
    fold('To', mail.to.join(', ')),
    ...(mail.cc && mail.cc.length > 0 ? [fold('Cc', mail.cc.join(', '))] : []),
    fold('Subject', encodeWord(mail.subject)),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    ...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`, `References: ${mail.inReplyTo}`] : []),
  ];
  const qp = Buffer.from(mail.body, 'utf8')
    .toString('binary')
    .split('')
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code === 10) return '\r\n';
      if (code === 13) return '';
      if ((code >= 33 && code <= 60) || (code >= 62 && code <= 126)) return ch;
      if (code === 32 || code === 9) return ch;
      return '=' + code.toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');
  return lines.join('\r\n') + '\r\n\r\n' + qp;
}

export type GmailApiPayload = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailApiPayload[];
  headers?: { name: string; value: string }[];
};

export type ReadMail = {
  id: string;
  threadId: string;
  snippet: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
};

function header(payload: GmailApiPayload, name: string): string {
  const found = payload.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
}

/** Walk the MIME tree for the first text/plain part with a body. */
function plainTextBody(payload: GmailApiPayload): string {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(base64UrlDecode(payload.body.data)).toString('utf8');
  }
  for (const part of payload.parts ?? []) {
    const text = plainTextBody(part);
    if (text) return text;
  }
  return '';
}

/** Turn one `users.messages.get` response into the shape the UI shows. */
export function parseGmailMessage(raw: {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: GmailApiPayload;
}): ReadMail {
  const payload = raw.payload ?? {};
  return {
    id: raw.id,
    threadId: raw.threadId,
    snippet: raw.snippet ?? '',
    from: header(payload, 'From'),
    to: header(payload, 'To'),
    subject: header(payload, 'Subject'),
    date: header(payload, 'Date'),
    body: plainTextBody(payload),
  };
}
