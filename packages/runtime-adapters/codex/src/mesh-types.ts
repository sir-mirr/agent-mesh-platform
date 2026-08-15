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

export interface ReminderRow {
  id: string;
  type: "once" | "cron" | "interval";
  status: string;
  schedule_spec: string;
  payload: string;
  context: string | null;
  next_fire_at: string | null;
  fire_count: number;
  last_fired_at: string | null;
  idempotency_key: string | null;
  created_at: string;
}
