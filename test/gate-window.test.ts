/**
 * The window a gate run holds, and the release that must not go missing.
 *
 * The browser suite is exclusive on this machine, so a run is bracketed by two
 * broadcasts and the other agents wait on the first and resume on the second.
 * Both were sent by hand and one went missing: the start for the `5a0bfdc`
 * window arrived, the release never did, and the other side had to read `ps` to
 * find out whether the machine was free. **A window announced and never
 * released is worse than one never announced** — the other side is waiting on a
 * signal that is not coming.
 *
 * What is pinned here is that the release survives every path out, including
 * the ones where remembering to send it is hardest: a red run, and a run
 * somebody stopped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const GATE = resolve(import.meta.dir, "..", "scripts", "gate.ts");

interface Sent { from: string; to: string; body: string }

/** A mailer that records rather than delivers. */
function recorder() {
  const sent: Sent[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      sent.push((await req.json()) as Sent);
      return Response.json({ ok: true });
    },
  });
  return { sent, server, url: `http://127.0.0.1:${server.port}/api/mail` };
}

const servers: Array<{ stop: () => void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(); });

function runGate(url: string, label: string, command: string[]) {
  return Bun.spawn(["bun", GATE, label, "--", ...command], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      AGENT_MESH_MAILBOX_URL: url,
      AGENT_MESH_AGENT_ID: "gate-probe",
      AGENT_MESH_GATE_PEERS: "peer-one,peer-two",
    },
  });
}

/** A command that prints a bun-test-shaped summary and exits with `code`. */
const printing = (pass: number, fail: number, code = 0) => [
  "bun", "-e",
  `console.log("\\n ${pass} pass\\n ${fail} fail\\n"); process.exit(${code});`,
];

describe("bracketing a run", () => {
  test("announces the start and releases with what the run measured", async () => {
    const { sent, server, url } = recorder();
    servers.push(server);

    const proc = runGate(url, "test/ 전수", printing(936, 0));
    await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    const starts = sent.filter((m) => m.body.includes("측정 출발"));
    const ends = sent.filter((m) => m.body.includes("측정 종료"));
    expect(starts).toHaveLength(2);        // one per peer
    expect(ends).toHaveLength(2);
    expect(new Set(ends.map((m) => m.to))).toEqual(new Set(["peer-one", "peer-two"]));
    expect(ends[0]!.body).toContain("936 pass / 0 fail");
    expect(ends[0]!.body).toContain("창 해제");
    expect(starts[0]!.from).toBe("gate-probe");
  });

  /**
   * **The red path is the one that matters.** A release that only follows a
   * green run goes missing exactly when the other side most needs to know the
   * machine is free.
   */
  test("releases the window when the run fails", async () => {
    const { sent, server, url } = recorder();
    servers.push(server);

    const proc = runGate(url, "test/ 전수", printing(930, 6, 1));
    await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);

    const end = sent.find((m) => m.body.includes("측정 종료"));
    expect(end).toBeDefined();
    expect(end!.body).toContain("930 pass / 6 fail");
    expect(end!.body).toContain("exit 1");
  });

  /**
   * **Exiting zero is not a result.** A process can exit zero having run
   * nothing, and reporting that as success is the shape this repository keeps
   * finding behind its own checks. With no counts printed, the release says it
   * has no numbers rather than inventing one.
   */
  test("says it measured nothing rather than reading the exit code as a result", async () => {
    const { sent, server, url } = recorder();
    servers.push(server);

    const proc = runGate(url, "a run that says nothing", ["bun", "-e", "console.log('quiet')"]);
    await new Response(proc.stdout).text();
    await proc.exited;

    const end = sent.find((m) => m.body.includes("측정 종료"))!;
    expect(end.body).toContain("수치 없음");
    expect(end.body).not.toContain("pass /");
  });

  /** Somebody stops the run: the machine is free now, and nothing else says so. */
  test("releases the window when the run is stopped", async () => {
    const { sent, server, url } = recorder();
    servers.push(server);

    const proc = runGate(url, "a long run", ["bun", "-e", "setTimeout(() => {}, 60_000)"]);
    // Wait for the start to land, so the kill lands on a gate that is running.
    const deadline = Date.now() + 8000;
    while (sent.length < 2 && Date.now() < deadline) await Bun.sleep(50);
    expect(sent.filter((m) => m.body.includes("측정 출발"))).toHaveLength(2);

    proc.kill("SIGTERM");
    const stopped = Date.now() + 8000;
    while (!sent.some((m) => m.body.includes("측정 종료")) && Date.now() < stopped) {
      await Bun.sleep(50);
    }
    const end = sent.find((m) => m.body.includes("측정 종료"));
    expect(end, "the window was never released").toBeDefined();
    expect(end!.body).toContain("중단");
  }, 20_000);

  /** The run's own output still reaches the terminal — the gate tees, it does not swallow. */
  test("passes the run's output through", async () => {
    const { server, url } = recorder();
    servers.push(server);
    const proc = runGate(url, "noisy", ["bun", "-e", "console.log('a line the operator needs')"]);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("a line the operator needs");
  });

  /**
   * A mailer that is down must not take the gate with it: the run is the point
   * and the broadcast is the courtesy.
   */
  test("runs anyway when nobody is listening", async () => {
    const proc = runGate("http://127.0.0.1:1/api/mail", "no mailer", printing(1, 0));
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("1 pass");
  }, 20_000);
});
