import { describe, expect, test } from "bun:test";

import { autoApprovalResponse } from "./approval";

describe("autoApprovalResponse", () => {
  test("accepts every explicit MCP approval question", () => {
    expect(autoApprovalResponse("item/tool/requestUserInput", {
      questions: [
        { id: "q1", options: [{ label: "Decline" }, { label: "Accept" }] },
        { id: "q2", options: [{ label: "Approve" }] },
      ],
    })).toEqual({
      answers: { q1: { answers: ["Accept"] }, q2: { answers: ["Approve"] } },
    });
  });

  test("does not answer non-approval user input", () => {
    expect(autoApprovalResponse("item/tool/requestUserInput", {
      questions: [{ id: "q1", options: [{ label: "Production" }, { label: "Staging" }] }],
    })).toBeNull();
  });

  test("uses the correct modern and legacy approval decisions", () => {
    expect(autoApprovalResponse("item/commandExecution/requestApproval", {})).toEqual({ decision: "accept" });
    expect(autoApprovalResponse("item/fileChange/requestApproval", {})).toEqual({ decision: "accept" });
    expect(autoApprovalResponse("execCommandApproval", {})).toEqual({ decision: "approved" });
    expect(autoApprovalResponse("applyPatchApproval", {})).toEqual({ decision: "approved" });
  });
});
