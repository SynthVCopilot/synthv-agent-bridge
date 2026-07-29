/**
 * Internal MCP actions executed by the Node process instead of the SynthV Lua
 * bridge. They still appear through the compact v2 action catalog, but must
 * never be sent over the file-IPC protocol.
 */
export const LOCAL_ACTIONS = [
  "inspect_score_file",
  "import_monophonic_score",
] as const;

export type LocalAction = (typeof LOCAL_ACTIONS)[number];
