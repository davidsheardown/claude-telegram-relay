/**
 * TwiML Response Builders
 *
 * Generates Twilio Markup Language (TwiML) XML responses for voice calls.
 */

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Speak a greeting and start recording the caller's response. */
export function greeting(actionUrl: string): string {
  return sayAndRecord("Hey! What can I help with?", actionUrl);
}

/** Speak text, then record the caller's next response. */
export function sayAndRecord(text: string, actionUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Emma-Generative">${escapeXml(text)}</Say>
  <Record
    action="${escapeXml(actionUrl)}"
    maxLength="120"
    playBeep="false"
    trim="trim-silence"
    timeout="3"
  />
  <Say voice="Polly.Emma-Generative">I didn't hear anything. Talk to you later!</Say>
</Response>`;
}

/** Speak text and end the call. */
export function sayAndHangup(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Emma-Generative">${escapeXml(text)}</Say>
</Response>`;
}

/** Create an HTTP Response with TwiML content type. */
export function twimlResponse(twiml: string): Response {
  return new Response(twiml, {
    headers: { "Content-Type": "text/xml" },
  });
}
