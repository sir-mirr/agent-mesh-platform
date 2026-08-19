/**
 * A refusal that actually happened, seen in the metric that reports it.
 *
 * `packages/http/src/behaviour-metrics.test.ts` covers the shaping against
 * sources that failed — the case that matters and the one a live mesh will not
 * produce on request. What it cannot cover is the wiring: that a real § 12
 * egress denial reaches `recordRefusal`, survives the hub's `/api/v1/limits`,
 * and arrives on the screen's route as a number that went up.
 *
 * agent-mesh-local-pm named this as the next thing worth measuring — **seeing a
 * refusal counted is worth more than reading the line that counts it** — after
 * driving the messaging path end to end and finding that four of their own
 * assumptions about it were wrong.
 *
 * The metric is read before and after rather than compared to a constant. These
 * counters are per-process and the suite shares a mesh, so any absolute number
 * here would be a claim about what else has run.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

import { callHttp, loginAsAdmin, newKeyPair, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let adminCookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  adminCookie = await loginAsAdmin(mesh.http);
}, 60_000);

afterAll(() => mesh?.stop());

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${mesh.http.url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie: adminCookie, ...(init.headers ?? {}) },
  });

async function behaviour() {
  const res = await admin("/api/v1/admin/telemetry/behaviour");
  expect({ status: res.status }).toEqual({ status: 200 });
  return (await res.json()) as {
    counting_since: string | null;
    egress_refusals: { value: number | null; unavailable?: string };
    accepted: { value: number | null };
  };
}

test("an egress denial arrives as a number that went up", async () => {
  const before = await behaviour();
  // The window has to be there, or the count below cannot be read at all.
  expect({ window: typeof before.counting_since === "string" }).toEqual({ window: true });
  expect({ read: before.egress_refusals.value !== null }).toEqual({ read: true });

  // § 12: a group with no egress rule sends nowhere. Built here rather than
  // reused, because the refusal has to happen inside this test's window.
  expect((await admin("/api/v1/admin/groups", {
    method: "POST", body: JSON.stringify({ group_id: "metered" }),
  })).status).toBe(201);

  const a = newKeyPair();
  await provision(mesh.hub, "meter-a", "ai-claude", null, a.publicKey);
  await provision(mesh.hub, "meter-b", "ai-claude", null, newKeyPair().publicKey);
  expect((await admin("/api/v1/admin/keys/approve", {
    method: "POST", body: JSON.stringify({ fingerprint: a.fingerprint }),
  })).status).toBe(200);
  for (const identity of ["meter-a", "meter-b"]) {
    expect((await admin("/api/v1/admin/groups/metered/members", {
      method: "POST", body: JSON.stringify({ identity }),
    })).status).toBe(200);
  }

  const refused = await callHttp(
    mesh.hub,
    { kid: a.fingerprint, privateKey: a.privateKey },
    "mesh.send",
    { to: "meter-b", content: "this one is counted" },
  );
  // The refusal is asserted here too: a send that failed for another reason
  // would leave the count flat and this test would report the wiring broken.
  expect(refused.body.error.data.code).toBe("EGRESS_DENIED");

  const after = await behaviour();
  expect({
    counted: (after.egress_refusals.value ?? 0) > (before.egress_refusals.value ?? 0),
  }).toEqual({ counted: true });

  // And the window did not move, so the two counts are comparable — a hub that
  // restarted between them would reset to zero and read as a fall.
  expect(after.counting_since).toBe(before.counting_since);
}, 60_000);

/**
 * And the other counter the same route reports.
 *
 * `rate_limited` sums every limiter's refusals, so the cheapest wire to prove
 * is the provisioning one — plain POSTs, no signature preimage to rebuild here
 * from the one in `ratelimit.test.ts`. What is being checked is not that the
 * limiter works, which that file covers over the wire, but that its count
 * reaches the screen's route: a different source from the refusals above, read
 * through the same hub response, and able to break on its own.
 *
 * Its own mesh, with the limit lowered to something a test can reach. The
 * shared one leaves provisioning generous on purpose.
 */
test("a rate-limited request arrives as a number that went up", async () => {
  const strict = await startMesh({
    env: { AGENT_MESH_PROVISION_BURST: "2", AGENT_MESH_PROVISION_PER_MINUTE: "1" },
  });
  try {
    const cookie = await loginAsAdmin(strict.http);
    const read = async () => {
      const res = await fetch(`${strict.http.url}/api/v1/admin/telemetry/behaviour`, { headers: { cookie } });
      expect({ status: res.status }).toEqual({ status: 200 });
      return (await res.json()) as { rate_limited: { value: number | null } };
    };

    const before = await read();
    expect({ read: before.rate_limited.value !== null }).toEqual({ read: true });

    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await provision(strict.hub, `rl-metric-${i}`, "service");
      seen.push(res.status);
    }
    // Asserted, so a run where nothing was refused reports itself rather than
    // reporting the wiring broken.
    expect(seen, `every provisioning was served: ${seen.join(", ")}`).toContain(429);

    const after = await read();
    expect({ counted: (after.rate_limited.value ?? 0) > (before.rate_limited.value ?? 0) })
      .toEqual({ counted: true });
  } finally {
    strict.stop();
  }
}, 60_000);
