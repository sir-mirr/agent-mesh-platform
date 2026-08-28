import type { RestEgressRow, RestGroupRow, RestGroupsResponse } from "@agent-mesh/contracts";

import { apiClient, listOf } from "./client.ts";

export interface GroupItem {
  id: string;
  name: string;
  /** Absent or `null` only when an older or malformed response did not name it. */
  tenant?: string | null;
  description?: string | null;
  member_count?: number | null;
  members?: string[];
  egress_allowed?: string[] | null;
  created_at?: string | null;
}

export async function fetchGroups(): Promise<GroupItem[]> {
  const data = await apiClient<RestGroupsResponse>("/api/v1/admin/groups");
  // The bare-array branch went: this route has always answered `{ ok, tenant,
  // groups, egress }`. A body without a `groups` array is refused rather than
  // drawn as a mesh with no groups — that is a claim about the tenant made out
  // of a fact about the read, and this screen has a separate state for it.
  const list = listOf<RestGroupRow>(data?.groups, "/api/v1/admin/groups", "groups");
  // Whether the route answered with egress rules at all, kept apart from the
  // rules being empty. Without it every group on a response carrying no
  // `egress` reads as "allowed to reach nothing", which is a claim.
  const egressKnown = Array.isArray(data?.egress);
  const egressList: RestEgressRow[] = egressKnown ? data.egress : [];
  const tenantsInResponse = new Set(
    list.map((g) => typeof g.tenant === "string" ? g.tenant : null),
  );
  // Older tenant-scoped responses did not repeat the tenant on each egress row
  // and remain unambiguous while the group response has one tenant. Once more
  // than one tenant is present, a tenant-less rule cannot be joined truthfully.
  const egressTenantAmbiguous = egressList.some((e) => typeof e.tenant !== "string")
    && tenantsInResponse.size > 1;
  return list.map((g) => {
    // `g.group_id || g.id || \`grp_${g.name?…}\`` — the last two links read
    // names this route does not send. It answers `tenant group_id description
    // created_at created_by members`, so the first link always won and the
    // synthesised `grp_…` id could never be reached.
    const groupId = g.group_id;
    const tenant = typeof g.tenant === "string" ? g.tenant : null;
    // `source_group` / `target_group` / `member_count` / `egress_allowed` were
    // the leading half of four fallbacks here and no package on this platform
    // sends any of them, so the trailing half ran every time. They stayed
    // quiet because those trailing halves are the real computation — unlike
    // the receipt's digest, which fell back to a value that was some other
    // thing's hash. Left in place they read as a description of the route.
    const groupEgress = egressList
      .filter((e) => {
        if (e.from_group !== groupId) return false;
        const egressTenant = typeof e.tenant === "string" ? e.tenant : null;
        // A tenant is part of the group key. Older tenant-scoped responses name
        // neither side and still match; a partial response naming only one side
        // cannot be safely joined.
        return egressTenant === null ? !egressTenantAmbiguous : tenant === egressTenant;
      })
      .map((e) => e.to_group);
    return {
      id: groupId,
      // The route sends no `name`; `group_id` is the name. `g.name || g.group_id`
      // always reached the second link.
      name: g.group_id,
      tenant,
      description: g.description ?? null,
      member_count: Array.isArray(g.members) ? g.members.length : null,
      members: Array.isArray(g.members) ? g.members : [],
      egress_allowed: egressKnown && !egressTenantAmbiguous ? groupEgress : null,
      created_at: g.created_at ?? null,
    };
  });
}

export async function createGroupApi(
  name: string,
  description?: string,
  tenant?: string,
): Promise<{ ok: boolean; group_id?: string; created?: boolean; group?: any }> {
  return await apiClient<{ ok: boolean; group_id?: string; created?: boolean; group?: any }>("/api/v1/admin/groups", {
    method: "POST",
    body: JSON.stringify({ group_id: name, description, tenant }),
  });
}

export interface AssignGroupMemberResponse {
  ok: boolean;
  identity: string;
  tenant: string;
  from_group: string | null;
  to_group: string;
}

export async function assignGroupMemberApi(
  groupId: string,
  identity: string,
  tenant?: string,
): Promise<AssignGroupMemberResponse> {
  return apiClient<AssignGroupMemberResponse>(
    `/api/v1/admin/groups/${encodeURIComponent(groupId)}/members`,
    {
      method: "POST",
      body: JSON.stringify({ identity, tenant }),
    },
  );
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
