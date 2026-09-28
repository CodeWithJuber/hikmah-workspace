# Hikmah Workspace v10 Rebuild

Branch: `rebuild/v10` · Base: `main` @ 7d331ee9 · Started: 2026-09-27

Full production-ready rebuild of hikmah-workspace. Audits that drove this plan:

- `~/workspace/hikmah-research/audit-backend.md`
- `~/workspace/hikmah-research/audit-frontend.md`
- `~/workspace/hikmah-research/audit-research.md`

## Principles

1. **Reuse best-of-breed** frameworks/libraries/SDKs (Vercel AI SDK, better-auth, Radix, streamdown,
   CodeMirror, xterm). Custom code only where the product is genuinely custom (the co-model research).
2. **Keep the research substrate untouched**: `public/research/v6/` fitted artifacts, `lib/context-model/`
   math, gate discipline, honesty contract. Rebuild _around_ it, never re-derive it.
3. **One product**: one shell, one design system, real routes everywhere (no hash routing).
4. **Production-ready**: P0 security fixes first, then UX, then the missing v5 control layer.

## Phases

- **Phase 1 — Security + hygiene**: gate/delete `/api/agentic/jev`, CSP/HSTS, `HIKMAH_VAULT_KEY`
  required at boot, private-by-default registration, fresh-DB migration verify (0013 index),
  `db/schema.ts` regenerate-or-delete, env var documentation.
- **Phase 1b — Dead code deletion**: 11 unused deps, 22 unused ui primitives, dead v10 CSS fork,
  dead routes, zombie `lib/playground/` reachability pass, rename "co-scientist".
- **Phase 2 — UX shell unification**: `/chat` architecture wins; `/workspace` hash pages become real
  routes; one sidebar/nav; one token system (evergreen identity); one button + overlay system;
  skeletons, shared empty states, billing retry, learning surfaces merged, terminal/SSH in main nav.
- **Phase 3 — v5 control layer (research properly used)**: workflow arms
  (Local/Direct/Verify-repair/Decompose/Explore-consensus) with hard call budgets + terminal states,
  policy learner for arm selection, single `enqueueRun()` pipeline, episode-solver wired to real
  annotations, `learning/retrieval.ts` routed through `lib/text/normalise.ts`.
- **Phase 4 — Verification**: `npm run typecheck`, `npm test`, production build + smoke,
  docs update, PR `rebuild/v10` → `main`.

## What ships in v10

Every existing feature production-ready: chat + agents, workspace (agents/terminal/tools/connections/
typeform/knowledge/learning/kernel/labs/admin), billing, MCP, workbench, media, auth — on one
unified, honest, fast shell.
