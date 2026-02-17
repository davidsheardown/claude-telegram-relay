/**
 * Claude Phone Service (Twilio)
 *
 * Handles inbound and outbound phone calls via Twilio.
 * Reuses the same Claude CLI pipeline as the Telegram relay.
 *
 * Run: bun run src/phone.ts
 */

import { transcribe } from "./transcribe.ts";
import {
  supabase,
  callClaude,
  buildPrompt,
  saveMessage,
  getRelevantContext,
  getMemoryContext,
  processMemoryIntents,
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

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of callSessions) {
    if (now - session.lastActivity > 30 * 60 * 1000) {
      callSessions.delete(sid);
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

  try {
    // Download recording (Twilio provides WAV when appending .wav)
    const audioResponse = await fetch(`${recordingUrl}.wav`, {
      headers: {
        Authorization: `Basic ${btoa(TWILIO_ACCOUNT_SID + ":" + TWILIO_AUTH_TOKEN)}`,
      },
    });
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    // Transcribe with existing Groq Whisper pipeline
    const transcription = await transcribe(audioBuffer);

    if (!transcription) {
      return twimlResponse(
        sayAndRecord(
          "Sorry, I couldn't understand that. Could you repeat?",
          `${BASE_URL}/voice/respond`
        )
      );
    }

    console.log(`Transcribed: ${transcription}`);
    await saveMessage("user", `[Phone]: ${transcription}`, "phone");

    // Check for goodbye intent
    if (/\b(goodbye|bye|hang up|end call|that's all)\b/i.test(transcription)) {
      const farewell = "Alright, talk to you later! Bye!";
      await saveMessage("assistant", farewell, "phone");
      cleanupRecording(recordingSid);
      return twimlResponse(sayAndHangup(farewell));
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

    const rawResponse = await callClaude(enrichedPrompt);
    const response = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", response, "phone");

    // Cleanup recording from Twilio storage
    cleanupRecording(recordingSid);

    // Respond and listen for next turn
    return twimlResponse(
      sayAndRecord(response, `${BASE_URL}/voice/respond`)
    );
  } catch (error) {
    console.error("Recording processing error:", error);
    return twimlResponse(
      sayAndRecord(
        "Sorry, I had a hiccup. What were you saying?",
        `${BASE_URL}/voice/respond`
      )
    );
  }
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
// OUTBOUND CALL (exported for use by other modules)
// ============================================================

export async function makeOutboundCall(
  message: string,
  to?: string
): Promise<string> {
  const targetNumber = to || USER_PHONE_NUMBER;

  if (!targetNumber) {
    throw new Error("No target phone number specified");
  }

  if (!TWILIO_PHONE_NUMBER) {
    throw new Error("TWILIO_PHONE_NUMBER not configured");
  }

  const call = await twilioClient.calls.create({
    to: targetNumber,
    from: TWILIO_PHONE_NUMBER,
    url: `${BASE_URL}/voice/outbound?message=${encodeURIComponent(message)}`,
    statusCallback: `${BASE_URL}/voice/status`,
    statusCallbackEvent: ["completed"],
  });

  console.log(`Outbound call initiated: ${call.sid}`);
  return call.sid;
}

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

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
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
        case "/voice/status":
          return handleStatus(params);
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
