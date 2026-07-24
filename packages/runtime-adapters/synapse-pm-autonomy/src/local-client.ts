import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

import type { LocalAutonomyClient } from "./pm-task-flow";
import type { TaskRecord } from "./store";

const SOCKET_PREFIX = "/run/synapse-pm-autonomy/";

/** Closed Unix-socket client used only by the PM dispatcher wrapper. */
export class UnixAutonomyClient implements LocalAutonomyClient {
  constructor(private readonly socketPath: string) {
    if (!socketPath.startsWith(SOCKET_PREFIX) || !socketPath.endsWith(".sock")) throw new Error("socket path is outside the daemon runtime directory");
  }

  request(operation: "create" | "progress" | "gate" | "complete", payload: Record<string, unknown>): Promise<TaskRecord> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(JSON.stringify({ id: randomUUID(), op: operation, ...payload }) + "\n"));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        socket.end();
        try {
          const response = JSON.parse(buffer.slice(0, end)) as { ok?: boolean; task?: TaskRecord; error?: { code?: string } };
          if (!response.ok || !response.task) throw new Error(response.error?.code ?? "CONTROL_REJECTED");
          resolve(response.task);
        } catch (error) { reject(error); }
      });
      socket.once("error", reject);
    });
  }
}
