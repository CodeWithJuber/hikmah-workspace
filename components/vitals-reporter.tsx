'use client';
/** Report what the page actually felt like, from the browser that felt it.
 *
 * ~2 KB of library and one beacon per metric. It exists because every
 * performance number in this repo comes from a throttled Chromium in CI, which
 * can compare two builds and can say nothing at all about a real phone on a
 * real network — so "the frontend hangs" had to be reported by a person.
 *
 * First-party: the beacon goes to this deployment's own /api/vitals and the row
 * lands in the same SQLite file as everything else. A third-party analytics SDK
 * would contradict the privacy page, and this is the whole of what is sent:
 * the metric's name, its number, web-vitals' own rating, the route TEMPLATE
 * (never a conversation id) and whether the window was narrow.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/** The route as a template, so an id never reaches the server.
 *
 * `usePathname()` gives the real path — `/chat/8f2c…` — and the id in it is the
 * one thing here that would identify anybody. Mapped to its surface before it
 * leaves the browser rather than stripped on the way in, so there is no moment
 * where the server holds it. */
function template(pathname: string): string {
  const [, first] = pathname.split('/');
  if (!first) return '/';
  return '/' + first;
}

export function VitalsReporter() {
  const pathname = usePathname();
  useEffect(() => {
    let cancelled = false;
    const route = template(pathname);
    void import('web-vitals').then(({ onCLS, onINP, onLCP, onFCP, onTTFB }) => {
      if (cancelled) return;
      const send = (metric: { name: string; value: number; rating: string }) => {
        const body = JSON.stringify({
          route,
          metric: metric.name,
          // CLS is a fraction and the rest are milliseconds; rounding the
          // milliseconds costs nothing and keeps the body small, but rounding
          // CLS would round every real value to 0.
          value: metric.name === 'CLS' ? Number(metric.value.toFixed(4)) : Math.round(metric.value),
          rating: metric.rating,
          width: window.innerWidth < 640 ? 'phone' : 'desktop',
        });
        // sendBeacon survives the page being closed, which is exactly when CLS
        // and INP report their final value. fetch(keepalive) is the fallback
        // for the browsers that do not have it; neither is awaited, and a
        // failure is not worth telling anybody about.
        try {
          if (navigator.sendBeacon?.('/api/vitals', new Blob([body], { type: 'application/json' })))
            return;
        } catch {
          /* fall through */
        }
        void fetch('/api/vitals', {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body,
        }).catch(() => {});
      };
      for (const observe of [onCLS, onINP, onLCP, onFCP, onTTFB]) observe(send);
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);
  return null;
}
