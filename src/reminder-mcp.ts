/**
 * Reminder MCP Server
 *
 * Exposes three tools to Claude:
 *   - schedule_reminder: schedule a one-off Telegram reminder
 *   - list_reminders:    list all pending reminders
 *   - cancel_reminder:   cancel a pending reminder by ID
 *
 * Reminders are stored in REMINDERS_FILE (default: ~/.reminders.json).
 * The reminder-daemon.ts process polls this file and fires Telegram messages.
 *
 * Run via: bun run src/reminder-mcp.ts
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

const REMINDERS_FILE =
  process.env.REMINDERS_FILE ||
  join(process.env.HOME || "~", ".reminders.json");

// ============================================================
// DATA
// ============================================================

interface Reminder {
  id: string;
  message: string;
  datetime: string; // ISO 8601
  created: string;  // ISO 8601
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
  await mkdir(dirname(REMINDERS_FILE), { recursive: true });
  await writeFile(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}

// ============================================================
// TOOL HANDLERS
// ============================================================

async function scheduleReminder(
  message: string,
  datetime: string
): Promise<string> {
  const dt = new Date(datetime);
  if (isNaN(dt.getTime())) {
    return `Error: invalid datetime "${datetime}". Use ISO 8601 format, e.g. "2026-02-21T15:00:00".`;
  }
  if (dt <= new Date()) {
    return `Error: datetime is in the past (${dt.toISOString()}).`;
  }

  const reminders = await readReminders();
  const reminder: Reminder = {
    id: randomUUID().slice(0, 8),
    message,
    datetime: dt.toISOString(),
    created: new Date().toISOString(),
  };
  reminders.push(reminder);
  await writeReminders(reminders);

  const localTime = dt.toLocaleString("en-GB", {
    timeZone: process.env.USER_TIMEZONE || "Europe/London",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `Reminder scheduled (ID: ${reminder.id}) for ${localTime}: "${message}"`;
}

async function listReminders(): Promise<string> {
  const reminders = await readReminders();
  if (reminders.length === 0) return "No pending reminders.";

  const tz = process.env.USER_TIMEZONE || "Europe/London";
  return reminders
    .sort((a, b) => a.datetime.localeCompare(b.datetime))
    .map((r) => {
      const localTime = new Date(r.datetime).toLocaleString("en-GB", {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `[${r.id}] ${localTime} — ${r.message}`;
    })
    .join("\n");
}

async function cancelReminder(id: string): Promise<string> {
  const reminders = await readReminders();
  const index = reminders.findIndex((r) => r.id === id);
  if (index === -1) return `No reminder found with ID "${id}".`;
  const [removed] = reminders.splice(index, 1);
  await writeReminders(reminders);
  return `Cancelled reminder [${removed.id}]: "${removed.message}"`;
}

// ============================================================
// MCP JSON-RPC STDIO SERVER
// ============================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function respond(id: number | string | null, result: unknown): void {
  const response: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(response) + "\n");
}

function respondError(
  id: number | string | null,
  code: number,
  message: string
): void {
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
  process.stdout.write(JSON.stringify(response) + "\n");
}

const TOOLS = [
  {
    name: "schedule_reminder",
    description:
      "Schedule a one-off reminder that will be sent to David via Telegram at the specified time.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The reminder message to send.",
        },
        datetime: {
          type: "string",
          description:
            'When to send the reminder, in ISO 8601 format (e.g. "2026-02-21T15:00:00"). Always use the Europe/London timezone.',
        },
      },
      required: ["message", "datetime"],
    },
  },
  {
    name: "list_reminders",
    description: "List all pending reminders.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a pending reminder by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The reminder ID to cancel (shown in list_reminders).",
        },
      },
      required: ["id"],
    },
  },
];

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "reminder-scheduler", version: "1.0.0" },
      });
      break;

    case "notifications/initialized":
      // No response needed for notifications
      break;

    case "tools/list":
      respond(id, { tools: TOOLS });
      break;

    case "tools/call": {
      const params = req.params as {
        name: string;
        arguments: Record<string, string>;
      };
      const args = params.arguments || {};
      let text: string;

      try {
        switch (params.name) {
          case "schedule_reminder":
            text = await scheduleReminder(args.message, args.datetime);
            break;
          case "list_reminders":
            text = await listReminders();
            break;
          case "cancel_reminder":
            text = await cancelReminder(args.id);
            break;
          default:
            respondError(id, -32601, `Unknown tool: ${params.name}`);
            return;
        }
        respond(id, {
          content: [{ type: "text", text }],
        });
      } catch (err) {
        respond(id, {
          content: [{ type: "text", text: `Error: ${err}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      respondError(id, -32601, `Method not found: ${req.method}`);
  }
}

// Read newline-delimited JSON from stdin
let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req: JsonRpcRequest = JSON.parse(trimmed);
      await handleRequest(req);
    } catch {
      respondError(null, -32700, "Parse error");
    }
  }
});

process.stdin.on("end", () => process.exit(0));
