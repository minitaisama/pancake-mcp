import fs from "node:fs";
import path from "node:path";
import type { ConnectorCredentials, PancakeMcpConfig } from "./config.js";

export type ConnectorKey = "facebook_vietlicense" | "zalo_thanh";

export interface NormalizedProviderMessage {
  id: string;
  senderId: string | null;
  senderName: string | null;
  direction: "inbound" | "outbound";
  text: string;
  originalMessage: string | null;
  createdAt: string;
  postId: string | null;
  canReplyPrivately: boolean | null;
  attachments: Array<{
    type: string;
    url: string | null;
    id: string | null;
    name: string | null;
  }>;
  raw?: Record<string, unknown>;
}

export interface ProviderMessagesResult {
  connectorKey: ConnectorKey;
  pageId: string;
  conversationId: string;
  success: boolean;
  messagesCount: number;
  messages: NormalizedProviderMessage[];
  phoneMetadata: {
    hasPhone: boolean;
    phoneNumbers: string[];
  };
  notesCount: number;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}

function redactToken(input: string, token: string): string {
  if (!token) return input;
  return input.split(token).join("[REDACTED]");
}

export class PancakeProviderClient {
  constructor(
    private readonly config: PancakeMcpConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  resolveConnector(
    connectorKey?: ConnectorKey,
    conversationId?: string,
  ): { connectorKey: ConnectorKey; creds: ConnectorCredentials } {
    const key: ConnectorKey =
      connectorKey ||
      (conversationId?.startsWith("pzl_") ? "zalo_thanh" : "facebook_vietlicense");
    const creds = key === "zalo_thanh" ? this.config.zalo : this.config.facebook;
    if (!creds.pageId || !creds.accessToken) {
      throw new Error(
        `Missing Pancake credentials for connector "${key}". Run "pancake-mcp auth sync-dokploy" or set PANCAKE_PAGE_ID / PANCAKE_ACCESS_TOKEN.`,
      );
    }
    return { connectorKey: key, creds };
  }

  private buildUrl(
    version: "v1" | "v2",
    creds: ConnectorCredentials,
    subpath: string,
    query: Record<string, string | undefined> = {},
  ): string {
    const base = `${this.config.pancakeApiUrl}/api/public_api/${version}/pages/${encodeURIComponent(creds.pageId)}`;
    const url = new URL(`${base}${subpath}`);
    url.searchParams.set("page_access_token", creds.accessToken);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  private async requestJson<T>(
    method: "GET" | "POST" | "PUT",
    url: string,
    token: string,
    options: {
      body?: unknown;
      timeoutMs?: number;
      maxAttempts?: number;
    } = {},
  ): Promise<T> {
    const isGet = method === "GET";
    // Never retry POST/PUT mutations to prevent duplicate customer messages
    const maxAttempts = isGet ? Math.max(1, options.maxAttempts ?? 2) : 1;
    const timeoutMs = options.timeoutMs ?? (isGet ? 12_000 : 20_000);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: options.body
            ? { "Content-Type": "application/json", Accept: "application/json" }
            : { Accept: "application/json" },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });

        const rawText = await res.text();
        let parsed: unknown = null;
        if (rawText) {
          try {
            parsed = JSON.parse(rawText);
          } catch {
            throw new Error(
              `Pancake returned non-JSON response (HTTP ${res.status}) for ${redactToken(url, token)}`,
            );
          }
        }

        if (!res.ok) {
          throw new Error(
            `Pancake API HTTP ${res.status}: ${redactToken(rawText.slice(0, 200), token)}`,
          );
        }

        return parsed as T;
      } catch (err) {
        lastError = err;
        if (isGet && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async listConversations(params: {
    connectorKey?: ConnectorKey;
    type?: "INBOX" | "COMMENT";
    unreadFirst?: boolean;
    since?: number;
    until?: number;
    lastConversationId?: string;
    tags?: string[];
    limit?: number;
  } = {}): Promise<{
    connectorKey: ConnectorKey;
    pageId: string;
    conversations: Array<Record<string, unknown>>;
    pagination: Record<string, unknown> | null;
  }> {
    const { connectorKey, creds } = this.resolveConnector(params.connectorKey);
    const nowSec = Math.floor(Date.now() / 1000);
    const until = params.until ?? nowSec;
    const since = params.since ?? until - 7 * 24 * 3600;
    const url = this.buildUrl("v2", creds, "/conversations", {
      since: String(since),
      until: String(until),
      type: params.type,
      unread_first: params.unreadFirst !== undefined ? String(params.unreadFirst) : undefined,
      last_conversation_id: params.lastConversationId,
      tags: params.tags?.length ? params.tags.join(",") : undefined,
      limit: params.limit ? String(params.limit) : undefined,
    });

    const data = await this.requestJson<{
      success?: boolean;
      conversations?: Array<Record<string, unknown>>;
      pagination?: Record<string, unknown>;
    }>("GET", url, creds.accessToken);

    const rows = Array.isArray(data?.conversations) ? data.conversations : [];
    const limited = params.limit ? rows.slice(0, params.limit) : rows;
    return {
      connectorKey,
      pageId: creds.pageId,
      conversations: limited,
      pagination: data?.pagination ?? null,
    };
  }

  async getConversation(
    conversationId: string,
    options: { connectorKey?: ConnectorKey; type?: "INBOX" | "COMMENT"; lookbackDays?: number } = {},
  ): Promise<{
    connectorKey: ConnectorKey;
    pageId: string;
    source: "direct" | "collection_fallback" | "not_found";
    conversation: Record<string, unknown> | null;
  }> {
    const { connectorKey, creds } = this.resolveConnector(options.connectorKey, conversationId);
    // 1. Try direct route (maxAttempts=1 because some pages return HTML for single conversation v2 route)
    try {
      const directUrl = this.buildUrl("v2", creds, `/conversations/${encodeURIComponent(conversationId)}`);
      const directRes = await this.requestJson<{
        success?: boolean;
        conversation?: Record<string, unknown>;
      }>("GET", directUrl, creds.accessToken, { maxAttempts: 1, timeoutMs: 8_000 });
      if (directRes?.success && directRes.conversation) {
        return {
          connectorKey,
          pageId: creds.pageId,
          source: "direct",
          conversation: directRes.conversation,
        };
      }
    } catch {
      // Fall back to bounded collection scan
    }

    // 2. Bounded collection scan (up to 5 pages)
    const until = Math.floor(Date.now() / 1000);
    const since = until - Math.max(1, options.lookbackDays ?? 14) * 24 * 3600;
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const listRes = await this.listConversations({
        connectorKey,
        since,
        until,
        type: options.type || "INBOX",
        lastConversationId: cursor,
      });
      const match = listRes.conversations.find((c) => String(c.id || "") === conversationId);
      if (match) {
        return {
          connectorKey,
          pageId: creds.pageId,
          source: "collection_fallback",
          conversation: match,
        };
      }
      const nextCursor = String(
        (listRes.pagination as Record<string, unknown> | null)?.last_id ||
          listRes.conversations.at(-1)?.id ||
          "",
      );
      if (!listRes.conversations.length || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }

    return {
      connectorKey,
      pageId: creds.pageId,
      source: "not_found",
      conversation: null,
    };
  }

  async getMessages(
    conversationId: string,
    options: {
      connectorKey?: ConnectorKey;
      limit?: number;
      currentCount?: number;
      customerId?: string;
      userView?: boolean;
      includeRaw?: boolean;
    } = {},
  ): Promise<ProviderMessagesResult> {
    const { connectorKey, creds } = this.resolveConnector(options.connectorKey, conversationId);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validCustomerUuid =
      options.customerId && uuidRe.test(options.customerId) ? options.customerId : undefined;
    const useUserViewFirst = Boolean(options.userView && validCustomerUuid);

    const buildMsgUrl = (withUserView: boolean, customerUuid?: string) =>
      this.buildUrl("v1", creds, `/conversations/${encodeURIComponent(conversationId)}/messages`, {
        limit: String(options.limit ?? 30),
        current_count: options.currentCount !== undefined ? String(options.currentCount) : undefined,
        customer_id: withUserView && customerUuid ? customerUuid : undefined,
        user_view: withUserView ? "true" : undefined,
        is_new_api: withUserView ? "true" : undefined,
        separate_pos: withUserView ? "true" : undefined,
      });

    type RawMessagesPayload = {
      success?: boolean;
      error_code?: number;
      messages?: Array<Record<string, unknown>>;
      notes?: Array<Record<string, unknown>>;
      has_phone?: boolean;
      phone_info?: unknown;
      recent_phone_numbers?: unknown[];
      conv_recent_phone_numbers?: unknown[];
      conv_phone_numbers?: unknown[];
    };

    let resData: RawMessagesPayload;
    try {
      resData = await this.requestJson<RawMessagesPayload>(
        "GET",
        buildMsgUrl(useUserViewFirst, validCustomerUuid),
        creds.accessToken,
      );
    } catch (err) {
      if (useUserViewFirst) {
        resData = await this.requestJson<RawMessagesPayload>(
          "GET",
          buildMsgUrl(false),
          creds.accessToken,
        );
      } else {
        throw err;
      }
    }

    // If user_view returned error_code=120 or empty on a comment thread, retry plain public view
    if (
      useUserViewFirst &&
      (resData?.error_code === 120 || (!resData?.messages?.length && resData?.success === false))
    ) {
      resData = await this.requestJson<RawMessagesPayload>("GET", buildMsgUrl(false), creds.accessToken);
    } else if (
      !useUserViewFirst &&
      (resData?.error_code === 120 || (!resData?.messages?.length && resData?.success === false))
    ) {
      // Public view returned error_code=120; resolve customer UUID from conversation if needed and retry user_view
      let customerUuid = validCustomerUuid;
      if (!customerUuid) {
        try {
          const conv = await this.getConversation(conversationId, { connectorKey });
          const customers = Array.isArray(conv.conversation?.customers)
            ? (conv.conversation.customers as Array<Record<string, unknown>>)
            : [];
          const candidateId = String(customers[0]?.id ?? "").trim();
          if (uuidRe.test(candidateId)) customerUuid = candidateId;
        } catch {
          // Ignore lookup error
        }
      }
      if (customerUuid) {
        resData = await this.requestJson<RawMessagesPayload>(
          "GET",
          buildMsgUrl(true, customerUuid),
          creds.accessToken,
        );
      }
    }

    const rawMessages = Array.isArray(resData?.messages) ? resData.messages : [];
    const normalized: NormalizedProviderMessage[] = rawMessages.map((m) => {
      const fromObj = (m.from && typeof m.from === "object" ? m.from : {}) as Record<string, unknown>;
      const senderId = String(fromObj.id ?? m.sender_id ?? m.from_id ?? "").trim() || null;
      const senderName = String(fromObj.name ?? m.sender_name ?? "").trim() || null;
      const direction: "inbound" | "outbound" =
        senderId && senderId !== creds.pageId ? "inbound" : "outbound";
      const originalMessage = typeof m.original_message === "string" ? m.original_message : null;
      const rawText = String(m.original_message ?? m.message ?? m.text ?? "");
      const text = stripHtml(rawText);
      const rawAttachments = Array.isArray(m.attachments) ? m.attachments : [];
      const attachments = rawAttachments.map((att: unknown) => {
        const a = (att && typeof att === "object" ? att : {}) as Record<string, unknown>;
        const imageData = (a.image_data && typeof a.image_data === "object" ? a.image_data : {}) as Record<string, unknown>;
        return {
          type: String(a.type ?? a.attachment_type ?? "unknown"),
          url: String(a.url ?? a.file_url ?? imageData.url ?? "").trim() || null,
          id: String(a.id ?? "").trim() || null,
          name: String(a.name ?? a.filename ?? "").trim() || null,
        };
      });

      return {
        id: String(m.id ?? m.message_id ?? ""),
        senderId,
        senderName,
        direction,
        text,
        originalMessage,
        createdAt: String(m.inserted_at ?? m.created_at ?? ""),
        postId: m.post_id ? String(m.post_id) : null,
        canReplyPrivately:
          typeof m.can_reply_privately === "boolean" ? m.can_reply_privately : null,
        attachments,
        ...(options.includeRaw ? { raw: m } : {}),
      };
    });

    const phoneSet = new Set<string>();
    for (const arr of [
      resData?.recent_phone_numbers,
      resData?.conv_recent_phone_numbers,
      resData?.conv_phone_numbers,
    ]) {
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === "string" && item.trim()) phoneSet.add(item.trim());
          else if (item && typeof item === "object" && "phone_number" in item) {
            const p = String((item as Record<string, unknown>).phone_number ?? "").trim();
            if (p) phoneSet.add(p);
          }
        }
      }
    }

    const limit = options.limit ?? 30;
    return {
      connectorKey,
      pageId: creds.pageId,
      conversationId,
      success: resData?.success === true,
      messagesCount: normalized.length,
      messages: normalized.slice(-limit),
      phoneMetadata: {
        hasPhone: Boolean(resData?.has_phone || phoneSet.size > 0),
        phoneNumbers: Array.from(phoneSet),
      },
      notesCount: Array.isArray(resData?.notes) ? resData.notes.length : 0,
    };
  }

  async getTags(connectorKey?: ConnectorKey): Promise<{
    connectorKey: ConnectorKey;
    pageId: string;
    tags: Array<{ id: string | number; text: string }>;
  }> {
    const { connectorKey: resolvedKey, creds } = this.resolveConnector(connectorKey);
    const url = this.buildUrl("v1", creds, "/tags");
    const res = await this.requestJson<{ tags?: unknown[]; data?: unknown[] }>(
      "GET",
      url,
      creds.accessToken,
    );
    const rawList = Array.isArray(res?.tags)
      ? res.tags
      : Array.isArray(res?.data)
        ? res.data
        : [];
    const tags = rawList
      .map((item) => {
        const t = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return {
          id: (t.id ?? t.tag_id ?? "") as string | number,
          text: String(t.text ?? t.name ?? "").trim(),
        };
      })
      .filter((t) => t.id !== "" && t.text);

    return {
      connectorKey: resolvedKey,
      pageId: creds.pageId,
      tags,
    };
  }

  async addConversationTag(params: {
    conversationId: string;
    tagNameOrId: string | number;
    connectorKey?: ConnectorKey;
    confirmMutation: boolean;
  }): Promise<{
    success: boolean;
    conversationId: string;
    tag: { id: string | number; text: string };
  }> {
    if (!params.confirmMutation) {
      throw new Error("Refusing to mutate conversation tags without confirmMutation=true");
    }
    const { connectorKey, creds } = this.resolveConnector(
      params.connectorKey,
      params.conversationId,
    );
    const { tags } = await this.getTags(connectorKey);
    const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
    const targetNorm = norm(String(params.tagNameOrId));
    const match = tags.find(
      (t) => String(t.id) === String(params.tagNameOrId) || norm(t.text) === targetNorm,
    );
    if (!match) {
      throw new Error(
        `Tag "${params.tagNameOrId}" not found on page ${creds.pageId}. Available tags: ${tags.map((t) => t.text).join(", ")}`,
      );
    }

    const psid = params.conversationId.includes("_")
      ? params.conversationId.split("_").pop()
      : undefined;
    const url = this.buildUrl(
      "v1",
      creds,
      `/conversations/${encodeURIComponent(params.conversationId)}/tags`,
    );
    const res = await this.requestJson<{ success?: boolean }>(
      "POST",
      url,
      creds.accessToken,
      { body: { tag_id: match.id, value: true, psid } },
    );

    return {
      success: res?.success !== false,
      conversationId: params.conversationId,
      tag: match,
    };
  }

  async uploadMedia(params: {
    filePath: string;
    connectorKey?: ConnectorKey;
    mimeType?: string;
    confirmSend: boolean;
  }): Promise<{
    success: boolean;
    id: string;
    attachmentType: string;
    fileName: string;
  }> {
    if (!params.confirmSend) {
      throw new Error("Refusing to upload media without confirmSend=true");
    }
    const { creds } = this.resolveConnector(params.connectorKey);
    const resolvedPath = path.resolve(params.filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }
    const buffer = fs.readFileSync(resolvedPath);
    const fileName = path.basename(resolvedPath);
    const ext = path.extname(fileName).toLowerCase();
    const mimeType =
      params.mimeType ||
      (ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".mp4"
              ? "video/mp4"
              : "application/octet-stream");

    const url = this.buildUrl("v1", creds, "/upload_contents");
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: mimeType }), fileName);

    const response = await this.fetchImpl(url, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(25_000),
    });

    if (!response.ok) {
      throw new Error(`Pancake upload failed with HTTP ${response.status}`);
    }

    const raw = (await response.json()) as Record<string, unknown>;
    return {
      success: raw?.success === true,
      id: typeof raw?.id === "string" ? raw.id : "",
      attachmentType: String(raw?.attachment_type ?? raw?.type ?? ""),
      fileName,
    };
  }

  async sendMessage(params: {
    conversationId: string;
    message?: string;
    contentIds?: string[];
    imagePath?: string;
    connectorKey?: ConnectorKey;
    confirmSend: boolean;
  }): Promise<{
    success: boolean;
    conversationId: string;
    results: Array<{
      kind: "image" | "text";
      success: boolean;
      messageId: string | null;
      attachmentId?: string;
    }>;
  }> {
    if (!params.confirmSend) {
      throw new Error(
        "Refusing to send Pancake message without confirmSend=true. Read-only diagnostics must never send or blindly retry messages.",
      );
    }
    const { connectorKey, creds } = this.resolveConnector(
      params.connectorKey,
      params.conversationId,
    );
    const results: Array<{
      kind: "image" | "text";
      success: boolean;
      messageId: string | null;
      attachmentId?: string;
    }> = [];

    const url = this.buildUrl(
      "v1",
      creds,
      `/conversations/${encodeURIComponent(params.conversationId)}/messages`,
    );

    // 1. Upload & send image if imagePath or contentIds provided
    const contentIds = [...(params.contentIds ?? [])];
    if (params.imagePath) {
      const uploaded = await this.uploadMedia({
        filePath: params.imagePath,
        connectorKey,
        confirmSend: true,
      });
      if (!uploaded.success || !uploaded.id) {
        throw new Error(`Failed to upload image: ${params.imagePath}`);
      }
      contentIds.push(uploaded.id);
    }

    if (contentIds.length > 0) {
      const imgRes = await this.requestJson<{ success?: boolean; id?: string }>(
        "POST",
        url,
        creds.accessToken,
        {
          body: {
            action: "reply_inbox",
            content_ids: contentIds,
            ...(contentIds.length === 1 ? { content_id: contentIds[0] } : {}),
          },
        },
      );
      results.push({
        kind: "image",
        success: imgRes?.success === true,
        messageId: typeof imgRes?.id === "string" ? imgRes.id : null,
        attachmentId: contentIds.join(","),
      });
    }

    // 2. Send text message if provided (Pancake requires text and content_ids in separate calls)
    if (params.message && params.message.trim()) {
      if (results.length > 0) {
        await new Promise((r) => setTimeout(r, 700));
      }
      const txtRes = await this.requestJson<{ success?: boolean; id?: string }>(
        "POST",
        url,
        creds.accessToken,
        {
          body: {
            action: "reply_inbox",
            message: params.message.trim(),
          },
        },
      );
      results.push({
        kind: "text",
        success: txtRes?.success === true,
        messageId: typeof txtRes?.id === "string" ? txtRes.id : null,
      });
    }

    if (results.length === 0) {
      throw new Error("Provide at least one of message, imagePath, or contentIds");
    }

    return {
      success: results.every((r) => r.success),
      conversationId: params.conversationId,
      results,
    };
  }
}
