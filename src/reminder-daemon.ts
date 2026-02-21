/**
 * Reminder Daemon
 *
 * Polls ~/.reminders.json every 60 seconds.
 * When a reminder is due, sends a Telegram message and removes it from the file.
 *
 * Run via PM2: pm2 start reminder-daemon
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const REMINDERS_FILE =
  process.env.REMINDERS_FILE ||
  join(process.env.HOME || "~", ".reminders.json");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const POLL_INTERVAL_MS = 30_000; // check every 30 seconds

interface Reminder {
  id: string;
  message: string;
  datetime: string;
  created: string;
}

async function readReminders(): Promise<Reminder[]> {
  try {
    const content = await readFile(REMINDERS_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function writeReminders(reminders: Reminder[]): Promise<void> {
  await writeFile(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: `⏰ *Reminder*\n\n${message}`,
          parse_mode: "Markdown",
        }),
      }
    );
    return response.ok;
  } catch (err) {
    console.error("[reminder-daemon] Telegram error:", err);
    return false;
  }
}

async function checkReminders(): Promise<void> {
  const reminders = await readReminders();
  if (reminders.length === 0) return;

  const now = new Date();
  const due = reminders.filter((r) => new Date(r.datetime) <= now);
  const pending = reminders.filter((r) => new Date(r.datetime) > now);

  for (const reminder of due) {
    console.log(
      `[reminder-daemon] Firing reminder [${reminder.id}]: "${reminder.message}"`
    );
    const sent = await sendTelegram(reminder.message);
    if (!sent) {
      console.error(
        `[reminder-daemon] Failed to send reminder [${reminder.id}]`
      );
      // Put it back so it retries on next poll
      pending.push(reminder);
    }
  }

  if (due.length > 0) {
    await writeReminders(pending);
  }
}

async function main() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error(
      "[reminder-daemon] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID"
    );
    process.exit(1);
  }

  console.log(
    `[reminder-daemon] Started. Polling ${REMINDERS_FILE} every ${POLL_INTERVAL_MS / 1000}s`
  );

  // Run immediately on start, then on interval
  await checkReminders();
  setInterval(checkReminders, POLL_INTERVAL_MS);
}

main();
