import { createHash } from "node:crypto";

import { type CreateTaskInput, SynapsePmAutonomyStore, type TaskRecord } from "./store";

export interface GateArtifact {
  task_id: string;
  manifest_sha256: string;
  schema: "synapse/verified-done/v1";
  status: "verified_done";
  profiles: Array<{ profile: string; status: "PASS" }>;
}

export interface GateRunner {
  run(manifestRef: string): Promise<{ artifact: GateArtifact; rawArtifact: Uint8Array }>;
}

function validArtifact(task: TaskRecord, artifact: GateArtifact): boolean {
  return artifact.schema === "synapse/verified-done/v1"
    && artifact.status === "verified_done"
    && artifact.task_id === task.task_id
    && artifact.manifest_sha256 === `sha256:${task.manifest_sha256}`
    && artifact.profiles.length > 0
    && artifact.profiles.every((profile) => typeof profile.profile === "string" && profile.status === "PASS");
}

/** PM-only task facade. It has no caller-supplied PASS/result or artifact path. */
export class SynapsePmTaskController {
  constructor(private readonly store: SynapsePmAutonomyStore, private readonly gateRunner: GateRunner) {}

  create(input: CreateTaskInput): TaskRecord { return this.store.create(input); }
  progress(taskId: string, phase: string, nextAction: string): TaskRecord { return this.store.progress(taskId, phase, nextAction); }
  complete(taskId: string): TaskRecord { return this.store.complete(taskId); }

  async gate(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error("task not found");
    if (task.status !== "active") throw new Error(`task is not active: ${task.status}`);
    try {
      const result = await this.gateRunner.run(task.manifest_ref);
      if (!validArtifact(task, result.artifact)) return this.store.recordGateFail(taskId, "artifact_invalid");
      const artifactRef = `sha256:${createHash("sha256").update(result.rawArtifact).digest("hex")}`;
      return this.store.recordGatePass(taskId, artifactRef);
    } catch {
      return this.store.recordGateFail(taskId, "gate_failed");
    }
  }
}
