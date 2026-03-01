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
const WEATHER_LAT = process.env.WEATHER_LAT || "51.3205";
const WEATHER_LON = process.env.WEATHER_LON || "-2.2087";

// ============================================================
// WEATHER
// ============================================================

const WMO_DESCRIPTIONS: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Icy fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow",
  80: "Rain showers", 81: "Heavy showers", 82: "Violent showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
};

async function fetchWeather(): Promise<string> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&current_weather=true&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) return "";
    const data = await res.json() as any;
    const code: number = data.daily?.weathercode?.[0] ?? data.current_weather?.weathercode ?? -1;
    const desc = WMO_DESCRIPTIONS[code] ?? "Mixed conditions";
    const max = Math.round(data.daily?.temperature_2m_max?.[0] ?? 0);
    const min = Math.round(data.daily?.temperature_2m_min?.[0] ?? 0);
    const rain = data.daily?.precipitation_probability_max?.[0] ?? 0;
    return `${desc}, ${min}–${max}°C, ${rain}% chance of rain`;
  } catch {
    return "";
  }
}

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

function extractFormattedBriefing(output: string): string {
  // Claude sometimes outputs analysis before the briefing — strip it.
  // The formatted briefing starts with the ☀️ greeting line.
  const idx = output.indexOf("☀️");
  return idx !== -1 ? output.slice(idx).trim() : output.trim();
}

async function buildBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const weather = await fetchWeather();
  const weatherLine = weather
    ? `Weather for today (Trowbridge, UK): ${weather}`
    : "";

  const prompt = `You are preparing David's morning briefing for ${dateStr}.
${weatherLine ? `\n${weatherLine}\n` : ""}
Please gather the following using your MCP tools, then output ONLY the formatted briefing — no analysis, no preamble, no explanation:

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

Format the briefing using Telegram-compatible Markdown (bold with *, not **).
Use sections with emoji headers. Keep it concise and scannable.
If any section has no items, say "Nothing to report" for that section.
Include a 🌤 Weather section at the top using the pre-fetched data above — do not fetch weather yourself.
Start your response directly with the ☀️ greeting line. Output nothing before it.`;

  const raw = await callClaude(prompt);
  return extractFormattedBriefing(raw);
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
