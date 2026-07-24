import { SynapsePmAutonomyStore, type TaskRecord } from "./store";

export interface MeshNotifier {
  send(to: "synapse-pm", content: string): Promise<void>;
}

export interface WatchdogOptions {
  now?: () => Date;
  heartbeatAfterMs?: number;
  nudgeAfterMs?: number;
  escalateAfterMs?: number;
}

function age(now: Date, timestamp: string): number {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) throw new Error("invalid stored task timestamp");
  return now.getTime() - parsed.getTime();
}

function message(kind: "HEARTBEAT" | "NUDGE" | "ESCALATION", task: TaskRecord): string {
  return `[AUTONOMY ${kind} task=${task.task_id} phase=${task.phase} next_action=${task.next_action}]`;
}

/** The daemon owns watchdog state; mesh is used only for outbound notification. */
export class SynapsePmAutonomyWatchdog {
  private readonly now: () => Date;
  private readonly heartbeatAfterMs: number;
  private readonly nudgeAfterMs: number;
  private readonly escalateAfterMs: number;

  constructor(private readonly store: SynapsePmAutonomyStore, private readonly notifier: MeshNotifier, options: WatchdogOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.heartbeatAfterMs = options.heartbeatAfterMs ?? 15 * 60_000;
    this.nudgeAfterMs = options.nudgeAfterMs ?? 30 * 60_000;
    this.escalateAfterMs = options.escalateAfterMs ?? 45 * 60_000;
    if (this.heartbeatAfterMs <= 0 || this.nudgeAfterMs <= this.heartbeatAfterMs || this.escalateAfterMs <= this.nudgeAfterMs) throw new Error("watchdog thresholds must increase");
  }

  async tick(): Promise<void> {
    const now = this.now();
    for (const task of this.store.active()) {
      const progressAge = age(now, task.last_progress_at);
      if (progressAge >= this.escalateAfterMs && task.escalation_level < 2) {
        const updated = this.store.escalate(task.task_id);
        await this.notifier.send("synapse-pm", message("ESCALATION", updated));
      } else if (progressAge >= this.nudgeAfterMs && task.escalation_level < 1) {
        const updated = this.store.nudge(task.task_id);
        await this.notifier.send("synapse-pm", message("NUDGE", updated));
      } else {
        const heartbeatAge = task.last_heartbeat_at ? age(now, task.last_heartbeat_at) : Number.POSITIVE_INFINITY;
        if (progressAge >= this.heartbeatAfterMs && heartbeatAge >= this.heartbeatAfterMs) {
          const updated = this.store.heartbeat(task.task_id);
          await this.notifier.send("synapse-pm", message("HEARTBEAT", updated));
        }
      }
    }
  }
}
