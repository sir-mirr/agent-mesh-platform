# Codex Agent-Mesh tools

`src/mesh-tools-server.ts` is the stdio MCP server that gives a Codex lane the
same Agent-Mesh tools as the Claude runtime adapter. It is intentionally
separate from `src/main.ts`: the running adapter keeps its established
event/watchdog path, while Codex app-server starts this server through its MCP
configuration.

The server never opens a hub WebSocket. It calls the already-running adapter's
loopback HTTP action proxy at `127.0.0.1:CODEX_ADAPTER_HTTP_PORT` (the Synapse
PM deployment uses `4602`), and that adapter remains the sole hub-connection
owner for its identity. The proxy applies its existing HTTP token check and
uses the adapter's existing hub authorization. Do not change identities,
credentials, proxy permissions, or hub settings when registering it.

## MCP registration

During PM-coordinated deployment, configure the Codex app-server's MCP server
entry to execute the repository's `agent-mesh-codex-tools` binary (or its
equivalent `bun packages/runtime-adapters/codex/src/mesh-tools-server.ts`
command) with the same `CODEX_ADAPTER_HTTP_PORT` and
`CODEX_ADAPTER_HTTP_TOKEN` values as the running adapter. This repository does
not modify the app-server launcher or perform that registration itself.

The advertised tools are:

- `reply`
- `fetch_messages`
- `list_agents`
- `create_reminder`
- `list_reminders`
- `cancel_reminder`

`create_reminder`, `list_reminders`, and `cancel_reminder` are restricted by
the existing hub identity/proxy boundary to `CODEX_TARGET_AGENT`.

## PM post-restart smoke test

Run this only after PM has reviewed the change and restarted the Codex adapter
and its configured MCP server.

1. In the Synapse PM Codex session, inspect the available MCP tools and verify
   the six names above appear exactly once.
2. Call `list_reminders` with `{ "status": "active" }` and retain the result
   for cleanup comparison.
3. Call `create_reminder` once with a unique payload and an ISO-8601 `schedule`
   soon enough to observe (but safely in the future), for example:
   `{ "type": "once", "schedule": { "at": "<future UTC timestamp>" }, "payload": "mesh tools smoke <unique id>" }`.
   Record the returned reminder id.
4. Call `list_reminders` with `{ "status": "all" }` and verify the returned
   envelope's `lane` is the PM lane and its row has that id with
   `status: "active"`.
5. Wait for the self-reminder to arrive in the PM lane, then call
   `list_reminders` again to confirm the once reminder fired and is no longer
   pending.
6. If the reminder is still pending, call `cancel_reminder` with its id and
   confirm the result reports `status: "cancelled"`. Do not leave a smoke
   reminder active.
7. Call `reply` with the Finja chat identity and a unique message, for example:
   `{ "chat_id": "finja", "text": "Codex mesh-tools active-send smoke <unique id>" }`.
   Verify Finja receives it. This verifies an active outbound mesh send, not
   just reply dispatch for an inbound adapter message.

If any call reports `adapter action proxy unavailable`, `adapter action proxy
failed`, or `hub not connected`, stop the smoke test and inspect the adapter
lifecycle; do not retry by changing credentials or identity settings.
