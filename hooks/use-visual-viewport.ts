import { useEffect, useState } from 'react';

/** What the visual viewport looked like at the last event. */
export type ViewportSnapshot = {
  /** The visual viewport height, in CSS px. */
  height: number;
  /** The visual viewport's top offset (page zoom or keyboard pan), in CSS px. */
  offsetTop: number;
  /** Heuristic: the visual viewport shrank below the layout viewport, which
   * on iOS is the on-screen keyboard. A 1px tolerance keeps rounding noise
   * from flapping the state. */
  keyboardOpen: boolean;
};

/** The visualViewport surface we need — deliberately a Pick, so tests can
 * hand in a fake without a browser. */
export type VisualViewportLike = Pick<
  VisualViewport,
  'height' | 'offsetTop' | 'addEventListener' | 'removeEventListener'
>;

/** A snapshot from a visualViewport-like and the layout viewport height. */
export function readVisualViewport(vv: VisualViewportLike, innerHeight: number): ViewportSnapshot {
  return {
    height: vv.height,
    offsetTop: vv.offsetTop,
    keyboardOpen: vv.height < innerHeight - 1,
  };
}

/** Wires resize/scroll on a visualViewport-like to a callback. Returns null
 * (no crash, no listeners) when there is no visual viewport — desktop
 * no-op. Kept separate from the hook so it is testable without React. */
export function bindVisualViewport(
  vv: VisualViewportLike | null | undefined,
  innerHeight: () => number,
  onChange: (snapshot: ViewportSnapshot) => void,
): (() => void) | null {
  if (!vv) return null;
  const update = () => onChange(readVisualViewport(vv, innerHeight()));
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
  };
}

/** The current visual viewport, or null where it is unavailable (SSR,
 * desktop). The composer uses `keyboardOpen` to lift above the iOS keyboard.
 *
 * NOTE: validated only against a mocked visualViewport in unit tests — real
 * iPhone behavior is unverified (see the UX plan item: do not ship blind). */
export function useVisualViewport(): ViewportSnapshot | null {
  const [snapshot, setSnapshot] = useState<ViewportSnapshot | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const cleanup = bindVisualViewport(
      window.visualViewport,
      () => window.innerHeight,
      setSnapshot,
    );
    return cleanup ?? undefined;
  }, []);

  return snapshot;
}
