import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface ConnectorCredentials {
  pageId: string;
  accessToken: string;
}

export interface PancakeMcpConfig {
  opsUrl: string;
  diagnosticsToken: string;
  pancakeApiUrl: string;
  facebook: ConnectorCredentials;
  zalo: ConnectorCredentials;
  configSource: string[];
}

export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".config", "pancake-mcp");
export const DEFAULT_CONFIG_FILE = path.join(DEFAULT_CONFIG_DIR, "config.json");

export function parseDotEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function readJsonFileSafe(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function readEnvFileSafe(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {};
    return parseDotEnvContent(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export function resolveConfig(overrides?: Partial<{
  opsUrl: string;
  diagnosticsToken: string;
  pancakeApiUrl: string;
  facebookPageId: string;
  facebookAccessToken: string;
  zaloPageId: string;
  zaloAccessToken: string;
  envFilePath: string;
  configFilePath: string;
}>): PancakeMcpConfig {
  const sources: string[] = [];
  const configFile = overrides?.configFilePath || process.env.PANCAKE_MCP_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  const storedConfig = readJsonFileSafe(configFile);
  if (Object.keys(storedConfig).length > 0) {
    sources.push(`config:${configFile}`);
  }

  const candidateEnvFiles = [
    overrides?.envFilePath,
    process.env.PANCAKE_MCP_ENV_FILE,
    path.join(process.cwd(), ".env"),
  ].filter((x): x is string => Boolean(x));

  const fileEnv: Record<string, string> = {};
  for (const envPath of candidateEnvFiles) {
    const parsed = readEnvFileSafe(envPath);
    if (Object.keys(parsed).length > 0) {
      Object.assign(fileEnv, parsed);
      sources.push(`env:${envPath}`);
      break;
    }
  }

  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const envVal = process.env[k]?.trim();
      if (envVal) return envVal;
    }
    for (const k of keys) {
      const storedVal = storedConfig[k]?.trim();
      if (storedVal) return storedVal;
    }
    for (const k of keys) {
      const fileVal = fileEnv[k]?.trim();
      if (fileVal) return fileVal;
    }
    return "";
  };

  if (Object.keys(process.env).some((k) => k.startsWith("PANCAKE_") || k.startsWith("CHAT_DIAGNOSTICS") || k.startsWith("VIETLICENSE_"))) {
    sources.unshift("process.env");
  }

  const opsUrl = (
    overrides?.opsUrl ||
    pick("VIETLICENSE_CHAT_OPS_URL", "CHAT_OPS_URL") ||
    "http://127.0.0.1:3000"
  ).replace(/\/+$/, "");

  const diagnosticsToken = overrides?.diagnosticsToken || pick("CHAT_DIAGNOSTICS_TOKEN");
  const pancakeApiUrl = (
    overrides?.pancakeApiUrl ||
    pick("PANCAKE_API_URL") ||
    "https://pages.fm"
  ).replace(/\/+$/, "");

  const facebookPageId =
    overrides?.facebookPageId ||
    pick("PANCAKE_PAGE_ID", "PANCAKE_VIETLICENSE_PAGE_ID", "VIETLICENSE_FB_PAGE_ID");
  const facebookAccessToken =
    overrides?.facebookAccessToken ||
    pick(
      "PANCAKE_ACCESS_TOKEN",
      "PANCAKE_API_KEY",
      "PANCAKE_VIETLICENSE_ACCESS_TOKEN",
      "VIETLICENSE_FB_ACCESS_TOKEN",
    );

  const zaloPageId =
    overrides?.zaloPageId ||
    pick("PANCAKE_ZALO_PAGE_ID");
  const zaloAccessToken =
    overrides?.zaloAccessToken ||
    pick("PANCAKE_ZALO_ACCESS_TOKEN");

  return {
    opsUrl,
    diagnosticsToken,
    pancakeApiUrl,
    facebook: {
      pageId: facebookPageId,
      accessToken: facebookAccessToken,
    },
    zalo: {
      pageId: zaloPageId,
      accessToken: zaloAccessToken,
    },
    configSource: sources.length > 0 ? sources : ["defaults"],
  };
}

export function saveLocalConfig(
  values: Record<string, string>,
  configFilePath = DEFAULT_CONFIG_FILE,
): { path: string; keysUpdated: string[] } {
  const dir = path.dirname(configFilePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = readJsonFileSafe(configFilePath);
  const merged: Record<string, string> = { ...existing };
  const keysUpdated: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string" && v.trim()) {
      merged[k] = v.trim();
      keysUpdated.push(k);
    }
  }
  fs.writeFileSync(configFilePath, JSON.stringify(merged, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(configFilePath, 0o600);
  } catch {
    // Ignore chmod errors on non-POSIX filesystems
  }
  return { path: configFilePath, keysUpdated };
}

export async function syncCredentialsFromDokploy(options?: {
  applicationId?: string;
  envFilePath?: string;
  configFilePath?: string;
}): Promise<{
  configPath: string;
  keysSaved: string[];
  hasOpsToken: boolean;
  hasFacebookToken: boolean;
  hasZaloToken: boolean;
}> {
  const appId = options?.applicationId || process.env.DOKPLOY_VL_CHAT_APP_ID || "zFOnzXuYWQLDCvsqhyCjv";
  const collected: Record<string, string> = {};

  // 1. Read local .env if available
  const envCandidates = [
    options?.envFilePath,
    process.env.PANCAKE_MCP_ENV_FILE,
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), "Desktop", "Code Work ", "vietlicense-chat", ".env"),
  ].filter((x): x is string => Boolean(x));

  for (const candidate of envCandidates) {
    const parsed = readEnvFileSafe(candidate);
    if (Object.keys(parsed).length > 0) {
      for (const k of [
        "VIETLICENSE_CHAT_OPS_URL",
        "CHAT_DIAGNOSTICS_TOKEN",
        "PANCAKE_API_URL",
        "PANCAKE_PAGE_ID",
        "PANCAKE_VIETLICENSE_PAGE_ID",
        "PANCAKE_ACCESS_TOKEN",
        "PANCAKE_API_KEY",
        "PANCAKE_ZALO_PAGE_ID",
        "PANCAKE_ZALO_ACCESS_TOKEN",
      ]) {
        if (parsed[k]) collected[k] = parsed[k];
      }
      break;
    }
  }

  // 2. Read Dokploy application environment if dokploy CLI is installed and authenticated
  try {
    const cliPath = execFileSync("which", ["dokploy"], { encoding: "utf8" }).trim();
    const realCliPath = fs.realpathSync(cliPath);
    const dokployConfigPath = path.resolve(path.dirname(realCliPath), "..", "config.json");
    if (fs.existsSync(dokployConfigPath)) {
      const { url, token } = JSON.parse(fs.readFileSync(dokployConfigPath, "utf8")) as {
        url?: string;
        token?: string;
      };
      if (url && token) {
        const endpoint = new URL("/api/trpc/application.one", url);
        endpoint.searchParams.set("input", JSON.stringify({ json: { applicationId: appId } }));
        const response = await fetch(endpoint, {
          headers: { "x-api-key": token },
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          const body = (await response.json()) as {
            result?: { data?: { json?: { env?: string } } };
          };
          const envStr = String(body.result?.data?.json?.env ?? "");
          const remoteEnv = parseDotEnvContent(envStr);
          const pageId =
            remoteEnv.PANCAKE_VIETLICENSE_PAGE_ID ||
            remoteEnv.PANCAKE_PAGE_ID ||
            remoteEnv.VIETLICENSE_FB_PAGE_ID ||
            "";
          const fbToken =
            remoteEnv.PANCAKE_VIETLICENSE_ACCESS_TOKEN ||
            remoteEnv.PANCAKE_API_KEY ||
            remoteEnv.PANCAKE_ACCESS_TOKEN ||
            remoteEnv.VIETLICENSE_FB_ACCESS_TOKEN ||
            "";
          if (pageId) collected.PANCAKE_PAGE_ID = pageId;
          if (fbToken) collected.PANCAKE_ACCESS_TOKEN = fbToken;
          if (remoteEnv.PANCAKE_ZALO_PAGE_ID) collected.PANCAKE_ZALO_PAGE_ID = remoteEnv.PANCAKE_ZALO_PAGE_ID;
          if (remoteEnv.PANCAKE_ZALO_ACCESS_TOKEN) collected.PANCAKE_ZALO_ACCESS_TOKEN = remoteEnv.PANCAKE_ZALO_ACCESS_TOKEN;
          if (remoteEnv.CHAT_DIAGNOSTICS_TOKEN && !collected.CHAT_DIAGNOSTICS_TOKEN) {
            collected.CHAT_DIAGNOSTICS_TOKEN = remoteEnv.CHAT_DIAGNOSTICS_TOKEN;
          }
        }
      }
    }
  } catch {
    // Dokploy CLI optional; proceed with local env values
  }

  const saved = saveLocalConfig(collected, options?.configFilePath);
  const resolved = resolveConfig({ configFilePath: options?.configFilePath });
  return {
    configPath: saved.path,
    keysSaved: saved.keysUpdated,
    hasOpsToken: Boolean(resolved.diagnosticsToken),
    hasFacebookToken: Boolean(resolved.facebook.pageId && resolved.facebook.accessToken),
    hasZaloToken: Boolean(resolved.zalo.pageId && resolved.zalo.accessToken),
  };
}

export interface ParsedTargetReference {
  raw: string;
  kind:
    | "pancake_url"
    | "pancake_conversation_id"
    | "local_uuid"
    | "message_id"
    | "order_id";
  pancakeUrl?: string;
  pancakeConversationId?: string;
  conversationId?: string;
  messageId?: string;
  orderId?: string;
  connectorKey: "facebook_vietlicense" | "zalo_thanh";
  surfaceHint: "INBOX" | "COMMENT";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUID_ORDER_RE = /^c[a-z0-9]{20,32}$/i;

export function parseTargetReference(
  input: string,
  defaultFacebookPageId?: string,
): ParsedTargetReference {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Target reference cannot be empty");
  }

  // 1. URL (https://pancake.vn/...?c_id=... or https://pages.fm/...)
  if (/^https?:\/\//i.test(trimmed) || trimmed.includes("pancake.vn") || trimmed.includes("pages.fm")) {
    const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsedUrl = new URL(normalizedUrl);
    const cidFromQuery =
      parsedUrl.searchParams.get("c_id") ||
      parsedUrl.searchParams.get("conversation_id") ||
      parsedUrl.searchParams.get("id");
    let convId = cidFromQuery?.trim() || "";
    if (!convId) {
      const pathMatch = parsedUrl.pathname.match(/\/(pzl_u_\d+_\d+|\d+_\d+)(?:\/|$)/);
      if (pathMatch) convId = pathMatch[1];
    }
    const connectorKey = convId.startsWith("pzl_") ? "zalo_thanh" : "facebook_vietlicense";
    const firstPart = convId.split("_")[0] || "";
    const surfaceHint =
      connectorKey === "facebook_vietlicense" &&
      defaultFacebookPageId &&
      firstPart &&
      firstPart !== defaultFacebookPageId
        ? "COMMENT"
        : "INBOX";
    return {
      raw: trimmed,
      kind: "pancake_url",
      pancakeUrl: normalizedUrl,
      pancakeConversationId: convId || undefined,
      connectorKey,
      surfaceHint,
    };
  }

  // 2. Local UUID
  if (UUID_RE.test(trimmed)) {
    return {
      raw: trimmed,
      kind: "local_uuid",
      conversationId: trimmed,
      connectorKey: "facebook_vietlicense",
      surfaceHint: "INBOX",
    };
  }

  // 3. Pancake message ID (m_...)
  if (trimmed.startsWith("m_")) {
    return {
      raw: trimmed,
      kind: "message_id",
      messageId: trimmed,
      connectorKey: "facebook_vietlicense",
      surfaceHint: "INBOX",
    };
  }

  // 4. Zalo conversation ID (pzl_u_<page>_<user>)
  if (trimmed.startsWith("pzl_u_")) {
    return {
      raw: trimmed,
      kind: "pancake_conversation_id",
      pancakeConversationId: trimmed,
      connectorKey: "zalo_thanh",
      surfaceHint: "INBOX",
    };
  }

  // 5. Facebook conversation or comment thread ID (<id1>_<id2>)
  if (/^\d+_\d+$/.test(trimmed)) {
    const firstPart = trimmed.split("_")[0] || "";
    const surfaceHint =
      defaultFacebookPageId && firstPart && firstPart !== defaultFacebookPageId
        ? "COMMENT"
        : "INBOX";
    return {
      raw: trimmed,
      kind: "pancake_conversation_id",
      pancakeConversationId: trimmed,
      connectorKey: "facebook_vietlicense",
      surfaceHint,
    };
  }

  // 6. Admin Order ID (cuid like cmv6cogif0fplqp01endssgyf)
  if (CUID_ORDER_RE.test(trimmed) || trimmed.startsWith("ord_")) {
    return {
      raw: trimmed,
      kind: "order_id",
      orderId: trimmed,
      connectorKey: "facebook_vietlicense",
      surfaceHint: "INBOX",
    };
  }

  // Default fallback as pancakeConversationId
  return {
    raw: trimmed,
    kind: "pancake_conversation_id",
    pancakeConversationId: trimmed,
    connectorKey: trimmed.startsWith("pzl_") ? "zalo_thanh" : "facebook_vietlicense",
    surfaceHint: "INBOX",
  };
}
