/**
 * The design language, as one file the CLI compiles.
 *
 * Astryx is a devDependency and a build step; nothing under app/ or components/
 * imports it, `@stylexjs/stylex` never reaches the browser, and its own
 * Tailwind bridge is never imported — that bridge declares `--color-primary`
 * and `--color-accent` as TEXT colours where shadcn means FILLS, and contains
 * no `foreground` at all, so importing it would strip the label off every
 * shadcn Button.
 *
 * What it is used for is the part that is genuinely hard and is not worth
 * hand-writing: a perceptually even ramp derived from one seed, in both colour
 * modes, with the contrast of every generated pair guaranteed rather than
 * hoped for. The output is committed, so if this package breaks or is
 * abandoned the escape is to delete two devDependencies and keep the CSS.
 *
 *   npm run design:build     regenerate app/styles/palette.generated.css
 *   npm run design:check     fail if the committed file is stale
 *
 * The values below are the ones the product already wears: `#17664f` is the
 * mark and the front door, and it carries text at 8.9:1 on white. 14px is
 * already this app's dominant body size, so the scale is anchored where the
 * rhythm already is rather than moving every screen a step.
 */
import { defineTheme } from '@astryxdesign/core';

export const hikmahTheme = defineTheme({
  name: 'hikmah',

  /* One seed per mode. The generator derives surfaces, text, icons, borders,
   * muted fills and the hover and pressed overlays from it, holding text at
   * >= 4.5:1 against its own surface in both modes — which is the guarantee
   * that makes this worth a dependency. `cool` greys because the product's
   * greys already lean blue-green beside the mark. */
  color: { accent: ['#17664f', '#7fd3aa'], neutralStyle: 'cool', contrast: 'standard' },

  /* 14px is what this app is already written at — 123 uses of it — so the
   * scale is anchored there rather than at Astryx's 16 default. 1.2 is the
   * default step and reads calmly at this size. */
  typography: {
    scale: { base: 14, ratio: 1.2 },
    /* Inter, which the app now actually loads.
     *
     * This comment used to say the opposite, and it was right at the time:
     * base.css asked for `Inter` and nothing anywhere loaded it — no next/font,
     * no @font-face, no stylesheet link — so every device without it installed
     * drew in the fallback, and naming a family here would only have changed
     * what Astryx's own rules asked for, not what appeared. Written
     * `Arial, Helvetica` on one attempt and measured, that changed the typeface
     * of the whole site.
     *
     * app/layout.tsx loads it now, self-hosted from a pinned package, so the
     * name and the pixels agree for the first time. The fallbacks below are
     * what a device sees before the 48 KB arrives and if it never does.
     */
    body: {
      family: 'Inter',
      fallbacks: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    code: { family: 'ui-monospace', fallbacks: '"SF Mono", Menlo, Consolas, monospace' },
  },

  /* The app's own --radius is 0.625rem; base 4 with the default multiplier
   * lands the element and container steps either side of it. */
  radius: { base: 4, multiplier: 1 },

  /* Faster than the Astryx default, deliberately: this is a streaming app and
   * chrome must not compete with tokens arriving on screen. */
  motion: { fast: 110, medium: 220, slow: 520, ratio: 0.75 },

  /* The colours the product already has, kept exactly rather than derived, so
   * its identity survives byte for byte. A [light, dark] pair compiles to
   * light-dark(), which is how this theme follows the `data-theme` the layout
   * already stamps from the cookie. */
  tokens: {
    '--color-accent': ['#17664f', '#7fd3aa'],
    // Changing an accent means owning the label that sits on it, in both modes.
    '--color-on-accent': ['#ffffff', '#10241b'],
    '--color-background-body': ['#ffffff', '#10241b'],
    /* The surfaces, pinned for the same reason the body is.
     *
     * Derived, they came off the generator's own neutral ramp — #F4FFF9 light
     * and #151D19 dark — which is a near-white mint in light and, against the
     * pinned body above, a DARKER grey-green in dark. A card darker than the
     * page it sits on inverts the one cue that says "this is raised", and it
     * only happened because the body was pinned and the surfaces were not.
     * Pinned together, a card is lighter than the page in dark and tinted
     * against it in light, which is the same relationship in both modes. */
    '--color-background-surface': ['#f6f8f9', '#16301f'],
    '--color-background-card': ['#ffffff', '#16301f'],
    '--color-background-popover': ['#ffffff', '#1b3b28'],
    /* The edge of something you type into, which WCAG 2.2 holds to 3:1 against
     * what is behind it — a rule about UI components, not text, so the
     * generator's own text guarantee does not cover it. Derived it was #5C6C63,
     * which is 2.93:1 on the pinned dark body: a field you cannot quite find.
     * One step lighter clears it at 3.08:1. The light value already passed and
     * is kept. */
    '--color-border-emphasized': ['#84948c', '#616f67'],
  },
});
