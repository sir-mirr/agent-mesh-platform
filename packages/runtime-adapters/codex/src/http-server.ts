import { CHANNEL_SOURCE_VALUES, type ChannelSource } from "@agent-mesh/core";

import type { CodexRuntimeAdapter } from "./adapter";

export interface StartCodexAdapterHttpServerOptions {
  adapter: CodexRuntimeAdapter;
  port: number;
  token: string | null;
  logger?: (...args: unknown[]) => void;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isAuthorized(req: Request, token: string | null): boolean {
  if (!token) return true;
  return req.headers.get("authorization") === `Bearer ${token}`;
}

function parseChannelSource(raw: unknown): ChannelSource | null {
  if (typeof raw !== "string") return null;
  return CHANNEL_SOURCE_VALUES.includes(raw as ChannelSource) ? (raw as ChannelSource) : null;
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function optionalPositiveInt(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

export async function handleMeshToolAction(
  adapter: CodexRuntimeAdapter,
  body: Record<string, unknown>,
): Promise<unknown> {
  // This is intentionally a closed action set, not a generic JSON-RPC tunnel.
  // In particular, callers cannot select a different `from` identity; the
  // established adapter connection and its existing hub authorization remain
  // the only authority used for all operations.
  switch (body.action) {
    case "send": {
      const to = optionalString(body.to);
      const content = optionalString(body.content);
      if (!to || !content) throw new Error("send requires non-empty to and content");
      const replyTo = body.reply_to === null ? null : optionalString(body.reply_to) ?? null;
      return adapter.hub.send({
        to,
        from: adapter.config.targetAgent,
        content,
        reply_to: replyTo,
      });
    }
    case "list_agents":
      return { agents: await adapter.hub.listAgents() };
    case "fetch_messages": {
      const agentId = optionalString(body.agent_id);
      if (!agentId) throw new Error("fetch_messages requires non-empty agent_id");
      const limit = optionalPositiveInt(body.limit);
      return { messages: await adapter.hub.fetchMessages({
        agentId,
        ...(limit === undefined ? {} : { limit }),
      }) };
    }
    case "schedule_reminder": {
      const id = optionalString(body.id);
      const type = body.type;
      const scheduleSpec = optionalString(body.schedule_spec);
      const payload = optionalString(body.payload);
      const nextFireAt = optionalString(body.next_fire_at);
      const context = optionalString(body.context);
      const idempotencyKey = optionalString(body.idempotency_key);
      if (!id || (type !== "once" && type !== "cron") || !scheduleSpec || !payload || !nextFireAt) {
        throw new Error("schedule_reminder requires id, type, schedule_spec, payload, and next_fire_at");
      }
      return adapter.hub.scheduleReminder({
        id,
        type,
        scheduleSpec,
        payload,
        nextFireAt,
        ...(context === undefined ? {} : { context }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
    }
    case "cancel_reminder": {
      const id = optionalString(body.id);
      if (!id) throw new Error("cancel_reminder requires non-empty id");
      return adapter.hub.cancelReminder(id);
    }
    case "list_reminders": {
      const status = optionalString(body.status);
      const limit = optionalPositiveInt(body.limit);
      return { rows: await adapter.hub.listReminders({
        ...(status === undefined ? {} : { status }),
        ...(limit === undefined ? {} : { limit }),
      }) };
    }
    default:
      throw new Error("unsupported mesh action");
  }
}

export function startCodexAdapterHttpServer(
  options: StartCodexAdapterHttpServerOptions,
): { stop(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/healthz" && req.method === "GET") {
        return jsonResponse(200, { ok: true });
      }
      if (!isAuthorized(req, options.token)) {
        return jsonResponse(401, { error: "unauthorized" });
      }

      try {
        if (url.pathname === "/ingress/channel" && req.method === "POST") {
          const body = (await req.json()) as {
            source?: unknown;
            inputText?: unknown;
            envelope?: unknown;
            chatId?: unknown;
            channelId?: unknown;
            replyToMessageId?: unknown;
            replyToMsgId?: unknown;
            authorId?: unknown;
            replyRoute?: {
              channelId?: unknown;
              replyToMsgId?: unknown;
              authorId?: unknown;
            };
          };
          const source = parseChannelSource(body.source);
          const inputText =
            typeof body.inputText === "string"
              ? body.inputText
              : typeof body.envelope === "string"
                ? body.envelope
                : null;
          const chatId =
            typeof body.chatId === "string"
              ? body.chatId
              : typeof body.channelId === "string"
                ? body.channelId
                : typeof body.replyRoute?.channelId === "string"
                  ? body.replyRoute.channelId
                  : null;
          const replyToMessageId =
            typeof body.replyToMessageId === "string"
              ? body.replyToMessageId
              : typeof body.replyToMsgId === "string"
                ? body.replyToMsgId
                : typeof body.replyRoute?.replyToMsgId === "string"
                  ? body.replyRoute.replyToMsgId
                  : undefined;
          const authorId =
            typeof body.authorId === "string"
              ? body.authorId
              : typeof body.replyRoute?.authorId === "string"
                ? body.replyRoute.authorId
                : undefined;

          if (!source || !inputText || !chatId) {
            options.logger?.(
              `ingress/channel rejected invalid body source=${String(body.source)} chatId=${String(body.chatId ?? body.channelId ?? body.replyRoute?.channelId)} authorId=${String(body.authorId ?? body.replyRoute?.authorId)}`,
            );
            return jsonResponse(400, { error: "invalid_ingress_body" });
          }

          await options.adapter.enqueueChannelPayload({
            source,
            inputText,
            chatId,
            ...(replyToMessageId ? { replyToMessageId } : {}),
            ...(authorId ? { authorId } : {}),
          });
          options.logger?.(
            `ingress/channel accepted source=${source} chatId=${chatId} authorId=${authorId ?? "-"} ` +
              `replyTo=${replyToMessageId ?? "-"} textBytes=${inputText.length}`,
          );
          return jsonResponse(202, { ok: true });
        }
        if (url.pathname === "/actions/mesh" && req.method === "POST") {
          const body = (await req.json()) as unknown;
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return jsonResponse(400, { error: "invalid_mesh_action_body" });
          }
          const result = await handleMeshToolAction(options.adapter, body as Record<string, unknown>);
          return jsonResponse(200, { result });
        }
      } catch (error) {
        options.logger?.(`adapter http error ${url.pathname}: ${error}`);
        return jsonResponse(502, { error: "adapter_request_failed", detail: String(error) });
      }

      return jsonResponse(404, { error: "not_found" });
    },
  });

  options.logger?.(`runtime-codex http listening on 127.0.0.1:${options.port}`);
  return {
    stop() {
      server.stop(true);
    },
  };
}
