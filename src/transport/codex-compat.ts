import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface SdkRegisteredTool {
  execution?: unknown;
}

interface SdkMcpServerInternals {
  _registeredTools?: Record<string, SdkRegisteredTool>;
}

function hasOnlyDefaultForbiddenExecution(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const entries = Object.entries(value);
  return entries.length === 1 && entries[0]?.[0] === 'taskSupport' && entries[0][1] === 'forbidden';
}

/**
 * SDK 1.29 emits `execution: { taskSupport: "forbidden" }` for every normal
 * tool. MCP defines the same value as the default when the field is absent, but
 * Codex CLI 0.136.0 currently fails to expose tools from servers that include
 * this new task-execution metadata. Omit only the default value; preserve any
 * future required/optional task support.
 */
export function omitDefaultForbiddenToolExecution(server: McpServer): void {
  const tools = (server as unknown as SdkMcpServerInternals)._registeredTools;
  if (!tools) {
    return;
  }

  for (const tool of Object.values(tools)) {
    if (hasOnlyDefaultForbiddenExecution(tool.execution)) {
      delete tool.execution;
    }
  }
}
