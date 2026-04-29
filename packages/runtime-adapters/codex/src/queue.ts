import type { ThreadManager } from "./thread-manager";
import type { TurnEnvelope } from "./turn-envelope";
import { sameReplyRoute } from "./turn-envelope";

export interface QueueOptions {
  manager: ThreadManager;
}

type LaneName = "self-reminder" | "agent-mesh" | "channel";
const LANE_PRIORITY: LaneName[] = ["self-reminder", "agent-mesh", "channel"];
const MAX_READY_RETRY = 5;

function laneFor(env: TurnEnvelope): LaneName {
  const source = env.sourceMeta.primarySource;
  if (source === "self-reminder") return "self-reminder";
  if (source === "agent-mesh") {
    return env.replyRoute.kind === "none" ? "self-reminder" : "agent-mesh";
  }
  return "channel";
}

export class TurnQueue {
  private lanes: Record<LaneName, TurnEnvelope[]> = {
    "self-reminder": [],
    "agent-mesh": [],
    "channel": [],
  };
  private active: TurnEnvelope | null = null;
  private running = false;
  private processing = false;
  private wakeup: (() => void) | null = null;

  constructor(private readonly opts: QueueOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.wakeup?.();
  }

  async enqueue(env: TurnEnvelope): Promise<"queued" | "steered"> {
    if (
      this.active &&
      sameReplyRoute(this.active.replyRoute, env.replyRoute, {
        activeEnqueuedAt: this.active.sourceMeta.enqueuedAt,
      })
    ) {
      const buffer = (this.active.steerBuffer ??= []);
      for (const item of env.inputItems) buffer.push(item);
      this.active.sourceMeta.steerAppends += env.inputItems.length;
      if (this.active.replyRoute.kind === "channel") {
        this.active.sourceMeta.enqueuedAt = new Date().toISOString();
      }
      try {
        await this.opts.manager.steerActive(env.inputItems);
      } catch (error) {
        log(`steer merge failed for active=${this.active.turnId}: ${error}`);
        this.pushToLane(env);
        this.notify();
        return "queued";
      }
      return "steered";
    }

    this.pushToLane(env);
    this.notify();
    return "queued";
  }

  enqueueFront(env: TurnEnvelope): LaneName {
    const lane = laneFor(env);
    this.lanes[lane].unshift(env);
    this.notify();
    return lane;
  }

  flushPending(reason: string): number {
    let count = 0;
    for (const lane of LANE_PRIORITY) {
      count += this.lanes[lane].length;
      this.lanes[lane] = [];
    }
    log(`flushPending reason=${reason} flushed=${count}`);
    return count;
  }

  getActive(): TurnEnvelope | null {
    return this.active;
  }

  pendingCount(): number {
    return (
      this.lanes["self-reminder"].length +
      this.lanes["agent-mesh"].length +
      this.lanes.channel.length
    );
  }

  clearActive(): void {
    this.active = null;
    this.notify();
  }

  requeueFront(env: TurnEnvelope, reason: string): "requeued" | "dropped" {
    const previous = env.sourceMeta.readyRetryCount ?? 0;
    const next = previous + 1;
    env.sourceMeta.readyRetryCount = next;
    if (next > MAX_READY_RETRY) {
      log(`requeueFront drop turnId=${env.turnId} reason=${reason}`);
      if (this.active === env) this.active = null;
      this.notify();
      return "dropped";
    }
    const lane = laneFor(env);
    this.lanes[lane].unshift(env);
    if (this.active === env) this.active = null;
    this.notify();
    return "requeued";
  }

  wake(): void {
    this.notify();
  }

  private pushToLane(env: TurnEnvelope): LaneName {
    const lane = laneFor(env);
    this.lanes[lane].push(env);
    return lane;
  }

  private pickNext(): TurnEnvelope | null {
    for (const lane of LANE_PRIORITY) {
      const queue = this.lanes[lane];
      if (queue.length > 0) return queue.shift()!;
    }
    return null;
  }

  private notify(): void {
    if (!this.wakeup) return;
    const wake = this.wakeup;
    this.wakeup = null;
    wake();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (!this.active && this.pendingCount() > 0 && !this.processing) {
        if (!this.opts.manager.codexIsReady()) {
          await new Promise<void>((resolve) => {
            this.wakeup = resolve;
          });
          continue;
        }
        const next = this.pickNext();
        if (!next) {
          await new Promise<void>((resolve) => {
            this.wakeup = resolve;
          });
          continue;
        }
        this.active = next;
        this.processing = true;
        try {
          await this.opts.manager.runEnvelope(next);
        } catch (error) {
          log(`runEnvelope threw for turnId=${next.turnId}: ${error}`);
          if (this.active === next) this.active = null;
        } finally {
          this.processing = false;
        }
        continue;
      }

      await new Promise<void>((resolve) => {
        this.wakeup = resolve;
      });
    }
  }
}

function log(...args: unknown[]) {
  console.log("[runtime-codex] [queue]", ...args);
}
