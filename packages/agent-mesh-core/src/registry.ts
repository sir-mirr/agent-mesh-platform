export type AgentTransportKind = "runtime" | "channel-driver" | "system" | "proxy";

export interface RegisteredAgent {
  identity: string;
  description?: string;
  lastSeen?: string;
  kind?: AgentTransportKind;
  online?: boolean;
  proxyFor?: string[];
}

export interface AgentRegistry {
  get(identity: string): Promise<RegisteredAgent | null> | RegisteredAgent | null;
  list(): Promise<RegisteredAgent[]> | RegisteredAgent[];
}

export interface DeliveryRoute {
  recipientIdentity: string;
  transportIdentity: string;
  viaProxy: boolean;
}

export interface RouteResolver {
  resolve(identity: string): Promise<DeliveryRoute | null> | DeliveryRoute | null;
}
