# Architecture

What runs where, and why it is split that way. Written for whoever has to operate
this or change it later, including the parts that are deliberately limited.

## The two services

| Service     | What it is                                                               |
| ----------- | ------------------------------------------------------------------------ |
| `app`       | Next.js, the run worker, SQLite. Read-only filesystem, `cap_drop ALL`.   |
| `workbench` | Terminal, SSH, shell commands, stdio MCP servers. Writable `/workspace`. |
| `search`    | SearXNG, reachable only from the private network.                        |
| `caddy`     | HTTPS, and the only thing exposed publicly.                              |

The split is not a preference. Next.js 16 cannot serve a WebSocket in
production: a route handler's `handleUpgrade` is a no-op, `NextResponse.upgrade`
is still a draft RFC, and a custom server is incompatible with
`output: 'standalone'`. The app image is also read-only and installed with
`npm ci --ignore-scripts`, so a pty binding cannot be built there and `npx`
cannot run. A terminal, a shell tool and a command-line MCP server all need
exactly those things.

Keeping them apart has a second effect worth stating plainly: a command that
misbehaves in the workbench has no route to the app's database or to the
encrypted secret store. The workbench holds no secrets of its own.

## Who trusts whom

```
browser ──HTTPS──> caddy ──┬──> app        (session cookie, Better Auth)
                           └──> workbench  (single-use ticket, /ws/*)

app ──private network──> workbench         (shared bearer token)
```

- **Browser → app**: the ordinary signed-in session.
- **Browser → workbench**: the app mints an HMAC-signed, single-use, 30-second
  ticket; the workbench checks the signature is its own, that the ticket has not
  expired or been used, and that `Origin` is the app's. It has no session store
  and no idea who is signed in, which keeps the authentication rules in one place
  rather than drifting across two services.
- **App → workbench**: `HIKMAH_WORKBENCH_TOKEN`, over the compose network only.

The ticket format is implemented twice, in `lib/workbench/ticket.ts` and
`workbench/src/ticket.ts`, because the two packages cannot import each other.
`tests/workbench-ticket.test.mjs` issues with one copy and verifies with the
other, so drift fails in CI rather than in production.

The workbench deliberately does **not** read `.env`. That file holds the vault
key and the session secret, and this service hands people a shell. It receives
only `HIKMAH_WORKBENCH_TOKEN` and `HIKMAH_APP_ORIGIN`, and the shell itself
inherits an allowlist (`PATH`, `HOME`, `TERM`, locale) rather than whatever the
process happens to hold. A denylist would have to be updated every time the
service gains a variable, and the cost of forgetting once is someone's vault key
in `env` output.

## Runs

A run belongs to the server, not to the tab that started it.

```
POST /api/conversations/[id]/runs   → queues a run, returns its id immediately
GET  /api/runs/[id]/stream?after=N  → SSE, replayable, leave and rejoin at will
POST /api/runs/[id]/cancel          → aborts the provider call, not just the socket
```

The worker starts from `instrumentation.ts`, the only documented once-per-server
hook. Three details there are load-bearing:

- The Node-only work sits behind a runtime check and a dynamic import, so
  `node:sqlite` stays out of the edge compile.
- The loop is started **without** being awaited. Next waits for `register()` to
  resolve before serving any request, and a loop that runs for the life of the
  process would never resolve.
- `SIGTERM` and `SIGINT` hand back whatever is in flight, so the next boot
  resumes it rather than finding rows marked `running` with nobody driving them.

Whether any of that actually happens depends on `instrumentation.js` being traced
into the standalone build — invisible until runs silently queue forever after a
deploy. `/api/health` therefore reports the worker's state and the queue depth,
and the production smoke test asserts it. The health check never _fails_ on the
worker: a stalled loop is worth seeing, and is not a reason to take a container
out of rotation while it is still serving chat.

Claiming uses `UPDATE ... RETURNING` so a run is taken exactly once; without it,
claiming is a read-then-write race. Reconnect subscribes, then replays, then
drops already-covered events — the other order loses any chunk written between
the read and the subscribe.

The resume buffer holds only the step in flight and is pruned when that step
becomes a message row, so a reconnecting client is not handed chunks it will
also receive as history. Sequence numbers therefore cannot be counted from it:
they are claimed from a counter on the run, which is never pruned. Counting from
the buffer worked for a run that finished in one step and failed silently for
one that paused for an approval — the numbers restarted at zero, every event of
the second half arrived below the cursor the client was holding, and both the
replay and the client discarded the rest of the answer with no error anywhere.

The browser side of this is `lib/chat/durable-transport.ts`, which exists
because the AI SDK's own transport expects one request that answers with the
stream and this route deliberately does not work that way. Posting a message
returns a run id; the output is tailed separately. Three things follow, and all
three are the reason the split is worth its cost:

- A dropped connection resumes from the last sequence number seen, so a reload
  mid-answer rejoins rather than restarting or losing the middle.
- A closed body does not mean the run ended — a proxy idle timeout closes one
  too. Asking again from the cursor tells them apart, which is what the stream
  route's `204` is for.
- A second submit while a run is in flight gets `409` with that run's id, and
  the transport tails it. Reporting an error there would hide work that is
  already producing output.

Stopping is two halves: `stop()` ends this tab's stream, and a POST to
`/api/runs/[id]/cancel` aborts the provider call the worker is still driving.
Only the first would leave the run finishing into the log with nobody watching.

The conversation id comes from the client, so an existing conversation's owner
is checked rather than assumed, and refused as "not found" so the reply does not
confirm that someone else's conversation exists.

Each conversation has its own URL (`/chat/[id]`), and `/chat` only picks one —
the most recently active, or a fresh id — and redirects, so a reload lands where
the owner was. `/` redirects to `/chat` rather than duplicating that choice, so
there is one place that decides which conversation opens.

The workspace — the chat that runs in the tab, and the screens around it:
coding, agents, compare, tools, connections, the terminal, memory, learning, the
research labs, settings, the owner console and the model connection — is at
`/workspace`. Its sub-page lives in the URL hash (`/workspace#/admin/media`),
which `workspaceDestination` reads without regard to the pathname, so those
addresses survived the move from the root unchanged. A row is not created by opening a conversation: the first message
creates it, so an abandoned "New chat" leaves nothing in the list. It is titled
from that message rather than by asking a model, which would cost a request and
a wait before the answer actually asked for, and on the free models this
deployment defaults to would sometimes return prose instead of a title. The
title is written once and never rewritten, because the owner finds a
conversation by the name it had when they last looked.

The list joins each conversation to its active run, because "working" and
"stopped to ask you something" look identical from the conversation row and need
opposite things from the owner. A run paused on an approval that the list cannot
show is a conversation that never finishes.

**Documented limit:** one worker per process, and the resume buffer is a
process-local `EventEmitter`. A second replica would break the tail.

## Approvals

A tool that needs the owner's say-so pauses the run. This is expressed as the AI
SDK's `toolApproval` policy rather than as a question inside a tool's `execute`,
because pausing a run and asking a person is something the framework can do and a
tool body cannot: by the time `execute` runs, there is nobody listening.

```
model calls a gated tool
  → policy returns 'user-approval'
  → the SDK emits approval-requested and stops the step
  → the worker records waiting_approval and persists the question as a message
  → the browser renders the Confirmation card
  → the answer POSTs back, replaces that message, and requeues the same run
```

The question is persisted, so a reload renders the card after the tab that asked
is gone. Answering is a _resume_, not a new run — treating it as one would hit
the "this conversation already has a run" refusal and strand the very run the
answer was meant to release. `requeueApproved` only moves a run out of
`waiting_approval` (and `requeueAnswered` only out of `waiting_client`), so a
second answer (two tabs, a double click) is absorbed rather than starting a
duplicate.

What is gated, and by what rule:

| Tool                | Rule                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `ssh_exec`          | The owner's own per-host allowlist, matched on the whole command. |
| `bash`              | A server-side read-only command list, matched on the first word.  |
| `sandbox_run`       | Always asks.                                                      |
| `mcp__server__tool` | Server trust plus the tool's annotations, plus a description pin. |
| everything else     | Not gated. They read or compute.                                  |

## Questions

An approval and a question look alike and are not the same. An approval carries
yes or no; a question carries what the person said, and `ToolExecutionOptions`
gives a tool's `execute` no access to that — only the call. So `ask_user` is not
a gated tool. It is a tool with **no `execute` at all**: the person is the
implementation.

```
model calls ask_user
  → nothing runs; the SDK leaves the call in input-available and ends the stream
  → the worker records waiting_client and persists the question as a message
  → the browser renders the question card
  → the answer is written as the tool's output and POSTs back, resuming the run
```

The same shape as an approval, and it reuses the same route and the same
"resume, never a new run" rule, with one guard added: a run stopped on a
question is released only by an answer, and one stopped on an approval only by a
decision. `lib/runs/resume.ts` holds that rule, and both the route and the
browser's auto-send read it from there — two copies that disagreed would send a
turn the server then refused, leaving the run paused with the answer already
given.

`waiting_client` needed no migration: `runs.status` is plain `TEXT` with no
`CHECK`. The status list in the comment at the top of `drizzle/0004_runs.sql`
therefore predates it and is one short — that file is SHA-pinned by
`server/storage.mjs` and must never be edited after shipping, so this page is
where the lifecycle is kept current.

Why the check is narrow rather than "the last tool call has an output":
`ask_user` is the only tool with no server-side `execute`, so it is the only one
whose result may legitimately arrive from a browser. Accepting any completed
tool call would let a client hand the run a result the server was supposed to
produce.

Two mistakes these rules exist to avoid. Matching a command by **prefix** would
let `df; rm -rf /` through on a pattern of `df`, so matching is anchored and any
command containing `;`, `|`, `&`, a backtick or a redirect is excluded before the
list is consulted at all. And a `readOnlyHint` is supplied by the same server
that supplies the tool, so it is honoured only for a server the owner explicitly
marked trusted — otherwise any server could opt itself out of every prompt.

## MCP

Each MCP tool is a first-class model tool with its real schema, named
`mcp__<server>__<tool>`. The previous design exposed two meta-tools and made the
model discover everything through them, which cost three round-trips before any
work, truncated every description to 250 characters, declared arguments as a
free-form object so the provider could not validate them, and made per-tool
permissions impossible.

Servers are rows, seeded from `lib/mcp/defaults.ts` on first read rather than by
a migration — so a server added to the catalogue later reaches owners who already
have rows. They are connected once per run and released when the stream ends,
because a worker that lives for the life of the process would otherwise
accumulate one set of connections per run it has ever driven.

**Tool pinning.** A tool's name, description and input schema are hashed. A
read-only tool on a trusted server still asks the _first_ time, because its
description has not been shown to anyone yet; once seen it runs freely; once
rewritten it drops back to asking and the change is reported. That is the
rug-pull case. A denied tool is not gated but **withheld** — gating it would
still put its description into the prompt, which is the thing being refused.

**Stdio servers** run in the workbench. It speaks streamable HTTP outward and
stdio inward, so `npx -y @modelcontextprotocol/server-filesystem` reaches the
client as an ordinary remote server and the manager keeps one transport. The
command travels in a request header rather than being registered beforehand:
registration state would go stale against a config the owner edited, and anything
holding the shared token can already run commands there through `bash`, so it
grants nothing new.

## Third-party service terms

**Quran.com MCP** (`https://mcp.quran.ai`, the root URL — both `/mcp` and `/sse`
return 404) is the one default server that is enabled, because it changes what
the model may assert rather than merely adding a capability: it carries grounding
rules requiring a cited edition instead of an answer from memory.

Its licence is **QFGPL-1.0, which is non-commercial and network-copyleft**. This
app therefore only ever _calls the hosted endpoint_: no fork, no vendored code,
no self-hosting of that server inside Hikmah. The licence covers the software,
not the Qur'an, translation or tafsir data.

The local `research_quran` ledger remains a first-class fallback, so Qur'an
grounding still works if the endpoint is withdrawn or a commercial launch makes
the dependency unwanted. That constraint is recorded in `lib/mcp/defaults.ts`
itself, not only here.

## Agents

An agent is a named bundle of instructions and a tool allowlist. It applies from
the next turn on, never retrospectively, and changes the model only if it names
one — so choosing an agent cannot quietly move a conversation to a different
provider.

Its instructions are **appended** to the workspace's rather than replacing them:
the base prompt says true things about this deployment, and an agent should not
be able to switch those off by accident.

The allowlist narrows the built-in tools and deliberately does **not** touch MCP
tools. Which servers are connected is the owner's decision, gated per tool by
the MCP policy; which built-ins a preset uses is a different question, and an
agent narrowing one should not silently answer the other. The owner's own
`disabledTools` outranks an agent either way.

Templates seed only into a workspace with no agents at all — a deliberate
difference from the MCP catalogue. There, a server added later genuinely should
reach existing owners. An agent is a starting point the owner then owns: seeding
by name would resurrect a template they deleted and sit the original beside their
renamed version of it. The cost is that a template added later reaches only new
owners, which is the right side to err on for something that is theirs.

## Workspace files

`list_files`, `read_file`, `write_file` and `delete_file` operate on rows rather
than on the workspace blob, which changes what they are for: a file written in
one conversation is there in the next, and it survives the tab that wrote it.
That is the difference between a scratchpad and a workspace.

It also lifts the limits. The blob allowed twelve files of eighty thousand
characters, which was never a statement about what a workspace should hold — it
was what could be rewritten as one JSON document on every keystroke-level save.
Rows are written one at a time, so the ceilings are now 200 files, 256k
characters each, 8 MB in total.

Paths may contain folders, and every segment is checked rather than the whole
string normalised: `..`, an absolute path and a prototype key are each refused,
never rewritten into something that happens to be inside. A caller that believes
it wrote to `../secrets` and did not is worse off than one that was told no.

These tools are **not** gated behind approval. They write inside the owner's own
workspace, which nothing else reads and no program runs; a file written here has
no effect until someone asks for one. `bash` and `ssh_exec` are gated because
they act on a machine.

## Compare

Compare mode answers the same question twice: once through the full agent, and
once directly with no tools at all. It is not a second opinion from a second
model, though it can be — it is the same question without the machinery, which
is what makes the difference between the two workflows visible.

The baseline runs _alongside_ the main answer rather than after it, and streams
into the same durable log as `data-compare` chunks sharing one part id. Both
follow from what the mode is for: running them in sequence would double the wait
for no gain, and a comparison that lived only in the tab that started it would
be gone on the reload where someone actually reads the two side by side. One
part id rather than one part per delta, or the stored message would hold a
hundred fragments instead of an answer.

The lane never fails the run. It is the second answer on the page; a provider
that refuses it should cost the comparison and not the answer the person asked
for. Two states are easy to get wrong and are handled explicitly: a provider
error arrives through `streamText`'s `onError` and does **not** throw out of the
iteration, so without catching it there a comparison that never started would be
published as finished and empty; and an aborted stream simply ends with no error
at all, so abort is checked before anything else, or a run someone stopped
halfway would be recorded as complete.

Only the model may be chosen by the caller. The key, the endpoint and the
free-only rule come from the run's own configuration, so the comparison cannot
be pointed at another endpoint carrying the owner's credentials.

## Generated media

`generate_image` and `generate_speech` are run tools rather than a button in the
composer, which changes two things: the model can decide a picture is the answer
without the owner having to know that in advance, and the result is stored where
a reopened conversation can still find it. The old surface kept generated media
in the browser's IndexedDB, which was the only option while the run belonged to
the tab.

What the model gets back is a reference and the prompt, never the bytes: twenty
megabytes of base64 in a transcript would cost more context than the whole
conversation and tell it nothing it can reason about. The owner's id is part of
the storage key, so an asset id copied out of a transcript reaches nothing from
another session, and the type is recovered from the stored extension against a
fixed table — a provider's claimed media type is replaced rather than trusted,
because the type is what decides how a browser interprets the bytes.

Media goes through OpenRouter, so a workspace already running on OpenRouter
needs no second credential. On any other provider it needs `HIKMAH_MEDIA_KEY`,
and without one the tools are not offered at all.

**Not here:** video generation, which is an asynchronous job that has to be
polled across steps, and transcription, which needs a file the owner uploads.
Both are their own piece of work rather than a variation on these. The old
surface still has them.

## SSH

The model may name a saved host id and a command. It may never supply a
hostname, a port, a username or a key path — those come from the owner's own row,
so an instruction injected through a fetched page or a tool description can name
a server the owner already trusts but cannot construct a connection to one they
did not. Naming an unknown host fails before any credential is decrypted, and the
refusal lists the real hosts so the model corrects itself rather than guessing.

Adding a host is three steps on purpose: save the details, connect once to see
the host key, and pin it only after the owner has read the fingerprint. Pinning
whatever answered the first connection would record an impostor just as happily
as the real server. Confirming re-probes and compares, so a stale or forged form
post cannot pin a key the host is not presenting. A pin is never silently
replaced: rotating a host key means removing the host and adding it again.

`ssh2` accepts any host key when `hostVerifier` is absent, so it is never
omitted.

## What is not here

Stated so nobody goes looking:

- **No disposable per-run containers.** The workbench container _is_ the sandbox:
  `cap_drop ALL`, `no-new-privileges`, an unprivileged user, its own network. It
  is not a jail — a command there has network access and can read what the shell
  user can. Per-run isolation (dockerode with a socket proxy, or gVisor) is a
  documented later hardening.
- **No OAuth for remote MCP.** Credentials are `${NAME}` references into the
  encrypted store.
- **No second app replica.** See the worker limit above.
- **The old browser-driven surface still exists** at the workspace page, and
  still exclusively owns media generation, Compare, artifacts, agents and the
  labs. Nothing legacy can be deleted until those move.
