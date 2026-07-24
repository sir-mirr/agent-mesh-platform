import type { CreateTaskInput, TaskRecord } from "./store";

export interface LocalAutonomyClient {
  request(operation: "create" | "progress" | "gate" | "complete", payload: Record<string, unknown>): Promise<TaskRecord>;
}

/**
 * The sole PM-owned task wrapper. It cannot inject a PASS or mark a task done;
 * completion is accepted only by the daemon after a verified gate artifact.
 */
export class PmAutonomousTaskFlow {
  constructor(private readonly client: LocalAutonomyClient) {}

  start(input: CreateTaskInput): Promise<TaskRecord> {
    return this.client.request("create", { input });
  }

  progress(taskId: string, phase: string, nextAction: string): Promise<TaskRecord> {
    return this.client.request("progress", { task_id: taskId, phase, next_action: nextAction });
  }

  verify(taskId: string): Promise<TaskRecord> {
    return this.client.request("gate", { task_id: taskId });
  }

  complete(taskId: string): Promise<TaskRecord> {
    return this.client.request("complete", { task_id: taskId });
  }
}
