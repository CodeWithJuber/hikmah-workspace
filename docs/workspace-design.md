# Hikmah Workspace design — 10 September 2026

The v4 reference is `workspace-concept-v4.png`. This supersedes the prior dark-sidebar concept below. The UI uses a near-white canvas, light gray 232px sidebar, blue active navigation, a 64px header, a centered conversation and an anchored composer. Controls open in a drawer rather than permanently taking conversation space. Chat, Coding and Agents own the main mode navigation; the composer Create menu chooses media operations.

The model picker is a 560px searchable popover with All/Free/Paid filters, tool support, input/output rates per million tokens, context and output windows. Unknown metadata is visible as unknown. No illustrative models, prices, conversations or tool outcomes from the concept are seeded into real sessions. The existing Orbit brand glyph is retained.

A full-page Workspace admin groups configuration into Overview, Models, Media, Connectors, Skills and Product plan. Media outputs use native audio/video controls, downloadable images and saved job status. MCP calls with approval enabled display the exact server, tool and arguments. Continuous runs show actual progress and a recoverable pause state. Private model reasoning is never represented as a fabricated trace.

Spacing, borders, typography, blue accents, pale sidebar and model menu follow the concept. New media/admin/approval states are deliberate functional extensions requested after the concept. Empty sessions show truthful starter prompts. Small-screen rules collapse sidebar navigation and keep code, menu and admin content in contained scroll regions. Dark theme remains available.

## Fidelity and verification limits

The concept image was inspected before implementation. TypeScript, request/controller tests and production compilation are the available checks for this update. Browser infrastructure timed out before a current page could be inspected; no v4 screenshot or populated/mobile visual comparison has been completed. The design intent is implemented, but pixel fidelity, keyboard traversal, media-player interaction and device usability remain explicit follow-up checks. Earlier screenshots below are historical evidence only.

## Historical v3 design record

# Hikmah workspace redesign

Visual thesis: a focused conversation workspace with a deep ink sidebar, cool-white canvas, indigo action color and optional inspector. The selected concept uses a 248px sidebar, flexible chat column and 300px run inspector. Body text is 16px; everyday controls are at least 14px. Borders and rounded corners separate working areas without repetitive cards.

Chat, Coding and Agents are primary navigation. Recent conversations stay in the sidebar. Experimental meaning, learning, planning, sound and mathematics tools remain available under Research labs. A new session opens in Chat. Empty, sending, receiving, tool-running, failed, cancelled and completed states must be distinct.

Connection settings include provider presets, exact API URL, session key, searchable model list, catalog check, actual generation test, optional sampling, streaming and token field compatibility. Default sampling is omitted, including for older imported sessions. Test generation is explicit and may incur provider usage.

Messages render safe Markdown and code, with copy, feedback, retry, edit/resend and workspace save controls. Errors are separate from assistant prose and excluded from later context. Activity receipts disclose only actions actually attempted. Agent writes require the workspace permission setting. Custom instructions, response style, context and request budgets are functional preferences.

Desktop uses sidebar plus fluid workspace. Run settings occupy a 300px right inspector when space allows and an accessible drawer on smaller screens. Mobile uses a navigation drawer and full-width composer; coding editor/preview have their own contained scrolling. No horizontal page overflow. Keyboard focus, reduced motion and touch-sized actions are required.

Intentional concept deviations: no invented prior conversations or tool outcomes are seeded into real user sessions; initial state is a truthful welcome with starter prompts. Feedback buttons save local feedback only. The tiny glyph is represented by the existing Lucide Orbit icon. The composer footer explains local storage and connection state when setup is needed. Advanced connection and research surfaces extend the same tokens and component system.

## Visual fidelity record

Reference: `studio-design-concept.png`. The rendered desktop welcome was inspected against this concept. The ink sidebar, indigo actions, cool-white conversation canvas, restrained borders, model control and anchored composer follow it. Run-settings fields and drawer semantics were checked in the browser DOM; the screenshot was taken before the inspector completed opening, so its fully rendered layout is not claimed as screenshot-verified.

The empty state intentionally differs from the populated concept because no fake conversations are seeded into user sessions. Synthetic populated-session import and subsequent responsive interaction checks were interrupted by browser infrastructure timeouts. The remaining dense-conversation, code-editor, mobile and dark-mode visual review is explicitly outstanding.
