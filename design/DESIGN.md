# Hikmah design system

One product, one design language. This is the canonical reference; the four
superseded shell/concept docs (agentic-workspace-design, design-spec,
workspace-design, chat-workflow-repair) are kept read-only in `design/archive/`.

## Identity

- Evergreen `#17664f` is the mark and the front door. It is the `--ax-accent`
  seed in `design/hikmah-theme.ts` (light) / `#7fd3aa` (dark, inverted rather
  than darkened so text on it stays readable). Nothing else is the accent.
- Inter for body and headings, self-hosted via `app/layout.tsx`; the code
  stack is the `--font-mono` token in `app/styles/tokens.css`.
- Outline Lucide icons; the existing Hikmah orbit mark is the brand glyph.
- No decorative gradients, wallpapers, fabricated counters, or bitmaps as UI.

## Shell geometry

- Sidebar rail: **232px** (`--sidebar-width` in `app/styles/overrides.css`),
  cool-gray navigation surface (`--sidebar` token), 64px header frame.
- The main work area is fluid (`minmax(0, 1fr)`); chat/composer center in it,
  full-width tables use the remainder.
- At **≤900px** the rail and auxiliary panels become modal drawers
  (`@media (max-width: 900px)` in `app/styles/chat.css`,
  `app/styles/workspace-experience.css`).
- The right inspector panel is closed by default; it opens intentionally and
  dismisses with one action.
- Principal controls are **44px** minimum touch targets
  (`app/styles/base.css`, `app/styles/auth.css`).

## Tokens

- One declaration per token in `app/styles/tokens.css`. No dark twin:
  values are `light-dark()` pairs driven by `color-scheme`, set from the
  `data-theme` attribute the layout stamps from the cookie. A token defined in
  light cannot be forgotten in dark.
- Fills that stack (drawers over cards over pages) are opaque mixes against
  the page, never stacked alpha — alpha compounds into colours nobody chose.
- Radius scale (generated): `--radius-inner` 4px, `--radius-element` 8px,
  `--radius-container` 12px, `--radius-page`/`--radius-chat` 28px,
  `--radius-full` pill. `--radius-page` is emitted by the generator's scale
  but read by nothing; see `design/README.md`.
- z-index ladder (`app/styles/tokens.css`): `--z-chat-scrim` 2,
  `--z-chat-drawer` 3, `--z-chat-panel` 4, `--z-chat-float` 5,
  `--z-scrim` 35, `--z-drawer` 40, `--z-skip-link` 100. No literal z-index
  anywhere else.
- Motion is fast on purpose (110/220/520ms): chrome must not compete with
  streaming tokens.

## Honesty contract (UI rules)

- The learning review pipeline's capability declares
  `providerWeightsChanged: false` (`lib/learning/types.ts`): reviewed
  examples supply bounded reference context to later requests; they never
  imply provider weight updates.
- Research and shared-episode surfaces label model outputs as **hypotheses**,
  with explicit evidence, witnesses, retraction, stale receipts and ambiguity
  (`docs/research-episode-integration.md`). Unknown metadata is shown as
  unknown, never invented.
- Data-loading failures stay failures with retry — never rendered as empty
  data. Empty states are truthful: no fake conversations, counters or outcomes
  are seeded. Disabled, loading, busy, saved and error states carry visible
  labels.
