import { parseTargetReference, type PancakeMcpConfig } from "./config.js";
import type { PancakeProviderClient, ProviderMessagesResult } from "./pancake-client.js";

export interface InspectedDbMessage {
  id: string;
  pancakeMessageId: string | null;
  direction: "inbound" | "outbound";
  senderName: string | null;
  content: string;
  attachmentsCount: number;
  createdAt: string;
}

export interface InspectedAuditLog {
  id: string;
  status: string;
  outcome: string | null;
  userMessage: string | null;
  debug: Record<string, unknown> | null;
  createdAt: string;
}

export interface InspectedChatbot2Decision {
  id: string;
  inboundMessageRef: string;
  action: string;
  decisionKind: string | null;
  topicKey: string | null;
  replyRouteKey: string | null;
  priceCommandKey: string | null;
  reasonCodes: string[];
  classifierModel: string | null;
  createdAt: string;
}

export interface ConversationInspection {
  localConversationId: string;
  pancakeConversationId: string | null;
  customerName: string | null;
  connectorKey: string | null;
  tags: string[];
  botControl: Record<string, unknown> | null;
  latestOrder: Record<string, unknown> | null;
  sync: Record<string, unknown> | null;
  messages: InspectedDbMessage[];
  chatbot2Decisions: InspectedChatbot2Decision[];
  auditLogs: InspectedAuditLog[];
}

export class OpsDiagnosticsClient {
  constructor(
    private readonly config: PancakeMcpConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private assertConfigured(): void {
    if (!this.config.diagnosticsToken) {
      throw new Error(
        "Missing CHAT_DIAGNOSTICS_TOKEN. Run 'pancake-mcp auth sync-dokploy' or set CHAT_DIAGNOSTICS_TOKEN in environment.",
      );
    }
  }

  private async requestJson<T>(
    path: string,
    init: {
      method?: "GET" | "POST" | "PUT" | "PATCH";
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    this.assertConfigured();
    const timeoutMs = init.timeoutMs ?? 45_000;
    const url = `${this.config.opsUrl}${path}`;
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);

    const response = await this.fetchImpl(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.config.diagnosticsToken}`,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal,
    });

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 300) };
      }
    }

    if (!response.ok) {
      const errObj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      const serverCode = String(errObj.error ?? errObj.errorCode ?? `http_${response.status}`);
      throw new Error(`Ops API ${init.method ?? "GET"} ${path} failed (${response.status}): ${serverCode}`);
    }

    return parsed as T;
  }

  async getHealth(expectedRevision?: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    const qs = expectedRevision ? `?expectedRevision=${encodeURIComponent(expectedRevision)}` : "";
    return this.requestJson(`/api/ops/v1/diagnostics/health${qs}`, { timeoutMs });
  }

  async getOverview(windowMinutes = 30, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.requestJson(`/api/ops/v1/diagnostics/overview?windowMinutes=${windowMinutes}`, { timeoutMs });
  }

  async getOperationsV2(params: {
    section?: "runtime" | "queues" | "outreach" | "reliability" | "bulk" | "settings" | "all";
    windowMinutes?: number;
    analyticsWindow?: "24h" | "7d" | "30d";
    campaignId?: string;
    timeoutMs?: number;
  } = {}): Promise<Record<string, unknown>> {
    const q = new URLSearchParams();
    if (params.section) q.set("section", params.section);
    if (params.windowMinutes) q.set("windowMinutes", String(params.windowMinutes));
    if (params.analyticsWindow) q.set("analyticsWindow", params.analyticsWindow);
    if (params.campaignId) q.set("campaignId", params.campaignId);
    const qs = q.toString() ? `?${q.toString()}` : "";
    return this.requestJson(`/api/ops/v2/diagnostics/operations${qs}`, { timeoutMs: params.timeoutMs });
  }

  private buildV2TargetBody(
    target: string | {
      target?: string;
      pancakeUrl?: string;
      pancakeConversationId?: string;
      conversationId?: string;
      messageId?: string;
      deliveryId?: string;
      orderId?: string;
    },
  ): Record<string, unknown> {
    if (typeof target === "string") {
      const parsed = parseTargetReference(target, this.config.facebook.pageId);
      const body: Record<string, unknown> = {};
      if (parsed.pancakeUrl) body.pancakeUrl = parsed.pancakeUrl;
      else if (parsed.pancakeConversationId) body.pancakeConversationId = parsed.pancakeConversationId;
      else if (parsed.conversationId) body.conversationId = parsed.conversationId;
      else if (parsed.messageId) body.messageId = parsed.messageId;
      else if (parsed.orderId) body.orderId = parsed.orderId;
      return body;
    }

    if (target.target) {
      return {
        ...this.buildV2TargetBody(target.target),
        ...(target.pancakeUrl ? { pancakeUrl: target.pancakeUrl } : {}),
        ...(target.pancakeConversationId ? { pancakeConversationId: target.pancakeConversationId } : {}),
        ...(target.conversationId ? { conversationId: target.conversationId } : {}),
        ...(target.messageId ? { messageId: target.messageId } : {}),
        ...(target.deliveryId ? { deliveryId: target.deliveryId } : {}),
        ...(target.orderId ? { orderId: target.orderId } : {}),
      };
    }

    const body: Record<string, unknown> = {};
    if (target.pancakeUrl) body.pancakeUrl = target.pancakeUrl;
    if (target.pancakeConversationId) body.pancakeConversationId = target.pancakeConversationId;
    if (target.conversationId) body.conversationId = target.conversationId;
    if (target.messageId) body.messageId = target.messageId;
    if (target.deliveryId) body.deliveryId = target.deliveryId;
    if (target.orderId) body.orderId = target.orderId;
    return body;
  }

  async traceV2(params: {
    target?: string;
    pancakeUrl?: string;
    pancakeConversationId?: string;
    conversationId?: string;
    messageId?: string;
    deliveryId?: string;
    orderId?: string;
    scope?: "conversation" | "interactive" | "order" | "outreach" | "all";
    providerRead?: "never" | "auto" | "always";
    windowMinutes?: number;
    includeTimeline?: boolean;
    redactIdentifiers?: boolean;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      ...this.buildV2TargetBody(params),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.providerRead ? { providerRead: params.providerRead } : {}),
      ...(params.windowMinutes ? { windowMinutes: params.windowMinutes } : {}),
      ...(params.includeTimeline !== undefined ? { includeTimeline: params.includeTimeline } : {}),
      ...(params.redactIdentifiers !== undefined ? { redactIdentifiers: params.redactIdentifiers } : {}),
    };
    return this.requestJson("/api/ops/v2/diagnostics/trace", {
      method: "POST",
      body,
      timeoutMs: params.timeoutMs,
    });
  }

  async incidentFullV2(params: {
    target?: string;
    pancakeUrl?: string;
    pancakeConversationId?: string;
    conversationId?: string;
    messageId?: string;
    deliveryId?: string;
    orderId?: string;
    providerRead?: "never" | "auto" | "always";
    windowMinutes?: number;
    redactIdentifiers?: boolean;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      ...this.buildV2TargetBody(params),
      ...(params.providerRead ? { providerRead: params.providerRead } : {}),
      ...(params.windowMinutes ? { windowMinutes: params.windowMinutes } : {}),
      ...(params.redactIdentifiers !== undefined ? { redactIdentifiers: params.redactIdentifiers } : {}),
    };
    return this.requestJson("/api/ops/v2/diagnostics/incident", {
      method: "POST",
      body,
      timeoutMs: params.timeoutMs,
    });
  }

  async inspectConversation(
    localConversationId: string,
    options: { messageLimit?: number; logLimit?: number; timeoutMs?: number } = {},
  ): Promise<ConversationInspection> {
    const msgLimit = Math.min(Math.max(options.messageLimit ?? 30, 1), 150);
    const logLimit = Math.min(Math.max(options.logLimit ?? 20, 1), 100);
    const timeoutMs = options.timeoutMs ?? 30_000;

    const safeGet = async (path: string): Promise<Record<string, unknown> | null> => {
      try {
        return await this.requestJson<Record<string, unknown>>(path, { timeoutMs });
      } catch {
        return null;
      }
    };

    const [convData, logsData, decisionsData] = await Promise.all([
      safeGet(`/api/admin/conversations/${encodeURIComponent(localConversationId)}?limit=${msgLimit}`),
      safeGet(`/api/admin/conversations/${encodeURIComponent(localConversationId)}/logs?limit=${logLimit}`),
      safeGet(`/api/admin/chatbot2/decisions?limit=60`),
    ]);

    const convObj = (convData?.conversation && typeof convData.conversation === "object"
      ? convData.conversation
      : {}) as Record<string, unknown>;

    const rawMessages = Array.isArray(convData?.messages) ? convData.messages : [];
    const messages: InspectedDbMessage[] = rawMessages.map((m: unknown) => {
      const row = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
      const atts = Array.isArray(row.attachments) ? row.attachments : [];
      return {
        id: String(row.id ?? ""),
        pancakeMessageId: row.pancake_message_id ? String(row.pancake_message_id) : null,
        direction: row.direction === "outbound" ? "outbound" : "inbound",
        senderName: row.sender_name ? String(row.sender_name) : null,
        content: String(row.content ?? ""),
        attachmentsCount: atts.length,
        createdAt: String(row.created_at ?? ""),
      };
    });

    const rawLogs = Array.isArray(logsData?.logs) ? logsData.logs : [];
    const auditLogs: InspectedAuditLog[] = rawLogs.map((l: unknown) => {
      const row = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
      return {
        id: String(row.id ?? ""),
        status: String(row.status ?? ""),
        outcome: row.outcome ? String(row.outcome) : null,
        userMessage: row.userMessage ? String(row.userMessage) : null,
        debug: row.debug && typeof row.debug === "object" ? (row.debug as Record<string, unknown>) : null,
        createdAt: String(row.createdAt ?? ""),
      };
    });

    const rawDecisions = Array.isArray(decisionsData?.decisions) ? decisionsData.decisions : [];
    const chatbot2Decisions: InspectedChatbot2Decision[] = rawDecisions
      .filter((d: unknown) => {
        const row = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
        return String(row.conversation_id ?? "") === localConversationId;
      })
      .map((d: unknown) => {
        const row = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
        return {
          id: String(row.id ?? ""),
          inboundMessageRef: String(row.inbound_message_ref ?? ""),
          action: String(row.action ?? ""),
          decisionKind: row.decision_kind ? String(row.decision_kind) : null,
          topicKey: row.topic_key ? String(row.topic_key) : null,
          replyRouteKey: row.reply_route_key ? String(row.reply_route_key) : null,
          priceCommandKey: row.price_command_key ? String(row.price_command_key) : null,
          reasonCodes: Array.isArray(row.reason_codes) ? row.reason_codes.map(String) : [],
          classifierModel: row.classifier_model ? String(row.classifier_model) : null,
          createdAt: String(row.created_at ?? ""),
        };
      });

    return {
      localConversationId,
      pancakeConversationId: convObj.pancake_conversation_id ? String(convObj.pancake_conversation_id) : null,
      customerName: convObj.customer_name ? String(convObj.customer_name) : null,
      connectorKey: convObj.connector_key ? String(convObj.connector_key) : null,
      tags: Array.isArray(convObj.tags) ? convObj.tags.map(String) : [],
      botControl:
        convData?.botControl && typeof convData.botControl === "object"
          ? (convData.botControl as Record<string, unknown>)
          : null,
      latestOrder:
        convData?.latestOrder && typeof convData.latestOrder === "object"
          ? (convData.latestOrder as Record<string, unknown>)
          : null,
      sync:
        convData?.sync && typeof convData.sync === "object"
          ? (convData.sync as Record<string, unknown>)
          : null,
      messages,
      chatbot2Decisions,
      auditLogs,
    };
  }

  async searchDbConversations(params: {
    q?: string;
    tag?: string;
    connectorKey?: string;
    limit?: number;
    timeoutMs?: number;
  } = {}): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (params.q) query.set("q", params.q);
    if (params.tag) query.set("tag", params.tag);
    if (params.connectorKey) query.set("connectorKey", params.connectorKey);
    query.set("limit", String(Math.min(Math.max(params.limit ?? 20, 1), 100)));
    return this.requestJson(`/api/admin/conversations?${query.toString()}`, {
      timeoutMs: params.timeoutMs,
    });
  }

  async replayCommentLead(params: {
    target: string;
    postId?: string;
    messageId?: string;
    fromId?: string;
    confirmReplay: boolean;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    if (!params.confirmReplay) {
      throw new Error("Refusing to replay comment lead without confirmReplay=true");
    }
    const parsed = parseTargetReference(params.target, this.config.facebook.pageId);
    const idOrPancakeId = parsed.conversationId || parsed.pancakeConversationId || params.target.trim();
    return this.requestJson(`/api/admin/conversations/${encodeURIComponent(idOrPancakeId)}/replay-comment-lead`, {
      method: "POST",
      body: {
        ...(params.postId ? { postId: params.postId } : {}),
        ...(params.messageId ? { messageId: params.messageId } : {}),
        ...(params.fromId ? { fromId: params.fromId } : {}),
      },
      timeoutMs: params.timeoutMs ?? 30_000,
    });
  }

  async diagnoseUnified(params: {
    target?: string;
    pancakeUrl?: string;
    pancakeConversationId?: string;
    conversationId?: string;
    messageId?: string;
    deliveryId?: string;
    orderId?: string;
    providerRead?: "never" | "auto" | "always";
    windowMinutes?: number;
    includeMessages?: boolean;
    includeProviderMessages?: boolean;
    messageLimit?: number;
    redactIdentifiers?: boolean;
    providerClient?: PancakeProviderClient;
    timeoutMs?: number;
  }): Promise<{
    parsedTarget: ReturnType<typeof parseTargetReference> | null;
    incident: Record<string, unknown>;
    inspection: ConversationInspection | null;
    providerMessages: ProviderMessagesResult | null;
  }> {
    const rawTarget =
      params.target ||
      params.pancakeUrl ||
      params.pancakeConversationId ||
      params.conversationId ||
      params.messageId ||
      params.orderId ||
      "";
    const parsedTarget = rawTarget
      ? parseTargetReference(rawTarget, this.config.facebook.pageId)
      : null;

    const incident = await this.incidentFullV2({
      target: params.target,
      pancakeUrl: params.pancakeUrl,
      pancakeConversationId: params.pancakeConversationId,
      conversationId: params.conversationId,
      messageId: params.messageId,
      deliveryId: params.deliveryId,
      orderId: params.orderId,
      providerRead: params.providerRead ?? "auto",
      windowMinutes: params.windowMinutes ?? 60,
      redactIdentifiers: params.redactIdentifiers ?? false,
      timeoutMs: params.timeoutMs,
    });

    const subject = (incident.subject && typeof incident.subject === "object"
      ? incident.subject
      : {}) as Record<string, unknown>;
    const localId =
      !params.redactIdentifiers && typeof subject.localConversationId === "string"
        ? subject.localConversationId
        : params.conversationId || null;
    const pancakeConvId =
      typeof subject.pancakeConversationId === "string"
        ? subject.pancakeConversationId
        : parsedTarget?.pancakeConversationId || null;

    let inspection: ConversationInspection | null = null;
    if ((params.includeMessages ?? true) && localId) {
      inspection = await this.inspectConversation(localId, {
        messageLimit: params.messageLimit ?? 30,
        timeoutMs: params.timeoutMs,
      });
    }

    let providerMessages: ProviderMessagesResult | null = null;
    const shouldFetchProvider =
      params.includeProviderMessages === true ||
      (params.includeProviderMessages !== false && !localId && Boolean(pancakeConvId));
    if (shouldFetchProvider && pancakeConvId && params.providerClient) {
      try {
        providerMessages = await params.providerClient.getMessages(pancakeConvId, {
          limit: params.messageLimit ?? 30,
        });
      } catch {
        // Non-fatal if direct provider token is not configured
      }
    }

    return {
      parsedTarget,
      incident,
      inspection,
      providerMessages,
    };
  }
}
