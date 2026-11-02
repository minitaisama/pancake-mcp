import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTargetReference, type PancakeMcpConfig } from "../config.js";
import { PancakeProviderClient } from "../pancake-client.js";
import { OpsDiagnosticsClient } from "../ops-client.js";
import { executePancakeMcpTool, PANCAKE_MCP_TOOLS } from "../tools.js";

function makeTestConfig(): PancakeMcpConfig {
  return {
    opsUrl: "https://chat.vietlicense.vn",
    diagnosticsToken: "diag-test-token",
    pancakeApiUrl: "https://pages.fm",
    facebook: {
      pageId: "1131614906706493",
      accessToken: "fb-access-token",
    },
    zalo: {
      pageId: "pzl_7868329596561174642",
      accessToken: "zalo-access-token",
    },
    configSource: ["test"],
  };
}

describe("parseTargetReference", () => {
  it("parses Pancake VietLicense URL with c_id (Messenger INBOX)", () => {
    const parsed = parseTargetReference(
      "https://pancake.vn/VietLicenseOliuGroup?c_id=1131614906706493_27102859622703796",
      "1131614906706493",
    );
    assert.equal(parsed.kind, "pancake_url");
    assert.equal(parsed.pancakeConversationId, "1131614906706493_27102859622703796");
    assert.equal(parsed.connectorKey, "facebook_vietlicense");
    assert.equal(parsed.surfaceHint, "INBOX");
  });

  it("parses Facebook comment thread ID (POSTID_COMMENTID) and detects COMMENT surface", () => {
    const parsed = parseTargetReference("122130495812867963_950128391029384", "1131614906706493");
    assert.equal(parsed.kind, "pancake_conversation_id");
    assert.equal(parsed.pancakeConversationId, "122130495812867963_950128391029384");
    assert.equal(parsed.connectorKey, "facebook_vietlicense");
    assert.equal(parsed.surfaceHint, "COMMENT");
  });

  it("parses Zalo Personal conversation ID (pzl_u_...)", () => {
    const parsed = parseTargetReference("pzl_u_192837465_7868329596561174642");
    assert.equal(parsed.kind, "pancake_conversation_id");
    assert.equal(parsed.connectorKey, "zalo_thanh");
    assert.equal(parsed.surfaceHint, "INBOX");
  });

  it("parses local UUID conversation ID", () => {
    const parsed = parseTargetReference("d528a086-6210-4c42-9829-4d8a204ea645");
    assert.equal(parsed.kind, "local_uuid");
    assert.equal(parsed.conversationId, "d528a086-6210-4c42-9829-4d8a204ea645");
  });

  it("parses Facebook Graph message mid (m_...)", () => {
    const parsed = parseTargetReference("m_Yx918273918273918273918273");
    assert.equal(parsed.kind, "message_id");
    assert.equal(parsed.messageId, "m_Yx918273918273918273918273");
  });

  it("parses Admin Order ID (cuid or ord_...)", () => {
    const parsed = parseTargetReference("cmv6cogif0fplqp01endssgyf");
    assert.equal(parsed.kind, "order_id");
    assert.equal(parsed.orderId, "cmv6cogif0fplqp01endssgyf");
  });
});

describe("PancakeProviderClient", () => {
  it("falls back to bounded collection scan when direct /v2/conversations/:id returns HTML", async () => {
    const calls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/conversations/1131614906706493_27102859622703796")) {
        return new Response("<!DOCTYPE html><html><body>Pancake SPA</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.includes("/conversations?")) {
        return new Response(
          JSON.stringify({
            conversations: [
              {
                id: "1131614906706493_27102859622703796",
                type: "INBOX",
                seen: true,
                snippet: "Test snippet",
                updated_at: "2026-11-02T08:00:00.000Z",
                page_id: "1131614906706493",
                customers: [{ id: "cust_1", fb_id: "27102859622703796", name: "Minh Tai" }],
                tags: [{ id: 10, text: "Đã thanh toán" }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = new PancakeProviderClient(makeTestConfig(), mockFetch);
    const result = await client.getConversation("1131614906706493_27102859622703796", {
      connectorKey: "facebook_vietlicense",
      lookbackDays: 7,
    });

    assert.equal(result.source, "collection_fallback");
    assert.equal(result.conversation?.id, "1131614906706493_27102859622703796");
    const customers = result.conversation?.customers as Array<Record<string, unknown>>;
    assert.equal(customers[0]?.name, "Minh Tai");
    assert.equal(calls.length, 2);
  });

  it("retries /v1/messages with public view when user_view returns error_code=120", async () => {
    const calls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("user_view=true")) {
        return new Response(
          JSON.stringify({
            success: false,
            error_code: 120,
            message: "Unsupported get request for comment thread",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          messages: [
            {
              id: "122130_950128",
              message: "<div>cho mình xin giá win 11 pro</div>",
              original_message: "cho mình xin giá win 11 pro",
              inserted_at: "2026-11-02T08:10:00.000Z",
              from: { id: "user_99", name: "Khách Comment" },
              attachments: [],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new PancakeProviderClient(makeTestConfig(), mockFetch);
    const res = await client.getMessages("122130_950128", {
      connectorKey: "facebook_vietlicense",
      customerId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      userView: true,
    });

    assert.equal(res.success, true);
    assert.equal(res.messages.length, 1);
    assert.equal(res.messages[0]?.text, "cho mình xin giá win 11 pro");
    assert.equal(calls.length, 2);
  });

  it("blocks tag mutation and message sending unless confirmation flags are true", async () => {
    const client = new PancakeProviderClient(makeTestConfig(), async () => {
      throw new Error("fetch should not be called without confirmation");
    });

    await assert.rejects(
      () =>
        client.addConversationTag({
          conversationId: "1131614906706493_27102859622703796",
          tagNameOrId: "10",
          connectorKey: "facebook_vietlicense",
          confirmMutation: false,
        }),
      /Refusing to mutate conversation tags without confirmMutation=true/,
    );

    await assert.rejects(
      () =>
        client.sendMessage({
          conversationId: "1131614906706493_27102859622703796",
          message: "hello",
          connectorKey: "facebook_vietlicense",
          confirmSend: false,
        }),
      /Refusing to send Pancake message without confirmSend=true/,
    );
  });
});

describe("OpsDiagnosticsClient & MCP Tool Dispatcher", () => {
  it("exposes all 10 expected Pancake MCP tools", () => {
    const names = PANCAKE_MCP_TOOLS.map((t) => t.name);
    assert.deepEqual(names, [
      "pancake_status",
      "pancake_diagnose_incident",
      "pancake_inspect_messages",
      "pancake_trace",
      "pancake_operations",
      "pancake_search_conversations",
      "pancake_get_raw_conversation",
      "pancake_tags",
      "pancake_replay_comment_lead",
      "pancake_send_test_message",
    ]);
  });

  it("runs pancake_diagnose_incident combining Ops v2 incident + Admin messages + logs + Chatbot2 decisions", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/ops/v2/diagnostics/incident")) {
        return new Response(
          JSON.stringify({
            subject: {
              localConversationId: "d528a086-6210-4c42-9829-4d8a204ea645",
              pancakeConversationId: "1131614906706493_27102859622703796",
            },
            diagnosis: {
              firstBrokenStage: null,
              summary: "Hệ thống đã gửi xác nhận đơn hàng thành công.",
              recommendedNextChecks: ["Kiểm tra trạng thái order_pushes"],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/admin/conversations/d528a086-6210-4c42-9829-4d8a204ea645?")) {
        return new Response(
          JSON.stringify({
            conversation: {
              id: "d528a086-6210-4c42-9829-4d8a204ea645",
              pancake_conversation_id: "1131614906706493_27102859622703796",
              customer_name: "Minh Tài",
              connector_key: "facebook_vietlicense",
              tags: ["Cá nhân", "Đã thanh toán"],
            },
            messages: [
              {
                id: "msg_1",
                direction: "inbound",
                sender_name: "Minh Tài",
                content: "Mình đã chuyển khoản nhé",
                created_at: "2026-11-02T08:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/admin/conversations/d528a086-6210-4c42-9829-4d8a204ea645/logs")) {
        return new Response(
          JSON.stringify({
            logs: [
              {
                id: "log_1",
                status: "replied",
                outcome: "order_confirmation_sent",
                userMessage: "Mình đã chuyển khoản nhé",
                createdAt: "2026-11-02T08:00:05.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/admin/chatbot2/decisions")) {
        return new Response(
          JSON.stringify({
            decisions: [
              {
                id: "dec_1",
                conversation_id: "d528a086-6210-4c42-9829-4d8a204ea645",
                inbound_message_ref: "msg_1",
                action: "abstain",
                reason_codes: ["order_flow_owned"],
                created_at: "2026-11-02T08:00:02.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const cfg = makeTestConfig();
    const opsClient = new OpsDiagnosticsClient(cfg, mockFetch);
    const providerClient = new PancakeProviderClient(cfg, mockFetch);

    const res = (await executePancakeMcpTool(
      "pancake_diagnose_incident",
      {
        target: "https://pancake.vn/VietLicenseOliuGroup?c_id=1131614906706493_27102859622703796",
        providerRead: "never",
      },
      { config: cfg, opsClient, providerClient },
    )) as {
      inspection: {
        localConversationId: string;
        pancakeConversationId: string;
        customerName: string;
        auditLogs: Array<{ outcome: string }>;
        chatbot2Decisions: Array<{ reasonCodes: string[] }>;
      };
    };

    assert.equal(res.inspection.localConversationId, "d528a086-6210-4c42-9829-4d8a204ea645");
    assert.equal(res.inspection.pancakeConversationId, "1131614906706493_27102859622703796");
    assert.equal(res.inspection.customerName, "Minh Tài");
    assert.equal(res.inspection.auditLogs.length, 1);
    assert.equal(res.inspection.auditLogs[0]?.outcome, "order_confirmation_sent");
    assert.deepEqual(res.inspection.chatbot2Decisions[0]?.reasonCodes, ["order_flow_owned"]);
  });

  it("enforces confirmReplay=true on replayCommentLead", async () => {
    const ops = new OpsDiagnosticsClient(makeTestConfig(), async () => {
      throw new Error("Should not call fetch when confirmReplay=false");
    });

    await assert.rejects(
      () =>
        ops.replayCommentLead({
          target: "d528a086-6210-4c42-9829-4d8a204ea645",
          confirmReplay: false,
        }),
      /Refusing to replay comment lead without confirmReplay=true/,
    );
  });
});
