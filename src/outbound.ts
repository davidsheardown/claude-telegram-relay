/**
 * Outbound Phone Calls (Twilio)
 *
 * Extracted from phone.ts so relay.ts can import makeOutboundCall
 * without also starting the HTTP server.
 */

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const USER_PHONE_NUMBER = process.env.USER_PHONE_NUMBER || "";
const PORT = parseInt(process.env.PHONE_WEBHOOK_PORT || "3100");
const BASE_URL = process.env.PHONE_WEBHOOK_URL || `http://35.178.39.179:${PORT}`;

export async function makeOutboundCall(message: string, to?: string): Promise<string> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
  }

  const targetNumber = to || USER_PHONE_NUMBER;
  if (!targetNumber) throw new Error("No target phone number (USER_PHONE_NUMBER not set)");
  if (!TWILIO_PHONE_NUMBER) throw new Error("TWILIO_PHONE_NUMBER not configured");

  const Twilio = (await import("twilio")).default;
  const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  const call = await client.calls.create({
    to: targetNumber,
    from: TWILIO_PHONE_NUMBER,
    url: `${BASE_URL}/voice/outbound?message=${encodeURIComponent(message)}`,
    statusCallback: `${BASE_URL}/voice/status`,
    statusCallbackEvent: ["completed"],
  });

  console.log(`Outbound call initiated: ${call.sid}`);
  return call.sid;
}
