import type { ChannelEnvelope, ChannelSource } from "./envelope";

export interface NormalizedHistoryRecord extends ChannelEnvelope {
  storageKey: string;
  recordedAt: string;
}

export interface HistoryQuery {
  source: ChannelSource;
  chatId: string;
  limit?: number;
  beforeMessageId?: string;
}

export interface HistoryStore {
  append(record: NormalizedHistoryRecord): Promise<void> | void;
  getByMessageId(source: ChannelSource, chatId: string, messageId: string): Promise<NormalizedHistoryRecord | null> | NormalizedHistoryRecord | null;
  list(query: HistoryQuery): Promise<NormalizedHistoryRecord[]> | NormalizedHistoryRecord[];
}

export interface LiveHistoryProvider {
  fetchRecent(query: HistoryQuery): Promise<NormalizedHistoryRecord[]>;
}

export interface HistoryAccessPlan {
  primary: "normalized-store";
  fallback?: "live-source";
}

export const DEFAULT_HISTORY_ACCESS_PLAN: HistoryAccessPlan = {
  primary: "normalized-store",
  fallback: "live-source",
};
