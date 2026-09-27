# Hikmah Stack integration note

The Hikmah Stack repository was reviewed alongside ForgeKit. Its Rust kernel and evidence-ledger ideas are treated as a lower-level reference, not a second user-facing workflow. Hikmah keeps the existing durable run and approval boundaries, then exposes the useful parts through the chat, Learning and Research brief surfaces.

The production crosswalk is:

- Stack kernel principles remain behind existing run preparation and tool approval, so users see one calm chat instead of multiple orchestration consoles.
- Evidence and provenance stay attached to research briefs and learning receipts. A claim is never presented as verified solely because a kernel or model produced it.
- Any future Rust kernel bridge must use a narrow server boundary with typed JSON, timeouts, cancellation and fail-closed behavior. It must not duplicate the current run engine.
- The stack audit's caveats are preserved: benchmark and “complete” claims need reproducible fixtures before they become product promises.

This keeps the platform extensible while avoiding the repetition and disconnected flows that made the earlier UI hard to use.
