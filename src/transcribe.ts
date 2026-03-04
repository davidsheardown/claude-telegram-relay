/**
 * Voice Transcription Module
 *
 * Routes to Groq (cloud) or whisper.cpp (local) based on VOICE_PROVIDER env var.
 */

import { spawn } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";

const VOICE_PROVIDER = process.env.VOICE_PROVIDER || "";

/**
 * Transcribe an audio buffer to text.
 * Returns empty string if no provider is configured.
 * @param filename - hint for the audio format (e.g. "voice.wav", "voice.ogg")
 */
export async function transcribe(
  audioBuffer: Buffer,
  filename: string = "voice.ogg"
): Promise<string> {
  if (!VOICE_PROVIDER) return "";

  if (VOICE_PROVIDER === "groq") {
    return transcribeGroq(audioBuffer, filename);
  }

  if (VOICE_PROVIDER === "local") {
    return transcribeLocal(audioBuffer);
  }

  console.error(`Unknown VOICE_PROVIDER: ${VOICE_PROVIDER}`);
  return "";
}

async function transcribeGroq(
  audioBuffer: Buffer,
  filename: string = "voice.ogg"
): Promise<string> {
  const Groq = (await import("groq-sdk")).default;
  const groq = new Groq(); // reads GROQ_API_KEY from env

  const mimeType = filename.endsWith(".wav") ? "audio/wav" : "audio/ogg";
  const file = new File([audioBuffer], filename, { type: mimeType });

  const result = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3-turbo",
  });

  return result.text.trim();
}

function runCommand(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    const stderrChunks: Buffer[] = [];
    proc.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
    proc.on("close", (code) => resolve({ code: code ?? 0, stderr: Buffer.concat(stderrChunks).toString() }));
    proc.on("error", reject);
  });
}

async function transcribeLocal(audioBuffer: Buffer): Promise<string> {
  const whisperBinary = process.env.WHISPER_BINARY || "whisper-cpp";
  const modelPath = process.env.WHISPER_MODEL_PATH || "";

  if (!modelPath) {
    throw new Error("WHISPER_MODEL_PATH not set");
  }

  const timestamp = Date.now();
  const tmpDir = process.env.TMPDIR || "/tmp";
  const oggPath = join(tmpDir, `voice_${timestamp}.ogg`);
  const wavPath = join(tmpDir, `voice_${timestamp}.wav`);
  const txtPath = join(tmpDir, `voice_${timestamp}.txt`);

  try {
    // Write OGG to temp file
    await writeFile(oggPath, audioBuffer);

    // Convert OGG → WAV via ffmpeg
    const { code: ffmpegExit, stderr: ffmpegStderr } = await runCommand("ffmpeg", [
      "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath, "-y",
    ]);
    if (ffmpegExit !== 0) {
      throw new Error(`ffmpeg failed (code ${ffmpegExit}): ${ffmpegStderr}`);
    }

    // Transcribe via whisper.cpp
    const { code: whisperExit, stderr: whisperStderr } = await runCommand(whisperBinary, [
      "--model", modelPath, "--file", wavPath, "--output-txt",
      "--output-file", join(tmpDir, `voice_${timestamp}`), "--no-prints",
    ]);
    if (whisperExit !== 0) {
      throw new Error(`whisper-cpp failed (code ${whisperExit}): ${whisperStderr}`);
    }

    // Read the output text file
    const text = await readFile(txtPath, "utf-8");
    return text.trim();
  } finally {
    // Cleanup temp files
    await unlink(oggPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
    await unlink(txtPath).catch(() => {});
  }
}
