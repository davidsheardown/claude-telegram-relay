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

const REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

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
    callClaude(todayPrompt),
    callClaude(tomorrowPrompt),
  ]);

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

async function main() {
  console.log(
    `[calendar-cache] Starting. Cache file: ${CACHE_FILE}. Refreshing every ${REFRESH_INTERVAL_MS / 60000} minutes.`
  );

  await refreshCache();
  setInterval(refreshCache, REFRESH_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[calendar-cache] Fatal error:", err);
  process.exit(1);
});
