# v7 verification

10 September 2026. Tests use synthetic provider responses and isolated data; no live provider account or SSH/browser service credential was supplied.

The final automated suite contains 206 tests; all passed. It covers the released co-model and regression gates as well as provider transport, agent continuation, workspace boundaries, media/MCP contracts, knowledge retrieval, authenticated publication and durable storage.

New regression evidence:

- SSE under JSON MIME, JSON under SSE MIME, split UTF-8 BOM, generic MIME and multiline events.
- 1,333,581 wire bytes for only 3,500 output characters no longer hits a one-MB response cap.
- JSON responses over one MB, malformed records retaining earlier text, null choices, bounded empty SSE fields.
- Simulated 400-second active streams succeed; five minutes of true inactivity stops safely.
- Signed 54,000-character tool IDs survive completion, request history and checkpoint normalization.
- Large Unicode transcript and knowledge roundtrip through R2; cross-user isolation, same-origin checks, stale writers, failed writes, missing blobs, retired snapshots and ambiguous commit acknowledgments.
- Unknown or tool-incapable model policy, edit restrictions, disabled/missing connectors, suggestion exclusion, exact negation/literal preservation, bounded retrieval, owner-only shared publishing and unpublishing.

Browser QA uses the actual React workspace in the approved preview with a temporary isolated fetch fixture. It does not override production authentication. This fixture is removed before the production build.

Observed browser journeys:

- Provider settings, catalog dropdown with free/paid rates and context windows.
- Normal Chat executes the calculator and displays the correct 583.2 result and saved tool receipt.
- Tools menu exposes common file/calculator permissions and honest Browser/Search/SSH setup states.
- Personal knowledge creation with source, reload, and retrieval in a new answer with a visible used-item receipt.
- Compare shows requested/returned identities; a failed direct arm preserves the successful assisted response.
- The model calls suggest_memory with the user’s exact words; Knowledge shows a review-required candidate. Approval activates it; Forget removes a reference from future retrieval.
- Inline generated HTML renders; enabling isolated interactions changes the test button to “Clicked”; Expand opens the artifact panel.
- A 390-pixel test frame has a 388-pixel inner viewport and exactly 388-pixel document width, with no horizontal page overflow. Mobile Tools opens with readable connection/setup states. This is a browser viewport check, not a physical-device test.

Browser testing discovered and fixed `crypto.randomUUID` availability in an HTTP preview. The implementation now uses cryptographic `getRandomValues` as a UUID fallback, with no weak randomness. Some remote browser click calls timed out; after checking page state, keyboard and subsequent pointer interactions completed the same flows. Those remote-control timeouts are not reported as provider failures.

No evidence here establishes broad AGI, 100% human memory, universal Arabic ancestry, world-first novelty or superior quality over a provider at matched compute. Research proposals and remaining scale limits are documented in architecture.md and memory-research.md.
