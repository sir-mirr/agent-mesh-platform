export interface MeshMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  reply_to: string | null;
  ts: string;
}

export interface MeshAgent {
  id: string;
  description: string | null;
  online: boolean;
  last_seen: string | null;
  type: string | null;
}

export interface MeshMessageHistoryEntry extends MeshMessage {
  status: string;
}
