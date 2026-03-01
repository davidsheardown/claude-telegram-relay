/**
 * Text-to-Speech Module (OpenAI)
 *
 * Converts text to an OGG/Opus audio buffer suitable for Telegram's sendVoice.
 * Requires OPENAI_API_KEY in environment.
 *
 * Voice options: alloy, echo, fable, onyx, nova, shimmer
 * Default: alloy (neutral, clear)
 */

const TTS_VOICE = (process.env.TTS_VOICE || "alloy") as
  | "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

/**
 * Returns true if TTS is available (API key is set).
 */
export function ttsAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Strips markdown and emojis so the text sounds natural when spoken.
 */
export function toSpoken(text: string): string {
  return text
    .replace(/\*([^*]+)\*/g, "$1")       // bold
    .replace(/_([^_]+)_/g, "$1")          // italic
    .replace(/`[^`]+`/g, "$1")            // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → label only
    .replace(/^#{1,6}\s+/gm, "")          // headings
    .replace(/^[-•]\s+/gm, "")            // bullet points
    .replace(/\p{Emoji_Presentation}/gu, "") // emojis
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Synthesise text to an OGG/Opus buffer using OpenAI TTS.
 * Throws if OPENAI_API_KEY is not set or the API call fails.
 */
export async function synthesise(text: string): Promise<Buffer> {
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI(); // reads OPENAI_API_KEY from env

  const spoken = toSpoken(text);

  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice: TTS_VOICE,
    input: spoken,
    response_format: "opus", // OGG/Opus — Telegram sendVoice compatible
  });

  return Buffer.from(await response.arrayBuffer());
}
