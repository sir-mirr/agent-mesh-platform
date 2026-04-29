export interface MeshMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  reply_to: string | null;
  ts: string;
}
