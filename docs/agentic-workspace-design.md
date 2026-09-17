# Agentic workspace design specification

The generated chat and Learning Studio concepts (`chat-workspace-concept.png`, `learning-studio-concept.png`) are the implementation references for this change. Existing functional approvals, tools, files, provider connections, durable runs and owner-only training remain real integrations.

## Visual system

True white main canvas; cool gray navigation surface; evergreen accent. Inter with system fallbacks, outline Lucide icons and the existing Hikmah orbit mark. A 240px desktop rail and a 64px header frame a flexible `minmax(0, 1fr)` work area. Chat text and composer center inside the available work area, max-width 800px; full-width learning tables use the remainder. The right panel is closed by default, opened intentionally and dismissed with one action. No decorative gradient, wallpaper, fabricated counters or image used as interactive UI.

Use the generated semantic palette for both themes; 8px spacing rhythm, 44px principal controls, shared radius and type tokens. Focus indication, reduced motion and safe-area padding are required. At 900px and below, the rail and auxiliary panel become modal drawers. At 600px and below, secondary labels compact; action rows and tables may scroll locally, never the page. Main content must remain reachable at 320px and with text zoom.

## Content and component inventory

- Shell: Hikmah, New chat, Search conversations, Chats, Learning studio, Agents, Files, Memory, Settings, theme control. Header: current conversation title, Search, Learning, Workspace; Back to chat in learning mode.
- Empty chat: “What are we working on?”; “Research, build, and learn in one conversation.” Composer: “Ask a question, attach a file, or describe a task…”; tools, model, send. Shortcuts: Research, Build, Compare, Learn. Missing-key setup is a necessary real account state.
- Transcript: user text, rendered final response, tool activity, source/usage receipts, approval cards, completed artifacts; stop, retry and reconnect controls accurately reflect durable run state. Copy/export and drafts operate on actual transcript content.
- Learning: “Learning you can inspect”; “Review real model exchanges before they become reusable examples.” Capture strip, Review queue / Co-model training / Research evidence tabs, search, status filter, export, empty state and three-step Capture / Review / Reuse explanation. Review detail has source conversation, model/run provenance, redactions, correction, approve/reject and removal controls.
- Co-model training uses the existing annotated syntax-training and checkpoint endpoints. The separately verified shared-episode research engine exposes explicit evidence and bounded inference. Unavailable Stage 31–32 artifacts remain identified as unavailable.

## Implementation ownership and states

ChatShell owns navigation, one optional detail drawer, preserved chat state while learning is open, command navigation and theme. ConversationList owns actual server history with search and deletion confirmation. ChatView owns composing, transcript, status and recovery. LearningStudio owns its live review queue, training and research evidence tabs. Data loading failures must remain failures, with retry, rather than being rendered as empty data. Disabled, loading, busy, saved and error states have visible labels.

Intentional concept extensions: actual provider connection/onboarding, active-run and tool details, authenticated training errors, row review/correction controls, navigation commands, mobile close controls and actual existing settings. They are needed to make the specified workflows work. Existing product names and claims must remain accurate; “learning” cannot imply provider parameter updates.

## Acceptance evidence

Inspect the concepts and browser captures together for layout, copy, type, palette, icon style, local overflow and focus behavior. Test empty and non-empty chat, learning settings, capture/review/reuse, training/evidence, mobile drawers and failure recovery. Record actual commands and results separately; do not equate mock provider tests with real provider validation or staging with production.
