# Hikmah Playground design specification

Primary reference: the generated full Meaning screen, 9 September 2026. White scientific workbench, pale gray navigation rail, cobalt active state, flat outlined controls and divided output columns. No bitmap is used as UI.

Tokens: background #fff, rail #f5f7fa, ink #17212b, secondary #657181, primary #2457dc, borders #dde3eb. Desktop rail 220px, main inset 36px, base spacing 8px, corner radius 6px, control height 44px. Sans-serif body 16px, title 32px, section heading 22px; monospaced semantic values. Outline Lucide icons: File, BookOpen, SquareCheck, Waves, Sigma. Mobile sidebar uses the existing accessible Sheet; output columns stack.

Primary copy: Meaning playground; Try a sentence. Inspect what the model understands.; Export session; Language; Example; English; Help and remember; Sara helped Lina.; Interpret; Load example; Meaning structure; How it matched; Token; Meaning; Learned rule; Try a contrast; Compare; Controlled language model. Unknown constructions can return no match.; Runs on this device.

Component ownership: shell and session state; Meaning; Learn; Agent Tasks; Sound Lab; Maths; Chat & code. Shared shadcn Sidebar, Select, Slider, Dialog, Tabs, Table, Checkbox, Button, Input and Textarea. Native SVG diagrams are exact computed data, not illustrations. Browser-only Web Audio and sandboxed code preview.

User-requested extensions after concept: Chat & code navigation and provider configuration, including a custom OpenAI-compatible API endpoint. Add these within the same visual system. Learning, tool traces, model connection and mathematics require further controls below the initial Meaning screen. These are intentional functional extensions. The initial Meaning composition retains the reference hierarchy and copy.
