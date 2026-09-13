/** Whether a run may generate pictures and speech, and on whose key.
 *
 * Its own file rather than a function inside `service.ts` for one reason: that
 * module reaches the storage handle, the MCP manager and the agent builder, so
 * it cannot be imported by a test. This decision is the whole of the Pro plan's
 * media claim and is worth being able to call directly.
 */

/** The two fields of a run's config this reads. */
export type MediaConfig = {
  /** Whether this person's plan includes it. Absent means yes, which keeps
   * every run row written before the entitlement existed behaving as it did. */
  media?: boolean;
  baseUrl: string;
  apiKey: string;
};

/**
 * The key the media tools run on, or '' when this run may not generate at all.
 *
 * Two conditions, and they answer different questions. `media` is whether the
 * plan includes generating pictures and speech; the key is whether the
 * deployment can. Media goes through OpenRouter, so a run already on OpenRouter
 * uses the same key and media works without configuring anything twice; on any
 * other provider it needs its own, and without one the tools are simply not
 * offered rather than offered and failing.
 *
 * That derivation is what made the plan's paid feature quietly everyone's: a
 * free bring-your-own-key user is on OpenRouter with a key of their own, so
 * both tools were theirs. Returning '' is what removes them — `buildRunAgent`
 * only builds the media tools when it is given a key, so the model is never
 * offered a tool it would be refused.
 */
export function mediaKeyFor(
  config: MediaConfig,
  env: { readonly [name: string]: string | undefined } = process.env,
): string {
  if (config.media === false) return '';
  if (/(^|\.)openrouter\.ai$/.test(hostOf(config.baseUrl))) return config.apiKey;
  return env.HIKMAH_MEDIA_KEY ?? '';
}

/** The host of a base URL, or '' when it is not a URL at all. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}
