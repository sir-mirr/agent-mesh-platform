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
  // Whether the route answered with egress rules at all, kept apart from the
  // rules being empty. Without it every group on a response carrying no
  // `egress` reads as "allowed to reach nothing", which is a claim.
  const egressKnown = Array.isArray(data.egress);
  const egressList: any[] = egressKnown ? data.egress : [];
  return list.map((g: any) => {
    const groupId = g.group_id || g.id || `grp_${g.name?.toLowerCase().replace(/\s+/g, "_")}`;
    // `source_group` / `target_group` / `member_count` / `egress_allowed` were
    // the leading half of four fallbacks here and no package on this platform
    // sends any of them, so the trailing half ran every time. They stayed
    // quiet because those trailing halves are the real computation — unlike
    // the receipt's digest, which fell back to a value that was some other
    // thing's hash. Left in place they read as a description of the route.
    const groupEgress = egressList
      .filter((e: any) => e.from_group === groupId)
      .map((e: any) => e.to_group);
    return {
      id: groupId,
      name: g.name || g.group_id,
      description: g.description ?? null,
      member_count: Array.isArray(g.members) ? g.members.length : null,
      members: Array.isArray(g.members) ? g.members : [],
      egress_allowed: egressKnown ? groupEgress : null,
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

