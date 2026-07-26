import { connect } from "node:net";
import { assertSocketPath } from "./policy";
import type { ControlRequest } from "./daemon";

/** Production client is local-only and fixed to the runtime socket; fixtures may supply a temp validator. */
export async function sendAutonomyControl(socketPath: string, request: ControlRequest, socketPathValidator: (socketPath: string) => string = assertSocketPath): Promise<unknown> {
  const safePath = socketPathValidator(socketPath);
  return await new Promise((resolve, reject) => {
    const socket = connect({ path: safePath });
    let body = "";
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    socket.once("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid control response")); } });
    // Keep the writable side open until the daemon's asynchronous dispatch has
    // produced its response; ending here can race an async UDS handler.
    socket.once("connect", () => { socket.write(JSON.stringify(request) + "\n"); });
  });
}
