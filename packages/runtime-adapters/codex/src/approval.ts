/**
 * Response payloads for app-server approval requests.
 *
 * MCP app-tool approvals use item/tool/requestUserInput.  That request type
 * can also represent ordinary user input, so it is deliberately approved only
 * when every question presents an explicit Accept/Approve option.
 */
export function autoApprovalResponse(method: string, params: unknown): Record<string, unknown> | null {
  switch (method) {
    case "item/tool/requestUserInput":
      return acceptToolRequestUserInput(params);
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "accept" };
    case "execCommandApproval":
    case "applyPatchApproval":
      // Legacy app-server protocol uses the older ReviewDecision vocabulary.
      return { decision: "approved" };
    default:
      return null;
  }
}

function acceptToolRequestUserInput(params: unknown): Record<string, unknown> | null {
  const questions = (params as { questions?: unknown })?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const answers: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const item = question as { id?: unknown; options?: unknown };
    if (typeof item.id !== "string" || !Array.isArray(item.options)) return null;
    const accept = item.options.find((option) => {
      const label = (option as { label?: unknown })?.label;
      return typeof label === "string" && /^(accept|approve)$/i.test(label.trim());
    }) as { label?: string } | undefined;
    if (!accept?.label) return null;
    answers[item.id] = { answers: [accept.label] };
  }
  return { answers };
}
