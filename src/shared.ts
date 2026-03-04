/**
 * Shared Module
 *
 * Common logic used by both the Telegram relay and phone service.
 * Uses Claude CLI (API key auth) with MCP server support.
 */

import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";

// Re-export memory functions for convenience
export { processMemoryIntents, getMemoryContext, getRelevantContext };

export const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const HOME = process.env.HOME || process.env.USERPROFILE || "~";
const RELAY_DIR =
  process.env.RELAY_DIR || join(HOME, ".claude-relay");
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
// SESSION MANAGEMENT
// ============================================================

const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

let session: SessionState = { sessionId: null, lastActivity: new Date().toISOString() };

try {
  const content = await readFile(SESSION_FILE, "utf-8");
  session = JSON.parse(content);
} catch {
  // No existing session — that's fine
}

async function saveSession(state: SessionState): Promise<void> {
  try {
    await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Ignore write errors (dir may not exist yet)
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
  const toolKeywords = /\b(email|calendar|schedule|meeting|weather|search|news|google|microsoft|outlook|office|reminder|remind|research|ms365|briefing)\b/;
  if (toolKeywords.test(msg) || msg.length > 300) {
    return SONNET;
  }

  // Default: Haiku for short conversational messages
  return HAIKU;
}

// ============================================================
// CALL CLAUDE (CLI subprocess — uses ANTHROPIC_API_KEY + MCP from .claude.json)
// ============================================================

const CLAUDE_PATH = process.env.CLAUDE_PATH || "/usr/bin/claude";

export async function callClaude(
  prompt: string,
  options?: { model?: string }
): Promise<string> {
  const model = options?.model ?? selectModel(prompt);
  console.log(`Calling Claude [${model}]: ${prompt.substring(0, 50)}...`);

  const args = ["--print", "--model", model, "--output-format", "json", "--dangerously-skip-permissions"];
  if (session.sessionId) args.push("--resume", session.sessionId);

  try {
    const proc = Bun.spawn([CLAUDE_PATH, ...args], {
      stdin: new TextEncoder().encode(prompt),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderrText);
      return `Error: ${stderrText.trim() || "Claude exited with code " + exitCode}`;
    }

    try {
      const parsed = JSON.parse(stdoutText);
      if (parsed.session_id) {
        session.sessionId = parsed.session_id;
        session.lastActivity = new Date().toISOString();
        await saveSession(session);
      }
      return parsed.result ?? parsed.content ?? stdoutText.trim();
    } catch {
      return stdoutText.trim() || "I processed your request but had no text response.";
    }
  } catch (error) {
    console.error("Claude error:", error);
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
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
  channel: "telegram" | "phone" = "telegram",
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

  if (channel === "phone") {
    parts.push(
      "You are a personal AI assistant on a phone call. Keep responses to 2-3 sentences max.",
      "Speak naturally as if talking, not texting. No markdown, no bullet points, no URLs, no code blocks.",
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
