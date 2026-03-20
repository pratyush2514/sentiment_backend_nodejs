import type {
  CanonicalSignalSeverity,
  ChannelMode,
  IncidentFamily,
  OriginType,
  SignalStateImpact,
  SurfacePriority,
} from "../types/database.js";

export interface OperationalIncidentInput {
  text: string;
  channelMode: ChannelMode;
  originType: OriginType;
}

export interface OperationalIncidentResult {
  isIncident: boolean;
  severity: CanonicalSignalSeverity;
  stateImpact: SignalStateImpact;
  surfacePriority: SurfacePriority;
  incidentFamily: IncidentFamily;
  confidence: number;
  reasonCodes: string[];
}

const WORKFLOW_ERROR_RE =
  /\b(workflow error|workflowhasissueserror|cannot be executed|can not be executed|execution failed|failed to execute|node failed|trigger failed)\b/i;
const DATA_SHAPE_RE =
  /\b(no json object found|invalid json|json parse|unexpected token|schema validation|payload shape|data shape)\b/i;
const TIMEOUT_RE =
  /\b(timeout|timed out|deadline exceeded|took too long|request timeout)\b/i;
const HTTP_ERROR_RE =
  /\b(http [45]\d{2}|status [45]\d{2}|\b404\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)\b/i;
const INFRA_ERROR_RE =
  /\b(connection refused|service unavailable|database unavailable|socket hang up|dns|unreachable|out of memory|oom|fatal error|critical error|traceback|stack trace|exception)\b/i;
const GENERIC_INCIDENT_RE =
  /\b(error|errors|failed|failure|failing|fatal|critical|crash|crashed|broken|not working|outage)\b/i;

export function classifyOperationalIncident(
  input: OperationalIncidentInput,
): OperationalIncidentResult {
  const text = input.text.toLowerCase();
  const reasonCodes: string[] = [];
  let incidentFamily: IncidentFamily = "none";

  if (WORKFLOW_ERROR_RE.test(text)) {
    incidentFamily = text.includes("workflow error")
      ? "workflow_error"
      : "execution_failure";
    reasonCodes.push("workflow_error_pattern");
  } else if (DATA_SHAPE_RE.test(text)) {
    incidentFamily = "data_shape_error";
    reasonCodes.push("data_shape_error_pattern");
  } else if (TIMEOUT_RE.test(text)) {
    incidentFamily = "timeout";
    reasonCodes.push("timeout_pattern");
  } else if (HTTP_ERROR_RE.test(text)) {
    incidentFamily = "http_error";
    reasonCodes.push("http_error_pattern");
  } else if (INFRA_ERROR_RE.test(text)) {
    incidentFamily = "infra_error";
    reasonCodes.push("infra_error_pattern");
  } else if (GENERIC_INCIDENT_RE.test(text)) {
    incidentFamily = "unknown";
    reasonCodes.push("generic_incident_pattern");
  }

  const originBoost =
    input.originType === "bot" || input.originType === "system" ? 0.1 : 0;
  const modeBoost =
    input.channelMode === "automation"
      ? 0.15
      : input.channelMode === "mixed"
      ? 0.05
      : 0;

  const isStrongIncident =
    incidentFamily !== "none" &&
    !(
      incidentFamily === "unknown" &&
      input.channelMode === "collaboration" &&
      input.originType === "human"
    );
  const allowWeakerHumanIncident =
    input.channelMode !== "collaboration" && GENERIC_INCIDENT_RE.test(text);
  const isIncident = isStrongIncident || allowWeakerHumanIncident;

  if (!isIncident) {
    return {
      isIncident: false,
      severity: "none",
      stateImpact: "none",
      surfacePriority: "none",
      incidentFamily: "none",
      confidence: 0.35,
      reasonCodes,
    };
  }

  const explicitCritical =
    /\b(critical|fatal|sev1|sev-1|p0|outage)\b/i.test(text) ||
    incidentFamily === "workflow_error" ||
    incidentFamily === "execution_failure";
  const explicitMedium =
    /\b(error|failed|failure|not working|no json object found|timeout)\b/i.test(
      text,
    );

  const severity: CanonicalSignalSeverity = explicitCritical
    ? "high"
    : explicitMedium
    ? "medium"
    : "low";

  const stateImpact: SignalStateImpact =
    severity === "high"
      ? /\b(critical|fatal|outage|escalate)\b/i.test(text)
        ? "escalated"
        : "blocked"
      : "investigating";

  const surfacePriority: SurfacePriority =
    severity === "high" ? "high" : severity === "medium" ? "medium" : "low";

  return {
    isIncident: true,
    severity,
    stateImpact,
    surfacePriority,
    incidentFamily,
    confidence: Math.min(0.92, 0.65 + originBoost + modeBoost),
    reasonCodes,
  };
}
