/**
 * Alexa Skill — Lambda Handler
 *
 * Handles the Alexa skill protocol and relays queries to your VPS.
 *
 * Required Lambda environment variables:
 *   VPS_URL       — e.g. http://35.178.39.179:3200
 *   ALEXA_SECRET  — shared secret (must match VPS ALEXA_SECRET in .env)
 *
 * Alexa skill intents needed (set up in Alexa Developer Console):
 *   AskClaudeIntent  — with slot {query} of type AMAZON.SearchQuery
 *   AMAZON.StopIntent, AMAZON.CancelIntent, AMAZON.HelpIntent (built-ins)
 */

const VPS_URL = process.env.VPS_URL || "";
const ALEXA_SECRET = process.env.ALEXA_SECRET || "";
const TIMEOUT_MS = 7500; // Alexa hard limit is ~8s total; leave margin

// ============================================================
// ALEXA RESPONSE BUILDERS
// ============================================================

function speak(text, endSession = true) {
  return {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      shouldEndSession: endSession,
    },
  };
}

function speakAndListen(text, reprompt = "Is there anything else?") {
  return {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      reprompt: { outputSpeech: { type: "PlainText", text: reprompt } },
      shouldEndSession: false,
    },
  };
}

// ============================================================
// VPS RELAY
// ============================================================

async function askVPS(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${VPS_URL}/alexa/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, secret: ALEXA_SECRET }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`VPS returned ${response.status}`);
      return "Sorry, I had trouble reaching your assistant. Please try again.";
    }

    const data = await response.json();
    return data.speech || "I got a response but couldn't read it.";
  } catch (err) {
    if (err.name === "AbortError") {
      return "Your assistant is thinking. I'll send the answer to your phone shortly.";
    }
    console.error("VPS error:", err);
    return "Sorry, I couldn't connect to your assistant right now.";
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// INTENT HANDLERS
// ============================================================

async function handleLaunch() {
  return speakAndListen(
    "Hi, I'm your Claude assistant. What would you like to know?",
    "What can I help you with?"
  );
}

async function handleAskClaude(intent) {
  const query =
    intent.slots?.query?.value ||
    intent.slots?.Query?.value ||
    "";

  if (!query) {
    return speakAndListen(
      "Sorry, I didn't catch your question. Could you say that again?",
      "What would you like to ask?"
    );
  }

  const speech = await askVPS(query);

  // If the response ends with "to your phone" keep the session open briefly
  // so the user can ask a follow-up; otherwise end the session.
  const endsSession = !speech.includes("to your phone");
  return endsSession ? speak(speech) : speakAndListen(speech, "Is there anything else?");
}

function handleStop() {
  return speak("Goodbye!");
}

function handleHelp() {
  return speakAndListen(
    "You can ask me anything — calendar, reminders, general questions, or email. " +
    "Just say: ask Claude, followed by your question.",
    "What would you like to know?"
  );
}

// ============================================================
// LAMBDA ENTRY POINT
// ============================================================

export const handler = async (event) => {
  console.log("Request:", JSON.stringify(event.request));

  const requestType = event.request?.type;

  if (requestType === "LaunchRequest") {
    return handleLaunch();
  }

  if (requestType === "SessionEndedRequest") {
    return { version: "1.0", response: {} };
  }

  if (requestType === "IntentRequest") {
    const intentName = event.request?.intent?.name;

    switch (intentName) {
      case "AskClaudeIntent":
        return handleAskClaude(event.request.intent);
      case "AMAZON.StopIntent":
      case "AMAZON.CancelIntent":
        return handleStop();
      case "AMAZON.HelpIntent":
        return handleHelp();
      default:
        return speak("I'm not sure how to handle that. Try asking me a question.");
    }
  }

  return speak("Something unexpected happened. Please try again.");
};
