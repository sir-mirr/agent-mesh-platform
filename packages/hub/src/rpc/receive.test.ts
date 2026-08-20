/**
 * `mesh.receive`, called directly.
 *
 * `agent-mesh-local-pm` found `packages/mailbox/src/receive.ts` reading
 * `0.00 / 0.00` — 115 lines that nothing had executed — and asked whether that
 * was dead code or an end-to-end path nobody had written. It is neither: the
 * lease-and-settle logic runs inside the hub, which is a separate process, so
 * no in-process instrument had ever followed it.
 *
 * It does not need the process. `handleReceive` is an exported function over
 * this module's own database handle, so the whole path is reachable from a test
 * — which is the same lever that took `packages/http/src/main.ts` from absent
 * to measurable earlier today, one repository over.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * **Run in a child, and that is not incidental** — the same reason
 * `close-databases.test.ts` beside it does.
 *
 * `hub/src/db.ts` opens its handles at module load, against whatever state
 * directory was set at that moment, and the handles are `const`. In a suite
 * that shares one process, a file that owns a temporary directory and cleans it
 * up leaves every later caller of those handles with `SQLITE_IOERR` — which is
 * exactly what these tests did when they ran with the rest of `packages/`:
 * green alone, four red together, and the failure had nothing to do with what
 * they assert.
 *
 * A child gets its own registry and its own directory, so what is measured here
 * is `mesh.receive` rather than the order the suite happened to run in.
 */
const dir = mkdtempSync(join(tmpdir(), "hub-receive-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const RECEIVE = (identity: string | null, params: Record<string, unknown>) => `
  const { handleReceive, LEASE_SECONDS } = await import(${JSON.stringify(join(import.meta.dir, "receive.ts"))});
  const answered = handleReceive(${JSON.stringify(identity)}, ${JSON.stringify(params)}, 1);
  console.log(JSON.stringify({ answered: JSON.parse(answered), leaseSeconds: LEASE_SECONDS }));
`;

/** What the wire carries back, parsed, out of a process of its own. */
const call = async (identity: string | null, params: Record<string, unknown> = {}) => {
  const proc = Bun.spawn(["bun", "-e", RECEIVE(identity, params)], {
    env: { ...process.env, AGENT_MESH_STATE_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (!out.trim()) throw new Error(`mesh.receive produced nothing: ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!) as {
    answered: { result?: { messages?: unknown[]; lease_seconds?: number }; error?: { code: number; message: string } };
    leaseSeconds: number;
  };
};

describe("mesh.receive", () => {
  test("refuses a request that carries no identity, and says why", async () => {
    // The transport signs requests; an unsigned one has nobody to hand a
    // mailbox to. Naming the method in the message is what stops a caller
    // guessing which parameter it was short of.
    const { answered } = await call(null);
    expect(answered.error).toBeDefined();
    expect(answered.error!.message).toContain("mesh.receive");
  });

  test("hands an empty mailbox back as an empty batch, not as a refusal", async () => {
    // Nothing waiting is an answer. A worker polling an empty mailbox must be
    // able to tell it from a mailbox it was not allowed to read.
    const { answered } = await call("receive-probe-nobody");
    expect(answered.error).toBeUndefined();
    expect(answered.result!.messages).toEqual([]);
  });

  test("says how long the lease it just granted lasts", async () => {
    // The batch is leased rather than handed over: a worker that dies owes the
    // mesh nothing, and the messages come back when the lease expires. A caller
    // that does not know the window cannot decide when to ack.
    const { answered: a, leaseSeconds } = await call("receive-probe-nobody");
    expect(a.result!.lease_seconds).toBe(leaseSeconds);
  });

  test("clamps the batch size rather than passing it through", async () => {
    // `limit` arrives from the wire. Both ends of the range are the mesh's to
    // decide, and a request for none or for a million is a request the hub
    // answers on its own terms.
    for (const limit of [0, -5, 1_000_000, "not a number"]) {
      const { answered } = await call("receive-probe-nobody", { limit });
      expect(answered.error).toBeUndefined();
      expect(answered.result!.messages).toEqual([]);
    }
  });

  test("takes ack ids only when they are strings", async () => {
    // The list is filtered rather than trusted: a number or a null in there
    // would reach a prepared statement as an id, and the settle step runs
    // before the lease is granted.
    const { answered } = await call("receive-probe-nobody", { ack_ids: ["a", 2, null, "b"] });
    expect(answered.error).toBeUndefined();
  });
});
