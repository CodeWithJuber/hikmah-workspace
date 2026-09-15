import { getChatGPTUser } from '../../chatgpt-auth';
import { ownerIdentity, failure } from '@/lib/kernel/server';
import { publicOrigin } from '@/lib/server/origin';
import { APP_RELEASE } from '@/lib/release';
import {
  createVitalsStore,
  VITAL_METRICS,
  VITAL_RATINGS,
  VITAL_WIDTHS,
  type VitalMetric,
  type VitalRating,
  type VitalWidth,
} from '@/lib/vitals/store';
import { getStorage } from '@/server/storage.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

/** Routes this will accept, as templates.
 *
 * The browser sends the template, but the browser is not to be trusted with
 * what goes in a table, so it is checked against the list rather than stored as
 * given. This is also what keeps a conversation id out of the column: '/chat'
 * is here and '/chat/<id>' is not, so a measurement of a conversation is filed
 * under the surface, which is the only granularity that means anything anyway. */
const ROUTES = new Set([
  '/',
  '/chat',
  '/workspace',
  '/billing',
  '/sign-in',
  '/sign-up',
  '/sign-out',
  '/privacy',
  '/terms',
  '/preview',
]);

/**
 * How the site performed, from the browser that experienced it.
 *
 * Deliberately open to signed-out visitors: the landing page and the sign-in
 * page are the two surfaces a stranger judges the product on, and measuring
 * only what a signed-in owner sees would miss them. What that costs is that
 * this is the one write endpoint with no session, so it is bounded by
 * construction instead: a 1 KB body cap, an Origin check, one row per accepted
 * metric, every field either a number or a member of a fixed set, and nothing
 * stored that identifies a browser.
 *
 * `keepalive`/`sendBeacon` sends this while the page is unloading, which is why
 * it answers 204 with no body — there is nothing there to read it.
 */
export async function POST(request: Request) {
  if (request.headers.get('origin') !== publicOrigin(request))
    return Response.json(
      { error: 'Send this from the page being measured.' },
      { status: 403, headers },
    );

  // sendBeacon has no way to set a timeout and a page being unloaded has no way
  // to retry, so this reads the body once, small, and gives up rather than
  // holding the one Node thread open for a client that has already gone.
  const text = await request.text().catch(() => '');
  if (!text || text.length > 1024) return new Response(null, { status: 204, headers });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 204, headers });
  }
  const sample = body as Record<string, unknown>;

  const metric = sample.metric as VitalMetric;
  const rating = sample.rating as VitalRating;
  const width = sample.width as VitalWidth;
  const route = typeof sample.route === 'string' ? sample.route : '';
  const value = typeof sample.value === 'number' ? sample.value : Number.NaN;
  if (
    !(VITAL_METRICS as readonly string[]).includes(metric) ||
    !(VITAL_RATINGS as readonly string[]).includes(rating) ||
    !(VITAL_WIDTHS as readonly string[]).includes(width) ||
    !ROUTES.has(route) ||
    !Number.isFinite(value) ||
    value < 0 ||
    // 10 minutes. A larger number is a clock that moved or a tab that was
    // backgrounded for an hour, and either way it is not a measurement.
    value > 600_000
  )
    return new Response(null, { status: 204, headers });

  const user = await getChatGPTUser().catch(() => null);
  createVitalsStore(getStorage().raw).record({
    userId: user?.userId ?? null,
    route,
    metric,
    value,
    rating,
    width,
    release: APP_RELEASE,
  });
  return new Response(null, { status: 204, headers });
}

/**
 * The summary, for the owner console.
 *
 * Owner-only, because it is the one view of the deployment as a whole rather
 * than of one account's own work. Nothing in it is per person — the rows are
 * already grouped by route, metric and width before they get here — but a p75
 * across everybody is still an operator's number, not a user's.
 */
export async function GET(request: Request) {
  try {
    await ownerIdentity();
  } catch (error) {
    return failure(error);
  }
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return Response.json(
      { error: 'Use this from your signed-in workspace.' },
      { status: 403, headers },
    );
  const days = Number(new URL(request.url).searchParams.get('days'));
  return Response.json(
    {
      vitals: createVitalsStore(getStorage().raw).summary(
        Number.isFinite(days) && days > 0 && days <= 90 ? Math.floor(days) : 7,
      ),
    },
    { headers },
  );
}
