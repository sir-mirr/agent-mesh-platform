import { test } from "bun:test";
import { startMesh, provision, connectRpc } from "./harness";

test("probe3", async () => {
  const mesh = await startMesh({ withHttp: false });
  try {
    await provision(mesh.hub, "svc-b", "service");
    await provision(mesh.hub, "svc-c", "service");
    await provision(mesh.hub, "ai-x", "ai-codex");   // key proposed -> pending

    const b = await connectRpc(mesh.hub);
    await b.call("mesh.connect", { identity: "svc-b" });
    await b.call("mesh.send", { to: "svc-c", content: "queued-one" });

    const c = await connectRpc(mesh.hub);
    await c.call("mesh.connect", { identity: "svc-c" });
    await Bun.sleep(300);
    console.log("REPLAY NOTIFICATIONS:", JSON.stringify(c.notifications()));

    // live push ts
    await b.call("mesh.send", { to: "svc-c", content: "live-one" });
    await Bun.sleep(200);
    console.log("ALL NOTIFICATIONS:", JSON.stringify(c.notifications()));

    // unsigned connect for a requires_key identity whose key is pending
    const x = await connectRpc(mesh.hub);
    const r = await x.call("mesh.connect", { identity: "ai-x" });
    console.log("UNSIGNED ai-x CONNECT:", JSON.stringify(r));

    b.close(); c.close(); x.close();
  } finally {
    mesh.stop();
  }
}, 30000);
