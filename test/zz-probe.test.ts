import { afterEach, expect, test } from "bun:test";
import { startMesh, type Mesh } from "./harness";

let mesh: Mesh | null = null;
afterEach(() => {
  mesh?.stop();
  mesh = null;
});

test("probe: GET /api/v1/agents status", async () => {
  mesh = await startMesh({ withHttp: false });
  const res = await fetch(`${mesh.hub.url}/api/v1/agents`);
  const text = await res.text();
  console.log("PROBE status:", res.status, "body:", text.slice(0, 200));
  expect(true).toBe(true);
}, 30_000);
