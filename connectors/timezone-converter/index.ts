/** Timezone converter connector.
 *
 * Manifest claims: converts a moment between IANA timezones. Pure
 * computation over the platform's tz database via Intl — no network, no
 * lookup service. Permission requested: `time:read`.
 */
import type { ConnectorDefinition, ConnectorResult } from '@/lib/catalog/connector.ts';

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function supportedZones(): Set<string> {
  try {
    return new Set(
      (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ??
        [],
    );
  } catch {
    return new Set();
  }
}

/** Whether the platform knows the zone. `supportedValuesOf` is preferred, but
 * some ICU builds omit aliases like `UTC`, so a zone the formatter accepts
 * is accepted too. */
function knownZone(zone: string): boolean {
  if (supportedZones().has(zone)) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` at `instant`, in minutes (wall clock minus UTC). */
function offsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return (asUtc - instant.getTime()) / 60000;
}

/** Interpret a wall-clock time in `timeZone` as a UTC instant. Iterates the
 * offset lookup so DST boundaries converge; ambiguous/nonexistent wall
 * times near a transition resolve to the iteration's fixed point, which is
 * documented rather than hidden. */
function wallTimeToInstant(wall: string, timeZone: string): Date {
  const match = TIME_RE.exec(wall.trim());
  if (!match) throw new Error('Use ISO wall time: "2026-09-30T14:30:00".');
  const [, y, mo, d, h, mi, rawS] = match.map(Number);
  const s = Number.isNaN(rawS) ? 0 : rawS;
  const baseUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let instant = baseUtc - offsetMinutes(timeZone, new Date(baseUtc)) * 60000;
  for (let i = 0; i < 3; i++) {
    const next = baseUtc - offsetMinutes(timeZone, new Date(instant)) * 60000;
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Render an instant in a zone as `YYYY-MM-DDTHH:mm:ss±HH:MM`. */
function formatInZone(instant: Date, timeZone: string): { iso: string; offset: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // en-CA yields YYYY-MM-DD; midnight can render as 24:00:00 in some ICU
  // builds — normalise it rather than emitting an invalid hour.
  let hour = Number(get('hour'));
  let day = get('day');
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(instant.getTime() + 86400000);
    const dayParts = new Intl.DateTimeFormat('en-CA', { timeZone, day: '2-digit' }).formatToParts(
      rolled,
    );
    day = dayParts.find((p) => p.type === 'day')?.value ?? day;
  }
  const offset = formatOffset(offsetMinutes(timeZone, instant));
  const iso = `${get('year')}-${get('month')}-${day}T${String(hour).padStart(2, '0')}:${get('minute')}:${get('second')}${offset}`;
  return { iso, offset };
}

export const definition: ConnectorDefinition = {
  name: 'timezone-converter',
  requiredPermissions: ['time:read'],
  run(input: unknown): ConnectorResult {
    const body = (input ?? {}) as { time?: unknown; from?: unknown; to?: unknown };
    if (typeof body.time !== 'string' || body.time.trim().length === 0)
      return {
        ok: false,
        code: 'bad-input',
        error: 'Pass { "time": "2026-09-30T14:30:00", "from": "Asia/Dubai", "to": "UTC" }.',
      };
    if (typeof body.from !== 'string' || typeof body.to !== 'string')
      return {
        ok: false,
        code: 'bad-input',
        error: 'Both "from" and "to" must be IANA timezone names.',
      };
    for (const zone of [body.from, body.to]) {
      if (!knownZone(zone))
        return { ok: false, code: 'unknown-timezone', error: `Unknown timezone "${zone}".` };
    }
    let instant: Date;
    const trimmed = body.time.trim();
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime()))
        return { ok: false, code: 'bad-time', error: 'Could not parse the time. Use ISO 8601.' };
      instant = parsed;
    } else {
      try {
        instant = wallTimeToInstant(trimmed, body.from);
      } catch (error) {
        return {
          ok: false,
          code: 'bad-time',
          error: error instanceof Error ? error.message : 'Could not parse the time.',
        };
      }
    }
    const converted = formatInZone(instant, body.to);
    const source = formatInZone(instant, body.from);
    return {
      ok: true,
      data: {
        instant: instant.toISOString(),
        from: { zone: body.from, local: source.iso },
        to: { zone: body.to, local: converted.iso },
      },
    };
  },
};
