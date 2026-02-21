/**
 * Morning Briefing
 *
 * Fetches emails, work calendar, and Google Calendar via Claude MCPs,
 * then delivers via Telegram and/or phone call.
 *
 * Scheduled via PM2 cron. Set BRIEFING_DELIVERY in .env:
 *   "telegram" — Telegram only
 *   "phone"    — Phone call only
 *   "both"     — Telegram + phone call (default)
 */

import { spawn } from "bun";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || PROJECT_ROOT;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const DELIVERY = (process.env.MORNING_BRIEFING_DELIVERY || process.env.BRIEFING_DELIVERY || "telegram").toLowerCase();
const USER_TIMEZONE = process.env.USER_TIMEZONE || "Europe/London";

// ============================================================
// CALL CLAUDE WITH MCP TOOLS
// ============================================================

async function callClaude(prompt: string): Promise<string> {
  const args = [
    CLAUDE_PATH,
    "--output-format", "text",
    "--allowedTools", "mcp__google-calendar,mcp__ms365-personal,mcp__ms365-business",
    "-p", prompt,
  ];

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_DIR,
    env: { ...process.env, CLAUDECODE: "" },
  });

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("Claude error:", stderr);
    throw new Error(`Claude exited with code ${exitCode}: ${stderr}`);
  }

  return output.trim();
}

// ============================================================
// SEND TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`Telegram error: ${response.status} ${await response.text()}`);
  }
}

// ============================================================
// BUILD BRIEFING VIA CLAUDE
// ============================================================

async function buildBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const prompt = `You are preparing David's morning briefing for ${dateStr}.

Please gather the following using your MCP tools and format as a clean morning briefing:

1. **Personal email (ms365-personal / davidsheardown@hotmail.com):**
   - Fetch the top 3 emails from the Focused inbox
   - Exclude anything that looks like marketing, newsletters, promotions, or sales emails
   - For each: show sender, subject, and a one-line summary

2. **Work email (ms365-business / david@codingandconsulting.com):**
   - Fetch the top 3 emails from the Focused inbox
   - Exclude anything that looks like marketing, newsletters, promotions, or sales emails
   - For each: show sender, subject, and a one-line summary

3. **Work calendar (ms365-business):**
   - Fetch all meetings/events for today
   - Show time and title for each

4. **Personal Google Calendar:**
   - Fetch all events for today
   - Show time and title for each

Format the final briefing using Telegram-compatible Markdown (bold with *, not **).
Use sections with emoji headers. Keep it concise and scannable.
If any section has no items, say "Nothing to report" for that section.
Do not include any preamble or explanation — just the formatted briefing.`;

  return await callClaude(prompt);
}

/** Strip markdown for spoken phone delivery */
function toSpoken(text: string): string {
  return text
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/[🌅☀️📅📧🎯🤖📬📨🗓️]/gu, "")
    .replace(/^-\s/gm, "")
    .replace(/---/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`[morning-briefing] Starting (delivery: ${DELIVERY})...`);

  let briefing: string;
  try {
    briefing = await buildBriefing();
    console.log("[morning-briefing] Briefing built successfully");
  } catch (error) {
    console.error("[morning-briefing] Failed to build briefing:", error);
    process.exit(1);
  }

  // Telegram
  if (DELIVERY === "telegram" || DELIVERY === "both") {
    try {
      await sendTelegram(briefing);
      console.log("[morning-briefing] Telegram sent");
    } catch (error) {
      console.error("[morning-briefing] Telegram failed:", error);
    }
  }

  // Phone
  if (DELIVERY === "phone" || DELIVERY === "both") {
    try {
      const { makeOutboundCall } = await import("../src/phone.ts");
      const spoken = toSpoken(briefing);
      await makeOutboundCall(spoken);
      console.log("[morning-briefing] Phone call initiated");
    } catch (error) {
      console.error("[morning-briefing] Phone failed:", error);
    }
  }
}

main();
