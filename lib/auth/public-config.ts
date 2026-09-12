/** What the sign-in and sign-up pages are allowed to offer.
 *
 * Read on the server and handed to the forms as props, so a page never
 * advertises a route the deployment has not been configured for: a Google
 * button with no client id, or a "forgot your password" link on a deployment
 * that cannot send the mail. Server-only — it reads process.env.
 */
import { mailConfigured } from '@/server/email.mjs';
import { privateDeployment } from '@/server/auth.mjs';

export type PublicAuthConfig = {
  /** Whether anyone may create an account. */
  signUpOpen: boolean;
  /** Whether the Google button should be shown. */
  google: boolean;
  /** Whether this deployment can send mail, and so whether a password can be
   * reset and an address verified. */
  mail: boolean;
};

export function publicAuthConfig(): PublicAuthConfig {
  return {
    signUpOpen: !privateDeployment(),
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    mail: mailConfigured(),
  };
}
