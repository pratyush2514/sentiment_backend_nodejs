import type {
  DominantEmotion,
  EscalationRisk,
  InteractionTone,
} from "../types/database.js";

interface SurfaceAnalysisInput {
  dominantEmotion: DominantEmotion;
  interactionTone?: string | null;
  rawInteractionTone?: string | null;
  escalationRisk?: EscalationRisk | null;
  sarcasmDetected?: boolean | null;
  messageText?: string | null;
}

const INTERACTION_TONES = new Set<InteractionTone>([
  "neutral",
  "collaborative",
  "corrective",
  "tense",
  "confrontational",
  "dismissive",
]);

function normalizeInteractionTone(value?: string | null): InteractionTone | null {
  if (!value) return null;
  return INTERACTION_TONES.has(value as InteractionTone)
    ? (value as InteractionTone)
    : null;
}

function hasStrongHostility(messageText: string): boolean {
  const lower = messageText.toLowerCase();
  const hostileSignals = [
    "ridiculous",
    "unacceptable",
    "wtf",
    "what the hell",
    "stop doing this",
    "this is stupid",
    "useless",
    "lazy",
    "idiot",
    "are you even",
    "nonsense",
  ];

  return hostileSignals.some((signal) => lower.includes(signal));
}

function inferInteractionToneFromText(messageText?: string | null): InteractionTone | null {
  if (!messageText) return null;
  const lower = messageText.toLowerCase();

  const confrontationalSignals = [
    "ridiculous",
    "unacceptable",
    "wtf",
    "what the hell",
    "stop doing this",
  ];
  if (confrontationalSignals.some((signal) => lower.includes(signal))) {
    return "confrontational";
  }

  const dismissiveSignals = [
    "per my last message",
    "i'll just handle it myself",
    "fine, i'll do it",
    "fine i'll do it",
    "whatever",
  ];
  if (dismissiveSignals.some((signal) => lower.includes(signal))) {
    return "dismissive";
  }

  const correctiveSignals = [
    "please read",
    "before sending",
    "before sharing",
    "before posting",
    "please check",
    "read the diagram",
    "read the doc",
    "read the thread",
  ];
  if (correctiveSignals.some((signal) => lower.includes(signal))) {
    return "corrective";
  }

  const tenseSignals = [
    "maybe you didn't",
    "maybe you didnt",
    "you didn't tell",
    "you didnt tell",
    "how these files are being used",
    "lack of context",
  ];
  if (tenseSignals.some((signal) => lower.includes(signal))) {
    return "tense";
  }

  return null;
}

export function resolveSurfaceAnalysis(
  input: SurfaceAnalysisInput,
): {
  emotion: DominantEmotion;
  interactionTone: InteractionTone | null;
  explanationOverride: string | null;
} {
  const interactionTone =
    normalizeInteractionTone(input.interactionTone) ??
    normalizeInteractionTone(input.rawInteractionTone) ??
    inferInteractionToneFromText(input.messageText);

  const shouldSoftenAnger =
    input.dominantEmotion === "anger" &&
    !input.sarcasmDetected &&
    input.escalationRisk !== "high" &&
    !!interactionTone &&
    (interactionTone === "corrective" || interactionTone === "tense") &&
    !hasStrongHostility(input.messageText ?? "");

  return {
    emotion: shouldSoftenAnger ? "neutral" : input.dominantEmotion,
    interactionTone,
    explanationOverride: shouldSoftenAnger
      ? "This reads as direct corrective feedback or communication friction rather than clear anger. The wording is sharp, but it is still focused on fixing the work or clarifying missing context instead of turning into overt hostility."
      : null,
  };
}
