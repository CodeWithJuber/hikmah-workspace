# Design token chain

```
design/hikmah-theme.ts            ← the source of truth. Edit here.
        │  npm run design:build
        ▼
app/styles/palette.generated.css  ← generated. NEVER hand-edit.
        │  seeds: --ax-* colour ramp, radius scale, type scale,
        │  --font-family-* stacks, durations. (@generated — check-styles
        │  counts its colours separately.)
        ▼
app/styles/tokens.css             ← semantic tokens, hand-written.
        │  One :root block, light-dark() pairs. Maps the generated ramp
        │  to product names: --primary, --accent, --muted, --border,
        │  --ring, --z-*, --font-mono, --radius, …
        ▼
app/globals.css @theme inline     ← turns tokens into Tailwind utilities
                                    (bg-primary, text-muted-foreground…).
```

## Which file to edit

| Change                                                  | Edit                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand seed, pinned surfaces, type/radius/motion scales  | `design/hikmah-theme.ts`, then run `npm run design:build` to regenerate. `npm run design:check` (CI) fails if the committed CSS is stale.                                                                               |
| New semantic token (e.g. `--z-toast`, a new state fill) | `app/styles/tokens.css`, inside the existing `:root` block — do not add a second `:root`; the styles ratchet counts repeated selectors. Value must be a `light-dark()` pair or mode-independent (z-index, font stacks). |
| A token's value looks wrong in one mode                 | Almost always fix the seed in `design/hikmah-theme.ts` and regenerate, not the semantic token — the semantic token is just a name.                                                                                      |
| A component needs a one-off value                       | It doesn't. Use the token. If the scale genuinely lacks the step, add the token in `tokens.css` and say why.                                                                                                            |

## Notes

- `--ax-*` names belong to the generated palette; never reference `--color-*`
  (that namespace is Tailwind's — the collision stripped the label off every
  Button once; `tests/design-tokens.test.mjs` keeps them apart).
- `--radius-page` is emitted by the generator's radius scale but currently
  read by nothing. It cannot be deleted from the generated file by hand, and
  the generator offers no per-step removal — if a page-level container ever
  needs it, wire it there; otherwise it stays as inert scale headroom.
- Colour ratchet: `node scripts/check-styles.mjs` must stay green — no
  arbitrary hex in TSX outside `components/ui` (vendored), no new
  hand-written colours in CSS.
