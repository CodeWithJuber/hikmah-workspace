# Hikmah runtime starter

This optional adapter adds **Python and Node execution** to Hikmah through HTTP MCP. It also exposes **fixed SSH actions** you configure. It is a starting point for your own dedicated runtime host, not a hosted server already connected to the app.

## Set up

1. Use a dedicated Linux machine with Python 3.11+ and a rootless Docker installation. Keep it updated; containers share the host kernel. Use a VM isolation service for hostile multi-tenant workloads.
2. Pull the allowed runtime images once: `docker pull python:3.13-alpine` and `docker pull node:22-alpine`. Pin their digests in `IMAGES` for a controlled production release. The adapter never pulls model-selected images.
3. Keep `server.py` on this host. Set `HIKMAH_APP_ORIGIN` to your app's exact HTTPS origin (no trailing slash) and `HIKMAH_RUNTIME_TOKEN` to a secret with at least 32 characters. Use your process manager's protected environment/secret store. Do not put secrets in source or chats.
4. Run `python3 server.py` under an unprivileged service account. It listens only on `127.0.0.1:8765`.
5. Put an HTTPS reverse proxy in front of `/mcp`. Preserve Authorization and Origin. Set request limits and connection/rate limits. Do not expose Docker's socket or API. For production enforce egress controls and authentication at your gateway as well.
6. In Hikmah → Tools & runtimes → Manage connections, add `https://YOUR-RUNTIME-HOST/mcp`, revision **2025-11-25**, permission **Ask before each external call**. Enter the runtime token in its session-only credential field and choose **Connect & discover**.
7. Edit your agent and enable this connection. Ask it to run a Python or Node check. Review the proposed tool call. The returned stdout, stderr and exit code are its execution evidence.

Each execution uses a fresh container: network disabled, read-only root, no host mounts, non-root user, capabilities dropped, no privilege escalation, 64 processes, 256 MiB, 0.5 CPU and 15-second deadline. Input is bounded to 40 KB and output to 64 KB. No state is retained between calls. These are resource boundaries, not an unlimited server.

The adapter accepts only `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`. It returns JSON results; it does not implement interactive MCP, OAuth, SSE sessions, browser control or background scheduling. It is intentionally compatible with Hikmah's configured HTTP tool client, not a claim of full MCP conformance.

## Optional SSH actions

Set `HIKMAH_SSH_CONFIG` to a private JSON file on the runtime host. Use a dedicated remote account and key with only the permissions needed. Pre-enrol the host key in that account's known_hosts using your normal trusted process. Host-key checks are never disabled.

```json
{
  "server_uptime": {
    "host": "your-server.example",
    "user": "monitor",
    "identity": "/secure/monitor-key",
    "command": "uptime"
  }
}
```

Only aliases in this file become selectable. The model cannot supply a different host, identity or remote command. Treat every configured command as a capability grant. SSH changes happen on the remote server; they do not use the disposable code container.

## Browser, search, voice and operations

Connect those services through their own MCP endpoints. General web search and browser clicks are different tools from Hikmah's built-in Wikipedia search and public-page reader. Browser dictation/read-aloud is user operated; a voice template does not establish a phone line. Telephony, video rendering, CRM writes and job scheduling need real service adapters and accounts. Free-only chat remains enforced; this starter has no AI provider key or billing integration.

## Verification

`python3 -m unittest test_runtime.py` checks permission boundaries, request authentication, Docker arguments and bounded subprocess handling. A Docker smoke test must be performed on the machine that will actually run containers before enabling real user workloads. No Docker host was provisioned by downloading this starter.
