# Pancake MCP Server (`pancake`)

Unified diagnostics, message/log/decision inspection, direct Pancake Public API v1/v2 inspection, and safe guarded mutations for VietLicense Chat (`pancake.vn` / `pages.fm`).

## Golden Rules

1. **One-Shot First**: When given a Pancake link (`https://pancake.vn/...?c_id=...`), `PAGEID_PSID`, `POSTID_COMMENTID`, `pzl_u_...`, local UUID, or Admin Order ID, call `pancake_diagnose_incident` first. It returns the root-cause diagnosis, recent DB messages, `bot_audit_logs`, and `chatbot2_decisions` in a single call.
2. **Compare DB vs Pancake Provider**: If you suspect a message, image, POS card, or tag in Pancake wasn't ingested or synced into PostgreSQL, call `pancake_inspect_messages` with `source: "both"` or `pancake_get_raw_conversation`.
3. **Read-Only By Default**: Never retry an unknown delivery (`delivery_unknown`) blindly. Mutation tools (`pancake_tags` with `action: "add"`, `pancake_replay_comment_lead`, `pancake_send_test_message`) require explicit confirmation flags (`confirmMutation`, `confirmReplay`, `confirmSend`).

## Tool Quick Reference

| Tool | Purpose |
|------|---------|
| `pancake_status` | Check Ops API health, runtime revision, and Pancake FB/Zalo provider credential readiness |
| `pancake_diagnose_incident` | One-shot root-cause diagnosis + DB messages + `bot_audit_logs` + `chatbot2_decisions` (+ optional raw Pancake API) |
| `pancake_inspect_messages` | Compare DB messages, `bot_audit_logs`, and `chatbot2_decisions` with live Pancake provider messages & attachments |
| `pancake_trace` | Full Ops v2 trace across timeline, turns, deliveries, orders (`order_pushes`), and outreach (`r0`-`r2`/`z1`) |
| `pancake_operations` | Platform-wide runtime, queue depth, outreach status, reliability v2 governor, and settings |
| `pancake_search_conversations` | Search conversations by customer name/phone/tag/text in PostgreSQL or directly on Pancake API |
| `pancake_get_raw_conversation` | Direct Pancake Public API v2 conversation + v1 messages (auto HTML fallback + `user_view=true` POS card support) |
| `pancake_tags` | List page tag catalog or add a tag to a conversation (requires `confirmMutation: true`) |
| `pancake_replay_comment_lead` | Replay deterministic purchase comment flow for a missed FB comment (requires `confirmReplay: true`) |
| `pancake_send_test_message` | Send test text/image to a dedicated test thread (requires `confirmSend: true`) |
