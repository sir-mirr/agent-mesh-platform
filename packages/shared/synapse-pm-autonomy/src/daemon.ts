import { createHash } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { readFileSync } from "node:fs";

import { AutonomyStore, FixedArgvGateRunner } from "./autonomy";
import { BoundaryError, assertPeerUid, assertSafeFileUnderRoot, assertSocketPath } from "./policy";

export const MAX_CONTROL_BYTES = 4096;
type Operation = "create" | "progress" | "gate" | "complete";
export type ControlRequest = { op: Operation; input: Record<string, unknown> };

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoundaryError("CONTROL_REJECTED", `${field} must be an object`);
  return value as Record<string, unknown>;
}
function exact(record: Record<string, unknown>, keys: readonly string[], field: string): void {
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) {
    throw new BoundaryError("CONTROL_REJECTED", `${field} contains unknown or missing keys`);
  }
}
function string(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value || value.includes("\n") || value.includes("\r")) throw new BoundaryError("CONTROL_REJECTED", `${key} must be a newline-free string`);
  return value;
}

/** Parse one bounded line of closed-schema local control JSON. */
export function parseControlRequest(line: string): ControlRequest {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new BoundaryError("CONTROL_REJECTED", "control request is not JSON"); }
  const request = object(parsed, "request");
  exact(request, ["op", "input"], "request");
  const op = string(request, "op");
  if (op !== "create" && op !== "progress" && op !== "gate" && op !== "complete") throw new BoundaryError("CONTROL_REJECTED", "unsupported control operation");
  const input = object(request.input, "input");
  const expected = op === "create" ? ["task_id", "manifest_ref", "phase", "next_action"]
    : op === "progress" ? ["task_id", "phase", "next_action"]
      : ["task_id"];
  exact(input, expected, "input");
  for (const key of expected) string(input, key);
  return { op, input };
}

export class ControlLineDecoder {
  private buffered = "";
  push(chunk: string): string[] {
    if (Buffer.byteLength(this.buffered) + Buffer.byteLength(chunk) > MAX_CONTROL_BYTES) {
      this.buffered = "";
      throw new BoundaryError("CONTROL_INPUT_TOO_LARGE", "control input exceeds the fixed bound");
    }
    this.buffered += chunk;
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";
    return lines.filter((line) => line.length > 0);
  }
}

export interface DaemonOptions {
  socketPath: string;
  daemonUid: number;
  store: AutonomyStore;
  manifestsRoot: string;
  gateRunner: FixedArgvGateRunner;
  peerUid?: (socket: Socket) => number | null;
}

function osPeerUid(socket: Socket): number | null {
  const getter = (socket as unknown as { getPeerCredentials?: () => { uid?: unknown } }).getPeerCredentials;
  if (!getter) return null; // Platforms without OS peer credentials fail closed.
  const credentials = getter.call(socket);
  return typeof credentials.uid === "number" ? credentials.uid : null;
}

function response(value: unknown): string { return JSON.stringify(value) + "\n"; }

export function startAutonomyDaemon(options: DaemonOptions) {
  const socketPath = assertSocketPath(options.socketPath);
  const peerUid = options.peerUid ?? osPeerUid;
  const server = createServer((socket) => {
    try { assertPeerUid(peerUid(socket), options.daemonUid); } catch (error) { socket.end(response({ error: (error as BoundaryError).code })); return; }
    const decoder = new ControlLineDecoder();
    socket.on("data", (chunk: Buffer) => {
      let lines: string[];
      try { lines = decoder.push(chunk.toString("utf8")); } catch (error) { socket.destroy(error as Error); return; }
      for (const line of lines) void dispatch(line, options).then((value) => socket.end(response(value))).catch((error: unknown) => socket.end(response({ error: (error as BoundaryError).code ?? "CONTROL_REJECTED" })));
    });
  });
  server.listen(socketPath);
  return server;
}

async function dispatch(line: string, options: DaemonOptions): Promise<unknown> {
  const request = parseControlRequest(line);
  if (request.op === "create") {
    const manifestRef = string(request.input, "manifest_ref");
    // The caller never supplies a manifest hash; it is derived from its allowlisted bytes.
    const manifestPath = assertSafeFileUnderRoot(options.manifestsRoot, manifestRef);
    const manifestSha256 = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
    return options.store.create({ taskId: string(request.input, "task_id"), manifestRef, manifestSha256, phase: string(request.input, "phase"), nextAction: string(request.input, "next_action") });
  }
  if (request.op === "progress") return options.store.progress({ taskId: string(request.input, "task_id"), phase: string(request.input, "phase"), nextAction: string(request.input, "next_action") });
  if (request.op === "gate") {
    const task = options.store.get(string(request.input, "task_id"));
    if (!task) throw new BoundaryError("CONTROL_REJECTED", "task does not exist");
    return options.store.recordVerifiedGate(task.task_id, await options.gateRunner.run(task));
  }
  return options.store.complete(string(request.input, "task_id"));
}
