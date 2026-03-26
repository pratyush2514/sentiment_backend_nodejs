import { classifyOperationalIncident } from "./operationalIncident.js";
import { computeRiskScore } from "./riskHeuristic.js";
import type {
  CanonicalSignalSeverity,
  CanonicalSignalType,
  ChannelMode,
  IncidentFamily,
  MessageCandidateKind as DbMessageCandidateKind,
  OriginType,
  SignalStateImpact,
  StateTransition as DbStateTransition,
  SurfacePriority as DbSurfacePriority,
} from "../types/database.js";


export type MessageCandidateKind = DbMessageCandidateKind;
export type SurfacePriority = DbSurfacePriority;
export type StateTransition = DbStateTransition;

export interface MessageTriageResult {
  candidateKind: MessageCandidateKind;
  surfacePriority: SurfacePriority;
  candidateScore: number;
  stateTransition: StateTransition | null;
  signalType: CanonicalSignalType;
  severity: CanonicalSignalSeverity;
  stateImpact: SignalStateImpact;
  evidenceType: "heuristic";
  channelMode: ChannelMode;
  originType: OriginType;
  confidence: number;
  incidentFamily: IncidentFamily;
  reasonCodes: string[];
  signals: Record<string, unknown>;
}

const ACK_ONLY_RE =
  /^(ok(ay)?|haan|han|hmm+|hm+|got it|thanks?|thank you|thx|cool|sure|noted|done|perfect|all good|works now|working now|great|np|no worries|alright|will do|yep|yup|yes|k)\W*$/i;
const EMOJI_ONLY_RE = /^[\s\p{Extended_Pictographic}:()+\-_=*.,!?]+$/u;
const CONTRAST_RE = /\b(?:but|however|though|although|still|yet|except)\b/i;
const ROUTINE_TROUBLESHOOTING_RE =
  /\b(that'?s the problem i am getting|same issue|same problem|same here|i am getting this|i'm getting this|this is the error|this is what i see|that is what i see|that's what i see|this is happening|that is happening)\b/i;
const RESOLUTION_RE =
  /\b(fixed|resolved|working now|works now|all good now|can proceed|unblocked|done now|that worked|solved|closed this|issue is gone)\b/i;
const EXPLICIT_BLOCKER_RE =
  /\b(blocked\b|can't proceed|cannot proceed|unable to proceed|stuck until|waiting on|waiting for|held up by|need access before|need approval before)\b/i;
const QUESTION_RE =
  /\?|\b(can someone|could someone|who can|what account|where is|how do|what's|whats|why is|when will)\b/i;
const REQUEST_RE =
  /\b(please|can you|could you|need you to|take a look|review this|check this|help with|look into|lmk\b|let me know|please review|please check|please send|please merge|please fill|please share|can i merge)\b/i;
const FRUSTRATION_RE =
  /\b(pointless|how come.{0,20}(long|still)|not how|didnt get|didn'?t get|everything is broke|still broken|still stuck|keeps breaking|keeps failing|so slow|waste of time|makes no sense)\b/i;
const BREAKAGE_REPORT_RE =
  /\b(broke\b|broken\b|everything.{0,10}broke|not working|getting error|having issue|having issues|messed up|it crashed|keeps crashing)\b/i;
const ACTION_REQUIRED_RE =
  /\b(we need to fix|need to fix|needs fixing|need fixing|needs a fix|requires a fix|have to fix|has to be fixed|must fix|should fix|needs attention)\b/i;
const OWNER_RE =
  /\b(i'?ll handle|i will handle|assign(?:ed)? to|owner is|i can take|let me take|i'll pick this|i will pick this)\b/i;
const DECISION_RE =
  /\b(let'?s go with|we'?ve decided|we have decided|going with|ship this|do not use|use this|root cause|turns out|because of|due to|caused by|caused)\b/i;
const ESCALATION_RE =
  /\b(escalate|leadership|urgent|asap|immediately|critical|unacceptable|terrible|furious|angry|ridiculous)\b/i;
const LOG_CONTEXT_RE =
  /\b(exception|traceback|stack trace|error code|http \d{3}|undefined|nullpointer|segmentation fault)\b/i;
const PROBLEM_WORD_RE =
  /\b(problem|issue|error|failing|fails?|failed|broken|bug)\b/i;
const BREAKAGE_RE =
  /\b(breaking|breaks|crashing|crashed|down|outage|not working|isn't working|is not working)\b/i;
const CHANNEL_REFERENCE_RE = /(^|[\s(])#([a-z0-9][a-z0-9_-]{1,79})\b/gi;

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function pushReason(
  reasonCodes: string[],
  reason: string,
  condition: boolean,
): void {
  if (condition && !reasonCodes.includes(reason)) {
    reasonCodes.push(reason);
  }
}

function extractFocusedClause(text: string): string {
  const parts = text
    .split(/\b(?:but|however|though|although|still|yet|except)\b/i)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 1 ? (parts[parts.length - 1] ?? text) : text;
}

function detectSignals(text: string) {
  const riskScore = computeRiskScore(text);
  const hasBreakageSignal = BREAKAGE_RE.test(text);

  return {
    riskScore,
    routineTroubleshooting: ROUTINE_TROUBLESHOOTING_RE.test(text),
    explicitBlocker: EXPLICIT_BLOCKER_RE.test(text),
    resolutionSignal: RESOLUTION_RE.test(text),
    hasQuestion: QUESTION_RE.test(text),
    hasRequest: REQUEST_RE.test(text),
    hasActionRequiredSignal: ACTION_REQUIRED_RE.test(text),
    hasOwnerSignal: OWNER_RE.test(text),
    hasDecisionSignal: DECISION_RE.test(text),
    hasEscalationSignal: ESCALATION_RE.test(text) || riskScore >= 0.6,
    hasTechnicalLogContext: LOG_CONTEXT_RE.test(text),
    hasProblemWords: PROBLEM_WORD_RE.test(text) || hasBreakageSignal,
    hasBreakageSignal,
    hasFrustrationSignal: FRUSTRATION_RE.test(text),
    hasBreakageReport: BREAKAGE_REPORT_RE.test(text),
  };
}

function normalizeChannelReference(value?: string | null): string | null {
  const normalized = (value ?? "")
    .trim()
    .replace(/^#/, "")
    .replace(/\s+/g, "_")
    .toLowerCase();

  return normalized.length > 0 ? normalized : null;
}

function extractReferencedChannelName(
  text: string,
  currentChannelName?: string | null,
): string | null {
  const current = normalizeChannelReference(currentChannelName);
  const matches = text.matchAll(CHANNEL_REFERENCE_RE);

  for (const match of matches) {
    const candidate = normalizeChannelReference(match[2] ?? null);
    if (!candidate) {
      continue;
    }

    if (!current || candidate !== current) {
      return candidate;
    }
  }

  return null;
}

export function isDeepAnalysisCandidate(
  candidateKind: MessageCandidateKind | null | undefined,
): boolean {
  return candidateKind === "message_candidate";
}

export function shouldEnrichMessageSignal(
  triage: Pick<MessageTriageResult, "signalType" | "stateImpact" | "originType">,
): boolean {
  if (triage.originType !== "human") {
    return false;
  }

  if (
    triage.signalType === "human_risk" ||
    triage.signalType === "request" ||
    triage.signalType === "decision" ||
    triage.signalType === "resolution"
  ) {
    return true;
  }

  return triage.stateImpact !== "none";
}

export function shouldRefreshThreadInsight(
  triage: Pick<
    MessageTriageResult,
    "candidateKind" | "surfacePriority" | "stateTransition"
  >,
  threadTs?: string | null,
): boolean {
  if (!threadTs) {
    return false;
  }

  if (
    triage.candidateKind === "thread_turning_point" ||
    triage.candidateKind === "resolution_signal"
  ) {
    return true;
  }

  if (triage.candidateKind !== "message_candidate") {
    return false;
  }

  return (
    triage.surfacePriority === "high" ||
    triage.stateTransition === "blocked" ||
    triage.stateTransition === "waiting_external" ||
    triage.stateTransition === "escalated"
  );
}

export function classifyMessageTriage(input: {
  text: string;
  normalizedText?: string | null;
  threadTs?: string | null;
  channelMode?: ChannelMode | null;
  originType?: OriginType | null;
  channelName?: string | null;
}): MessageTriageResult {
  const normalizedText = (input.normalizedText ?? input.text ?? "").trim();
  const lower = normalizedText.toLowerCase();
  const channelMode = input.channelMode ?? "collaboration";
  const originType = input.originType ?? "human";
  const focusedClause = extractFocusedClause(normalizedText);
  const focusedLower = focusedClause.toLowerCase();
  const primarySignals = detectSignals(lower);
  const focusedSignals =
    focusedLower === lower ? primarySignals : detectSignals(focusedLower);
  const reasonCodes: string[] = [];
  const riskScore = Math.max(
    primarySignals.riskScore,
    focusedSignals.riskScore,
  );
  const isShort = lower.length <= 24;
  const ackOnly =
    ACK_ONLY_RE.test(lower) || (isShort && EMOJI_ONLY_RE.test(normalizedText));
  const hasContrast = focusedLower !== lower && CONTRAST_RE.test(lower);
  const routineTroubleshooting =
    primarySignals.routineTroubleshooting ||
    focusedSignals.routineTroubleshooting;
  const explicitBlocker =
    primarySignals.explicitBlocker || focusedSignals.explicitBlocker;
  const resolutionSignal =
    primarySignals.resolutionSignal || focusedSignals.resolutionSignal;
  const hasQuestion = primarySignals.hasQuestion || focusedSignals.hasQuestion;
  const hasRequest = primarySignals.hasRequest || focusedSignals.hasRequest;
  const hasActionRequiredSignal =
    primarySignals.hasActionRequiredSignal ||
    focusedSignals.hasActionRequiredSignal;
  const hasOwnerSignal =
    primarySignals.hasOwnerSignal || focusedSignals.hasOwnerSignal;
  const hasDecisionSignal =
    primarySignals.hasDecisionSignal || focusedSignals.hasDecisionSignal;
  const hasEscalationSignal =
    primarySignals.hasEscalationSignal || focusedSignals.hasEscalationSignal;
  const hasTechnicalLogContext =
    primarySignals.hasTechnicalLogContext ||
    focusedSignals.hasTechnicalLogContext;
  const hasProblemWords =
    primarySignals.hasProblemWords || focusedSignals.hasProblemWords;
  const hasBreakageSignal =
    primarySignals.hasBreakageSignal || focusedSignals.hasBreakageSignal;
  const hasFrustrationSignal =
    primarySignals.hasFrustrationSignal || focusedSignals.hasFrustrationSignal;
  const hasBreakageReport =
    primarySignals.hasBreakageReport || focusedSignals.hasBreakageReport;
  const contrastFocusedRisk =
    hasContrast &&
    (focusedSignals.explicitBlocker ||
      focusedSignals.hasEscalationSignal ||
      focusedSignals.hasRequest ||
      focusedSignals.hasActionRequiredSignal ||
      focusedSignals.hasQuestion ||
      focusedSignals.hasProblemWords);
  const strongQuestionOrRequest =
    (hasQuestion || hasRequest) &&
    (explicitBlocker ||
      hasEscalationSignal ||
      hasActionRequiredSignal ||
      hasBreakageSignal ||
      hasProblemWords ||
      hasTechnicalLogContext ||
      contrastFocusedRisk ||
      riskScore >= 0.45);
  const operationalIncident = classifyOperationalIncident({
    text: normalizedText,
    channelMode,
    originType,
  });
  const referencedChannelName = extractReferencedChannelName(
    normalizedText,
    input.channelName ?? null,
  );
  const relatedIncident =
    originType === "human" &&
    Boolean(referencedChannelName) &&
    operationalIncident.isIncident
      ? {
          kind: "referenced_external_incident" as const,
          sourceChannelName: referencedChannelName!,
          blocksLocalWork:
            explicitBlocker ||
            hasActionRequiredSignal ||
            strongQuestionOrRequest ||
            hasEscalationSignal ||
            contrastFocusedRisk,
          incidentFamily: operationalIncident.incidentFamily,
        }
      : null;

  pushReason(reasonCodes, "ack_only", ackOnly);
  pushReason(reasonCodes, "contrast_focus", contrastFocusedRisk);
  pushReason(reasonCodes, "routine_troubleshooting", routineTroubleshooting);
  pushReason(reasonCodes, "explicit_blocker", explicitBlocker);
  pushReason(reasonCodes, "resolution_signal", resolutionSignal);
  pushReason(reasonCodes, "question", hasQuestion);
  pushReason(reasonCodes, "request", hasRequest);
  pushReason(reasonCodes, "action_required_signal", hasActionRequiredSignal);
  pushReason(reasonCodes, "owner_signal", hasOwnerSignal);
  pushReason(reasonCodes, "decision_signal", hasDecisionSignal);
  pushReason(reasonCodes, "escalation_signal", hasEscalationSignal);
  pushReason(reasonCodes, "technical_log_context", hasTechnicalLogContext);
  pushReason(reasonCodes, "problem_signal", hasProblemWords);
  pushReason(reasonCodes, "breakage_signal", hasBreakageSignal);
  pushReason(reasonCodes, "frustration_signal", hasFrustrationSignal);
  pushReason(reasonCodes, "breakage_report", hasBreakageReport);
  pushReason(reasonCodes, "risk_score_high", riskScore >= 0.6);
  pushReason(reasonCodes, "related_external_incident", relatedIncident !== null);

  const baseSignals: Record<string, unknown> = {
    ackOnly,
    routineTroubleshooting,
    explicitBlocker,
    resolutionSignal,
    hasQuestion,
    hasRequest,
    hasActionRequiredSignal,
    hasOwnerSignal,
    hasDecisionSignal,
    hasEscalationSignal,
    hasTechnicalLogContext,
    hasProblemWords,
    hasBreakageSignal,
    hasFrustrationSignal,
    hasBreakageReport,
    contrastFocusedRisk,
    riskScore,
    channelMode,
    originType,
    relatedIncidentKind: relatedIncident?.kind ?? null,
    relatedIncidentSourceChannelName: relatedIncident?.sourceChannelName ?? null,
    relatedIncidentBlocksLocalWork: relatedIncident?.blocksLocalWork ?? false,
    relatedIncidentFamily: relatedIncident?.incidentFamily ?? null,
  };

  if (!lower) {
    return {
      candidateKind: "ignore",
      surfacePriority: "none",
      candidateScore: 0,
      stateTransition: null,
      signalType: "ignore",
      severity: "none",
      stateImpact: "none",
      evidenceType: "heuristic",
      channelMode,
      originType,
      confidence: 0.35,
      incidentFamily: "none",
      reasonCodes: ["empty"],
      signals: {
        ...baseSignals,
        ackOnly: false,
        routineTroubleshooting: false,
        explicitBlocker: false,
        resolutionSignal: false,
        hasQuestion: false,
        hasRequest: false,
        hasActionRequiredSignal: false,
        hasOwnerSignal: false,
        hasDecisionSignal: false,
        hasEscalationSignal: false,
        hasBreakageSignal: false,
        hasFrustrationSignal: false,
        hasBreakageReport: false,
        contrastFocusedRisk: false,
        riskScore,
      },
    };
  }

  if (operationalIncident.isIncident && !relatedIncident) {
    return {
      candidateKind: "context_only",
      surfacePriority: operationalIncident.surfacePriority,
      candidateScore: clampScore(
        Math.max(0.4, operationalIncident.confidence),
      ),
      stateTransition:
        operationalIncident.stateImpact === "blocked"
          ? "blocked"
          : operationalIncident.stateImpact === "escalated"
          ? "escalated"
          : operationalIncident.stateImpact === "resolved"
          ? "resolved"
          : operationalIncident.stateImpact === "issue_opened"
          ? "issue_opened"
          : operationalIncident.stateImpact === "investigating"
          ? "investigating"
          : null,
      signalType: "operational_incident",
      severity: operationalIncident.severity,
      stateImpact: operationalIncident.stateImpact,
      evidenceType: "heuristic",
      channelMode,
      originType,
      confidence: operationalIncident.confidence,
      incidentFamily: operationalIncident.incidentFamily,
      reasonCodes: [...reasonCodes, ...operationalIncident.reasonCodes],
      signals: {
        ...baseSignals,
        operationalIncident: true,
        incidentFamily: operationalIncident.incidentFamily,
      },
    };
  }

  if (ackOnly && !resolutionSignal) {
    return {
      candidateKind: "ignore",
      surfacePriority: "none",
      candidateScore: 0.05,
      stateTransition: null,
      signalType: "ignore",
      severity: "none",
      stateImpact: "none",
      evidenceType: "heuristic",
      channelMode,
      originType,
      confidence: 0.9,
      incidentFamily: "none",
      reasonCodes,
      signals: baseSignals,
    };
  }

  const hasUnresolvedRisk =
    explicitBlocker ||
    hasEscalationSignal ||
    strongQuestionOrRequest ||
    hasActionRequiredSignal ||
    contrastFocusedRisk;

  if (resolutionSignal && !hasUnresolvedRisk) {
    return {
      candidateKind: "resolution_signal",
      surfacePriority: ackOnly ? "low" : "medium",
      candidateScore: clampScore(
        0.45 + (hasOwnerSignal ? 0.1 : 0) + (hasDecisionSignal ? 0.05 : 0),
      ),
      stateTransition: "resolved",
      signalType: "resolution",
      severity: ackOnly ? "low" : "medium",
      stateImpact: "resolved",
      evidenceType: "heuristic",
      channelMode,
      originType,
      confidence: clampScore(0.66 + (ackOnly ? 0.08 : 0)),
      incidentFamily: "none",
      reasonCodes,
      signals: baseSignals,
    };
  }

  if (
    routineTroubleshooting &&
    !explicitBlocker &&
    !hasEscalationSignal &&
    !hasRequest &&
    !hasQuestion &&
    !hasActionRequiredSignal &&
    !contrastFocusedRisk
  ) {
    return {
      candidateKind: "context_only",
      surfacePriority: "low",
      candidateScore: clampScore(0.22 + (hasProblemWords ? 0.06 : 0)),
      stateTransition: null,
      signalType: "context",
      severity: hasProblemWords ? "medium" : "low",
      stateImpact: "none",
      evidenceType: "heuristic",
      channelMode,
      originType,
      confidence: clampScore(0.62 + (hasProblemWords ? 0.04 : 0)),
      incidentFamily: "none",
      reasonCodes,
      signals: baseSignals,
    };
  }

  if (
    explicitBlocker ||
    hasEscalationSignal ||
    strongQuestionOrRequest ||
    hasActionRequiredSignal ||
    hasBreakageSignal
  ) {
    let stateTransition: StateTransition | null = null;
    if (explicitBlocker) {
      stateTransition =
        /\b(waiting on|waiting for|need approval|need access|until\b|vendor\b|dependency\b|external\b)\b/i.test(
          lower,
        )
          ? "waiting_external"
          : "blocked";
    } else if (hasEscalationSignal) {
      stateTransition = "escalated";
    } else if (hasDecisionSignal) {
      stateTransition = "decision_made";
    } else if (hasOwnerSignal) {
      stateTransition = "ownership_assigned";
    } else if (strongQuestionOrRequest) {
      stateTransition = "issue_opened";
    } else if (hasActionRequiredSignal || hasBreakageSignal) {
      stateTransition = input.threadTs ? "investigating" : "issue_opened";
    } else if (hasProblemWords) {
      stateTransition = input.threadTs ? "investigating" : "issue_opened";
    }

    return {
      candidateKind: "message_candidate",
      surfacePriority:
        hasEscalationSignal || (explicitBlocker && !routineTroubleshooting)
          ? "high"
          : "medium",
      candidateScore: clampScore(
        0.62 +
          (explicitBlocker ? 0.14 : 0) +
          (hasEscalationSignal ? 0.18 : 0) +
          (strongQuestionOrRequest ? 0.08 : 0) +
          (hasActionRequiredSignal ? 0.08 : 0) +
          (hasBreakageSignal ? 0.1 : 0) +
          (hasOwnerSignal ? 0.04 : 0),
      ),
      stateTransition,
      signalType:
        explicitBlocker || hasEscalationSignal || hasBreakageSignal
          ? "human_risk"
          : "request",
      severity:
        hasEscalationSignal || explicitBlocker
          ? "high"
          : hasBreakageSignal || hasActionRequiredSignal
          ? "medium"
          : "low",
      stateImpact:
        stateTransition === "blocked" || stateTransition === "waiting_external"
          ? "blocked"
          : stateTransition === "escalated"
          ? "escalated"
          : stateTransition === "investigating"
          ? "investigating"
          : "issue_opened",
      evidenceType: "heuristic",
      channelMode,
      originType,
      confidence: clampScore(
        0.68 +
          (explicitBlocker ? 0.1 : 0) +
          (hasEscalationSignal ? 0.1 : 0) +
          (hasBreakageSignal ? 0.06 : 0),
      ),
      incidentFamily: "none",
      reasonCodes,
      signals: baseSignals,
    };
  }

  if (
    hasOwnerSignal ||
    hasDecisionSignal ||
    (input.threadTs && (hasProblemWords || hasActionRequiredSignal))
  ) {
    let stateTransition: StateTransition | null = null;
    if (hasOwnerSignal) {
      stateTransition = "ownership_assigned";
    } else if (hasDecisionSignal) {
      stateTransition =
        /\b(root cause|turns out|because of|due to|caused by|caused)\b/i.test(
          lower,
        )
          ? "investigating"
          : "decision_made";
    } else if (hasProblemWords) {
      stateTransition = "investigating";
    }

    return {
      candidateKind: "thread_turning_point",
      surfacePriority: hasOwnerSignal || hasDecisionSignal ? "medium" : "low",
      candidateScore: clampScore(
        0.48 + (hasOwnerSignal ? 0.12 : 0) + (hasDecisionSignal ? 0.12 : 0),
      ),
      stateTransition,
      signalType: hasDecisionSignal ? "decision" : "context",
      severity: hasDecisionSignal || hasOwnerSignal ? "medium" : "low",
      stateImpact:
        stateTransition === "investigating"
          ? "investigating"
          : "none",
      evidenceType: "heuristic",
      channelMode,
      originType,
      confidence: clampScore(
        0.64 + (hasDecisionSignal ? 0.08 : 0) + (hasOwnerSignal ? 0.05 : 0),
      ),
      incidentFamily: "none",
      reasonCodes,
      signals: baseSignals,
    };
  }

  // Plain request detection: "please review", "can you check", "lmk" etc.
  // These don't have escalation/blocker signals but ARE actionable requests.
  if (hasRequest && !resolutionSignal) {
    return {
      candidateKind: "message_candidate",
      surfacePriority: "low",
      candidateScore: clampScore(0.45 + (hasQuestion ? 0.08 : 0)),
      stateTransition: null,
      signalType: "request",
      severity: "low",
      stateImpact: "none",
      evidenceType: "heuristic",
      channelMode,
      originType,
      confidence: clampScore(0.62 + (hasQuestion ? 0.05 : 0)),
      incidentFamily: "none",
      reasonCodes,
      signals: baseSignals,
    };
  }

  // Frustration/complaint detection without explicit escalation
  if (hasFrustrationSignal) {
    return {
      candidateKind: "message_candidate",
      surfacePriority: "medium",
      candidateScore: clampScore(0.55),
      stateTransition: null,
      signalType: "human_risk",
      severity: "medium",
      stateImpact: "investigating",
      evidenceType: "heuristic",
      channelMode,
      originType,
      confidence: clampScore(0.64),
      incidentFamily: "none",
      reasonCodes,
      signals: baseSignals,
    };
  }

  // Breakage/error report without explicit blocker signal
  if (hasBreakageReport) {
    return {
      candidateKind: "message_candidate",
      surfacePriority: "low",
      candidateScore: clampScore(0.48),
      stateTransition: input.threadTs ? "investigating" : null,
      signalType: "context",
      severity: "low",
      stateImpact: input.threadTs ? "investigating" : "none",
      evidenceType: "heuristic",
      channelMode,
      originType,
      confidence: clampScore(0.60),
      incidentFamily: "none",
      reasonCodes,
      signals: baseSignals,
    };
  }

  return {
    candidateKind: "context_only",
    surfacePriority:
      routineTroubleshooting || hasTechnicalLogContext || isShort
        ? "low"
        : "none",
    candidateScore: clampScore(
      0.18 + (hasProblemWords ? 0.07 : 0) + (routineTroubleshooting ? 0.05 : 0),
    ),
    stateTransition:
      routineTroubleshooting && input.threadTs ? "investigating" : null,
    signalType:
      hasDecisionSignal || hasOwnerSignal ? "decision" : "context",
    severity:
      routineTroubleshooting || hasTechnicalLogContext || hasProblemWords
        ? "low"
        : "none",
    stateImpact:
      routineTroubleshooting && input.threadTs ? "investigating" : "none",
    evidenceType: "heuristic",
    channelMode,
    originType,
    confidence: clampScore(0.58 + (routineTroubleshooting ? 0.04 : 0)),
    incidentFamily: "none",
    reasonCodes,
    signals: baseSignals,
  };
}
