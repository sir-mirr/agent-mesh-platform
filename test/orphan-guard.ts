/**
 * Kill a service this harness started when the run that started it is gone.
 *
 * **Three processes from a suite that died two days earlier.** A hub, an http
 * server and a vite dev server were found at `PPID 1`, still holding the
 * `agent-mesh-it-*` state directory of a `test/` run nobody remembered — two
 * days of unaccounted load on a machine whose measurements are supposed to be
 * exclusive, and a directory `removeStateDirWhenGone` was waiting on exits that
 * were never coming.
 *
 * `Mesh.stop()` takes the children down, and every suite calls it. That is the
 * orderly exit, and it is not the one that leaks: a `bun test` killed by a
 * timeout, an OOM, a `SIGKILL` from a gate that gave up, or the harness itself
 * throwing before `stop()` is reachable never runs any handler at all, so a
 * handler is the wrong place to put this. The child has to notice on its own.
 *
 * Preloaded rather than imported: these are real service entrypoints, spawned
 * exactly as a deployment runs them, and a test-only supervisor does not belong
 * inside product code. `--preload` runs this module in the child before the
 * entrypoint, and the entrypoint stays unaware.
 *
 * Reparenting is the signal, not a liveness probe. When the parent dies the
 * kernel sets `ppid` to 1 (or to a reaper on some systems), which is unambiguous
 * and immediate; `kill(pid, 0)` would answer the same question a beat later and
 * would be wrong the moment the pid is reused.
 *
 * The timer is `unref`ed so a service that means to exit still exits — this
 * decides when a process must not survive, never when it must keep running.
 */
const startedBy = Number(process.env.AGENT_MESH_TEST_PARENT_PID ?? "0");

if (Number.isInteger(startedBy) && startedBy > 0) {
  const timer = setInterval(() => {
    if (process.ppid === startedBy) return;
    console.error(
      `[orphan-guard] the run that started this (pid ${startedBy}) is gone; exiting rather than outliving it`,
    );
    process.exit(70);
  }, 500);
  timer.unref?.();
}

/**
 * **Say so when the stop came from outside.**
 *
 * A service that is signalled runs its own shutdown and logs `shutdown
 * complete (outcome: clean)` — the same two lines it writes when a suite ends
 * politely. So a run whose services were taken down under it looks, in the
 * log, exactly like a run that finished: every scenario after the kill fails
 * to connect, and the reader has thirty reds and no way to tell them from a
 * finding.
 *
 * That cost a morning. `bun` reaps subprocesses it considers dangling and
 * prints one line about it — `killed N dangling processes` — and a mutation
 * run that met it came back with the browser suite in pieces and an anchor
 * recorded as *not caught* when nothing had been measured at all.
 *
 * The witness is a log line, not a policy: it does not decide anything and it
 * does not stop the shutdown. It puts the signal, the time, and whether the
 * run that started this service is still alive next to the clean exit, so the
 * next reader can tell "somebody stopped me" from "I finished".
 *
 * **It must not make the signal a no-op.** A listener replaces the default
 * disposition, so on a process with no shutdown handler of its own this would
 * turn `SIGTERM` into nothing and leave exactly the immortal service the rest
 * of this file exists to prevent. When ours is the only listener, it exits.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    const starter =
      startedBy > 0
        ? `the run that started this (pid ${startedBy}) is ${process.ppid === startedBy ? "still running" : "already gone"}`
        : "no run identified itself as the starter";
    console.error(
      `[orphan-guard] ${signal} arrived from outside at ${new Date().toISOString()} — ${starter}. Whatever this process logs next is a shutdown it was told to do, not one it chose.`,
    );
    // Ours is the only listener: nothing else will act on this signal, and a
    // signal nothing acts on is a signal ignored.
    if (process.listenerCount(signal) === 1) process.exit(signal === "SIGTERM" ? 143 : 130);
  });
}
