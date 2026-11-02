---
name: pancake
description: Unified Pancake (pancake.vn / pages.fm) & VietLicense Chat troubleshooting, message/attachment/log/decision inspection, direct Pancake Public API v1/v2 inspection, and guarded operational actions. Activate this skill whenever the user mentions Pancake, pages.fm, a Pancake link (c_id=...), chat troubleshooting, bot replies (Auto Pilot, Chatbot 2.0, Ads Preset, Auto Comment, Price Commands), Outreach (R0, R0 Video, Z1, R1, R2), Create Order / payment bill confirmation, or Zalo QR tagging.
---

# Pancake & Chat Troubleshooting (`pancake`)

This skill provides a 1-to-2-call workflow for diagnosing and operating **Pancake (`pancake.vn` / `pages.fm`)** and **VietLicense Chat (`chat.vietlicense.org`)** across both **Facebook Page (`facebook_vietlicense`, page `1131614906706493`)** and **Zalo Personal (`zalo_thanh`, page `pzl_2129315222293162170`)**.

---

## 1. Golden Rules

1. **One-Call Diagnosis First (`pancake_diagnose_incident` / `pancake-mcp diagnose`)**:
   - Whenever the user gives a Pancake URL (`https://pancake.vn/...?c_id=...`), a Pancake conversation ID (`PAGEID_PSID`, `POSTID_COMMENTID`, `pzl_u_...`), a local UUID, a message ID (`m_...`), or an Admin Order ID, call `pancake_diagnose_incident` (or CLI `pancake-mcp diagnose "<target>"`) **first**.
   - In a single round-trip, it returns:
     - **Ops v2 Pipeline Stage Diagnosis** (`firstBrokenStage`, root cause explanation, recommended next checks)
     - **Full DB Conversation Context** (`messages`, `tags`, `botControl`, `latestOrder`, `sync` checkpoint)
     - **Recent `chatbot2_decisions`** (including `action`, `topicKey`, `replyRouteKey`, `priceCommandKey`, and `reasonCodes`)
     - **Recent `bot_audit_logs`** (`status`, `outcome`, `debug`)
2. **Compare DB vs Live Pancake Provider (`pancake_inspect_messages` / `pancake_get_raw_conversation`)**:
   - If you suspect a customer message, payment receipt image, Zalo QR image, POS order card, or tag exists on Pancake but was not ingested or parsed by the bot, call `pancake_inspect_messages` with `source: "both"` (or CLI `pancake-mcp messages "<target>" --source both`).
   - Direct Pancake API calls automatically handle Pancake's quirks:
     - **Single-conversation `/v2` HTML quirk**: Automatically falls back to a bounded `/v2/pages/:id/conversations` collection scan when `/v2/pages/:id/conversations/:convId` returns the HTML SPA shell.
     - **POS Order Card & `error_code=120` quirk**: Distinguishes internal Pancake customer UUIDs from Facebook PSIDs on `/v1/pages/:id/conversations/:convId/messages` and automatically falls back between `user_view=true` (POS cards) and public view on comment threads.
3. **Read-Only by Default — Never Blindly Retry**:
   - Never blindly resend a message in `delivery_unknown` state.
   - All mutation tools (`pancake_tags` with `action: "add"`, `pancake_replay_comment_lead`, `pancake_send_test_message`) require explicit confirmation flags (`confirmMutation: true`, `confirmReplay: true`, `confirmSend: true`).
   - Only use `pancake_send_test_message` on dedicated test threads (such as `1131614906706493_27102859622703796`) or when explicitly instructed by the user.

---

## 2. MCP Tools (`ServerName: "pancake"`) & CLI (`pancake-mcp`)

Every agent can either call the MCP server `pancake` or invoke the global CLI `/Users/agent0/.local/bin/pancake-mcp`:

| MCP Tool (`ServerName: "pancake"`) | CLI Command (`pancake-mcp`) | Purpose |
|------------------------------------|-----------------------------|---------|
| `pancake_status` | `pancake-mcp status` | Verify Ops API token, Facebook Page token, Zalo token, and live runtime health |
| `pancake_diagnose_incident` | `pancake-mcp diagnose <target> [--raw-provider]` | **Primary tool**: v2 stage diagnosis + DB messages + `bot_audit_logs` + `chatbot2_decisions` (+ optional raw Pancake messages) |
| `pancake_inspect_messages` | `pancake-mcp messages <target> --source both` | Side-by-side DB messages/logs/decisions and live Pancake provider messages/attachments/phone metadata |
| `pancake_trace` | `pancake-mcp trace <target> --scope all` | Normalized Diagnostics v2 evidence graph + chronological timeline across `conversation`, `interactive`, `order`, `outreach` |
| `pancake_operations` | `pancake-mcp operations --section all --overview` | System-wide queues, ingest cursors, Outreach R0–R2/Z1 backlog & SLA, Reliability v2 governor, bulk campaigns |
| `pancake_search_conversations` | `pancake-mcp search --source db --q "<query>"` | Search conversations in PostgreSQL (`q`, `tag`, `connectorKey`) or directly on Pancake v2 API (`INBOX`/`COMMENT`, `unreadFirst`, `tag`) |
| `pancake_get_raw_conversation` | `pancake-mcp raw <target>` | Direct Pancake Public API v2 conversation metadata + v1 messages |
| `pancake_tags` | `pancake-mcp tags` | List page tag catalog (`action: "list"`) or add a tag to a conversation (`action: "add"`, `confirmMutation: true`) |
| `pancake_replay_comment_lead` | `pancake-mcp replay-comment <target> --confirm` | Replay deterministic Auto Comment retail flow (public reply + inbox opener) when `can_reply_privately` is valid |
| `pancake_send_test_message` | `pancake-mcp send <target> --confirm --text "..."` | Upload/send image and/or text to a test thread (`confirmSend: true` required) |

### Credential Sync (`auth sync-dokploy`)

If `pancake_status` shows missing tokens on a fresh machine or after a token rotation:
```bash
pancake-mcp auth sync-dokploy
```
This reads local `.env` plus the authenticated Dokploy `vl-chat` application environment (`zFOnzXuYWQLDCvsqhyCjv`) and saves credentials into `~/.config/pancake-mcp/config.json` with `0600` permissions.

---

## 3. System Architecture & Troubleshooting Flow Cheat-Sheet

Understanding how `vietlicense-chat` processes Pancake conversations ensures immediate root-cause identification:

### A. Ingest & Discovery (`src/pancake/poller.ts`)
- **Two Connectors**:
  - `facebook_vietlicense` (`pageId: 1131614906706493`) — Messenger `INBOX` and Facebook Post `COMMENT`
  - `zalo_thanh` (`pageId: pzl_2129315222293162170`) — Zalo Personal `INBOX` (`pzl_u_...`)
- **Reliability v2 Discovery**: Lists changed conversations from Pancake v2 API, admits them into `pancake_realtime_candidates`, and hydrates bounded batches through the work-conserving Page API governor (`withPancakeApiPurpose`).
- **Checkpoints**: Stored in `conversations.metadata.pancake_checkpoint` (`last_message_id`, `last_message_at`). Messages older than `BOOT_AT` on first discovery are seeded without triggering replies.

### B. Interactive Auto Pilot (4 Pillars + Send Policy v2)
When `reply_mode = "auto_pilot"`, interactive replies are strictly governed by **Send Policy v2 ("match là gửi")**:
- Supporter/staff replies **never** block or delay automation (no 15-minute cooldown, no automatic `human_taken_over`). Supporter messages only seal the current customer turn so later customer messages start a fresh turn.
- Only `replyMode = "off"`, Chatbot 2.0 `kill_switch` / `mode`, or explicit Admin Stop Bot (`metadata.bot_stopped_by = "admin_stop_bot"`) disables replies.
- **Pillar 1 — Ads Preset (`src/agent/ad_preset_intent.ts`)**: Deterministic replies to Facebook Ad click/preset prompts (`src/quick_replies/deterministic_quick_reply_templates.ts`). Always sends when matched.
- **Pillar 2 — Auto Comment (`src/pancake/comment_retail_flow.ts`)**: Deterministic purchase comment flow (public comment ack + private Messenger inbox opener). Comments on excluded posts (`src/pancake/auto_comment_post_exclusions.ts`) log `auto_comment_post_excluded`.
- **Pillar 3 — Price Command (`src/price_commands/`)**: Explicit `/gia*`, `/win*`, `/off*` commands typed by Page admins/staff or matched via Chatbot 2.0.
- **Pillar 4 — Chatbot 2.0 (`src/chatbot2/`)**: Top 20 FAQ topics + Price Commands using the synced Pancake quick-reply catalog.
  - **7-Day Repeat Guard**: Each FAQ topic / Price Command sends at most once per conversation per 7 days (`CHATBOT2_REPEAT_WINDOW_DAYS`, `delivery_unknown` counts as sent).
  - **Ownership Abstains (`reason_codes` in `chatbot2_decisions`)**:
    - `human_or_b2b_tag_owned`: Conversation has tag `Doanh nghiệp`.
    - `customer_phone_or_zalo_handoff`: Customer sent a phone number or Zalo contact.
    - `order_flow_owned` / `complaint_or_case_specific` / `bulk_or_custom_quote` / `multiple_routes_ambiguous`: Intentionally handed off to human staff.
  - **Composite Turns**: Ads Preset + VAT or Price Command + VAT appends verbatim `/vat` in the same delivery plan (`src/chatbot2/composite_addon.ts`).

### C. Order Confirmation, Payment Bill Vision & Zalo QR Tagger
- **POS Order Push (`order_pushes`)**: Supporter creates/confirms order; system parses order info and pushes to VietLicense Admin API (`order_admin_push`).
- **Payment Bill Verification (`src/orders/order_confirmation.ts`)**:
  - When a customer sends an image on a conversation with an active order or bank transfer context, the Vision LLM (`gpt-5.4-mini`) inspects the attachment URL (`checkIfImageIsPaymentReceipt`).
  - Requires `isReceipt === true` and `confidence >= 0.6` (`PAYMENT_RECEIPT_MIN_CONFIDENCE`).
  - Common root causes when an order confirmation isn't sent:
    1. Pancake attachment URL was missing or expired before ingest (`attachmentsCount === 0` in DB vs `providerInspection`).
    2. Customer sent a screenshot of a product/error instead of a bank transfer receipt (`isReceipt: false`).
    3. Order was already confirmed (`already_confirmed` / tag `Đã thanh toán` already present).
- **Zalo QR Tagger (`src/pancake/zalo_qr_tagger.ts`)**:
  - Scans inbound customer images for Zalo personal QR codes (local `jsQR` decode for `zalo.me` / `qr.zalo.me` URLs + Vision fallback) and tags the conversation `QR Zalo`.

### D. Outreach Sequences (Website +6h → R0 Video +12h → R0 +48h → R1 D+4 → R2 D+6 & Z1 +24h)
- **Window**: R0/R1/R2 send only `08:00–21:00` (`Asia/Ho_Chi_Minh`); Z1 sends `09:15–22:30` (24h after latest phone/Zalo contact).
- **Hard Stop Conditions**: Any customer response after the latest reminder, populated `customers.phone`, purchase (`Đã thanh toán`), hard refusal, opt-out, blocked/support/spam/`RÁC` tag, or prior outbound sale phone `0382 520 281` immediately suppresses later steps.
- **Ambiguous POST (`delivery_unknown`)**: Never retried blindly; isolated for GET reconciliation against Pancake messages.

---

## 4. Detailed Playbooks

For step-by-step diagnostic recipes (Bot didn't reply, Payment bill didn't confirm order, Auto Comment didn't DM customer, Outreach R0/R1/R2 skipped, or Delivery stuck in `delivery_unknown`), read:
- `references/playbooks.md`
