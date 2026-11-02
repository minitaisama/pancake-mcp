#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { executePancakeMcpTool, PANCAKE_MCP_TOOLS } from "./tools.js";

export * from "./config.js";
export * from "./pancake-client.js";
export * from "./ops-client.js";
export * from "./tools.js";

export const PANCAKE_MCP_SERVER_INSTRUCTIONS = [
  "Pancake MCP Server provides unified diagnostics, pipeline tracing, conversation message inspection, and multi-connector (Facebook & Zalo) operations for Pancake (pages.fm / pancake.vn).",
  "1. For any conversation or comment troubleshooting, start with `pancake_diagnose_incident` (returns 12-stage Auto Pilot + Outreach R0-R2/Z1 + Order Push stages AND full conversation messages, Chatbot 2.0 decisions, and audit logs in 1 call).",
  "2. Use `pancake_inspect_messages` or `pancake_get_raw_conversation` when you need raw Pancake attachments (payment bill images, Zalo QR codes, POS order confirmation cards) or when a conversation is not yet ingested in the DB.",
  "3. Treat `delivery_unknown` strictly as GET-only verification — NEVER blindly retry or resend an ambiguous delivery.",
  "4. Mutation tools (`pancake_send_test_message`, `pancake_replay_comment_lead`, `pancake_tags` with action='add') require explicit confirmation flags (`confirmSend`, `confirmReplay`, `confirmMutation`).",
].join("\n");

export function createPancakeMcpServer(): Server {
  const server = new Server(
    {
      name: "pancake-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: PANCAKE_MCP_SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: PANCAKE_MCP_TOOLS,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const startedAt = performance.now();
    try {
      const result = await executePancakeMcpTool(
        name,
        (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
      );
      process.stderr.write(
        `${JSON.stringify({
          event: "pancake_mcp_tool_call",
          tool: name,
          ok: true,
          elapsedMs: Math.round(performance.now() - startedAt),
        })}\n`,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${JSON.stringify({
          event: "pancake_mcp_tool_call",
          tool: name,
          ok: false,
          elapsedMs: Math.round(performance.now() - startedAt),
          error: message.slice(0, 200),
        })}\n`,
      );
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message }, null, 2),
          },
        ],
      };
    }
  });

  return server;
}

export async function startPancakeMcpStdioServer(): Promise<void> {
  const server = createPancakeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Pancake MCP server running over stdio\n");
}

// Run stdio server when executed directly as main entrypoint
const isDirectMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/dist/index.js") ||
    process.argv[1].endsWith("\\dist\\index.js") ||
    process.argv[1].endsWith("/src/index.ts"));

if (isDirectMain) {
  startPancakeMcpStdioServer().catch((err) => {
    process.stderr.write(`Fatal MCP server error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
