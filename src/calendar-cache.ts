/**
 * Calendar Cache Refresher
 *
 * Runs every 20 minutes, fetches today's and tomorrow's calendar summaries
 * via Claude (with Google Calendar MCP), and writes ~/.calendar-cache.json.
 *
 * Alexa reads from this cache for instant responses without waiting for
 * a full Claude + MCP round-trip.
 *
 * Run: tsx src/calendar-cache.ts
 */

import "dotenv/config";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { callClaude } from "./shared.ts";

const CACHE_FILE =
  process.env.CALENDAR_CACHE_FILE ||
  join(process.env.HOME || "~", ".calendar-cache.json");

const TZ = process.env.USER_TIMEZONE || "Europe/London";

// Refresh at 8:00 and 15:00 local time each day
const REFRESH_HOURS = [8, 15];

function msUntilNextRefresh(): number {
  const now = new Date();
  const localHour = parseInt(
    now.toLocaleString("en-GB", { timeZone: TZ, hour: "numeric", hour12: false })
  );
  const localMin = now.getMinutes();
  const localSec = now.getSeconds();

  // Find next scheduled hour today or tomorrow
  const nextHour = REFRESH_HOURS.find((h) => h > localHour) ?? REFRESH_HOURS[0];
  const hoursUntil =
    nextHour > localHour
      ? nextHour - localHour
      : 24 - localHour + nextHour;

  const msUntil =
    hoursUntil * 60 * 60 * 1000 -
    localMin * 60 * 1000 -
    localSec * 1000;

  return msUntil;
}

interface CalendarCache {
  refreshed: string;
  today_date: string;
  today_text: string;
  tomorrow_text: string;
}

async function refreshCache(): Promise<void> {
  console.log("[calendar-cache] Refreshing...");

  const todayPrompt =
    "Check my Google Calendar and give me a brief spoken summary of today's events. " +
    "Keep it to 1-3 natural sentences suitable for Alexa to read aloud. " +
    "No markdown, no bullet points, no asterisks. " +
    "If there are no events, say exactly: You have no events today. " +
    "Reply with just the summary, nothing else.";

  const tomorrowPrompt =
    "Check my Google Calendar and give me a brief spoken summary of tomorrow's events. " +
    "Keep it to 1-3 natural sentences suitable for Alexa to read aloud. " +
    "No markdown, no bullet points, no asterisks. " +
    "If there are no events, say exactly: You have no events tomorrow. " +
    "Reply with just the summary, nothing else.";

  const [todayText, tomorrowText] = await Promise.all([
    callClaude(todayPrompt, { model: "claude-haiku-4-5" }),
    callClaude(tomorrowPrompt, { model: "claude-haiku-4-5" }),
  ]);

  if (todayText.startsWith("Error:") || tomorrowText.startsWith("Error:")) {
    console.warn(`[calendar-cache] Claude returned an error — skipping cache write. today: ${todayText.substring(0, 80)}`);
    return;
  }

  const cache: CalendarCache = {
    refreshed: new Date().toISOString(),
    today_date: new Date().toISOString().split("T")[0],
    today_text: todayText.replace(/[*_`#]/g, "").trim(),
    tomorrow_text: tomorrowText.replace(/[*_`#]/g, "").trim(),
  };

  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));

  console.log(`[calendar-cache] Today: ${cache.today_text.substring(0, 80)}...`);
  console.log(`[calendar-cache] Tomorrow: ${cache.tomorrow_text.substring(0, 80)}...`);
}

function scheduleNext(): void {
  const ms = msUntilNextRefresh();
  const nextTime = new Date(Date.now() + ms).toLocaleString("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
  console.log(`[calendar-cache] Next refresh at ${nextTime} (in ${Math.round(ms / 60000)} min)`);
  setTimeout(async () => {
    await refreshCache();
    scheduleNext();
  }, ms);
}

async function main() {
  console.log(
    `[calendar-cache] Starting. Cache file: ${CACHE_FILE}. Scheduled at ${REFRESH_HOURS.map((h) => `${h}:00`).join(" and ")} ${TZ}.`
  );

  await refreshCache();
  scheduleNext();
}

main().catch((err) => {
  console.error("[calendar-cache] Fatal error:", err);
  process.exit(1);
});
