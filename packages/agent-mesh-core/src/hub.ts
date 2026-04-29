import type { HistoryQuery, NormalizedHistoryRecord } from "./history";
import type { RegisteredAgent } from "./registry";

export interface HubConnectRequest {
  identity: string;
  description?: string;
  proxyFor?: string[];
}

export interface HubSendRequest {
  to: string;
  content: string;
  replyTo?: string;
  from?: string;
}

export interface HubSendResult {
  id: string;
  status: "pending" | "delivered";
}

export interface MeshHubClient {
  connect(request: HubConnectRequest): Promise<void>;
  send(request: HubSendRequest): Promise<HubSendResult>;
  fetchMessages(query: HistoryQuery): Promise<NormalizedHistoryRecord[]>;
  listAgents(): Promise<RegisteredAgent[]>;
}
