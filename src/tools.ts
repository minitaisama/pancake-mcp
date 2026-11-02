import { z } from "zod";
import { parseTargetReference, resolveConfig, type PancakeMcpConfig } from "./config.js";
import { OpsDiagnosticsClient } from "./ops-client.js";
import { PancakeProviderClient, type ConnectorKey } from "./pancake-client.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

const TARGET_PROPERTIES = {
  target: {
    type: "string",
    description:
      "Any target reference: Pancake URL (https://pancake.vn/...?c_id=...), Pancake conversation ID (PAGEID_PSID, POSTID_COMMENTID, pzl_u_...), local UUID, message ID (m_...), or Admin Order ID",
  },
  pancakeUrl: {
    type: "string",
    description: "Pancake conversation URL (https://pancake.vn/...?c_id=...)",
  },
  pancakeConversationId: {
    type: "string",
    description: "Exact Pancake conversation ID (e.g. 1131614906706493_27102859622703796)",
  },
  conversationId: {
    type: "string",
    description: "Local database conversation UUID",
  },
  messageId: {
    type: "string",
    description: "Exact Pancake message/comment ID",
  },
  deliveryId: {
    type: "string",
    description: "Outbound delivery UUID",
  },
  orderId: {
    type: "string",
    description: "VietLicense Admin Order ID or local order push UUID",
  },
};

export const PANCAKE_MCP_TOOLS: ToolDefinition[] = [
  {
    name: "pancake_status",
    description:
      "Check Pancake MCP credential readiness (Ops API token, Facebook Page token, Zalo token) and live runtime/database health of the chat server.",
    inputSchema: {
      type: "object",
      properties: {
        expectedRevision: {
          type: "string",
          description: "Optional Git SHA or source fingerprint to verify against live runtime",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "pancake_diagnose_incident",
    description:
      "One-call unified troubleshooting for any Pancake conversation/comment/order. Returns the v2 pipeline stage diagnosis (firstBrokenStage across Auto Pilot, Outreach R0-R2/Z1, Create Order) PLUS full conversation messages, Chatbot 2.0 decisions (with reason_codes), and bot_audit_logs. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        providerRead: {
          type: "string",
          enum: ["auto", "never", "always"],
          description: "Pancake GET mode during incident evaluation (default: auto)",
        },
        windowMinutes: {
          type: "number",
          description: "Lookback window in minutes (default: 60, range: 5-1440)",
        },
        includeMessages: {
          type: "boolean",
          description: "Include conversation messages, audit logs, and Chatbot 2.0 decisions (default: true)",
        },
        includeProviderMessages: {
          type: "boolean",
          description: "Also fetch raw messages/attachments directly from Pancake API (default: auto when local DB has no messages)",
        },
        messageLimit: {
          type: "number",
          description: "Number of recent messages to return (default: 30, max: 150)",
        },
        redactIdentifiers: {
          type: "boolean",
          description: "Redact operational identifiers for external sharing (default: false)",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "pancake_inspect_messages",
    description:
      "Inspect conversation messages, Chatbot 2.0 decisions, bot_audit_logs, tags, latest order push, and/or raw Pancake provider messages & attachment URLs (payment bills, Zalo QR codes, POS order cards, phone numbers). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        source: {
          type: "string",
          enum: ["both", "db", "provider"],
          description: "Where to read messages from: 'db' (Admin/Ops DB), 'provider' (direct Pancake API), or 'both' (default: 'both')",
        },
        connectorKey: {
          type: "string",
          enum: ["facebook_vietlicense", "zalo_thanh"],
          description: "Optional explicit connector key when reading from provider",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default: 30, max: 150)",
        },
        includeRawProviderPayload: {
          type: "boolean",
          description: "Include raw Pancake message JSON objects for deep attachment/POS debugging (default: false)",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "pancake_trace",
    description:
      "Get the normalized Diagnostics v2 evidence graph and optional event timeline for a conversation, message, delivery, or order across scopes: conversation | interactive | order | outreach | all. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        scope: {
          type: "string",
          enum: ["conversation", "interactive", "order", "outreach", "all"],
          description: "Trace scope (default: all)",
        },
        includeTimeline: {
          type: "boolean",
          description: "Include chronological normalized event timeline (default: true)",
        },
        providerRead: {
          type: "string",
          enum: ["auto", "never", "always"],
          description: "Pancake GET mode (default: auto)",
        },
        windowMinutes: {
          type: "number",
          description: "Lookback window in minutes (default: 60)",
        },
        redactIdentifiers: {
          type: "boolean",
          description: "Redact operational identifiers (default: false)",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "pancake_operations",
    description:
      "Check system-wide operations & reliability status: ingest cursors, interactive/delivery queues, outreach step backlogs & SLA analytics (24h/7d/30d), discovery SLA, governor lane contention, bulk campaigns, and runtime settings. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["runtime", "queues", "outreach", "reliability", "bulk", "settings", "all"],
          description: "Operations v2 section to inspect (default: all)",
        },
        includeOverviewV1: {
          type: "boolean",
          description: "Also include v1 overview with stage latencies and governor lane wait telemetry (default: false)",
        },
        windowMinutes: {
          type: "number",
          description: "Aggregate window in minutes (default: 60, range: 5-43200)",
        },
        analyticsWindow: {
          type: "string",
          enum: ["24h", "7d", "30d"],
          description: "Outreach delivery analytics window (default: 24h)",
        },
        campaignId: {
          type: "string",
          description: "Optional bulk campaign UUID when section='bulk'",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "pancake_search_conversations",
    description:
      "Search or list conversations either in the local database (by query, tag, connectorKey) or directly from the Pancake v2 API (INBOX/COMMENT, unread_first, tags). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["db", "provider"],
          description: "Search in local 'db' (/api/admin/conversations) or direct 'provider' (Pancake v2 API). Default: 'db'",
        },
        q: {
          type: "string",
          description: "Search query (customer name, phone, or conversation ID) when source='db'",
        },
        tag: {
          type: "string",
          description: "Filter by conversation tag (e.g. 'Doanh nghiệp', 'QR Zalo', 'Cá nhân')",
        },
        connectorKey: {
          type: "string",
          enum: ["facebook_vietlicense", "zalo_thanh"],
          description: "Connector key (default: facebook_vietlicense)",
        },
        type: {
          type: "string",
          enum: ["INBOX", "COMMENT"],
          description: "Conversation surface when source='provider' (default: INBOX)",
        },
        unreadFirst: {
          type: "boolean",
          description: "Prioritize unread conversations when source='provider'",
        },
        lookbackDays: {
          type: "number",
          description: "Lookback window in days when source='provider' (default: 7)",
        },
        limit: {
          type: "number",
          description: "Maximum conversations to return (default: 20, max: 100)",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "pancake_get_raw_conversation",
    description:
      "Fetch a conversation's raw metadata and messages directly from the Pancake Public API (with automatic collection-scan fallback when Pancake's single-conversation v2 endpoint returns HTML). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Pancake URL or Pancake conversation ID (e.g. 1131614906706493_27102859622703796)",
        },
        connectorKey: {
          type: "string",
          enum: ["facebook_vietlicense", "zalo_thanh"],
          description: "Optional explicit connector key",
        },
        type: {
          type: "string",
          enum: ["INBOX", "COMMENT"],
          description: "Conversation type hint for collection fallback (default: INBOX)",
        },
        messageLimit: {
          type: "number",
          description: "Max messages to fetch (default: 30)",
        },
        includeRawMessages: {
          type: "boolean",
          description: "Include raw unfiltered Pancake message objects (default: false)",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "pancake_tags",
    description:
      "List all tags configured on the Pancake page, or add/toggle a tag on a specific conversation (requires confirmMutation=true).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add"],
          description: "'list' page tags (read-only) or 'add' a tag to a conversation (mutation)",
        },
        connectorKey: {
          type: "string",
          enum: ["facebook_vietlicense", "zalo_thanh"],
          description: "Connector key (default: facebook_vietlicense)",
        },
        target: {
          type: "string",
          description: "Pancake conversation URL or ID (required when action='add')",
        },
        tagNameOrId: {
          type: "string",
          description: "Tag display name (e.g. 'QR Zalo', 'Doanh nghiệp') or tag ID (required when action='add')",
        },
        confirmMutation: {
          type: "boolean",
          description: "Must be true when action='add'",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "pancake_replay_comment_lead",
    description:
      "Safely replay a missed purchase comment lead via POST /api/admin/conversations/:id/replay-comment-lead (sends public comment ack + private inbox opener and records audit log). Requires confirmReplay=true.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Pancake comment conversation URL, Pancake ID (POSTID_COMMENTID), or local UUID",
        },
        postId: {
          type: "string",
          description: "Optional explicit Facebook post ID (PAGEID_POSTID) override",
        },
        messageId: {
          type: "string",
          description: "Optional explicit comment message ID override",
        },
        fromId: {
          type: "string",
          description: "Optional explicit commenter PSID override",
        },
        confirmReplay: {
          type: "boolean",
          description: "Must be set to true to authorize sending the comment lead reply",
        },
      },
      required: ["target", "confirmReplay"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "pancake_send_test_message",
    description:
      "Send an authorized test message and/or image to a Pancake conversation (e.g. user test thread). Never use to blindly retry a delivery_unknown message. Requires confirmSend=true.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Pancake conversation URL or ID (e.g. 1131614906706493_27102859622703796)",
        },
        message: {
          type: "string",
          description: "Text message content to send",
        },
        imagePath: {
          type: "string",
          description: "Optional local file path to an image (.png/.jpg/.webp) to upload and send",
        },
        contentIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional pre-uploaded Pancake attachment content_ids",
        },
        connectorKey: {
          type: "string",
          enum: ["facebook_vietlicense", "zalo_thanh"],
          description: "Optional explicit connector key",
        },
        confirmSend: {
          type: "boolean",
          description: "Must be true to authorize sending a real message to Pancake",
        },
      },
      required: ["target", "confirmSend"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
];

export interface ToolExecutionDependencies {
  config?: PancakeMcpConfig;
  opsClient?: OpsDiagnosticsClient;
  providerClient?: PancakeProviderClient;
}

export async function executePancakeMcpTool(
  name: string,
  rawArgs: Record<string, unknown> = {},
  deps: ToolExecutionDependencies = {},
): Promise<unknown> {
  const cfg = deps.config ?? resolveConfig();
  const ops = deps.opsClient ?? new OpsDiagnosticsClient(cfg);
  const provider = deps.providerClient ?? new PancakeProviderClient(cfg);

  switch (name) {
    case "pancake_status": {
      const schema = z.object({ expectedRevision: z.string().optional() }).strict();
      const args = schema.parse(rawArgs);
      let runtimeHealth: Record<string, unknown> | null = null;
      let runtimeError: string | null = null;
      if (cfg.diagnosticsToken) {
        try {
          runtimeHealth = await ops.getHealth(args.expectedRevision);
        } catch (err) {
          runtimeError = err instanceof Error ? err.message : String(err);
        }
      }
      return {
        config: {
          opsUrl: cfg.opsUrl,
          hasDiagnosticsToken: Boolean(cfg.diagnosticsToken),
          pancakeApiUrl: cfg.pancakeApiUrl,
          facebook: {
            pageId: cfg.facebook.pageId || null,
            hasAccessToken: Boolean(cfg.facebook.accessToken),
          },
          zalo: {
            pageId: cfg.zalo.pageId || null,
            hasAccessToken: Boolean(cfg.zalo.accessToken),
          },
          sources: cfg.configSource,
        },
        runtimeHealth,
        runtimeError,
      };
    }

    case "pancake_diagnose_incident": {
      const schema = z
        .object({
          target: z.string().optional(),
          pancakeUrl: z.string().optional(),
          pancakeConversationId: z.string().optional(),
          conversationId: z.string().optional(),
          messageId: z.string().optional(),
          deliveryId: z.string().optional(),
          orderId: z.string().optional(),
          providerRead: z.enum(["auto", "never", "always"]).optional(),
          windowMinutes: z.number().int().min(5).max(1440).optional(),
          includeMessages: z.boolean().optional(),
          includeProviderMessages: z.boolean().optional(),
          messageLimit: z.number().int().min(1).max(150).optional(),
          redactIdentifiers: z.boolean().optional(),
        })
        .strict();
      const args = schema.parse(rawArgs);
      return ops.diagnoseUnified({
        ...args,
        providerClient: provider,
      });
    }

    case "pancake_inspect_messages": {
      const schema = z
        .object({
          target: z.string().optional(),
          pancakeUrl: z.string().optional(),
          pancakeConversationId: z.string().optional(),
          conversationId: z.string().optional(),
          messageId: z.string().optional(),
          deliveryId: z.string().optional(),
          orderId: z.string().optional(),
          source: z.enum(["both", "db", "provider"]).optional().default("both"),
          connectorKey: z.enum(["facebook_vietlicense", "zalo_thanh"]).optional(),
          limit: z.number().int().min(1).max(150).optional().default(30),
          includeRawProviderPayload: z.boolean().optional().default(false),
        })
        .strict();
      const args = schema.parse(rawArgs);
      const rawRef =
        args.target ||
        args.pancakeUrl ||
        args.pancakeConversationId ||
        args.conversationId ||
        args.messageId ||
        args.orderId ||
        "";
      if (!rawRef) {
        throw new Error("Provide at least one target identifier");
      }
      const parsed = parseTargetReference(rawRef, cfg.facebook.pageId);

      let localId = args.conversationId || parsed.conversationId || null;
      let pancakeConvId = args.pancakeConversationId || parsed.pancakeConversationId || null;

      if (args.source !== "provider" && !localId && cfg.diagnosticsToken) {
        try {
          const traceEnv = await ops.traceV2({
            target: rawRef,
            scope: "conversation",
            providerRead: "never",
          });
          const subject = (traceEnv.subject && typeof traceEnv.subject === "object"
            ? traceEnv.subject
            : {}) as Record<string, unknown>;
          if (typeof subject.localConversationId === "string") {
            localId = subject.localConversationId;
          }
          if (typeof subject.pancakeConversationId === "string") {
            pancakeConvId = subject.pancakeConversationId;
          }
        } catch {
          // Proceed with provider fallback if local conversation not found
        }
      }

      const dbInspection =
        args.source !== "provider" && localId
          ? await ops.inspectConversation(localId, { messageLimit: args.limit })
          : null;

      if (!pancakeConvId && dbInspection?.pancakeConversationId) {
        pancakeConvId = dbInspection.pancakeConversationId;
      }

      let providerInspection = null;
      let providerError: string | null = null;
      if (args.source !== "db" && pancakeConvId) {
        try {
          providerInspection = await provider.getMessages(pancakeConvId, {
            connectorKey: args.connectorKey,
            limit: args.limit,
            includeRaw: args.includeRawProviderPayload,
          });
        } catch (err) {
          providerError = err instanceof Error ? err.message : String(err);
        }
      }

      return {
        parsedTarget: parsed,
        localConversationId: localId,
        pancakeConversationId: pancakeConvId,
        dbInspection,
        providerInspection,
        ...(providerError ? { providerError } : {}),
      };
    }

    case "pancake_trace": {
      const schema = z
        .object({
          target: z.string().optional(),
          pancakeUrl: z.string().optional(),
          pancakeConversationId: z.string().optional(),
          conversationId: z.string().optional(),
          messageId: z.string().optional(),
          deliveryId: z.string().optional(),
          orderId: z.string().optional(),
          scope: z.enum(["conversation", "interactive", "order", "outreach", "all"]).optional(),
          includeTimeline: z.boolean().optional().default(true),
          providerRead: z.enum(["auto", "never", "always"]).optional(),
          windowMinutes: z.number().int().min(5).max(1440).optional(),
          redactIdentifiers: z.boolean().optional(),
        })
        .strict();
      const args = schema.parse(rawArgs);
      return ops.traceV2(args);
    }

    case "pancake_operations": {
      const schema = z
        .object({
          section: z
            .enum(["runtime", "queues", "outreach", "reliability", "bulk", "settings", "all"])
            .optional()
            .default("all"),
          includeOverviewV1: z.boolean().optional().default(false),
          windowMinutes: z.number().int().min(5).max(43_200).optional(),
          analyticsWindow: z.enum(["24h", "7d", "30d"]).optional(),
          campaignId: z.string().optional(),
        })
        .strict();
      const args = schema.parse(rawArgs);
      const [operationsV2, overviewV1] = await Promise.all([
        ops.getOperationsV2({
          section: args.section,
          windowMinutes: args.windowMinutes,
          analyticsWindow: args.analyticsWindow,
          campaignId: args.campaignId,
        }),
        args.includeOverviewV1
          ? ops.getOverview(Math.min(args.windowMinutes ?? 30, 1440))
          : Promise.resolve(null),
      ]);
      return {
        operations: operationsV2,
        ...(overviewV1 ? { overview: overviewV1 } : {}),
      };
    }

    case "pancake_search_conversations": {
      const schema = z
        .object({
          source: z.enum(["db", "provider"]).optional().default("db"),
          q: z.string().optional(),
          tag: z.string().optional(),
          connectorKey: z.enum(["facebook_vietlicense", "zalo_thanh"]).optional(),
          type: z.enum(["INBOX", "COMMENT"]).optional(),
          unreadFirst: z.boolean().optional(),
          lookbackDays: z.number().int().min(1).max(90).optional().default(7),
          limit: z.number().int().min(1).max(100).optional().default(20),
        })
        .strict();
      const args = schema.parse(rawArgs);
      if (args.source === "provider") {
        const until = Math.floor(Date.now() / 1000);
        const since = until - args.lookbackDays * 24 * 3600;
        return provider.listConversations({
          connectorKey: args.connectorKey,
          type: args.type,
          unreadFirst: args.unreadFirst,
          since,
          until,
          tags: args.tag ? [args.tag] : undefined,
          limit: args.limit,
        });
      }
      return ops.searchDbConversations({
        q: args.q,
        tag: args.tag,
        connectorKey: args.connectorKey,
        limit: args.limit,
      });
    }

    case "pancake_get_raw_conversation": {
      const schema = z
        .object({
          target: z.string().min(1),
          connectorKey: z.enum(["facebook_vietlicense", "zalo_thanh"]).optional(),
          type: z.enum(["INBOX", "COMMENT"]).optional(),
          messageLimit: z.number().int().min(1).max(150).optional().default(30),
          includeRawMessages: z.boolean().optional().default(false),
        })
        .strict();
      const args = schema.parse(rawArgs);
      const parsed = parseTargetReference(args.target, cfg.facebook.pageId);
      const convId = parsed.pancakeConversationId || args.target.trim();
      const connectorKey: ConnectorKey = args.connectorKey || parsed.connectorKey;
      const surfaceType = args.type || parsed.surfaceHint;

      const [convResult, msgResult] = await Promise.all([
        provider.getConversation(convId, { connectorKey, type: surfaceType }),
        provider.getMessages(convId, {
          connectorKey,
          limit: args.messageLimit,
          includeRaw: args.includeRawMessages,
        }),
      ]);

      return {
        parsedTarget: parsed,
        conversation: convResult,
        messages: msgResult,
      };
    }

    case "pancake_tags": {
      const schema = z
        .object({
          action: z.enum(["list", "add"]),
          connectorKey: z.enum(["facebook_vietlicense", "zalo_thanh"]).optional(),
          target: z.string().optional(),
          tagNameOrId: z.union([z.string(), z.number()]).optional(),
          confirmMutation: z.boolean().optional().default(false),
        })
        .strict();
      const args = schema.parse(rawArgs);
      if (args.action === "list") {
        return provider.getTags(args.connectorKey);
      }
      if (!args.target || args.tagNameOrId === undefined) {
        throw new Error("target and tagNameOrId are required when action='add'");
      }
      const parsed = parseTargetReference(args.target, cfg.facebook.pageId);
      const convId = parsed.pancakeConversationId || args.target.trim();
      return provider.addConversationTag({
        conversationId: convId,
        tagNameOrId: args.tagNameOrId,
        connectorKey: args.connectorKey || parsed.connectorKey,
        confirmMutation: args.confirmMutation,
      });
    }

    case "pancake_replay_comment_lead": {
      const schema = z
        .object({
          target: z.string().min(1),
          postId: z.string().optional(),
          messageId: z.string().optional(),
          fromId: z.string().optional(),
          confirmReplay: z.boolean(),
        })
        .strict();
      const args = schema.parse(rawArgs);
      return ops.replayCommentLead(args);
    }

    case "pancake_send_test_message": {
      const schema = z
        .object({
          target: z.string().min(1),
          message: z.string().optional(),
          imagePath: z.string().optional(),
          contentIds: z.array(z.string()).optional(),
          connectorKey: z.enum(["facebook_vietlicense", "zalo_thanh"]).optional(),
          confirmSend: z.boolean(),
        })
        .strict();
      const args = schema.parse(rawArgs);
      const parsed = parseTargetReference(args.target, cfg.facebook.pageId);
      const convId = parsed.pancakeConversationId || args.target.trim();
      return provider.sendMessage({
        conversationId: convId,
        message: args.message,
        imagePath: args.imagePath,
        contentIds: args.contentIds,
        connectorKey: args.connectorKey || parsed.connectorKey,
        confirmSend: args.confirmSend,
      });
    }

    default:
      throw new Error(`Unknown Pancake MCP tool: ${name}`);
  }
}
