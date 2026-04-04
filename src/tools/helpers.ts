import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Typed wrapper for the 4-arg `server.tool(name, description, schema, handler)` overload.
 *
 * The MCP SDK v1.29 declares this overload in its .d.ts but TypeScript overload
 * resolution fails to pick it due to ZodRawShapeCompat / ToolAnnotations ambiguity.
 * The runtime method works fine — this helper just bypasses the type-level issue.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolWithDescription(server: McpServer): (name: string, description: string, schema: any, handler: any) => any {
  return server.tool.bind(server);
}
