import { connect } from "node:net";
import { assertSocketPath } from "./policy";
import type { ControlRequest } from "./daemon";

/** Local-only client. It never opens TCP and can only target the exact runtime socket namespace. */
export async function sendAutonomyControl(socketPath: string, request: ControlRequest): Promise<unknown> {
  const safePath = assertSocketPath(socketPath);
  return await new Promise((resolve, reject) => {
    const socket = connect({ path: safePath });
    let body = "";
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    socket.once("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid control response")); } });
    socket.once("connect", () => { socket.end(JSON.stringify(request) + "\n"); });
  });
}
