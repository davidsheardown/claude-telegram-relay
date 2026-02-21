/**
 * Smart Check-in
 *
 * Runs every 30 minutes via PM2 cron. Claude decides whether to proactively
 * message the user based on real context: goals, facts, calendar, and how
 * long since the last conversation.
 *
 * Limits: max 2 check-ins per day, minimum 2 hours between check-ins.
 * Toggle on/off via Telegram: /checkin on | /checkin off | /checkin status
 *
 * PM2: pm2 start ... --cron "*/30 7-20 * * *" (7am–8pm UTC)
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { callClaude, buildPrompt, supabase, getMemoryContext } from "../src/shared.ts";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || "Europe/London";
const STATE_FILE = process.env.CHECKIN_STATE_FILE ||
  join(process.env.HOME || "~", ".checkin-state.json");

const MAX_CHECKINS_PER_DAY = 2;
const MIN_HOURS_BETWEEN = 2;

// ============================================================
// STATE
// ============================================================

interface CheckinState {
  enabled: boolean;
  lastCheckinTime: string;
  checkinsToday: number;
  lastCheckinDate: string; // YYYY-MM-DD in user's timezone
}

async function loadState(): Promise<CheckinState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      enabled: false,
      lastCheckinTime: "",
      checkinsToday: 0,
      lastCheckinDate: "",
    };
  }
}

async function saveState(state: CheckinState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function setEnabled(enabled: boolean): Promise<void> {
  const state = await loadState();
  state.enabled = enabled;
  await saveState(state);
}

export async function getStatus(): Promise<{ enabled: boolean; lastCheckin: string; checkinsToday: number }> {
  const state = await loadState();
  return {
    enabled: state.enabled,
    lastCheckin: state.lastCheckinTime
      ? new Date(state.lastCheckinTime).toLocaleString("en-GB", { timeZone: USER_TIMEZONE })
      : "never",
    checkinsToday: state.checkinsToday,
  };
}

// ============================================================
// RATE LIMITING
// ============================================================

function todayString(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE }); // YYYY-MM-DD
}

function canCheckin(state: CheckinState): { allowed: boolean; reason: string } {
  if (!state.enabled) return { allowed: false, reason: "disabled" };

  const today = todayString();
  const checkinsToday = state.lastCheckinDate === today ? state.checkinsToday : 0;

  if (checkinsToday >= MAX_CHECKINS_PER_DAY) {
    return { allowed: false, reason: `already sent ${MAX_CHECKINS_PER_DAY} check-ins today` };
  }

  if (state.lastCheckinTime) {
    const hoursSince = (Date.now() - new Date(state.lastCheckinTime).getTime()) / (1000 * 60 * 60);
    if (hoursSince < MIN_HOURS_BETWEEN) {
      return { allowed: false, reason: `last check-in was ${hoursSince.toFixed(1)}h ago (min ${MIN_HOURS_BETWEEN}h)` };
    }
  }

  return { allowed: true, reason: "" };
}

// ============================================================
// LAST USER MESSAGE TIME
// ============================================================

async function getHoursSinceLastUserMessage(): Promise<number | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("messages")
      .select("created_at")
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(1);
    if (!data?.length) return null;
    return (Date.now() - new Date(data[0].created_at).getTime()) / (1000 * 60 * 60);
  } catch {
    return null;
  }
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("[smart-checkin] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const state = await loadState();
  const { allowed, reason } = canCheckin(state);

  if (!allowed) {
    console.log(`[smart-checkin] Skipping: ${reason}`);
    return;
  }

  const hoursSinceLastMsg = await getHoursSinceLastUserMessage();
  const memoryContext = await getMemoryContext(supabase);

  const now = new Date().toLocaleString("en-GB", {
    timeZone: USER_TIMEZONE,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const prompt = buildPrompt(
    `You are doing a proactive check-in. Current time: ${now}.
${hoursSinceLastMsg !== null ? `The user last messaged ${hoursSinceLastMsg.toFixed(1)} hours ago.` : ""}
You have checked in ${state.checkinsToday} time(s) today already (max ${MAX_CHECKINS_PER_DAY}).

Decide whether to send a check-in message. Consider:
- Is there something genuinely useful to say right now? (upcoming calendar events, goal deadlines, long silence worth breaking)
- Would this feel helpful or annoying given the time and context?
- Keep it short: 1-2 sentences max.

Use your calendar tools (ms365-business, google-calendar) to check for upcoming events if relevant.

If you decide to check in, respond with just the message to send — no preamble, no explanation.
If you decide NOT to check in, respond with exactly: NO_CHECKIN`,
    "telegram",
    undefined,
    memoryContext
  );

  console.log("[smart-checkin] Asking Claude...");
  const response = await callClaude(prompt);

  if (!response || response.trim().startsWith("NO_CHECKIN") || response.includes("Error:")) {
    console.log("[smart-checkin] Claude decided not to check in:", response?.slice(0, 100));
    return;
  }

  console.log("[smart-checkin] Sending:", response.slice(0, 100));
  const sent = await sendTelegram(response.trim());

  if (sent) {
    const today = todayString();
    state.lastCheckinTime = new Date().toISOString();
    state.checkinsToday = (state.lastCheckinDate === today ? state.checkinsToday : 0) + 1;
    state.lastCheckinDate = today;
    await saveState(state);
    console.log("[smart-checkin] Sent successfully");
  } else {
    console.error("[smart-checkin] Failed to send Telegram message");
  }
}

main();
