# Chat workflow repair

Base: deployed v9.1, `43ac2c0c45354e13c36e2c5a04dff2ba3950d14b` (11 September 2026). The local baseline matched all 359 tracked files in that GitHub snapshot.

## Confirmed causes and changes

| Observed in the deployed source | Change |
| --- | --- |
| Every `write_file` opened the workspace pane | Writes stay in chat. A completed task offers View workspace files; the preview runs only after Run preview. |
| Any non-running message could offer an artifact, including interrupted output | Artifact extraction and Save code require a completed response. |
| Streaming tool preambles were appended to the answer | Preambles remain in model history; final answer text contains the deliverable. In-progress text stays behind task progress until the run finishes. |
| Empty provider replies could finish successfully | Empty replies pause with a resumable checkpoint and an explicit explanation. |
| Model explanations expanded above the result | Completed answers come first. Activity and provider-supplied explanations are collapsed and inspectable. Opaque provider continuation data remains undisplayed. |
| MCP catalogs disappeared after reload and needed manual Connect | Enabled, permitted connections discover their tools at task start. Connection failures do not disable working tools. |
| Context checkpoint loading had no deadline; non-owner access prevented released-model use | Bound optional preparation; use public released parameters for a non-owner without accessing private owner checkpoints. |
| Default search was Wikipedia only | Add `search_web` backed by SearXNG, with a private Compose service; standalone deployments can use SearXNG or Brave. Retain Wikipedia as a separately labelled reference tool. |
| Runtime access required browser-to-runtime CORS and client credentials | Add an owner-only, same-origin relay to the fixed server-configured runtime. Runtime credentials remain on the server. Existing per-call approval remains enabled. |
| Qur'anic research was disconnected from chat | Add an indexed research tool returning actual ledger rows, context spans, source links, and their explicit verification status. |

Automatic chat combines research, coding, local execution, and connected tools. Agent profiles are reusable instructions, not independently executing agents or evidence of independent review. Explicitly selected agent restrictions and disabled tool switches still apply.

## Research evidence

The retained ledger has 6,236 unique verse records. Its observations are AI-authored first-pass research notes, not Arabic scripture or a verified tafsir. Coverage, hashes, and an engineering analogy do not establish religious authority or empirical model performance. The chat contract requires retrieving actual verse/translation/tafsir sources before making religious claims, preserving the edition, context, uncertainty, and disagreements.

The verification principles are engineering applications of the source material, not claims that an ayah specifies this software architecture. Relevant sources include [49:6](https://quran.com/al-hujurat/6) and [17:36](https://quran.com/al-isra/36). Root similarity alone is not evidence of language ancestry; the existing detailed corpus audit is retained in `public/research/v6/quran-context-and-language-report.md`.

Search integration follows the [SearXNG search API](https://docs.searxng.org/dev/search_api.html), [server settings](https://docs.searxng.org/admin/settings/settings_server.html), [official container configuration](https://github.com/searxng/searxng/blob/master/container/docker-compose.yml), and [Brave Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started). Search snippets are labelled as discovery leads; a retrieved page is not automatically a verified claim.

## Deployment

The normal Compose release starts a private SearXNG service and points the authenticated app at it. There is no published search port. `configure.py` generates and retains a separate search secret; the service has a 512 MiB memory limit. Set `HIKMAH_SEARCH_IMAGE` to an operator-approved immutable image digest to pin the search service. The default follows the official container's `latest` image; the search container was not run in this session.

For a separately managed search instance, set `HIKMAH_SEARCH_URL` to its `/search` endpoint with JSON format enabled. For a standalone app outside Compose, `BRAVE_SEARCH_API_KEY` can supply search when `HIKMAH_SEARCH_URL` is absent. Upstream blocks, empty results, and rate limits are reported as unavailable evidence.

The Python/Node/SSH runtime must already be installed using `public/runtime/README.md`. Set `HIKMAH_RUNTIME_URL` to its fixed `/mcp` endpoint and `HIKMAH_RUNTIME_TOKEN` to its existing token in the server environment. Configure its allowed origin to the Hikmah HTTPS origin. These values survive later releases and never enter the chat or client session. The owner sees Server runtime automatically once configured. SSH executes only owner-defined aliases through the existing adapter; no arbitrary host shell, Docker socket mount in the web app, or new production SSH access is added by this change.

## Validation and remaining gates

- Original suite: 228 passing tests.
- Updated suite: 238 passing tests, including real QuickJS isolation/execution, streaming continuation, empty replies, tool preambles, connector preparation, context-model access, web-search parsing/errors, runtime boundaries, and ledger lookup.
- Production build and TypeScript: passed.
- Standalone HTTP smoke: passed real login, role checks, origin checks, saved workspace persistence, and process restart.
- Deployment configuration tests: 4 passing.
- Repository lint remains at 26 errors already present in the base across the same files and rules; it is not a passing gate.
- Live browser inspection reached the private sign-in page and confirmed v9.1/build `43ac2c0`. Authenticated production chat, real provider behavior, installed runtime, and production search were not verified.
- Rendered desktop/mobile and interaction QA remain pending. This session blocked the local preview server; permission escalation was rejected. The offline fixture was also rejected by the browser URL policy. No workaround was used after that rejection. Screenshots or successful rendered checks are not claimed.

Before deployment approval, test authenticated chat on desktop and mobile: send a multi-step build, stop and resume a task, inspect model explanation, open/run a completed artifact, perform a real source-backed research query, and test the configured runtime with a harmless approved operation. The PR workflow validates the image; this PR does not merge or deploy itself.
