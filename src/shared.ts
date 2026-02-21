/**
 * Shared Module
 *
 * Common logic used by both the Telegram relay and phone service.
 * Extracted from relay.ts to avoid duplication.
 */

import { spawn } from "bun";
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

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR =
  process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
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
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CALL CLAUDE CLI
// ============================================================

export async function callClaude(
  prompt: string,
  options?: { resume?: boolean }
): Promise<string> {
  const args = [CLAUDE_PATH];

  args.push("--output-format", "text");
  args.push("--allowedTools", "WebSearch,WebFetch,mcp__supabase,mcp__google-calendar,mcp__ms365-personal,mcp__ms365-business,mcp__reminder-scheduler");

  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("-p", prompt);

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || PROJECT_ROOT,
      env: {
        ...process.env,
        CLAUDECODE: "",
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
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
