/**
 * Shared Module
 *
 * Common logic used by both the Telegram relay and phone service.
 * Uses Claude Agent SDK (API key auth) with MCP server support.
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";

// Re-export memory functions for convenience
export { processMemoryIntents, getMemoryContext, getRelevantContext };

export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ============================================================
// CONFIGURATION
// ============================================================

const HOME = process.env.HOME || process.env.USERPROFILE || "~";
const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE =
  process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

export const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

export async function saveMessage(
  role: string,
  content: string,
  channel: string = "telegram",
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel,
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// ============================================================
// MODEL ROUTER
// ============================================================

const OPUS   = "claude-opus-4-6";
const SONNET = "claude-sonnet-4-6";
const HAIKU  = "claude-haiku-4-5";

export function selectModel(prompt: string): string {
  // Extract just the user message (always last line after "User:")
  const userMsgMatch = prompt.match(/\nUser: ([\s\S]+)$/);
  const msg = (userMsgMatch ? userMsgMatch[1] : prompt).toLowerCase().trim();

  // Opus: explicit deep-thinking prefixes
  if (/^(think hard|deep dive|analyse carefully|analyze carefully|think carefully|step by step|comprehensive analysis)[:\s]/i.test(msg)) {
    return OPUS;
  }

  // Sonnet: tool-requiring keywords or longer messages
  // Only use Sonnet when tools are genuinely needed (fetching/writing data)
  const toolKeywords = /\b(email|calendar|schedule|meeting|weather|search|news|google|microsoft|outlook|office|reminder|remind|research|ms365|briefing)\b/;
  if (toolKeywords.test(msg) || msg.length > 500) {
    return SONNET;
  }

  // Default: Haiku for short conversational messages
  return HAIKU;
}

// ============================================================
// MCP SERVER CONFIG
// ============================================================

// Returns only the MCP servers relevant to the message — avoids sending
// 80 large tool schemas on every call (huge token waste).
function selectMcpServers(msg: string): string[] {
  const lower = msg.toLowerCase();
  const servers: string[] = ["reminder-scheduler"]; // always included

  if (/\b(calendar|schedule|event|meeting|appointment)\b/.test(lower)) {
    servers.push("google-calendar");
  }
  if (/\b(email|mail|inbox|hotmail|personal mail|message)\b/.test(lower)) {
    servers.push("ms365-personal");
  }
  if (/\b(work email|work mail|office|business|david@coding|ms365|teams)\b/.test(lower)) {
    servers.push("ms365-business");
  }
  // If no specific match but tools are likely needed, load all
  if (servers.length === 1 && /\b(email|calendar|schedule|meeting|weather|search|news|google|microsoft|outlook|office|reminder|remind|research|ms365|briefing)\b/.test(lower)) {
    servers.push("google-calendar", "ms365-personal", "ms365-business");
  }

  return servers;
}

type RawTool = { name: string; description?: string; inputSchema: unknown };

// Reduces the tool list to only those relevant to the query.
// ms365-business alone has 45 tools with huge schemas — sending all of them
// every call burns tokens and hits rate limits.
function filterRelevantTools(tools: RawTool[], msg: string, serverName: string): RawTool[] {
  const lower = msg.toLowerCase();

  // For ms365 servers, pick only the operation type needed
  if (serverName.startsWith("ms365")) {
    const wantsCalendar = /\b(calendar|event|meeting|appointment|schedule)\b/.test(lower);
    const wantsMail = /\b(email|mail|inbox|message|send|reply|forward)\b/.test(lower);
    const wantsContacts = /\b(contact|people|person|colleague)\b/.test(lower);

    return tools.filter((t) => {
      const n = t.name.toLowerCase();
      if (wantsCalendar && (n.includes("event") || n.includes("calendar"))) return true;
      if (wantsMail && (n.includes("mail") || n.includes("message") || n.includes("email"))) return true;
      if (wantsContacts && (n.includes("contact") || n.includes("people"))) return true;
      // If nothing specific matched, return core list-type tools only
      if (!wantsCalendar && !wantsMail && !wantsContacts) {
        return n.startsWith("list_") || n.startsWith("get_");
      }
      return false;
    });
  }

  // For other servers, return all tools (reminder-scheduler has only 3, calendar has 4)
  return tools;
}

function buildMcpServers(filter?: string[]): Record<string, object> {
  const servers: Record<string, object> = {};

  if (process.env.GOOGLE_CALENDAR_MCP_PATH) {
    servers["google-calendar"] = {
      command: process.env.UV_PATH || "uv",
      args: ["--directory", process.env.GOOGLE_CALENDAR_MCP_PATH, "run", "calendar_mcp.py"],
      env: { GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID || "" },
    };
  }

  if (process.env.MS365_PERSONAL_TOKEN_CACHE) {
    servers["ms365-personal"] = {
      command: "npx",
      args: ["-y", "@softeria/ms-365-mcp-server", "--preset", "mail"],
      env: {
        MS365_MCP_CLIENT_ID: process.env.MS365_PERSONAL_CLIENT_ID || "",
        MS365_MCP_TENANT_ID: "common",
        MS365_MCP_TOKEN_CACHE_PATH: process.env.MS365_PERSONAL_TOKEN_CACHE || "",
        MS365_MCP_SELECTED_ACCOUNT_PATH: process.env.MS365_PERSONAL_ACCOUNT_PATH || "",
      },
    };
  }

  if (process.env.MS365_BUSINESS_TOKEN_CACHE) {
    servers["ms365-business"] = {
      command: "npx",
      args: ["-y", "@softeria/ms-365-mcp-server", "--org-mode", "--preset", "mail,calendar"],
      env: {
        MS365_MCP_CLIENT_ID: process.env.MS365_BUSINESS_CLIENT_ID || "",
        MS365_MCP_TENANT_ID: process.env.MS365_BUSINESS_TENANT_ID || "",
        MS365_MCP_TOKEN_CACHE_PATH: process.env.MS365_BUSINESS_TOKEN_CACHE || "",
        MS365_MCP_SELECTED_ACCOUNT_PATH: process.env.MS365_BUSINESS_ACCOUNT_PATH || "",
      },
    };
  }

  // reminder-scheduler (local MCP — always added)
  const tsxBin = join(PROJECT_ROOT, "node_modules/.bin/tsx");
  servers["reminder-scheduler"] = {
    command: tsxBin,
    args: [join(PROJECT_ROOT, "src/reminder-mcp.ts")],
    env: {
      REMINDERS_FILE: process.env.REMINDERS_FILE || join(HOME, ".reminders.json"),
      USER_TIMEZONE: process.env.USER_TIMEZONE || "Europe/London",
    },
  };

  // Apply filter if provided
  if (filter) {
    for (const key of Object.keys(servers)) {
      if (!filter.includes(key)) delete servers[key];
    }
  }

  return servers;
}

// ============================================================
// CALL CLAUDE (Direct Anthropic SDK — API key only, no CLI subprocess)
// ============================================================

const anthropic = new Anthropic(); // uses ANTHROPIC_API_KEY from env

export async function callClaude(
  prompt: string,
  options?: { model?: string }
): Promise<string> {
  const model = options?.model ?? selectModel(prompt);
  console.log(`Calling Claude [${model}]: ${prompt.substring(0, 50)}...`);

  // Extract user message for MCP server selection
  const userMsgMatch = prompt.match(/\nUser: ([\s\S]+)$/);
  const userMsg = userMsgMatch ? userMsgMatch[1] : prompt;

  // Haiku calls are conversational — no tools needed, skip MCP entirely
  const needsTools = model !== HAIKU;
  const mcpFilter = needsTools ? selectMcpServers(userMsg) : [];

  // Start configured MCP servers in parallel (empty filter = no servers)
  const serverConfigs = buildMcpServers(needsTools ? mcpFilter : []) as Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  >;

  type McpEntry = { client: Client; tools: Anthropic.Tool[]; prefix: string };
  const entries: McpEntry[] = [];

  await Promise.allSettled(
    Object.entries(serverConfigs).map(async ([name, cfg]) => {
      try {
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
        });
        const client = new Client(
          { name: "claude-relay", version: "1.0.0" },
          { capabilities: {} }
        );
        await client.connect(transport);
        const { tools } = await client.listTools();
        // Prefix tool names with server name (snake_case) to ensure uniqueness
        const prefix = name.replace(/-/g, "_") + "__";
        // Filter tools to only those relevant to the query (reduces token count significantly)
        const relevantTools = filterRelevantTools(tools as Array<{ name: string; description?: string; inputSchema: unknown }>, userMsg, name);
        const anthropicTools: Anthropic.Tool[] = relevantTools.map((t) => ({
          name: prefix + t.name,
          description: (t.description ?? "").slice(0, 120), // truncate verbose descriptions
          input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
        }));
        entries.push({ client, tools: anthropicTools, prefix });
        console.log(`[MCP] ${name}: ${tools.length} tools`);
      } catch (err) {
        console.warn(`[MCP] ${name} failed:`, (err as Error).message);
      }
    })
  );

  // Build tool routing map
  const toolToClient = new Map<string, Client>();
  const mcpTools: Anthropic.Tool[] = [];
  for (const { client, tools } of entries) {
    for (const tool of tools) {
      mcpTools.push(tool);
      toolToClient.set(tool.name, client);
    }
  }

  // Anthropic native web search (server-side, no extra API key needed)
  const webSearchTool = {
    type: "web_search_20250305",
    name: "web_search",
  } as unknown as Anthropic.Tool;

  // Only include tools if this call needs them — empty array causes API error
  const allTools = needsTools ? [webSearchTool, ...mcpTools] : undefined;

  // Agent loop (max 10 turns)
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  let result = "";

  try {
    for (let turn = 0; turn < 10; turn++) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        ...(allTools ? { tools: allTools } : {}),
        messages,
      });

      // Capture any text in this turn
      for (const block of response.content) {
        if (block.type === "text") result = block.text;
      }

      if (response.stop_reason !== "tool_use") break;

      // Process tool calls
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const mcpClient = toolToClient.get(block.name);
        let content = "";

        if (mcpClient) {
          try {
            // Strip the server prefix before calling MCP (e.g. "ms365_personal__list_mail" → "list_mail")
            const originalName = block.name.includes("__")
              ? block.name.slice(block.name.indexOf("__") + 2)
              : block.name;
            const r = await mcpClient.callTool({
              name: originalName,
              arguments: block.input as Record<string, unknown>,
            });
            content = (r.content as Array<{ type: string; text?: string }>)
              .map((c) => c.text ?? JSON.stringify(c))
              .join("\n");
          } catch (err) {
            content = `Tool error: ${(err as Error).message}`;
          }
        }
        // web_search blocks: content stays "" — Anthropic fills results automatically

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
      }
      messages.push({ role: "user", content: toolResults });
    }
  } catch (error) {
    console.error("Claude error:", error);
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await Promise.allSettled(entries.map(({ client }) => client.close()));
  }

  return result || "I processed your request but had no text response.";
}

// ============================================================
// PROFILE
// ============================================================

export let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

// ============================================================
// PROMPT BUILDER
// ============================================================

export function buildPrompt(
  userMessage: string,
  channel: "telegram" | "phone" | "alexa" = "telegram",
  relevantContext?: string,
  memoryContext?: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts: string[] = [];

  if (channel === "phone" || channel === "alexa") {
    const src = channel === "alexa" ? "an Alexa voice query" : "a phone call";
    parts.push(
      `You are a personal AI assistant responding to ${src}. Keep responses to 2-3 sentences max.`,
      "Speak naturally. No markdown, no bullet points, no asterisks, no URLs, no code blocks.",
      "Use conversational language. Be warm and concise.",
      "You have access to WebSearch, WebFetch, Google Calendar, and Microsoft 365 tools. Use them for current events, weather, news, email, calendar, etc.",
      "For email: ms365-personal tools access davidsheardown@hotmail.com (personal). ms365-business tools access david@codingandconsulting.com (work email + calendar).",
      "Google Calendar tools access the personal Google calendar.",
      "Use reminder-scheduler tools (schedule_reminder, list_reminders, cancel_reminder) when the user asks to be reminded of something at a specific time. Reminders are sent via Telegram."
    );
  } else {
    parts.push(
      "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
      "Format responses using Telegram Markdown: *bold* for headers and key info, bullet points (- or •) for lists, `code` for technical values. Use emoji section headers (e.g. *📧 Emails*, *📅 Calendar*) when presenting structured data. Keep formatting lightweight — plain sentences for simple replies, structured only when presenting multiple items or sections.",
      "You have access to WebSearch, WebFetch, Google Calendar, and Microsoft 365 tools. USE THEM whenever the user asks about current events, weather, news, prices, email, calendar, or anything requiring up-to-date information. Do not say you lack internet access — you DO have web search. Use it proactively.",
      "For email: ms365-personal tools access davidsheardown@hotmail.com (personal). ms365-business tools access david@codingandconsulting.com (work email + calendar).",
      "Google Calendar tools access the personal Google calendar.",
      "Use reminder-scheduler tools (schedule_reminder, list_reminders, cancel_reminder) when the user asks to be reminded of something at a specific time. Reminders are sent via Telegram."
    );
  }

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}
