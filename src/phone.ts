/**
 * Claude Phone Service (Twilio)
 *
 * Handles inbound and outbound phone calls via Twilio.
 * Run: tsx src/phone.ts
 */

import "dotenv/config";
import { serve } from "@hono/node-server";
import { transcribe } from "./transcribe.ts";
import {
  supabase,
  callClaude,
  buildPrompt,
  saveMessage,
  getRelevantContext,
  getMemoryContext,
  processMemoryIntents,
  selectModel,
} from "./shared.ts";
import {
  greeting,
  sayAndRecord,
  sayAndHangup,
  twimlResponse,
} from "./twiml.ts";

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = parseInt(process.env.PHONE_WEBHOOK_PORT || "3100");
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const USER_PHONE_NUMBER = process.env.USER_PHONE_NUMBER || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const BASE_URL =
  process.env.PHONE_WEBHOOK_URL || `http://35.178.39.179:${PORT}`;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set!");
  process.exit(1);
}

// ============================================================
// TWILIO CLIENT (for outbound calls)
// ============================================================

const Twilio = (await import("twilio")).default;
const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ============================================================
// CALL SESSION TRACKING
// ============================================================

interface CallSession {
  turns: number;
  lastActivity: number;
}

const callSessions = new Map<string, CallSession>();

// Pending responses: callSid → Claude's response (or null while processing)
const pendingResponses = new Map<string, string | null>();

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of callSessions) {
    if (now - session.lastActivity > 30 * 60 * 1000) {
      callSessions.delete(sid);
      pendingResponses.delete(sid);
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// WEBHOOK HANDLERS
// ============================================================

async function handleInbound(params: Record<string, string>): Promise<Response> {
  const callSid = params.CallSid || "";
  const from = params.From || "";

  // Security: only allow authorized caller
  if (USER_PHONE_NUMBER && from !== USER_PHONE_NUMBER) {
    console.log(`Unauthorized caller: ${from}`);
    return twimlResponse(sayAndHangup("Sorry, this number is private."));
  }

  console.log(`Inbound call from ${from} (${callSid})`);
  callSessions.set(callSid, { turns: 0, lastActivity: Date.now() });

  await saveMessage("system", `Phone call started from ${from}`, "phone");

  return twimlResponse(greeting(`${BASE_URL}/voice/respond`));
}

async function handleRecordingResponse(
  params: Record<string, string>
): Promise<Response> {
  const callSid = params.CallSid || "";
  const recordingUrl = params.RecordingUrl || "";
  const recordingSid = params.RecordingSid || "";

  if (!recordingUrl) {
    return twimlResponse(
      sayAndHangup("I didn't catch that. Talk to you later!")
    );
  }

  const session = callSessions.get(callSid);
  if (session) {
    session.turns++;
    session.lastActivity = Date.now();
  }

  // Mark this call as processing
  pendingResponses.set(callSid, null);

  // Process recording asynchronously (don't await — return TwiML immediately)
  processRecordingAsync(callSid, recordingUrl, recordingSid).catch((error) => {
    console.error("Async recording processing error:", error);
    pendingResponses.set(callSid, "Sorry, I had a hiccup. What were you saying?");
  });

  // Return TwiML that says "thinking" then polls for the result
  return twimlResponse(thinkingAndPoll(callSid));
}

/** Process the recording in the background while Twilio polls. */
async function processRecordingAsync(
  callSid: string,
  recordingUrl: string,
  recordingSid: string
): Promise<void> {
  // Small delay to ensure recording is available
  await new Promise((r) => setTimeout(r, 1000));

  const audioResponse = await fetch(`${recordingUrl}.wav`, {
    headers: {
      Authorization: `Basic ${btoa(TWILIO_ACCOUNT_SID + ":" + TWILIO_AUTH_TOKEN)}`,
    },
  });

  if (!audioResponse.ok) {
    console.error(`Recording download failed: ${audioResponse.status}`);
    pendingResponses.set(callSid, "Sorry, I couldn't hear that properly. Could you say that again?");
    return;
  }

  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
  const transcription = await transcribe(audioBuffer, "voice.wav");

  if (!transcription) {
    pendingResponses.set(callSid, "Sorry, I couldn't understand that. Could you repeat?");
    return;
  }

  console.log(`Transcribed: ${transcription}`);
  await saveMessage("user", `[Phone]: ${transcription}`, "phone");

  // Check for goodbye intent
  if (/\b(goodbye|bye|hang up|end call|that's all)\b/i.test(transcription)) {
    const farewell = "GOODBYE:Alright, talk to you later! Bye!";
    await saveMessage("assistant", farewell.replace("GOODBYE:", ""), "phone");
    cleanupRecording(recordingSid);
    pendingResponses.set(callSid, farewell);
    return;
  }

  // Get context and call Claude
  const [relevantContext, memoryContext] = await Promise.all([
    getRelevantContext(supabase, transcription),
    getMemoryContext(supabase),
  ]);

  const enrichedPrompt = buildPrompt(
    `[Phone call]: ${transcription}`,
    "phone",
    relevantContext,
    memoryContext
  );

  // Determine upfront whether this will need MCP tools (Sonnet/Opus).
  // Those calls take 10-20s — better to hang up and call back than make the
  // user wait on the line. Haiku is near-instant so responds in-call.
  const model = selectModel(enrichedPrompt);
  const willBeSlow = model !== "claude-haiku-4-5";

  if (willBeSlow) {
    pendingResponses.set(callSid, "CALLBACK");
    console.log(`[phone] ${model} call — hanging up, will call back`);
  }

  const rawResponse = await callClaude(enrichedPrompt);
  const response = await processMemoryIntents(supabase, rawResponse);
  await saveMessage("assistant", response, "phone");
  cleanupRecording(recordingSid);

  if (willBeSlow) {
    if (response.startsWith("Error:")) {
      // Claude errored — send to Telegram instead of speaking the error aloud
      console.log(`[phone] Callback error — routing to Telegram: ${response.substring(0, 80)}`);
      await sendTelegram(`📞 *Phone asked:* "${transcription}"\n\n⚠️ Couldn't get an answer right now — ${response}`);
    } else {
      console.log(`[phone] Calling back ${USER_PHONE_NUMBER} with answer`);
      await twilioClient.calls.create({
        to: USER_PHONE_NUMBER,
        from: TWILIO_PHONE_NUMBER,
        url: `${BASE_URL}/voice/callback?message=${encodeURIComponent(response)}`,
        method: "POST" as const,
        statusCallback: `${BASE_URL}/voice/status`,
        statusCallbackEvent: ["completed"],
      }).catch((err: unknown) => console.error("[phone] Callback call error:", err));
    }
  } else {
    pendingResponses.set(callSid, response);
  }
}

/** Handle poll requests — check if Claude's response is ready. */
function handlePoll(query: URLSearchParams): Response {
  const callSid = query.get("callSid") || "";
  const response = pendingResponses.get(callSid);

  if (response === null || response === undefined) {
    // Still processing — play a short pause then redirect back to poll
    return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="2"/>
  <Redirect method="POST">${BASE_URL}/voice/poll?callSid=${encodeURIComponent(callSid)}</Redirect>
</Response>`);
  }

  // Too slow — hang up, answer will arrive via callback call
  if (response === "CALLBACK") {
    pendingResponses.delete(callSid);
    return twimlResponse(sayAndHangup("That will take a moment. I'll call you straight back with the answer."));
  }

  // Response is ready — clean up and deliver
  pendingResponses.delete(callSid);

  // Check for goodbye prefix
  if (response.startsWith("GOODBYE:")) {
    return twimlResponse(sayAndHangup(response.replace("GOODBYE:", "")));
  }

  return twimlResponse(sayAndRecord(response, `${BASE_URL}/voice/respond`));
}

/** TwiML that says "thinking" then redirects to poll endpoint. */
function thinkingAndPoll(callSid: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Redirect method="POST">${BASE_URL}/voice/poll?callSid=${encodeURIComponent(callSid)}</Redirect>
</Response>`;
}

async function handleOutbound(
  params: Record<string, string>,
  query: URLSearchParams
): Promise<Response> {
  const message = query.get("message") || "Hey, just checking in!";
  const callSid = params.CallSid || "";

  callSessions.set(callSid, { turns: 0, lastActivity: Date.now() });
  await saveMessage("assistant", `[Outbound call]: ${message}`, "phone");

  // Speak the message, then listen for response
  return twimlResponse(
    sayAndRecord(message, `${BASE_URL}/voice/respond`)
  );
}

async function sendTelegram(message: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
  }).catch(console.error);
}

/** Outbound callback — speaks the answer and hangs up. No further recording. */
function handleCallback(params: Record<string, string>, query: URLSearchParams): Response {
  const message = query.get("message") || params.message || "Here is your answer.";
  return twimlResponse(sayAndHangup(message));
}

function handleStatus(params: Record<string, string>): Response {
  const callSid = params.CallSid || "";
  const status = params.CallStatus || "";
  console.log(`Call ${callSid} status: ${status}`);

  if (status === "completed" || status === "failed" || status === "no-answer") {
    callSessions.delete(callSid);
  }

  return new Response("OK");
}

// ============================================================
// OUTBOUND CALL (re-exported from outbound.ts for external use)
// ============================================================

export { makeOutboundCall } from "./outbound.ts";

// ============================================================
// HELPERS
// ============================================================

function cleanupRecording(recordingSid: string): void {
  if (!recordingSid) return;
  twilioClient
    .recordings(recordingSid)
    .remove()
    .catch((err: unknown) =>
      console.error("Recording cleanup error:", err)
    );
}

// ============================================================
// HTTP SERVER
// ============================================================

serve({
  port: PORT,
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check
    if (req.method === "GET" && path === "/health") {
      return new Response("OK");
    }

    if (req.method === "POST") {
      const formData = await req.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = value.toString();
      }

      switch (path) {
        case "/voice/inbound":
          return handleInbound(params);
        case "/voice/respond":
          return handleRecordingResponse(params);
        case "/voice/outbound":
          return handleOutbound(params, url.searchParams);
        case "/voice/poll":
          return handlePoll(url.searchParams);
        case "/voice/status":
          return handleStatus(params);
        case "/voice/callback":
          return handleCallback(params, url.searchParams);
        default:
          return new Response("Not found", { status: 404 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Phone service running on port ${PORT}`);
console.log(`Webhook URL: ${BASE_URL}`);
console.log(`Twilio number: ${TWILIO_PHONE_NUMBER || "(not set)"}`);
console.log(`Authorized caller: ${USER_PHONE_NUMBER || "ANY (not recommended)"}`);
