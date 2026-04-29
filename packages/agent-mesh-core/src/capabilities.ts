import type { ChannelSource } from "./envelope";
import type { ChannelActionName } from "./tool-contract";

export type CapabilitySupport = "native" | "mapped" | "planned" | "unsupported";

export interface CapabilityDescriptor {
  support: CapabilitySupport;
  notes?: string;
}

export type CapabilityMatrix = Record<
  ChannelSource,
  Record<ChannelActionName, CapabilityDescriptor>
>;

export const DEFAULT_CAPABILITY_MATRIX: CapabilityMatrix = {
  "agent-mesh": {
    reply: { support: "native", notes: "Hub-native agent-to-agent delivery." },
    react: { support: "unsupported", notes: "No reaction concept in plain mesh traffic." },
    edit_message: { support: "unsupported", notes: "Mesh messages are append-only." },
    download_attachment: {
      support: "unsupported",
      notes: "Mesh traffic may reference files, but not source-managed attachments.",
    },
    fetch_messages: {
      support: "native",
      notes: "Normalized history can be served from the core-owned store.",
    },
  },
  discord: {
    reply: { support: "native", notes: "Driver maps directly to Discord send APIs." },
    react: { support: "native", notes: "Driver maps to Discord reactions." },
    edit_message: { support: "native", notes: "Driver edits bot-authored Discord messages." },
    download_attachment: {
      support: "native",
      notes: "Driver can download Discord-hosted attachments to local storage.",
    },
    fetch_messages: {
      support: "mapped",
      notes: "Prefer normalized history, fallback to live Discord history fetch.",
    },
  },
  telegram: {
    reply: { support: "planned", notes: "Reserved for a future Telegram driver." },
    react: { support: "planned", notes: "Reaction support depends on driver scope." },
    edit_message: { support: "planned", notes: "Telegram edit rules differ from Discord." },
    download_attachment: { support: "planned", notes: "Attachment policy to be defined." },
    fetch_messages: { support: "planned", notes: "History strategy remains open." },
  },
};

export function getCapabilityDescriptor(
  source: ChannelSource,
  action: ChannelActionName,
): CapabilityDescriptor {
  return DEFAULT_CAPABILITY_MATRIX[source][action];
}

export function isActionSupported(source: ChannelSource, action: ChannelActionName): boolean {
  return DEFAULT_CAPABILITY_MATRIX[source][action].support !== "unsupported";
}
