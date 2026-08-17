import { apiClient } from "./client.ts";

export interface GroupItem {
  id: string;
  name: string;
  description?: string | null;
  member_count?: number | null;
  members?: string[];
  egress_allowed?: string[] | null;
  created_at?: string | null;
}

export async function fetchGroups(): Promise<GroupItem[]> {
  const data = await apiClient<any>("/api/v1/admin/groups");
  const list = Array.isArray(data) ? data : data.groups ?? [];
  const egressList = Array.isArray(data.egress) ? data.egress : [];
  return list.map((g: any) => {
    const groupId = g.group_id || g.id || `grp_${g.name?.toLowerCase().replace(/\s+/g, "_")}`;
    const groupEgress = egressList
      .filter((e: any) => (e.from_group || e.source_group) === groupId)
      .map((e: any) => e.to_group || e.target_group);
    return {
      id: groupId,
      name: g.name || g.group_id,
      description: g.description ?? null,
      member_count: g.member_count ?? (Array.isArray(g.members) ? g.members.length : null),
      members: Array.isArray(g.members) ? g.members : [],
      egress_allowed: groupEgress.length > 0 ? groupEgress : (Array.isArray(g.egress_allowed) ? g.egress_allowed : null),
      created_at: g.created_at ?? null,
    };
  });
}

export async function createGroupApi(name: string, description?: string): Promise<{ ok: boolean; group_id?: string; created?: boolean; group?: any }> {
  return await apiClient<{ ok: boolean; group_id?: string; created?: boolean; group?: any }>("/api/v1/admin/groups", {
    method: "POST",
    body: JSON.stringify({ group_id: name, description }),
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

