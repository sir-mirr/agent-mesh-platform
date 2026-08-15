import { test } from "bun:test";
import { startMesh } from "./harness";

test("probe4", async () => {
  const mesh = await startMesh();
  try {
    const a = await fetch(`${mesh.http.url}/api/v1/agents`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "x", type: "service" }),
    });
    console.log("http POST /api/v1/agents ->", a.status, await a.text());
    const b = await fetch(`${mesh.hub.url}/api/v1/attachments/abc`);
    console.log("hub GET /api/v1/attachments/abc ->", b.status);
  } finally { mesh.stop(); }
}, 40000);
