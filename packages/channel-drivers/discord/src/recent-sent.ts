import type { RecentSentTracker } from "./types";

const DEFAULT_CAPACITY = 200;

export class RecentSentMessageTracker implements RecentSentTracker {
  private readonly sentIds = new Set<string>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  has(messageId: string): boolean {
    return this.sentIds.has(messageId);
  }

  note(messageId: string): void {
    this.sentIds.add(messageId);
    if (this.sentIds.size <= this.capacity) return;
    const oldest = this.sentIds.values().next().value;
    if (oldest) {
      this.sentIds.delete(oldest);
    }
  }
}
