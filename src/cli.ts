#!/usr/bin/env node
/**
 * pancake-mcp CLI & Stdio MCP Server
 *
 * Commands:
 *   pancake-mcp serve                                           Start MCP stdio server
 *   pancake-mcp status [--expected-revision <sha>] [--json]     Check Ops API + Pancake provider health
 *   pancake-mcp auth sync-dokploy [--app-id <id>]               Sync tokens from Dokploy vl-chat env into ~/.config/pancake-mcp/config.json
 *   pancake-mcp diagnose <target> [options]                     Full one-shot incident diagnosis (DB + logs + Chatbot2 + Pancake API)
 *   pancake-mcp messages <target> [options]                     Inspect DB and/or raw Pancake messages + bot_audit_logs + chatbot2_decisions
 *   pancake-mcp trace <target> [options]                        Full v2 trace (timeline, turns, deliveries, orders, outreach)
 *   pancake-mcp operations [options]                            Platform-wide health, queues, outreach, reliability, settings
 *   pancake-mcp search [options]                                Search conversations in DB or Pancake API
 *   pancake-mcp raw <target> [options]                          Direct Pancake Public API v1/v2 conversation + messages
 *   pancake-mcp tags [options]                                  List or add Pancake tags
 *   pancake-mcp replay-comment <target> --confirm [options]     Replay auto-comment retail flow (inbox + public reply)
 *   pancake-mcp send <target> --confirm [options]               Send test text/image to test conversation
 *   pancake-mcp call <tool_name> ['<json_args>']                Invoke any MCP tool directly
 *   pancake-mcp export-schemas <dir>                            Export lazy MCP tool schemas (.json + instructions.md)
 */

import fs from "node:fs";
import path from "node:path";
import {
  resolveConfig,
  syncCredentialsFromDokploy,
  parseTargetReference,
} from "./config.js";
import { PANCAKE_MCP_TOOLS, executePancakeMcpTool } from "./tools.js";
import { startPancakeMcpStdioServer } from "./index.js";

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseCliArgs(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const eqIdx = token.indexOf("=");
    if (eqIdx !== -1) {
      const key = token.slice(2, eqIdx);
      const val = token.slice(eqIdx + 1);
      flags[key] = val;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positional, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === "string" ? val : undefined;
}

function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const val = flagString(flags, key);
  if (val === undefined) return undefined;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true" || flags[key] === "1";
}

function printUsage(): void {
  console.log(`pancake-mcp — Pancake & VietLicense Chat Diagnostics MCP + CLI

Usage:
  pancake-mcp serve
  pancake-mcp status [--expected-revision <sha>] [--json]
  pancake-mcp auth sync-dokploy [--app-id zFOnzXuYWQLDCvsqhyCjv]
  pancake-mcp diagnose <target> [--provider-read auto|never|always] [--raw-provider] [--limit <n>] [--json]
  pancake-mcp messages <target> [--source both|db|provider] [--limit <n>] [--raw] [--json]
  pancake-mcp trace <target> [--scope all|conversation|interactive|order|outreach] [--no-timeline] [--json]
  pancake-mcp operations [--section all|runtime|queues|outreach|reliability|bulk|settings] [--overview] [--window <min>] [--json]
  pancake-mcp search [--source db|provider] [--q <query>] [--tag <tag>] [--connector facebook_vietlicense|zalo_thanh] [--type INBOX|COMMENT] [--unread] [--limit <n>] [--json]
  pancake-mcp raw <target> [--connector facebook_vietlicense|zalo_thanh] [--type INBOX|COMMENT] [--limit <n>] [--json]
  pancake-mcp tags [--add <tag> --target <target> --confirm] [--connector facebook_vietlicense|zalo_thanh] [--json]
  pancake-mcp replay-comment <target> --confirm [--post-id <id>] [--message-id <id>] [--from-id <id>] [--json]
  pancake-mcp send <target> --confirm [--text <msg>] [--image <path>] [--connector facebook_vietlicense|zalo_thanh] [--json]
  pancake-mcp parse <target>
  pancake-mcp call <tool_name> ['<json_args>']
  pancake-mcp export-schemas <target_dir>

Examples:
  pancake-mcp auth sync-dokploy
  pancake-mcp status
  pancake-mcp diagnose "https://pancake.vn/VietLicenseOliuGroup?c_id=1131614906706493_27102859622703796"
  pancake-mcp messages 1131614906706493_27102859622703796 --source both --limit 20
  pancake-mcp trace 1131614906706493_27102859622703796 --scope order
  pancake-mcp operations --section all --overview
  pancake-mcp search --source db --tag "Đã thanh toán" --limit 10
`);
}

function formatHumanSummary(command: string, result: Record<string, unknown>): void {
  if (command === "status") {
    const cfg = result.config as Record<string, unknown> | undefined;
    const fb = cfg?.facebook as Record<string, unknown> | undefined;
    const zl = cfg?.zalo as Record<string, unknown> | undefined;
    const health = result.runtimeHealth as Record<string, unknown> | undefined;
    console.log("=== Pancake MCP Status ===");
    console.log(`Config Sources   : ${Array.isArray(cfg?.sources) ? cfg.sources.join(", ") : "defaults"}`);
    console.log(`Ops API          : ${cfg?.opsUrl} (token=${cfg?.hasDiagnosticsToken ? "configured" : "MISSING"})`);
    if (health) {
      const runtime = health.runtime as Record<string, unknown> | undefined;
      const db = health.db as Record<string, unknown> | undefined;
      console.log(`Runtime Health   : status=${health.status ?? "ok"} | sha=${runtime?.gitSha ?? "?"} | db=${db?.status ?? "ok"}`);
    } else if (result.runtimeError) {
      console.log(`Runtime Error    : ${result.runtimeError}`);
    }
    console.log(`FB VietLicense   : pageId=${fb?.pageId ?? "none"} | token=${fb?.hasAccessToken ? "configured" : "MISSING"}`);
    console.log(`Zalo Thanh       : pageId=${zl?.pageId ?? "none"} | token=${zl?.hasAccessToken ? "configured" : "MISSING"}`);
    return;
  }

  if (command === "diagnose") {
    const parsed = result.parsedTarget as Record<string, unknown> | undefined;
    const inc = result.incident as Record<string, unknown> | undefined;
    const subject = inc?.subject as Record<string, unknown> | undefined;
    const diagnosis = inc?.diagnosis as Record<string, unknown> | undefined;
    const inspection = result.inspection as Record<string, unknown> | undefined;

    console.log("=== Unified Incident Diagnosis ===");
    console.log(`Target           : ${parsed?.raw} (kind=${parsed?.kind}, connector=${parsed?.connectorKey ?? "auto"}, surface=${parsed?.surfaceHint ?? "INBOX"})`);
    console.log(`Local Conv ID    : ${subject?.localConversationId ?? inspection?.localConversationId ?? "not found"}`);
    console.log(`Pancake Conv ID  : ${subject?.pancakeConversationId ?? inspection?.pancakeConversationId ?? "not found"}`);
    if (diagnosis) {
      console.log(`Broken Stage     : ${diagnosis.firstBrokenStage ?? "none"}`);
      console.log(`Summary          : ${diagnosis.summary ?? ""}`);
      const actions = Array.isArray(diagnosis.recommendedNextChecks) ? diagnosis.recommendedNextChecks : [];
      if (actions.length > 0) {
        console.log(`Next Checks      : ${actions.join(" | ")}`);
      }
    }
    if (inspection) {
      console.log(`Customer         : ${inspection.customerName ?? "?"} | connector=${inspection.connectorKey ?? "?"}`);
      console.log(`Tags             : ${JSON.stringify(inspection.tags ?? [])}`);
      if (inspection.latestOrder) {
        console.log(`Latest Order     : ${JSON.stringify(inspection.latestOrder)}`);
      }
      const msgs = Array.isArray(inspection.messages) ? inspection.messages : [];
      console.log(`\n--- Recent DB Messages (${msgs.length}) ---`);
      for (const m of msgs.slice(-15) as Array<Record<string, unknown>>) {
        console.log(
          `  [${m.createdAt}] (${m.direction}/${m.senderName ?? ""}): ${String(m.content ?? "").replace(/\s+/g, " ").slice(0, 160)} ${Number(m.attachmentsCount ?? 0) > 0 ? `[attachments=${m.attachmentsCount}]` : ""}`,
        );
      }
      const decisions = Array.isArray(inspection.chatbot2Decisions) ? inspection.chatbot2Decisions : [];
      if (decisions.length > 0) {
        console.log(`\n--- Recent Chatbot 2.0 Decisions (${decisions.length}) ---`);
        for (const d of decisions.slice(0, 8) as Array<Record<string, unknown>>) {
          console.log(
            `  [${d.createdAt}] action=${d.action} kind=${d.decisionKind ?? "-"} topic=${d.topicKey ?? "-"} route=${d.replyRouteKey ?? "-"} priceCmd=${d.priceCommandKey ?? "-"} reasons=${JSON.stringify(d.reasonCodes ?? [])}`,
          );
        }
      }
      const logs = Array.isArray(inspection.auditLogs) ? inspection.auditLogs : [];
      if (logs.length > 0) {
        console.log(`\n--- Recent Bot Audit Logs (${logs.length}) ---`);
        for (const l of logs.slice(0, 10) as Array<Record<string, unknown>>) {
          console.log(`  [${l.createdAt}] status=${l.status} outcome=${l.outcome ?? "-"} msg=${String(l.userMessage ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
        }
      }
    }
    const provMsgs = result.providerMessages as Record<string, unknown> | undefined;
    if (provMsgs && Array.isArray(provMsgs.messages)) {
      console.log(`\n--- Raw Pancake Provider Messages (${provMsgs.messages.length}) ---`);
      for (const pm of provMsgs.messages.slice(-10) as Array<Record<string, unknown>>) {
        console.log(`  [${pm.createdAt}] (${pm.direction}/${pm.senderName ?? ""}): ${String(pm.text ?? "").replace(/\s+/g, " ").slice(0, 140)}`);
      }
    }
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

function buildInstructionsMarkdown(): string {
  return `# Pancake MCP Server (\`pancake\`)

Unified diagnostics, message/log/decision inspection, direct Pancake Public API v1/v2 inspection, and safe guarded mutations for VietLicense Chat (\`pancake.vn\` / \`pages.fm\`).

## Golden Rules

1. **One-Shot First**: When given a Pancake link (\`https://pancake.vn/...?c_id=...\`), \`PAGEID_PSID\`, \`POSTID_COMMENTID\`, \`pzl_u_...\`, local UUID, or Admin Order ID, call \`pancake_diagnose_incident\` first. It returns the root-cause diagnosis, recent DB messages, \`bot_audit_logs\`, and \`chatbot2_decisions\` in a single call.
2. **Compare DB vs Pancake Provider**: If you suspect a message, image, POS card, or tag in Pancake wasn't ingested or synced into PostgreSQL, call \`pancake_inspect_messages\` with \`source: "both"\` or \`pancake_get_raw_conversation\`.
3. **Read-Only By Default**: Never retry an unknown delivery (\`delivery_unknown\`) blindly. Mutation tools (\`pancake_tags\` with \`action: "add"\`, \`pancake_replay_comment_lead\`, \`pancake_send_test_message\`) require explicit confirmation flags (\`confirmMutation\`, \`confirmReplay\`, \`confirmSend\`).

## Tool Quick Reference

| Tool | Purpose |
|------|---------|
| \`pancake_status\` | Check Ops API health, runtime revision, and Pancake FB/Zalo provider credential readiness |
| \`pancake_diagnose_incident\` | One-shot root-cause diagnosis + DB messages + \`bot_audit_logs\` + \`chatbot2_decisions\` (+ optional raw Pancake API) |
| \`pancake_inspect_messages\` | Compare DB messages, \`bot_audit_logs\`, and \`chatbot2_decisions\` with live Pancake provider messages & attachments |
| \`pancake_trace\` | Full Ops v2 trace across timeline, turns, deliveries, orders (\`order_pushes\`), and outreach (\`r0\`-\`r2\`/\`z1\`) |
| \`pancake_operations\` | Platform-wide runtime, queue depth, outreach status, reliability v2 governor, and settings |
| \`pancake_search_conversations\` | Search conversations by customer name/phone/tag/text in PostgreSQL or directly on Pancake API |
| \`pancake_get_raw_conversation\` | Direct Pancake Public API v2 conversation + v1 messages (auto HTML fallback + \`user_view=true\` POS card support) |
| \`pancake_tags\` | List page tag catalog or add a tag to a conversation (requires \`confirmMutation: true\`) |
| \`pancake_replay_comment_lead\` | Replay deterministic purchase comment flow for a missed FB comment (requires \`confirmReplay: true\`) |
| \`pancake_send_test_message\` | Send test text/image to a dedicated test thread (requires \`confirmSend: true\`) |
`;
}

export function exportSchemasToDir(targetDir: string): string[] {
  fs.mkdirSync(targetDir, { recursive: true });
  const written: string[] = [];

  for (const tool of PANCAKE_MCP_TOOLS) {
    const schemaPath = path.join(targetDir, `${tool.name}.json`);
    const payload = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    fs.writeFileSync(schemaPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    written.push(schemaPath);
  }

  const instructionsPath = path.join(targetDir, "instructions.md");
  fs.writeFileSync(instructionsPath, buildInstructionsMarkdown(), "utf8");
  written.push(instructionsPath);
  return written;
}

export async function runCli(argv: string[]): Promise<void> {
  const { positional, flags } = parseCliArgs(argv);
  const command = positional[0];

  if (!command || command === "help" || flagBool(flags, "help") || flagBool(flags, "h")) {
    printUsage();
    return;
  }

  if (command === "serve") {
    await startPancakeMcpStdioServer();
    return;
  }

  if (command === "export-schemas") {
    const outDir = positional[1];
    if (!outDir) {
      throw new Error("Usage: pancake-mcp export-schemas <target_dir>");
    }
    const files = exportSchemasToDir(outDir);
    console.log(JSON.stringify({ ok: true, exportedCount: files.length, files }, null, 2));
    return;
  }

  if (command === "parse") {
    const target = positional[1];
    if (!target) {
      throw new Error("Usage: pancake-mcp parse <target>");
    }
    const cfg = resolveConfig();
    console.log(JSON.stringify(parseTargetReference(target, cfg.facebook.pageId), null, 2));
    return;
  }

  if (command === "auth") {
    const sub = positional[1];
    if (sub === "sync-dokploy") {
      const appId = flagString(flags, "app-id") ?? "zFOnzXuYWQLDCvsqhyCjv";
      const synced = await syncCredentialsFromDokploy({ applicationId: appId });
      console.log(
        JSON.stringify(
          {
            ok: true,
            ...synced,
          },
          null,
          2,
        ),
      );
      return;
    }
    throw new Error(`Unknown auth subcommand: ${sub ?? "(none)"}. Use: pancake-mcp auth sync-dokploy`);
  }

  const config = resolveConfig();
  const deps = { config };
  const jsonOut = flagBool(flags, "json");

  if (command === "status") {
    const res = (await executePancakeMcpTool(
      "pancake_status",
      {
        expectedRevision: flagString(flags, "expected-revision"),
      },
      deps,
    )) as Record<string, unknown>;
    if (jsonOut) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      formatHumanSummary("status", res);
    }
    return;
  }

  if (command === "diagnose") {
    const target = positional[1];
    if (!target) throw new Error("Usage: pancake-mcp diagnose <target>");
    const res = (await executePancakeMcpTool(
      "pancake_diagnose_incident",
      {
        target,
        providerRead: flagString(flags, "provider-read") ?? "auto",
        includeProviderMessages: flagBool(flags, "raw-provider") ? true : undefined,
        messageLimit: flagNumber(flags, "limit") ?? 40,
      },
      deps,
    )) as Record<string, unknown>;
    if (jsonOut) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      formatHumanSummary("diagnose", res);
    }
    return;
  }

  if (command === "messages") {
    const target = positional[1];
    if (!target) throw new Error("Usage: pancake-mcp messages <target>");
    const res = await executePancakeMcpTool(
      "pancake_inspect_messages",
      {
        target,
        source: flagString(flags, "source") ?? "both",
        connectorKey: flagString(flags, "connector"),
        limit: flagNumber(flags, "limit") ?? 30,
        includeRawProviderPayload: flagBool(flags, "raw"),
      },
      deps,
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "trace") {
    const target = positional[1];
    if (!target) throw new Error("Usage: pancake-mcp trace <target>");
    const res = await executePancakeMcpTool(
      "pancake_trace",
      {
        target,
        scope: flagString(flags, "scope") ?? "all",
        includeTimeline: !flagBool(flags, "no-timeline"),
        windowMinutes: flagNumber(flags, "window") ?? 60,
        providerRead: flagString(flags, "provider-read") ?? "never",
      },
      deps,
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "operations") {
    const res = await executePancakeMcpTool(
      "pancake_operations",
      {
        section: flagString(flags, "section") ?? "all",
        includeOverviewV1: flagBool(flags, "overview"),
        windowMinutes: flagNumber(flags, "window") ?? 60,
        analyticsWindow: flagString(flags, "analytics-window") ?? "24h",
      },
      deps,
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "search") {
    const res = await executePancakeMcpTool(
      "pancake_search_conversations",
      {
        source: flagString(flags, "source") ?? "db",
        q: flagString(flags, "q"),
        tag: flagString(flags, "tag"),
        connectorKey: flagString(flags, "connector") ?? "facebook_vietlicense",
        type: flagString(flags, "type"),
        unreadFirst: flagBool(flags, "unread") ? true : undefined,
        limit: flagNumber(flags, "limit") ?? 20,
      },
      deps,
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "raw") {
    const target = positional[1];
    if (!target) throw new Error("Usage: pancake-mcp raw <target>");
    const res = await executePancakeMcpTool(
      "pancake_get_raw_conversation",
      {
        target,
        connectorKey: flagString(flags, "connector"),
        type: flagString(flags, "type"),
        messageLimit: flagNumber(flags, "limit") ?? 30,
        includeRawMessages: flagBool(flags, "raw"),
      },
      deps,
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "tags") {
    const addTag = flagString(flags, "add");
    const res = await executePancakeMcpTool(
      "pancake_tags",
      {
        action: addTag ? "add" : "list",
        connectorKey: flagString(flags, "connector") ?? "facebook_vietlicense",
        target: flagString(flags, "target") ?? positional[1],
        tagNameOrId: addTag,
        confirmMutation: flagBool(flags, "confirm"),
      },
      deps,
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "replay-comment") {
    const target = positional[1];
    if (!target) throw new Error("Usage: pancake-mcp replay-comment <target> --confirm");
    const res = await executePancakeMcpTool(
      "pancake_replay_comment_lead",
      {
        target,
        postId: flagString(flags, "post-id"),
        messageId: flagString(flags, "message-id"),
        fromId: flagString(flags, "from-id"),
        confirmReplay: flagBool(flags, "confirm"),
      },
      deps,
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "send") {
    const target = positional[1];
    if (!target) throw new Error("Usage: pancake-mcp send <target> --confirm [--text <msg>] [--image <path>]");
    const res = await executePancakeMcpTool(
      "pancake_send_test_message",
      {
        target,
        connectorKey: flagString(flags, "connector") ?? "facebook_vietlicense",
        message: flagString(flags, "text"),
        imagePath: flagString(flags, "image"),
        confirmSend: flagBool(flags, "confirm"),
      },
      deps,
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "call") {
    const toolName = positional[1];
    if (!toolName) throw new Error("Usage: pancake-mcp call <tool_name> ['<json_args>']");
    const rawArgs = positional[2] ? (JSON.parse(positional[2]) as Record<string, unknown>) : {};
    const res = await executePancakeMcpTool(toolName, rawArgs, deps);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}. Run 'pancake-mcp --help' for usage.`);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/cli.js") ||
    process.argv[1].endsWith("/cli.ts") ||
    process.argv[1].endsWith("/pancake-mcp"));

if (isMain) {
  runCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    process.exit(1);
  });
}
