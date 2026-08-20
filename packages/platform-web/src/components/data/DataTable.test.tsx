/**
 * The four states a table can be in, and the three that are not "no rows".
 *
 * *Loading*, *refused or unreachable*, *empty*, and *rows* are four different
 * statements, and this console has drawn the wrong one before: a queue whose
 * failure branch kept `[]` instead of `null` told every operator **nobody is
 * waiting** about a backend that had never answered. This component is where
 * three of those four sentences are chosen, so this is where the choice is
 * asserted.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, cleanup } = await import("@testing-library/react");
const { DataTable } = await import("./DataTable.tsx");

afterEach(cleanup);

type Row = { identity: string; type: string };
const COLUMNS = [
  { key: "identity", header: "Identity" },
  { key: "type", header: "Type", render: (r: Row) => <em>{r.type}</em> },
];
const table = (props: Record<string, unknown>) =>
  render(
    <DataTable<Row>
      columns={COLUMNS}
      keyExtractor={(r) => r.identity}
      data={[]}
      {...props}
    />,
  ).container;

describe("DataTable", () => {
  it("draws the rows it is given, through the column renderers", () => {
    const c = table({ data: [{ identity: "a-1", type: "worker" }] });
    expect(c.textContent).toContain("a-1");
    expect(c.querySelector("em")?.textContent).toBe("worker");
  });

  it("always draws the headers, so an empty table still says what it is about", () => {
    const c = table({ data: [] });
    expect(c.textContent).toContain("Identity");
    expect(c.textContent).toContain("Type");
  });

  it("says it is loading rather than empty", () => {
    const c = table({ isLoading: true });
    expect(c.textContent).toMatch(/불러오는 중|loading/i);
  });

  it("says the read failed rather than that there is nothing", () => {
    // The distinction the queue defect crossed: an error is a statement about
    // the backend, and `nothing to show` is a statement about the mesh.
    const c = table({ isError: true, errorMessage: "the server refused" });
    expect(c.textContent).toContain("the server refused");
  });

  it("prefers loading over error when both are set", () => {
    const c = table({ isLoading: true, isError: true, errorMessage: "boom" });
    expect(c.textContent).not.toContain("boom");
  });

  it("uses the caller's empty sentence, and has one of its own", () => {
    expect(table({ data: [], emptyMessage: "no agents in this group" }).textContent)
      .toContain("no agents in this group");
    cleanup();
    expect(table({ data: [] }).textContent).toBeTruthy();
  });
});
