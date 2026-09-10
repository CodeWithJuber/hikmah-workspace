# Verification record — 10 September 2026

## Continuous workspace, model catalog, media and admin release

143 distinct automated checks passed across the complete suite and the focused rerun after correcting a test's JSON-payload parsing. Coverage includes 79 existing meaning/planning/sound checks and 64 workspace, transport, provider, catalog, run-controller, media and MCP checks. Strict TypeScript checking passed. The native Sites/Vinext production build completed successfully with both provider and media routes. A client chunk-size warning remains; this is not a performance or load certification.

New controller checks complete eight requests and 21 actions without the previous four-request/sixteen-action stop; preserve the current goal during context reduction; continue visible length-limited output; pause empty reasoning-only output; stop repeated tool batches before a third execution; and resume a cancelled batch without repeating its completed first action. Explicit read-only preferences survive session import. File reads page with exact continuation offsets.

Catalog checks verify per-token versus per-million units, missing/dynamic rates, exact Experiential slug/default-route joins, unknown versus free prices and reasoning request shapes. Experiential public metadata is fetched without an account key, and its failure leaves the account model list usable. Route prices are marked as estimates. Missing capability metadata is not invented.

Media checks exercise authentication/origin rejection, native image and transcription schemas, playable binary speech, video job submission and GET-only retrieval, fixed provider destinations, safe error handling and no hidden generation retry. MCP checks cover URL restrictions, the 2025 initialization/session lifecycle, paginated discovery, own-credential forwarding, exact tool calls and 2026 stateless headers/SSE results. These are controlled HTTP fixtures, not paid live provider tests or certification of all MCP capabilities.

The current browser connection failed with a 300-second service timeout before v4 interaction began. Browser recovery was also unresponsive. No v4 screenshot, populated conversation, keyboard navigation, mobile/dark layout, media-player interaction or IndexedDB reload behavior has been visually verified. The inspected concept is saved in `docs/workspace-concept-v4.png`; prior screenshots below describe older releases only. A failed browser handoff does not imply successful visual QA.

The added admin is owner-private personal configuration. It does not provide commercial tenant isolation, RBAC, billing or a durable background job service. MCP support requires an accessible HTTP server and compatible CORS; OAuth, stdio hosting, MCP Apps and a hosted browser fleet are not implemented. Video providers may continue a submitted job after tab closure; saved job IDs are used for retrieval instead of silently generating again. Browser checkpoints cannot establish exactly-once external effects across a crash.

No real API key was supplied for this update. Authenticated chat and media generation, account/model access, production latency and native-device behavior remain unverified. The product plan distinguishes implemented capabilities, researched integration contracts, commercial hypotheses and future architecture. It does not claim a full Quran/tafsir audit, a universal acoustic-language law, AGI or guaranteed profit.

## Historical verification

# Verification record — 9 September 2026

## Workspace redesign and generation compatibility

The repeated error was traced as far as the provider boundary: recent Worker records showed 22 `/api/provider` requests returning HTTP 200 rather than relay crashes. A provider can still emit a generation error in its JSON/SSE body. No real key, selected model, or complete authenticated error body was available, so the precise cause of the user's account-specific failures is not claimed as proven.

The [Experiential Labs integration reference](https://platform.experientiallabs.ai/llms.txt) recommends starting with minimal model/messages requests and warns that some routes reject sampling parameters. The old client always supplied temperature 0.3. The new client omits sampling unless explicitly enabled, including for imported older profiles. The [official error reference](https://platform.experientiallabs.ai/docs/errors) informs a whitelist of safe machine codes and corrective actions. Non-streaming requests and an explicit token-field choice are now supported. A user-initiated generation test distinguishes catalog access from actual inference. There are no hidden paid retries.

44 targeted checks passed in this update: 14 relay, 14 transport, 7 compatibility/context, and 9 workspace/session checks. They cover sampling migration, non-streaming, safe structured errors, empty error metadata, attachment context, exclusion of failed answers, retained completed tool receipts, legacy failed-session migration, permission boundaries, cancellation and size limits. Strict TypeScript and whitespace checks passed. The native framework production build passed. Vite reported a client chunk-size warning; CodeMirror is loaded dynamically, and no load-scale or performance certification is implied. Unchanged research mathematics tests were not unnecessarily rerun.

Browser QA reached the redesigned desktop welcome, navigation, connection settings, data tab and run-settings controls through the supervised internal preview. A rendered desktop screenshot was inspected against the design concept. Subsequent file-chooser and browser calls timed out; runtime recovery also remained unresponsive and was stopped. As a result, populated conversation rendering, CodeMirror interactions, file import, responsive device interaction and dark-mode appearance were not fully reverified in this update. Static responsive rules, accessible component wiring and TypeScript were checked, but they do not replace those interaction checks. The earlier release's browser checks below remain historical evidence only. Temporary QA fixtures were removed from public assets before publication.

No authenticated live inference, provider account health, native mobile hardware, multi-user persistence or large-scale load behavior was tested. The redesigned interface is delivered as a working improvement; full production readiness is not certified by this test run.

## Provider connection repair

The user identified `https://api.experientiallabs.ai/v1`. A non-billable check from the execution environment reached `/models` with HTTP 401 without a key. A CORS preflight for `/chat/completions`, carrying the published app's Origin and the authorization/content-type request headers, returned HTTP 400 without Access-Control-Allow-Origin. The same-origin relay now uses this exact provider origin and OpenRouter as explicit destinations; it does not accept an arbitrary upstream URL. The Experiential Labs preset is available in connection settings, and an already-saved matching URL automatically selects the relay.

36 relevant regression checks passed for this repair: 14 new relay checks, 14 existing transport checks, and 8 workspace/session boundary checks. These include the actual client transport composed with the server handler and mocked SSE upstream responses, preserved tool payloads, model catalogs over 1 MB before metadata trimming, authentication/origin rejection, request validation, no redirects/retries, HTTP status preservation, key/error redaction, size limits and cancellation. Strict TypeScript checking passed. The provider's real unauthenticated endpoint was reached, but no real user API key was available, so authenticated catalog loading and paid generation are not claimed as live-tested. No browser UI QA was performed for this repair.

OpenRouter streaming behavior is checked against its [official streaming documentation](https://openrouter.ai/docs/api_reference/streaming). The relay preserves SSE bytes, including comments, usage and tool deltas; existing parsing handles them on the client. CORS support on arbitrary direct-browser custom endpoints is still required. Keys are never persisted by the app; for the two relay presets they pass transiently through the app server in a dedicated request header, avoiding interference with the Site's own Authorization handling.

## Initial release

101 automated checks passed: 24 meaning-learning checks, 30 planning/evidence checks, 25 sound/graph checks, 14 provider-transport checks, and 8 integration boundary checks. Strict TypeScript checking passed. The native framework production build is the publication gate.

The browser Meaning flow emitted correct negation and reversed participant roles. A six-row valid candidate was approved with seven new correct development frames; applying it changed the active model. The corrupt tense candidate emitted seven wrong development frames and its Apply button was disabled.

The hosting simulator generated six steps costing nine units. Step once consumed one unit; complete execution verified its local goal. Injected repair failure consumed six units and left four; replanning correctly reported the remaining goal blocked by the configured resources. No external operation was performed.

Audio playback was invoked on the generated sample. FFT/STFT and reversal values were recomputed. Scope changes excluded an unrelated refuting source; removing a required dependency prevented payload delivery. Moving graph diffusion time updated the energy from 0.06891 toward zero while preserving the signal sum.

The Coding workspace ran its isolated HTML/CSS/JS preview. Clicking its button changed Count: 0 to Count: 1. Stop preview removed execution. Model connection rendered the custom base URL/key/model fields and rejected an empty public-provider key before a network request. No paid inference was performed because no real key was supplied. HTTP/SSE behavior is covered with mocks, not a live provider account.

Browser method: supported cloud browser, supervised internal preview. Desktop screenshot was inspected at the native viewport. A temporary 390px-wide iframe fixture exercised the actual responsive viewport; mobile main content was 375px after the scrollbar, and scrollWidth also 375px. The mobile drawer opened, navigated to Chat & code and closed. The fixture was removed before publication.

Visual comparison: accepted full-screen concept is `docs/design-concept.png`. The final rendered screenshot and concept were inspected with view_image. Checked white/pale-gray surfaces, cobalt active navigation, typography hierarchy, control geometry, two-column output anatomy, semantic graph, table rules, and mobile stacking. Fixed the Tailwind v4 default black border color and added accessible slider names. Main Meaning copy follows the concept; token case is normalized to expose the learner's actual tokenizer.

Intentional extensions: the user subsequently requested Chat, Coding and configurable API connections, so navigation and the connection/session control were added. Advanced source records and raw outputs follow the initial Meaning view. Other labs reuse the same visual system. No material layout mismatch remained in the checked states; this is a faithful functional implementation of the accepted concept with those requested extensions.

A development hot-refresh briefly mixed old/new React context modules while source was being edited. A clean reload restored the app; no application-origin error appeared after that reload. Browser extension-origin metadata errors were also present and are unrelated to the app. Live model generation, microphone capture, native mobile hardware, server-side persistence and arbitrary provider-native APIs were not tested or claimed.
