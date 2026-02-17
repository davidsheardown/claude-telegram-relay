/**
 * Morning Briefing Example
 *
 * Sends a daily summary via Telegram and/or phone call.
 * Customize this for your own morning routine.
 *
 * Set BRIEFING_DELIVERY in .env:
 *   "telegram" (default) — Telegram message only
 *   "phone"              — Phone call only
 *   "both"               — Telegram message + phone call
 *
 * Schedule this with:
 * - macOS: launchd (see daemon/morning-briefing.plist)
 * - Linux: cron or systemd timer
 * - Windows: Task Scheduler
 *
 * Run manually: bun run examples/morning-briefing.ts
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const DELIVERY = (process.env.BRIEFING_DELIVERY || "telegram").toLowerCase();

// ============================================================
// TELEGRAM HELPER
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
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

    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// DATA FETCHERS (customize these for your sources)
// ============================================================

async function getUnreadEmails(): Promise<string> {
  // Example: Use Gmail API, IMAP, or MCP tool
  // Return a summary of unread emails

  // Placeholder - replace with your implementation
  return "- 3 unread emails (1 urgent from client)";
}

async function getCalendarEvents(): Promise<string> {
  // Example: Use Google Calendar API or MCP tool
  // Return today's events

  // Placeholder
  return "- 10:00 Team standup\n- 14:00 Client call";
}

async function getActiveGoals(): Promise<string> {
  // Load from your persistence layer (Supabase, JSON file, etc.)

  // Placeholder
  return "- Finish video edit\n- Review PR";
}

async function getWeather(): Promise<string> {
  // Optional: Weather API

  // Placeholder
  return "Sunny, 22°C";
}

async function getAINews(): Promise<string> {
  // Optional: Pull from X/Twitter, RSS, or news API
  // Use Grok, Perplexity, or web search

  // Placeholder
  return "- OpenAI released GPT-5\n- Anthropic launches new feature";
}

// ============================================================
// BUILD BRIEFING
// ============================================================

async function buildBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const sections: string[] = [];

  // Header
  sections.push(`🌅 **Good Morning!**\n${dateStr}\n`);

  // Weather (optional)
  try {
    const weather = await getWeather();
    sections.push(`☀️ **Weather**\n${weather}\n`);
  } catch (e) {
    console.error("Weather fetch failed:", e);
  }

  // Calendar
  try {
    const calendar = await getCalendarEvents();
    if (calendar) {
      sections.push(`📅 **Today's Schedule**\n${calendar}\n`);
    }
  } catch (e) {
    console.error("Calendar fetch failed:", e);
  }

  // Emails
  try {
    const emails = await getUnreadEmails();
    if (emails) {
      sections.push(`📧 **Inbox**\n${emails}\n`);
    }
  } catch (e) {
    console.error("Email fetch failed:", e);
  }

  // Goals
  try {
    const goals = await getActiveGoals();
    if (goals) {
      sections.push(`🎯 **Active Goals**\n${goals}\n`);
    }
  } catch (e) {
    console.error("Goals fetch failed:", e);
  }

  // AI News (optional)
  try {
    const news = await getAINews();
    if (news) {
      sections.push(`🤖 **AI News**\n${news}\n`);
    }
  } catch (e) {
    console.error("News fetch failed:", e);
  }

  // Footer (only for Telegram)
  sections.push("---\n_Reply to chat or say \"call me\" for voice briefing_");

  return sections.join("\n");
}

/** Strip markdown and emojis for spoken delivery. */
function toSpoken(text: string): string {
  return text
    .replace(/\*\*/g, "")           // bold
    .replace(/_([^_]+)_/g, "$1")    // italic
    .replace(/[🌅☀️📅📧🎯🤖]/g, "") // emojis
    .replace(/^-\s/gm, "")          // bullet dashes
    .replace(/---/g, "")            // horizontal rules
    .replace(/\n{3,}/g, "\n\n")     // collapse blank lines
    .trim();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`Building morning briefing (delivery: ${DELIVERY})...`);

  const briefing = await buildBriefing();
  let ok = true;

  // Telegram delivery
  if (DELIVERY === "telegram" || DELIVERY === "both") {
    if (!BOT_TOKEN || !CHAT_ID) {
      console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
      ok = false;
    } else {
      console.log("Sending briefing via Telegram...");
      const sent = await sendTelegram(briefing);
      if (sent) {
        console.log("Telegram briefing sent!");
      } else {
        console.error("Telegram delivery failed");
        ok = false;
      }
    }
  }

  // Phone delivery
  if (DELIVERY === "phone" || DELIVERY === "both") {
    try {
      const { makeOutboundCall } = await import("../src/phone.ts");
      const spoken = toSpoken(briefing);
      console.log("Calling with briefing...");
      await makeOutboundCall(spoken);
      console.log("Phone briefing initiated!");
    } catch (error) {
      console.error("Phone delivery failed:", error);
      ok = false;
    }
  }

  if (!ok) process.exit(1);
}

main();

// ============================================================
// LAUNCHD PLIST FOR SCHEDULING (macOS)
// ============================================================
/*
Save this as ~/Library/LaunchAgents/com.claude.morning-briefing.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.morning-briefing</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/morning-briefing.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-telegram-relay</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/morning-briefing.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/morning-briefing.error.log</string>
</dict>
</plist>

Load with: launchctl load ~/Library/LaunchAgents/com.claude.morning-briefing.plist
*/

// ============================================================
// CRON FOR SCHEDULING (Linux)
// ============================================================
/*
Add to crontab with: crontab -e

# Run at 9:00 AM every day
0 9 * * * cd /path/to/claude-telegram-relay && /home/USER/.bun/bin/bun run examples/morning-briefing.ts >> /tmp/morning-briefing.log 2>&1
*/
