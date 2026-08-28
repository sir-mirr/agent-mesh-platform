import { apiClient, listOf } from "./client.ts";

const OVERDUE_ROUTE = "/api/v1/admin/reminders/overdue";

export interface HeldOverdueReminder {
  reminder_id: string;
  agent_id: string;
  /** The exact slot key returned by the server. Send it back unchanged. */
  scheduled_at: string;
  held_since: string;
  overdue_ms: number | null;
  status: string | null;
}

export type ReminderDecision = "replay" | "skip";

export interface OverdueDecisionRecord {
  reminder_id: string;
  scheduled_at: string;
  decision: ReminderDecision | string;
  approval_ref: string;
  decided_at: string;
  decided_by: string | null;
}

export interface OverdueReminderState {
  reminders: HeldOverdueReminder[];
  decisions: OverdueDecisionRecord[];
}

interface OverdueResponse {
  ok: boolean;
  reminders?: unknown;
  decisions?: unknown;
}

export async function fetchOverdueReminders(): Promise<OverdueReminderState> {
  const response = await apiClient<OverdueResponse>(OVERDUE_ROUTE);
  return {
    reminders: listOf<HeldOverdueReminder>(response.reminders, OVERDUE_ROUTE, "reminders"),
    decisions: listOf<OverdueDecisionRecord>(response.decisions, OVERDUE_ROUTE, "decisions"),
  };
}

export interface DecideOverdueReminderInput {
  scheduled_at: string;
  decision: ReminderDecision;
  approval_ref: string;
}

export function decideOverdueReminder(
  reminderId: string,
  input: DecideOverdueReminderInput,
): Promise<OverdueDecisionRecord & { ok: true }> {
  return apiClient<OverdueDecisionRecord & { ok: true }>(
    `${OVERDUE_ROUTE}/${encodeURIComponent(reminderId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}
