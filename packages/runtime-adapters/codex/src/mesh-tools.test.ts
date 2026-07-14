import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ReminderRow } from "./mesh-types";
import { createCodexMeshToolsServer } from "./mesh-tools-server";
import {
  MESH_TOOL_DEFINITIONS,
  MESH_TOOL_NAMES,
  dispatchMeshTool,
  type MeshToolsHub,
} from "./mesh-tools";

function reminder(id: string): ReminderRow {
  return {
    id,
    type: "once",
    status: "active",
    schedule_spec: '{"at":"2099-01-01T00:00:00Z"}',
    payload: "check the queue",
    context: null,
    next_fire_at: "2099-01-01 00:00:00",
    fire_count: 0,
    last_fired_at: null,
    idempotency_key: null,
    created_at: "2026-07-14 00:00:00",
  };
}

function fakeHub(): { hub: MeshToolsHub; calls: string[]; reminders: ReminderRow[] } {
  const calls: string[] = [];
  const reminders: ReminderRow[] = [reminder("rem_existing")];
  const hub: MeshToolsHub = {
    async send(opts) {
      calls.push(`send:${opts.to}:${opts.from}:${opts.content}:${opts.reply_to ?? ""}`);
      return { id: "msg_1", status: "delivered" };
    },
    async listAgents() {
      calls.push("list_agents");
      return [{ id: "peer", description: "Peer\nagent", online: true, last_seen: null, type: "human" }];
    },
    async fetchMessages(opts) {
      calls.push(`fetch_messages:${opts.agentId}:${opts.limit ?? ""}`);
      return [{ id: "msg_2", from: "lane", to: opts.agentId, content: "hello\nthere", reply_to: null, ts: "2026-07-14T00:00:00Z", status: "delivered" }];
    },
    async scheduleReminder(opts) {
      calls.push(`schedule_reminder:${opts.type}:${opts.payload}`);
      reminders.push({ ...reminder(opts.id), payload: opts.payload, schedule_spec: opts.scheduleSpec, next_fire_at: opts.nextFireAt });
      return { ok: true, id: opts.id, type: opts.type, next_fire_at: opts.nextFireAt };
    },
    async cancelReminder(id) {
      calls.push(`cancel_reminder:${id}`);
      return { changes: id === "rem_existing" ? 1 : 0 };
    },
    async listReminders(opts) {
      calls.push(`list_reminders:${opts.status ?? ""}:${opts.limit ?? ""}`);
      return reminders;
    },
  };
  return { hub, calls, reminders };
}

describe("Codex Agent-Mesh MCP tools", () => {
  test("advertises the complete Claude-compatible tool set", () => {
    expect(MESH_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...MESH_TOOL_NAMES]);
    expect(MESH_TOOL_NAMES).toEqual([
      "reply",
      "fetch_messages",
      "list_agents",
      "create_reminder",
      "list_reminders",
      "cancel_reminder",
    ]);
  });

  test("exposes the advertised tools over the Codex MCP server", async () => {
    const { hub, calls } = fakeHub();
    const server = createCodexMeshToolsServer({ hub, laneIdentity: "synapse-pm" });
    const client = new Client({ name: "mesh-tools-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...MESH_TOOL_NAMES]);
    const result = await client.callTool({ name: "list_agents", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "peer (online type=human) - Peer agent" }]);
    expect(calls).toEqual(["list_agents"]);
  });

  test("dispatches every advertised tool through the existing hub paths", async () => {
    const { hub, calls } = fakeHub();
    const options = { hub, laneIdentity: "synapse-pm" };

    expect((await dispatchMeshTool(options, "reply", { chat_id: "peer", text: "hello", reply_to: "msg_0" })).content[0].text)
      .toBe("sent id=msg_1 status=delivered");
    expect((await dispatchMeshTool(options, "fetch_messages", { agent_id: "peer", limit: 300 })).content[0].text)
      .toContain("hello there");
    expect((await dispatchMeshTool(options, "list_agents", {})).content[0].text)
      .toBe("peer (online type=human) - Peer agent");

    const created = await dispatchMeshTool(options, "create_reminder", {
      type: "once",
      schedule: { at: "2099-01-01T00:00:00Z" },
      payload: "check the queue",
      context: "review",
      idempotency_key: "queue-check",
    });
    expect(created.isError).toBeUndefined();
    expect(JSON.parse(created.content[0].text)).toMatchObject({ agent_id: "synapse-pm", created_by: "synapse-pm" });

    expect((await dispatchMeshTool(options, "list_reminders", { status: "all", limit: 250 })).content[0].text)
      .toContain('"lane":"synapse-pm"');
    expect((await dispatchMeshTool(options, "cancel_reminder", { id: "rem_existing" })).content[0].text)
      .toBe('{"id":"rem_existing","status":"cancelled","lane":"synapse-pm"}');
    expect(calls).toEqual([
      "send:peer:synapse-pm:hello:msg_0",
      "fetch_messages:peer:200",
      "list_agents",
      "schedule_reminder:once:check the queue",
      "list_reminders:all:200",
      "list_reminders:all:200",
      "cancel_reminder:rem_existing",
    ]);
  });

  test("returns Claude-compatible validation and unavailable-service errors", async () => {
    const { hub } = fakeHub();
    const options = { hub, laneIdentity: "synapse-pm" };
    const invalid = await dispatchMeshTool(options, "create_reminder", {
      type: "once",
      schedule: { at: "2099-01-01T00:00:00Z" },
      payload: "",
    });
    expect(invalid).toEqual({
      content: [{ type: "text", text: "create_reminder failed: payload is required" }],
      isError: true,
    });

    const unavailable = await dispatchMeshTool({
      hub: { ...hub, listAgents: async () => { throw new Error("hub not connected"); } },
      laneIdentity: "synapse-pm",
    }, "list_agents", {});
    expect(unavailable).toEqual({
      content: [{ type: "text", text: "list_agents failed: hub not connected" }],
      isError: true,
    });
  });
});
