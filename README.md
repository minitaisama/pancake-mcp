# pancake-mcp

**Unified Model Context Protocol (MCP) Server, CLI & Agent Skill for Pancake (`pancake.vn` / `pages.fm`) and Chat Diagnostics.**

`pancake-mcp` collapses multi-step chat, bot, order, and outreach troubleshooting into a **single MCP tool call or CLI command**. It connects both to your **Chat Diagnostics / Admin API** (`/api/ops/v1/*`, `/api/ops/v2/*`, `/api/admin/*`) and directly to the **Pancake Public API v1 & v2** (`https://pages.fm/api/public_api/v1` & `v2`) across Facebook Pages (`INBOX` & `COMMENT`) and Zalo Personal connectors.

---

## Key Capabilities

1. **One-Call Incident Diagnosis (`pancake_diagnose_incident`)**:
   - Accepts any target format: Pancake URL (`https://pancake.vn/...?c_id=...`), Pancake conversation ID (`PAGEID_PSID`, `POSTID_COMMENTID`, `pzl_u_...`), local database UUID, Facebook message ID (`m_...`), or Admin Order ID.
   - Returns in one call:
     - **Diagnostics v2 Stage Verdict** (`firstBrokenStage` across Auto Pilot, Outreach R0–R2/Z1, Create Order)
     - **Recent DB Messages & Sync Checkpoints**
     - **Chatbot 2.0 Decisions** (`action`, `topicKey`, `replyRouteKey`, `priceCommandKey`, `reasonCodes`)
     - **Bot Audit Logs** (`status`, `outcome`, `debug`)
     - **Latest Order Push** (`orderId`, `orderUrl`, `totalVnd`)
2. **Side-by-Side DB vs. Pancake Provider Inspection (`pancake_inspect_messages` & `pancake_get_raw_conversation`)**:
   - Automatically handles Pancake Public API quirks:
     - **Single-conversation `/v2` HTML fallback**: Falls back to a bounded `/v2/pages/:id/conversations` collection scan when `/v2/pages/:id/conversations/:convId` returns an HTML SPA shell.
     - **POS Cards & `error_code=120` fallback**: Queries `/v1/pages/:id/conversations/:convId/messages` with `user_view=true&is_new_api=true&separate_pos=true&customer_id=<psid>` to expose POS cards and attachments, and automatically retries in public view when `error_code=120` is returned on Facebook comment threads.
3. **Read-Only by Default, Guarded Mutations**:
   - Read-only diagnostics never trigger outbound customer messages or blind retries of `delivery_unknown` states.
   - Mutation tools (`pancake_tags` with `action="add"`, `pancake_replay_comment_lead`, `pancake_send_test_message`) require explicit confirmation flags (`confirmMutation: true`, `confirmReplay: true`, `confirmSend: true`).

---

## Installation & Build

```bash
npm install
npm run build
npm test
```

### Global CLI Link

```bash
ln -sf "$(pwd)/dist/cli.js" ~/.local/bin/pancake-mcp
chmod +x dist/cli.js
```

---

## Configuration

`pancake-mcp` resolves credentials in the following order:
1. Process environment variables (`process.env`)
2. Local user config file `~/.config/pancake-mcp/config.json` (`0600` permissions)
3. `.env` file in the current working directory

See `.env.example` for all supported environment variables:

```bash
VIETLICENSE_CHAT_OPS_URL=https://chat.example.com
CHAT_DIAGNOSTICS_TOKEN=your_diagnostics_token_here
PANCAKE_API_URL=https://pages.fm
PANCAKE_PAGE_ID=your_facebook_page_id
PANCAKE_ACCESS_TOKEN=your_facebook_page_access_token
PANCAKE_ZALO_PAGE_ID=your_zalo_page_id
PANCAKE_ZALO_ACCESS_TOKEN=your_zalo_access_token
```

If you have an authenticated `dokploy` CLI setup on your workstation, sync credentials into `~/.config/pancake-mcp/config.json` (`0600`) with:

```bash
pancake-mcp auth sync-dokploy
```

---

## CLI Usage

```bash
# Check Ops API + Pancake provider credential readiness & runtime health
pancake-mcp status

# One-call full diagnosis from a Pancake URL or conversation ID
pancake-mcp diagnose "https://pancake.vn/VietLicenseOliuGroup?c_id=1131614906706493_27102859622703796"

# Compare DB messages/logs/decisions with live Pancake API messages & attachments
pancake-mcp messages 1131614906706493_27102859622703796 --source both --limit 20

# Inspect Diagnostics v2 trace across conversation | interactive | order | outreach | all
pancake-mcp trace 1131614906706493_27102859622703796 --scope order

# Platform-wide operations, queues, outreach backlogs, and reliability governor
pancake-mcp operations --section all --overview

# Search conversations in DB or directly on Pancake API
pancake-mcp search --source db --tag "Doanh nghiệp" --limit 10
pancake-mcp search --source provider --type COMMENT --unread --limit 10

# Fetch raw conversation metadata + messages directly from Pancake Public API
pancake-mcp raw 1131614906706493_27102859622703796

# List page tags
pancake-mcp tags --connector facebook_vietlicense
```

---

## MCP Server Configuration

Add `pancake` to your MCP client configuration (e.g., `~/.gemini/config/mcp_config.json` or Claude Desktop config):

```json
{
  "mcpServers": {
    "pancake": {
      "command": "node",
      "args": ["/path/to/pancake-mcp/dist/cli.js", "serve"]
    }
  }
}
```

To export lazy-loaded MCP tool schemas (`<toolName>.json` + `instructions.md`):

```bash
pancake-mcp export-schemas ~/.gemini/antigravity/mcp/pancake
```

---

## Included Agent Skill

The repository includes a ready-to-use agent skill in [`skills/pancake-mcp/`](./skills/pancake-mcp/):
- [`skills/pancake-mcp/SKILL.md`](./skills/pancake-mcp/SKILL.md) — Architecture cheat-sheet, 4-pillar Auto Pilot rules, Send Policy v2, Order/Payment Bill Vision rules, Outreach R0–R2/Z1 gates, and MCP tool routing.
- [`skills/pancake-mcp/references/playbooks.md`](./skills/pancake-mcp/references/playbooks.md) — Step-by-step troubleshooting playbooks.

---

## License

MIT
