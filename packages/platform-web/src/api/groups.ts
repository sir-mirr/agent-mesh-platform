import { apiClient } from "./client.ts";

export interface GroupItem {
  id: string;
  name: string;
  description?: string | null;
  member_count?: number;
  members?: string[];
  egress_allowed?: string[];
  created_at?: string;
}

export async function fetchGroups(): Promise<GroupItem[]> {
  const data = await apiClient<any>("/api/v1/admin/groups");
  const list = Array.isArray(data) ? data : data.groups ?? [];
  return list.map((g: any) => ({
    id: g.group_id || g.id || `grp_${g.name?.toLowerCase().replace(/\s+/g, "_")}`,
    name: g.name || g.group_id,
    description: g.description ?? null,
    member_count: g.member_count ?? (g.members?.length || 0),
    members: g.members ?? [],
    egress_allowed: g.egress_allowed ?? [],
    created_at: g.created_at || new Date().toISOString(),
  }));
}

export async function createGroupApi(name: string, description?: string): Promise<{ ok: boolean; group?: any }> {
  return await apiClient<{ ok: boolean; group?: any }>("/api/v1/admin/groups", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
}

export async function addEgressRuleApi(groupId: string, toGroupId: string): Promise<{ ok: boolean }> {
  return await apiClient<{ ok: boolean }>(`/api/v1/admin/groups/${encodeURIComponent(groupId)}/egress`, {
    method: "POST",
    body: JSON.stringify({ to_group: toGroupId }),
  });
}

export async function deleteEgressRuleApi(groupId: string, toGroupId: string): Promise<{ ok: boolean }> {
  return await apiClient<{ ok: boolean }>(`/api/v1/admin/groups/${encodeURIComponent(groupId)}/egress/${encodeURIComponent(toGroupId)}`, {
    method: "DELETE",
  });
}

