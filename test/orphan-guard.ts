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
