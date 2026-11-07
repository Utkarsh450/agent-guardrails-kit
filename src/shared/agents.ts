export const AGENT_IDS = [
  "claude",
  "cursor",
  "codex",
  "antigravity",
  "qoder",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  antigravity: "Antigravity",
  qoder: "Qoder",
};

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}
