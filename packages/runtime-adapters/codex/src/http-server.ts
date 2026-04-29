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
