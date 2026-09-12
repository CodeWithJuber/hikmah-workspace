/** Transactional email, or nothing at all.
 *
 * A deployment with no RESEND_API_KEY is a working deployment: development, CI,
 * the standalone smoke and the container smoke all run without one, and none of
 * them should need a mail server. So the sender is a no-op there, and the two
 * features that depend on it — verifying an address and resetting a password —
 * are switched off rather than half-working. `mailConfigured()` is what decides
 * that, in one place, so the auth options and the sign-up page cannot disagree
 * about whether a verification email is coming.
 */

/** Whether this deployment can send mail at all. */
export function mailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.HIKMAH_MAIL_FROM);
}

let client;

async function resend() {
  if (client) return client;
  const { Resend } = await import('resend');
  client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

/**
 * Send one message. Resolves either way.
 *
 * A failure is logged and swallowed on purpose: Better Auth calls this inside
 * sign-up and password-reset handlers, and a provider outage must not turn a
 * created account into a 500 the person reads as "it did not work". The account
 * exists; the email can be re-requested.
 */
export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) return false;
  try {
    const { error } = await (
      await resend()
    ).emails.send({
      from: process.env.HIKMAH_MAIL_FROM,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    });
    if (error) throw Error(error.message ?? 'The mail provider refused the message.');
    return true;
  } catch (error) {
    console.error('[hikmah] email not sent:', error instanceof Error ? error.message : error);
    return false;
  }
}

/** The plain-text body for the two messages this app sends.
 *
 * Text rather than a template: these are two short messages whose whole job is
 * to carry one link, and a React email pipeline for that would be more build
 * than message. The link is passed in already signed by Better Auth.
 */
export function verifyMessage(url) {
  return {
    subject: 'Confirm your email for Hikmah',
    text: [
      'Confirm this address to finish setting up your workspace:',
      '',
      url,
      '',
      'The link is good for one use. If you did not create an account, ignore this — nothing was set up.',
    ].join('\n'),
  };
}

export function resetMessage(url) {
  return {
    subject: 'Reset your Hikmah password',
    text: [
      'Set a new password here:',
      '',
      url,
      '',
      'The link expires shortly and can be used once. If you did not ask for this, ignore it — your password has not changed.',
    ].join('\n'),
  };
}
