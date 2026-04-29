import type { DiscordToolService, DiscordLogFn } from "./types";

export interface StartDiscordHttpServerOptions {
  port: number;
  token: string | null;
  tools: DiscordToolService;
  logger?: DiscordLogFn;
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

export function startDiscordDriverHttpServer(
  options: StartDiscordHttpServerOptions,
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
        if (url.pathname === "/send" && req.method === "POST") {
          const body = (await req.json()) as {
            channelId?: string;
            text?: string;
            replyToMsgId?: string;
            files?: string[];
          };
          if (typeof body.channelId !== "string" || typeof body.text !== "string") {
            return jsonResponse(400, { error: "invalid_send_body" });
          }
          const result = await options.tools.reply({
            chat_id: body.channelId,
            text: body.text,
            ...(body.replyToMsgId ? { reply_to: body.replyToMsgId } : {}),
            ...(Array.isArray(body.files) ? { files: body.files.filter((item) => typeof item === "string") } : {}),
          });
          return jsonResponse(200, { ok: true, messageIds: result.messageIds });
        }

        if (url.pathname === "/react" && req.method === "POST") {
          const body = (await req.json()) as {
            channelId?: string;
            messageId?: string;
            emoji?: string;
          };
          if (
            typeof body.channelId !== "string" ||
            typeof body.messageId !== "string" ||
            typeof body.emoji !== "string"
          ) {
            return jsonResponse(400, { error: "invalid_react_body" });
          }
          await options.tools.react({
            chat_id: body.channelId,
            message_id: body.messageId,
            emoji: body.emoji,
          });
          return jsonResponse(201, { ok: true });
        }

        if (url.pathname === "/edit" && req.method === "POST") {
          const body = (await req.json()) as {
            channelId?: string;
            messageId?: string;
            text?: string;
          };
          if (
            typeof body.channelId !== "string" ||
            typeof body.messageId !== "string" ||
            typeof body.text !== "string"
          ) {
            return jsonResponse(400, { error: "invalid_edit_body" });
          }
          const result = await options.tools.editMessage({
            chat_id: body.channelId,
            message_id: body.messageId,
            text: body.text,
          });
          return jsonResponse(200, { ok: true, messageId: result.messageId });
        }

        if (url.pathname === "/typing" && req.method === "POST") {
          const body = (await req.json()) as {
            channelId?: string;
            action?: "start" | "stop";
          };
          if (
            typeof body.channelId !== "string" ||
            (body.action !== "start" && body.action !== "stop")
          ) {
            return jsonResponse(400, { error: "invalid_typing_body" });
          }
          await options.tools.sendTyping({
            chat_id: body.channelId,
            action: body.action,
          });
          return jsonResponse(200, { ok: true, ...(body.action === "stop" ? { noop: true } : {}) });
        }
      } catch (error) {
        options.logger?.(`discord http error ${url.pathname}: ${error}`);
        return jsonResponse(502, { error: "driver_request_failed", detail: String(error) });
      }

      return jsonResponse(404, { error: "not_found" });
    },
  });

  options.logger?.(`discord driver http listening on 127.0.0.1:${options.port}`);
  return {
    stop() {
      server.stop(true);
    },
  };
}
