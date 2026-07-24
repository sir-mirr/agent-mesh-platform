import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";

import { type CreateTaskInput } from "./store";
import { SynapsePmTaskController } from "./controller";

type Request =
  | { id: string; op: "create"; input: CreateTaskInput }
  | { id: string; op: "progress"; task_id: string; phase: string; next_action: string }
  | { id: string; op: "gate"; task_id: string }
  | { id: string; op: "complete"; task_id: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUNTIME_DIR = "/run/synapse-pm-autonomy";
const CREATE_INPUT_KEYS = ["taskId", "manifestSha256", "manifestRef", "lane", "owner", "phase", "nextAction"];
const MAX_CONTROL_BYTES = 16_384;

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

export function runtimeSocketPath(value: string): string {
  const normalized = resolve(value);
  if (dirname(normalized) !== RUNTIME_DIR || !normalized.endsWith(".sock")) throw new Error("socket path is outside the daemon runtime directory");
  return normalized;
}

function parseRequest(raw: unknown): Request {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid control request");
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !ID.test(value.id) || typeof value.op !== "string") throw new Error("invalid control envelope");
  if (value.op === "create" && Object.keys(value).length === 3 && value.input && typeof value.input === "object" && !Array.isArray(value.input) && exactKeys(value.input as Record<string, unknown>, CREATE_INPUT_KEYS)) {
    return { id: value.id, op: "create", input: value.input as CreateTaskInput };
  }
  if (value.op === "progress" && Object.keys(value).length === 5 && typeof value.task_id === "string" && typeof value.phase === "string" && typeof value.next_action === "string") {
    return { id: value.id, op: "progress", task_id: value.task_id, phase: value.phase, next_action: value.next_action };
  }
  if ((value.op === "gate" || value.op === "complete") && Object.keys(value).length === 3 && typeof value.task_id === "string") {
    return { id: value.id, op: value.op, task_id: value.task_id };
  }
  throw new Error("invalid control request shape");
}

export class LocalControlPlane {
  constructor(private readonly controller: SynapsePmTaskController) {}

  async handle(raw: unknown): Promise<Record<string, unknown>> {
    let requestId = "unknown";
    try {
      const request = parseRequest(raw);
      requestId = request.id;
      const task = request.op === "create" ? this.controller.create(request.input)
        : request.op === "progress" ? this.controller.progress(request.task_id, request.phase, request.next_action)
        : request.op === "gate" ? await this.controller.gate(request.task_id)
        : this.controller.complete(request.task_id);
      return { id: request.id, ok: true, task };
    } catch (error) {
      const code = error instanceof Error && error.message === "COMPLETION_REJECTED" ? "COMPLETION_REJECTED" : "CONTROL_REJECTED";
      return { id: requestId, ok: false, error: { code } };
    }
  }
}

/** Unix-only local control transport. Socket mode 0600 is the OS access gate. */
export async function startLocalControlServer(socketPath: string, control: LocalControlPlane): Promise<Server> {
  const normalizedSocketPath = runtimeSocketPath(socketPath);
  await mkdir(dirname(normalizedSocketPath), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(normalizedSocketPath);
    if (!info.isSocket()) throw new Error("refusing to replace a non-socket control path");
    await rm(normalizedSocketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_CONTROL_BYTES) { socket.destroy(); return; }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line || line.length > MAX_CONTROL_BYTES) { socket.destroy(); return; }
        let value: unknown;
        try { value = JSON.parse(line); } catch { socket.write(JSON.stringify({ ok: false, error: { code: "CONTROL_REJECTED" } }) + "\n"); continue; }
        void control.handle(value).then((response) => socket.write(JSON.stringify(response) + "\n"));
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(normalizedSocketPath, resolve));
  await chmod(normalizedSocketPath, 0o600);
  return server;
}
