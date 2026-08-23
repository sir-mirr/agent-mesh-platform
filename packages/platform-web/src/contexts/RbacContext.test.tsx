/**
 * What this session may do, and the question this context must never answer.
 *
 * Every gate on the admin console — `GuardedRoute`, and every item in the
 * sidebar — comes here and asks for a name. So the interesting assertions are
 * not that `includes` works; they are about the answers this module refuses to
 * give. It must not widen a list because of who the person is, it must not read
 * a missing list as a full one, and it must not hand anybody a role to compare,
 * because the moment a role is reachable from here some later screen will gate
 * on it and § 11's whole point is undone one shortcut at a time.
 *
 * The direction of the old defect is why both ends are pinned below. When these
 * sites read `caps.length > 0 ? server : ROLE_CAPABILITIES[role]`, "the server
 * says you hold nothing" fell through to a role table that, for an
 * administrator, meant every capability there is: holding one name locked four
 * screens and holding none opened them. It inverted exactly at zero, which is
 * why a test that only narrows a non-empty list would never have found it.
 *
 * `useAuth` is replaced rather than driven, and the replacement spreads the real
 * module and is put back afterwards — `mock.module` is global to the process,
 * so an export list shorter than the real one breaks whichever file runs next.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { registerDom } from "../register-dom";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a paired `unregister()` takes `document`
// away from a file that is still using it.
registerDom();

const { render, cleanup, act } = await import("@testing-library/react");
const { AuthProvider } = await import("@/contexts/AuthContext.tsx");
const { RbacProvider, useRbac } = await import("./RbacContext.tsx");
const { ALL_CAPABILITIES } = await import("@/types/auth.ts");

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
  // `AuthProvider` seeds itself from here; a session left behind signs in the
  // next test, in this file and in every file after it.
  localStorage.clear();
});

type Rbac = ReturnType<typeof useRbac>;

let seen: Rbac | null = null;
function Probe() {
  seen = useRbac();
  return null;
}

/**
 * Mount the provider over a session the *server* described, and hand back what
 * it exposes.
 *
 * **`useAuth` is not replaced.** A `mock.module` is installed on the process at
 * file top level, before bun runs any test anywhere, so a shim here reached
 * every other file that reads a session — `ChangePasswordPage` lost
 * `refreshSession`, and the count ran to 435 failures that appeared only when
 * the files ran together. The session comes from a stubbed `/auth/me` instead,
 * which is also the only place the real one ever comes from.
 */
const forUser = async (user: { name?: string; role?: string; capabilities?: unknown } | null): Promise<Rbac> => {
  globalThis.fetch = (async () => {
    if (user === null) {
      return new Response(JSON.stringify({ error: "not signed in" }),
        { status: 401, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      ok: true, github_id: 1, github_login: user.name ?? "operator",
      role: user.role === "PLATFORM_ADMIN" ? "admin" : "member",
      approved: true, created_at: "", must_change_password: false,
      capabilities: user.capabilities,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  seen = null;
  await act(async () => {
    render(
      <AuthProvider>
        <RbacProvider>
          <Probe />
        </RbacProvider>
      </AuthProvider>,
    );
  });
  return seen!;
};

describe("hasCapability", () => {
  it("answers from the list the server sent, name by name", async () => {
    const rbac = await forUser({
      name: "operator", role: "AGENT_OPERATOR",
      capabilities: ["key.approve", "group.manage"],
    });
    expect(rbac.hasCapability("key.approve")).toBe(true);
    expect(rbac.hasCapability("group.manage")).toBe(true);
    expect(rbac.hasCapability("role.grant")).toBe(false);
  });

  it("does not let one name imply the one next to it", async () => {
    // `audit.read.metadata` and `audit.read.content` are the two sides of the
    // privacy boundary in SPEC 11 — who sent what, against what they wrote. An
    // implication table here would cross that line with nothing said, and it is
    // exactly the kind of table this layer used to keep.
    const rbac = await forUser({
      name: "auditor", role: "TENANT_ADMIN",
      capabilities: ["audit.read.metadata"],
    });
    expect(rbac.hasCapability("audit.read.metadata")).toBe(true);
    expect(rbac.hasCapability("audit.read.content")).toBe(false);
  });

  it("gives a platform administrator holding no names nothing at all", async () => {
    // The end point the old fallback inverted at. An empty array is the
    // server's answer and not the absence of one, so every one of the thirteen
    // is refused however senior the title beside it reads.
    const rbac = await forUser({ name: "admin", role: "PLATFORM_ADMIN", capabilities: [] });
    for (const cap of ALL_CAPABILITIES) {
      expect(rbac.hasCapability(cap)).toBe(false);
    }
    expect(rbac.capabilities).toEqual([]);
  });

  it("does not widen a short list because the role beside it is senior", async () => {
    // The other end: the role table did not only fire at zero in principle, and
    // a session holding one name must still hold exactly one.
    const rbac = await forUser({
      name: "admin", role: "PLATFORM_ADMIN",
      capabilities: ["tenant.read.stats"],
    });
    expect(rbac.capabilities).toEqual(["tenant.read.stats"]);
    expect(rbac.hasCapability("tenant.read.stats")).toBe(true);
    expect(rbac.hasCapability("role.grant")).toBe(false);
    expect(rbac.hasCapability("user.admit")).toBe(false);
  });

  it("holds nothing for a session that has no user, and still exposes a list", async () => {
    // Two separate statements. Nobody signed in holds nothing — and the list is
    // an array rather than `undefined`, because the sidebar maps over it and
    // the difference between an empty menu and a crashed shell is this line.
    const rbac = await forUser(null);
    expect(rbac.hasCapability("key.approve")).toBe(false);
    expect(Array.isArray(rbac.capabilities)).toBe(true);
    expect(rbac.capabilities).toEqual([]);
  });

  it("reads a session with no capabilities field as holding nothing", async () => {
    // A deployment running an older build answers `/auth/me` without the field
    // at all. The answer to "the server did not say" is nothing rather than
    // everything: a console that offers too little is a complaint, and one that
    // offers what nobody granted is the defect this whole layer was rewritten
    // for. The API refuses either way; what is decided here is what is offered.
    const rbac = await forUser({ name: "stale", role: "PLATFORM_ADMIN" });
    expect(rbac.capabilities).toEqual([]);
    expect(rbac.hasCapability("group.manage")).toBe(false);
  });
});

describe("RbacContext", () => {
  it("exposes no role for a later screen to gate on", async () => {
    // `role` used to sit in this value and nothing read it. Its absence is the
    // assertion: authorisation on the screen layer is capability-only, and a
    // role reachable from the RBAC context reads as part of that decision to
    // whoever writes the next guard.
    const rbac = await forUser({ name: "admin", role: "PLATFORM_ADMIN", capabilities: [] });
    expect(Object.keys(rbac).sort()).toEqual(["capabilities", "hasCapability"]);
    expect("role" in rbac).toBe(false);
  });

  it("refuses outside its provider instead of answering no to everything", async () => {
    // A context defaulting to an empty capability list would be indistinguishable
    // from a session that genuinely holds nothing: every gated screen would
    // bounce and every menu item would vanish, with nothing in a log to say a
    // provider was missing. Throwing is the only version of that a person sees.
    expect(() => render(<Probe />)).toThrow(/RbacProvider/);
  });
});
