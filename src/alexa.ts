/**
 * Alexa Query Endpoint
 *
 * Receives queries from the AWS Lambda Alexa skill and returns spoken responses.
 * Uses a two-tier approach:
 *   Fast path  — calendar and reminders served from local cache files (<500ms)
 *   Slow path  — Claude with a 6s timeout; on timeout, sends full answer to
 *                Telegram and tells Alexa "I'll send that to your phone."
 *
 * Run: tsx src/alexa.ts
 */

import "dotenv/config";
import { serve } from "@hono/node-server";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  callClaude,
  buildPrompt,
  saveMessage,
  processMemoryIntents,
  supabase,
} from "./shared.ts";

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = parseInt(process.env.ALEXA_WEBHOOK_PORT || "3200");
const ALEXA_SECRET = process.env.ALEXA_SECRET || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const RESPONSE_TIMEOUT_MS = 6000;

const CALENDAR_CACHE_FILE =
  process.env.CALENDAR_CACHE_FILE ||
  join(process.env.HOME || "~", ".calendar-cache.json");

const REMINDERS_FILE =
  process.env.REMINDERS_FILE ||
  join(process.env.HOME || "~", ".reminders.json");

// ============================================================
// FAST PATH HELPERS
// ============================================================

function isCalendarQuery(text: string): boolean {
  return /\b(calendar|schedule|appointment|meeting|event|today|tomorrow|diary)\b/i.test(text);
}

function isReminderListQuery(text: string): boolean {
  return /\b(remind(er)?s?|what.*remind|pending|upcoming remind)\b/i.test(text) &&
    !/\bset|add|create|schedule\b/i.test(text); // "set a reminder" goes to slow path
}

function isTimeQuery(text: string): boolean {
  return /\b(what(('?s| is) the)? time|current time|time is it)\b/i.test(text);
}

function timeFastPath(): string {
  const tz = process.env.USER_TIMEZONE || "Europe/London";
  return new Date().toLocaleString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

async function calendarFastPath(text: string): Promise<string | null> {
  try {
    const content = await readFile(CALENDAR_CACHE_FILE, "utf-8");
    const cache = JSON.parse(content);

    const ageMs = Date.now() - new Date(cache.refreshed).getTime();
    if (ageMs > 25 * 60 * 1000) {
      console.log("[alexa] Calendar cache stale — falling to slow path");
      return null;
    }

    return /tomorrow/i.test(text) ? cache.tomorrow_text : cache.today_text;
  } catch {
    return null; // cache missing — fall to slow path
  }
}

async function reminderFastPath(): Promise<string> {
  try {
    const content = await readFile(REMINDERS_FILE, "utf-8");
    const reminders: Array<{ id: string; message: string; datetime: string }> =
      JSON.parse(content);

    if (reminders.length === 0) return "You have no pending reminders.";

    const tz = process.env.USER_TIMEZONE || "Europe/London";
    const list = reminders
      .sort((a, b) => a.datetime.localeCompare(b.datetime))
      .slice(0, 5)
      .map((r) => {
        const time = new Date(r.datetime).toLocaleString("en-GB", {
          timeZone: tz,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `${time}: ${r.message}`;
      })
      .join(". ");

    return `You have ${reminders.length} reminder${reminders.length > 1 ? "s" : ""}. ${list}.`;
  } catch {
    return "I couldn't check your reminders right now.";
  }
}

// ============================================================
// TELEGRAM FALLBACK
// ============================================================

async function sendTelegram(message: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: "Markdown" }),
  }).catch(console.error);
}

// ============================================================
// HTTP SERVER
// ============================================================

serve({
  port: PORT,
  fetch: async (req: Request) => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("OK");
    }

    if (req.method !== "POST" || url.pathname !== "/alexa/query") {
      return new Response("Not found", { status: 404 });
    }

    let body: { text?: string; secret?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (ALEXA_SECRET && body.secret !== ALEXA_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const text = body.text?.trim() || "";
    if (!text) {
      return new Response(
        JSON.stringify({ speech: "I didn't catch that. Could you try again?" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    console.log(`[alexa] Query: "${text}"`);

    const json = (speech: string) =>
      new Response(JSON.stringify({ speech }), {
        headers: { "Content-Type": "application/json" },
      });

    // ── Fast path: time ──────────────────────────────────────
    if (isTimeQuery(text)) {
      const speech = `It's ${timeFastPath()}.`;
      console.log(`[alexa] Fast path (time): ${speech}`);
      return json(speech);
    }

    // ── Fast path: calendar ──────────────────────────────────
    if (isCalendarQuery(text)) {
      const cached = await calendarFastPath(text);
      if (cached) {
        console.log(`[alexa] Fast path (calendar): ${cached.substring(0, 60)}`);
        return json(cached);
      }
    }

    // ── Fast path: reminders list ────────────────────────────
    if (isReminderListQuery(text)) {
      const speech = await reminderFastPath();
      console.log(`[alexa] Fast path (reminders): ${speech.substring(0, 60)}`);
      return json(speech);
    }

    // ── Slow path: Claude with timeout ───────────────────────
    const prompt = buildPrompt(`[Alexa voice query]: ${text}`, "alexa");

    // Single Claude call — reused for Telegram fallback if timeout fires
    const claudePromise = callClaude(prompt).then((r) =>
      r.replace(/[*_`#]/g, "").trim()
    ).catch((err: Error) => {
      console.error("[alexa] Claude error:", err.message);
      return null as unknown as string;
    });

    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), RESPONSE_TIMEOUT_MS)
    );

    const result = await Promise.race([claudePromise, timeoutPromise]);

    if (result !== null) {
      // Responded in time
      console.log(`[alexa] Slow path response: ${result.substring(0, 60)}`);
      const processed = await processMemoryIntents(supabase, result);
      await saveMessage("user", `[Alexa]: ${text}`, "alexa");
      await saveMessage("assistant", processed, "alexa");
      return json(processed.replace(/[*_`#]/g, "").trim());
    }

    // Timeout — tell Alexa immediately, send full answer to Telegram when ready
    console.log(`[alexa] Timeout — routing answer to Telegram`);
    claudePromise
      .then(async (answer) => {
        const processed = await processMemoryIntents(supabase, answer);
        await saveMessage("user", `[Alexa]: ${text}`, "alexa");
        await saveMessage("assistant", processed, "alexa");
        await sendTelegram(
          `🔔 *Alexa asked:* "${text}"\n\n${processed}`
        );
      })
      .catch(console.error);

    return json("That will take a moment. I'll send the full answer to your phone.");
  },
});

console.log(`[alexa] Service running on port ${PORT}`);
