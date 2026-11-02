# Pancake Troubleshooting Playbooks

Step-by-step playbooks for the 6 most common Pancake & VietLicense Chat troubleshooting scenarios.

---

## Playbook 1: "Tại sao bot không rep khách này?" (Bot Did Not Reply)

1. **Run One-Shot Diagnosis**:
   ```bash
   pancake-mcp diagnose "<pancake_url_or_c_id>"
   ```
   Or call MCP tool `pancake_diagnose_incident` with `target`.
2. **Check the 4 Layers in the Output**:
   - **Layer 1 — Ingest (`firstBrokenStage === " pancake_ingest"`)**:
     - Was the customer message ingested into `inspection.messages`?
     - If missing in DB, run `pancake-mcp messages "<target>" --source both` to check if the message exists on Pancake API (`providerInspection.messages`) and compare its `createdAt` against `inspection.sync`.
   - **Layer 2 — Conversation / Bot Control (`inspection.botControl` & `inspection.tags`)**:
     - Is `botControl.stopped === true` (`metadata.bot_stopped_by === "admin_stop_bot"`)?
     - Does `inspection.tags` include `"Doanh nghiệp"` (`human_or_b2b_tag_owned`)?
   - **Layer 3 — Chatbot 2.0 Decision (`inspection.chatbot2Decisions`)**:
     - Look at the latest decision's `action` (`send` vs `abstain`) and `reasonCodes`:
       - `repeat_topic_within_window` / `repeat_price_command_within_window`: Already sent this FAQ topic or Price Command within the last 7 days (`CHATBOT2_REPEAT_WINDOW_DAYS`).
       - `customer_phone_or_zalo_handoff`: Customer provided a phone number or Zalo contact; bot hands off to sale staff.
       - `order_flow_owned` / `complaint_or_case_specific` / `bulk_or_custom_quote`: Classifier abstained so human staff can handle case-specific/order details.
   - **Layer 4 — Outbound Delivery (`incident.trace.interactive.deliveries`)**:
     - Did the bot decide to send, but Pancake API rejected the POST (e.g., 24h messaging window expired, user blocked page, or `delivery_unknown`)?

---

## Playbook 2: "Khách gửi bill chuyển khoản nhưng chưa xác nhận đơn / chưa nhảy tag Đã thanh toán"

1. **Inspect Both DB and Raw Provider Messages**:
   ```bash
   pancake-mcp messages "<pancake_url_or_c_id>" --source both --raw
   ```
2. **Verify Image Attachment & Order State**:
   - Check `providerInspection.messages` for the customer's image message: does `attachments` contain `type: "photo"` with a valid `url`?
   - Check `dbInspection.messages`: was `attachmentsCount > 0` recorded when ingested?
   - Check `dbInspection.auditLogs` for `outcome`:
     - `order_confirmation_sent`: Order confirmation succeeded.
     - `payment_receipt_rejected` / `not_payment_receipt`: Vision LLM (`checkIfImageIsPaymentReceipt`) returned `isReceipt: false` or `confidence < 0.6`.
     - Check `dbInspection.latestOrder` or run `pancake-mcp trace "<target>" --scope order` to inspect `order_pushes` status (`confirmed`, `pushed`, `failed`).

---

## Playbook 3: "Khách comment bài post nhưng bot không trả lời comment / không inbox"

1. **Diagnose the Comment Thread**:
   ```bash
   pancake-mcp diagnose "<comment_url_or_POSTID_COMMENTID>" --raw-provider
   ```
2. **Check Common Comment Exclusions & Constraints**:
   - **Excluded Post**: Check `auditLogs` for `auto_comment_post_excluded` (listed in `src/pancake/auto_comment_post_exclusions.ts`).
   - **Non-Purchase Intent**: Did the comment match a retail purchase / price question, or was it a tag-only / sticker / unrelated comment?
   - **Facebook `can_reply_privately: false`**: Check `providerMessages.messages[0].canReplyPrivately`. If Facebook blocks private replies (e.g., commenter privacy settings or old comment), the bot cannot open a private inbox thread via comment reply.
3. **Replay Missed Comment Lead (Only When Authorized)**:
   - If the comment was a valid retail lead that was missed during downtime, replay it safely:
     ```bash
     pancake-mcp replay-comment "<target>" --confirm
     ```

---

## Playbook 4: "Tại sao khách không nhận được R0 / R0 Video / Z1 / R1 / R2?"

1. **Run Outreach Trace**:
   ```bash
   pancake-mcp trace "<target>" --scope outreach
   ```
2. **Check Step Eligibility & Suppression Reasons**:
   - **Circuit State**: Run `pancake-mcp operations --section outreach` to see if the step (`r0`, `r0_video`, `z1`, `r1`, `r2`) is globally `paused` or `disabled` (e.g. `r0_video` and `z1` default to paused unless enabled by admin).
   - **Send Hours**: R0/R1/R2 only dispatch between `08:00` and `21:00` (`Asia/Ho_Chi_Minh`); Z1 dispatches `09:15–22:30`.
   - **Hard Suppression**:
     - Customer replied after the previous reminder (`customer_replied_after_anchor`).
     - `customers.phone` is populated (suppresses R0/R1/R2; triggers Z1 +24h instead).
     - Conversation has tag `Đã thanh toán`, `RÁC`, `Spam`, or `Blocked`.
     - Outbound message already contained sale phone `0382 520 281`.
   - **Dependency Gate**:
     - R1 requires confirmed R0 delivery.
     - R2 requires confirmed R1 text + confirmed/validly-skipped R1 album images + at least 24 hours since R1 completion.

---

## Playbook 5: "Kiểm tra tổng thể hệ thống khi có độ trễ hoặc nghẽn hàng đợi"

1. **Check Operations & Governor Telemetry**:
   ```bash
   pancake-mcp operations --section all --overview
   ```
2. **Evaluate Key Health Indicators**:
   - `runtime`: Verify `gitSha`, `uptimeSeconds`, `replyMode` (`auto_pilot`), and `discoveryMode` (`realtime`).
   - `reliability`: Check `pancake_realtime_candidates` backlog, hydration latency, and Page API governor lane wait times (`interactive_send`, `realtime_hydrate`, `outreach_send`, `read_observability`).
   - `queues`: Check `stale_dispatch_leases`, `delivery_unknown` count, and `order_admin_push` failures.
