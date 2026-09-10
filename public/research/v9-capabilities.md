# Hikmah capability update

## What the middle layer actually adds

Hikmah retrieves reviewed memory, may add a local context interpretation, exposes permission-scoped tools, manages task continuation and can request a draft review. The provider still generates the answer. Each completed answer now has a contribution record showing what actually ran. This record is not an improvement score or evidence of AGI. Compare keeps a direct-answer lane to help assess the workflow.

The Quranic research informs principles such as provenance, care with entrusted information, consultation and revision. Those principles do not establish a universal Arabic origin for languages, acoustic laws of meaning, or human-equivalent learning. The trained local models and their evaluation limits remain separately visible in the owner training area.

## Available without an external runtime

- A fresh QuickJS WASM sandbox for pure JavaScript. Worker termination, a 3-second interpreter deadline and a 32 MiB runtime limit; no injected host, network, DOM, Node or credential APIs.
- Existing workspace file editing, isolated HTML preview, arithmetic, task plans and reviewed memories.
- Wikipedia reference search in English, Arabic, Hindi, Spanish and Turkish, and public HTTPS page text through Jina Reader. These are external public services, without provider credentials. They may reject or rate-limit a request; Wikipedia search is not general web search.
- User-operated browser dictation and read-aloud when the browser supports them. Dictation may use the browser's speech service; it does not automatically submit text.
- Saved agent profiles with instructions, local tool allowlists, connector allowlists, memory selection and draft-review preference. Agent permissions intersect workspace permissions. They never override disabled tools or read-only files.

## Requires a real connected service

The downloadable runtime starter exposes Docker-isolated Python/Node execution and owner-defined SSH action aliases. It must be installed on a dedicated host and connected with its own credential. No runtime host has been provisioned by this release.

General web search, browser clicks, phone calls, CRM actions, video rendering and unattended jobs require their own services. Research, coding, voice, video and support templates are instruction workflows, not proof that those services are connected. Existing HTTP MCP connections expose their discovered tool catalog, with user approval according to the connection setting.

## Interface changes

Agents has its own directory and editor. Tools & runtimes separates built-in actions from connected services. Workspace settings contains personal connections and skills; Owner console contains privileged training and model release controls. Each chat has an agent selector. Readable provider explanations appear before their own answer and collapse when complete. A consistent H mark, functional icons, green accent palette and softer controls replace the previous mixed navigation styling.

## Verification and limits

The existing suite plus nine added capability tests passed across the final test runs: 225 tests. Four runtime-adapter tests check authentication, fixed SSH selection, Docker isolation arguments and bounded subprocess behavior. QuickJS tests executed real source, checked isolation and output limits, and interrupted an infinite loop. Type checking and the production build passed.

The browser verification service did not respond, so desktop/mobile visual inspection, microphone permission flows and browser-worker execution were not verified in this environment. The worker was included successfully in the production bundle. Web-service behavior was tested with controlled responses, not a signed-in live end-to-end request. The general Jina search endpoint returned HTTP 401 without a key during a separate availability check; it is not advertised as a default free search tool. No Docker host, SSH account, telephony service or paid model/media call was provisioned or used.

Technical references: [QuickJS Emscripten](https://github.com/justjake/quickjs-emscripten), [Jina Reader](https://github.com/jina-ai/reader), [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API).
