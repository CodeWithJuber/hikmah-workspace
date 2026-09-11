/** Only configuration, never forwarded headers, defines the public origin. */
export function publicOrigin(request: Request): string {
  return process.env.BETTER_AUTH_URL
    ? new URL(process.env.BETTER_AUTH_URL).origin
    : new URL(request.url).origin;
}
