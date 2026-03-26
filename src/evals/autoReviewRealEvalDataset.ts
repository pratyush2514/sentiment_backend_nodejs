/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";

type ChannelRiskSignal = "stable" | "elevated" | "escalating";
type ChannelRiskHealth = "healthy" | "attention" | "at-risk";
type SummaryFairness =
  | "fair"
  | "mixed"
  | "overstated"
  | "understated"
  | "unsupported";
type ReviewPriority = "low" | "medium" | "high";
type AutoReviewVerdict =
  | "likely_fair"
  | "likely_false_red"
  | "likely_undercalled"
  | "likely_ambiguous";
type AutoReviewConfidence = "high" | "medium" | "low";

interface RiskDriver {
  key?: string;
  label?: string;
  message?: string;
  severity?: string;
  category?: string;
}

interface RealEvalCase {
  caseId: string;
  channelId: string;
  channelName: string | null;
  currentSystemAssessment: {
    persisted: {
      signal: ChannelRiskSignal | null;
      health: ChannelRiskHealth | null;
      confidence: number | null;
      evidenceTier?: string | null;
      effectiveChannelMode: string | null;
      riskDrivers: RiskDriver[] | null;
      attentionSummary: {
        title?: string;
        status?: string;
        message?: string;
        driverKeys?: string[];
      } | null;
      latestSummaryCompleteness: string | null;
      hasActiveDegradations: boolean;
      activeDegradationCount: number;
    };
    recomputedFromCounts: {
      signal: ChannelRiskSignal;
      health: ChannelRiskHealth;
      signalConfidence: number;
      signalEvidenceTier?: string;
    } | null;
    differsFromPersisted?: boolean;
  };
  summaryContext: {
    runningSummary: string;
    keyDecisions: string[];
    totalRollups: number;
    latestRollupAt: string | null;
    totalMessages: number;
    totalAnalyses: number;
    activeMessageCount: number;
    activeWindowDays: number;
    sentimentSnapshot: Record<string, unknown>;
  } | null;
  rawHealthCounts: {
    analysisWindowDays: number;
    openAlertCount: number;
    highSeverityAlertCount: number;
    automationIncidentCount: number;
    criticalAutomationIncidentCount: number;
    automationIncident24hCount: number;
    criticalAutomationIncident24hCount: number;
    humanRiskSignalCount: number;
    requestSignalCount: number;
    decisionSignalCount: number;
    resolutionSignalCount: number;
    flaggedMessageCount: number;
    highRiskMessageCount: number;
    attentionThreadCount: number;
    blockedThreadCount: number;
    escalatedThreadCount: number;
    riskyThreadCount: number;
    totalMessageCount: number;
    skippedMessageCount: number;
    contextOnlyMessageCount: number;
    ignoredMessageCount: number;
    inflightMessageCount: number;
    totalAnalyzedCount: number;
    angerCount: number;
    disgustCount: number;
    fearCount: number;
    joyCount: number;
    neutralCount: number;
    sadnessCount: number;
    surpriseCount: number;
  } | null;
  truthDiagnostics: {
    ingestReadiness: string;
    intelligenceReadiness: string;
    messageCounts: {
      total: number;
      eligible: number;
      pending: number;
      processing: number;
      completed: number;
      failed: number;
      suppressed: number;
      partial: number;
    };
    summaryArtifact: {
      summary?: string;
      summary_kind?: string;
      completeness_status?: string;
    } | null;
    activeDegradationEvents: Array<{
      degradation_type?: string;
      severity?: string;
    }>;
  };
  humanReview: {
    expectedHealth: ChannelRiskHealth | null;
    expectedSignal: ChannelRiskSignal | null;
    shouldBeRed: boolean | null;
    summaryFairness: SummaryFairness | null;
    summaryAccuracyNotes: string | null;
    primaryUserFeeling: string | null;
    keyEvidence: string[];
    reviewer: string | null;
    reviewedAt: string | null;
    notes: string | null;
  };
}

interface RealEvalDataset {
  generatedAt: string;
  warning: string;
  workspace: {
    workspaceId: string;
    teamName: string | null;
  };
  windowPolicy?: {
    defaultScope?: string;
    activeWindowDays?: number;
    archiveWindowDays?: number;
    liveWindowHours?: number;
  };
  cases: RealEvalCase[];
}

interface AutoReviewSuggestion {
  verdict: AutoReviewVerdict;
  reviewPriority: ReviewPriority;
  confidence: AutoReviewConfidence;
  proposedHumanReview: {
    expectedHealth: ChannelRiskHealth;
    expectedSignal: ChannelRiskSignal;
    shouldBeRed: boolean;
    summaryFairness: SummaryFairness;
    primaryUserFeeling: string;
    keyEvidence: string[];
    notes: string;
  };
  rationale: string[];
}

interface AutoReviewedRealEvalCase extends RealEvalCase {
  autoReview: AutoReviewSuggestion;
}

interface AutoReviewedRealEvalDataset extends Omit<RealEvalDataset, "cases"> {
  cases: AutoReviewedRealEvalCase[];
}

interface CliOptions {
  inputPath?: string;
  outputPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--input":
        options.inputPath = next;
        index += 1;
        break;
      case "--output":
        options.outputPath = next;
        index += 1;
        break;
      case "--help":
        console.log(`Generate a first-pass reviewer for real eval datasets.

Options:
  --input <path>        Path to the exported real-eval JSON
  --output <path>       Output path for the auto-reviewed JSON
`);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        break;
    }
  }

  return options;
}

function resolveInputPath(rawPath?: string): string {
  if (rawPath) {
    return path.resolve(rawPath);
  }

  const fallbackDir = path.resolve(process.cwd(), "tmp/evals");
  if (!fs.existsSync(fallbackDir)) {
    throw new Error("No input path provided and tmp/evals does not exist.");
  }

  const candidates = fs
    .readdirSync(fallbackDir)
    .filter((entry) => entry.startsWith("real-channel-eval-") && entry.endsWith(".json"))
    .sort()
    .reverse();

  if (candidates.length === 0) {
    throw new Error("No exported real eval JSON files found under tmp/evals.");
  }

  return path.join(fallbackDir, candidates[0]);
}

function buildDefaultOutputPath(inputPath: string): string {
  const base = path.basename(inputPath).replace(/\.json$/u, "");
  return path.resolve(path.dirname(inputPath), `${base}.auto-reviewed.json`);
}

function jsonPathToCsvPath(jsonPath: string): string {
  return jsonPath.endsWith(".json")
    ? jsonPath.replace(/\.json$/u, ".csv")
    : `${jsonPath}.csv`;
}

function loadDataset(inputPath: string): RealEvalDataset {
  const raw = fs.readFileSync(inputPath, "utf8");
  return JSON.parse(raw) as RealEvalDataset;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce(
    (sum, pattern) => sum + (pattern.test(text) ? 1 : 0),
    0,
  );
}

function summaryTone(summary: string): {
  calmSignals: number;
  riskSignals: number;
  overstatedSignals: number;
} {
  const normalized = normalizeText(summary);
  const calmSignals = countMatches(normalized, [
    /\bstable\b/u,
    /\bno active\b/u,
    /\bno pressing issues\b/u,
    /\bno active discussions\b/u,
    /\bworking through\b/u,
    /\bunder investigation\b/u,
    /\bnext steps\b/u,
    /\bdecisions and next steps\b/u,
  ]);
  const riskSignals = countMatches(normalized, [
    /\bblocker\b/u,
    /\brisk\b/u,
    /\bescalat/u,
    /\bcritical\b/u,
    /\bsevere\b/u,
    /\bnot working\b/u,
    /\bbroken\b/u,
    /\bissue\b/u,
  ]);
  const overstatedSignals = countMatches(normalized, [
    /\bcritical failure\b/u,
    /\bsignificant operational issues\b/u,
    /\beverything is broke\b/u,
    /\bsevere concern\b/u,
    /\bhigh risk\b/u,
  ]);

  return { calmSignals, riskSignals, overstatedSignals };
}

function inferExpectedSignal(
  counts: RealEvalCase["rawHealthCounts"],
  effectiveChannelMode: string | null,
): { signal: ChannelRiskSignal; health: ChannelRiskHealth; shouldBeRed: boolean; rationale: string[] } {
  const rationale: string[] = [];
  if (!counts) {
    return {
      signal: "stable",
      health: "healthy",
      shouldBeRed: false,
      rationale: ["No health-count payload available, defaulting to a conservative stable suggestion."],
    };
  }

  const collaboration = effectiveChannelMode === "collaboration" || effectiveChannelMode === null;
  const hardRisk =
    counts.highSeverityAlertCount >= 2 ||
    counts.highRiskMessageCount >= 1 ||
    counts.blockedThreadCount >= 1 ||
    counts.escalatedThreadCount >= 1 ||
    counts.criticalAutomationIncident24hCount >= 1 ||
    counts.criticalAutomationIncidentCount >= 1;
  const mediumRisk =
    counts.highSeverityAlertCount >= 1 ||
    counts.riskyThreadCount >= 1 ||
    counts.humanRiskSignalCount >= 2 ||
    counts.flaggedMessageCount >= 2 ||
    counts.attentionThreadCount >= 1 ||
    counts.openAlertCount >= 1;
  const stabilizing =
    counts.resolutionSignalCount >= 2 ||
    counts.decisionSignalCount >= 3 ||
    (counts.resolutionSignalCount >= 1 && counts.decisionSignalCount >= 1);
  const thinEvidence =
    counts.totalMessageCount <= 3 &&
    counts.flaggedMessageCount === 0 &&
    counts.highRiskMessageCount === 0 &&
    counts.blockedThreadCount === 0 &&
    counts.escalatedThreadCount === 0 &&
    counts.riskyThreadCount === 0 &&
    counts.humanRiskSignalCount === 0 &&
    counts.automationIncidentCount === 0 &&
    counts.criticalAutomationIncidentCount === 0;

  if (hardRisk) {
    rationale.push("Hard-risk evidence is present (multiple severe alerts, blocked/escalated threads, or critical incidents).");
    return {
      signal: "escalating",
      health: "at-risk",
      shouldBeRed: true,
      rationale,
    };
  }

  if (mediumRisk) {
    rationale.push("There is meaningful risk pressure, but it is not strongly corroborated by hard-risk evidence.");
    if (thinEvidence && collaboration) {
      rationale.push("The active window is very thin for a collaboration channel, so a red suggestion would likely feel too strong.");
      return {
        signal: "elevated",
        health: "attention",
        shouldBeRed: false,
        rationale,
      };
    }

    if (stabilizing && collaboration) {
      rationale.push("Decision or resolution momentum is visible, which should keep the suggestion below red for collaboration work.");
      return {
        signal: "elevated",
        health: "attention",
        shouldBeRed: false,
        rationale,
      };
    }

    return {
      signal: "elevated",
      health: "attention",
      shouldBeRed: false,
      rationale,
    };
  }

  rationale.push("No strong corroborated risk evidence is present.");
  return {
    signal: "stable",
    health: "healthy",
    shouldBeRed: false,
    rationale,
  };
}

function inferSummaryFairness(entry: RealEvalCase): {
  fairness: SummaryFairness;
  rationale: string[];
} {
  const rationale: string[] = [];
  const summary =
    entry.summaryContext?.runningSummary ??
    entry.truthDiagnostics.summaryArtifact?.summary ??
    "";
  const tone = summaryTone(summary);
  const counts = entry.rawHealthCounts;

  if (!summary.trim()) {
    rationale.push("No summary text is available.");
    return { fairness: "unsupported", rationale };
  }

  if (!counts) {
    rationale.push("No raw health counts available to verify the summary against.");
    return { fairness: "mixed", rationale };
  }

  const hasRiskPressure =
    counts.highSeverityAlertCount > 0 ||
    counts.riskyThreadCount > 0 ||
    counts.blockedThreadCount > 0 ||
    counts.escalatedThreadCount > 0 ||
    counts.humanRiskSignalCount > 0 ||
    counts.automationIncidentCount > 0;

  const hasProgressSignals =
    counts.decisionSignalCount > 0 || counts.resolutionSignalCount > 0;

  if (tone.overstatedSignals > 0 && !hasRiskPressure) {
    rationale.push("The summary uses stronger failure language than the underlying counts support.");
    return { fairness: "overstated", rationale };
  }

  if (tone.calmSignals > 0 && hasRiskPressure && !hasProgressSignals) {
    rationale.push("The summary sounds calmer than the underlying unresolved risk counts.");
    return { fairness: "understated", rationale };
  }

  if (tone.riskSignals > 0 && !hasRiskPressure && hasProgressSignals) {
    rationale.push("The summary leans toward risk language even though the counts mostly show progress or low pressure.");
    return { fairness: "overstated", rationale };
  }

  if (hasRiskPressure && hasProgressSignals) {
    rationale.push("The summary has to balance both unresolved risk and visible progress.");
    return { fairness: "mixed", rationale };
  }

  rationale.push("The summary tone is broadly aligned with the available counts.");
  return { fairness: "fair", rationale };
}

function inferPrimaryUserFeeling(
  verdict: AutoReviewVerdict,
  summaryFairness: SummaryFairness,
): string {
  if (verdict === "likely_false_red") {
    return "This likely feels louder than the actual recent conversation.";
  }
  if (verdict === "likely_undercalled") {
    return "This may feel too calm for the unresolved pressure in the channel.";
  }
  if (summaryFairness === "mixed") {
    return "This likely feels partly right but not fully balanced.";
  }
  if (summaryFairness === "unsupported") {
    return "This likely feels ungrounded or too vague.";
  }
  return "This likely feels directionally fair to a user.";
}

function buildAutoReview(entry: RealEvalCase): AutoReviewSuggestion {
  const persisted = entry.currentSystemAssessment.persisted;
  const recomputed = entry.currentSystemAssessment.recomputedFromCounts;
  const signalInference = inferExpectedSignal(
    entry.rawHealthCounts,
    persisted.effectiveChannelMode,
  );
  const summaryInference = inferSummaryFairness(entry);
  const persistedRed =
    persisted.health === "at-risk" || persisted.signal === "escalating";
  const stale = Boolean(entry.currentSystemAssessment.differsFromPersisted);
  const reviewRationale = [
    ...signalInference.rationale,
    ...summaryInference.rationale,
  ];

  let verdict: AutoReviewVerdict = "likely_fair";
  if (persistedRed && !signalInference.shouldBeRed) {
    verdict = "likely_false_red";
    reviewRationale.push("The current persisted channel state looks stronger than this first-pass review would suggest.");
  } else if (!persistedRed && signalInference.shouldBeRed) {
    verdict = "likely_undercalled";
    reviewRationale.push("The current persisted channel state may be too mild for the observed signals.");
  } else if (summaryInference.fairness === "mixed" || stale) {
    verdict = "likely_ambiguous";
    reviewRationale.push("This case needs human review because the evidence or persisted state is mixed.");
  }

  let reviewPriority: ReviewPriority = "low";
  if (
    verdict === "likely_false_red" ||
    verdict === "likely_undercalled" ||
    summaryInference.fairness === "unsupported" ||
    stale
  ) {
    reviewPriority = "high";
  } else if (
    verdict === "likely_ambiguous" ||
    summaryInference.fairness === "mixed" ||
    (persisted.evidenceTier ?? "") === "signal"
  ) {
    reviewPriority = "medium";
  }

  let confidence: AutoReviewConfidence = "medium";
  if (
    reviewPriority === "high" &&
    (stale || verdict === "likely_false_red") &&
    recomputed !== null
  ) {
    confidence = "high";
  } else if (verdict === "likely_ambiguous") {
    confidence = "low";
  }

  const keyEvidence = [
    ...(persisted.riskDrivers ?? [])
      .map((driver) => driver.message ?? driver.label ?? "")
      .filter((line) => line.length > 0)
      .slice(0, 3),
  ];

  if (stale && recomputed) {
    keyEvidence.push(
      `Persisted state differs from recomputed state (${persisted.signal ?? "unknown"} -> ${recomputed.signal}).`,
    );
  }

  return {
    verdict,
    reviewPriority,
    confidence,
    proposedHumanReview: {
      expectedHealth: signalInference.health,
      expectedSignal: signalInference.signal,
      shouldBeRed: signalInference.shouldBeRed,
      summaryFairness: summaryInference.fairness,
      primaryUserFeeling: inferPrimaryUserFeeling(verdict, summaryInference.fairness),
      keyEvidence,
      notes: reviewRationale.join(" "),
    },
    rationale: reviewRationale,
  };
}

function buildCsvIndex(dataset: AutoReviewedRealEvalDataset): string {
  const headers = [
    "caseId",
    "channelId",
    "channelName",
    "persistedSignal",
    "persistedHealth",
    "persistedEvidenceTier",
    "proposedSignal",
    "proposedHealth",
    "proposedShouldBeRed",
    "summaryFairness",
    "verdict",
    "reviewPriority",
    "autoReviewConfidence",
    "primaryUserFeeling",
    "keyEvidence",
    "notes",
  ];

  const escape = (value: unknown) =>
    `"${String(value ?? "").replaceAll(`"`, `""`)}"`;

  const rows = dataset.cases.map((entry) => [
    entry.caseId,
    entry.channelId,
    entry.channelName ?? "",
    entry.currentSystemAssessment.persisted.signal ?? "",
    entry.currentSystemAssessment.persisted.health ?? "",
    entry.currentSystemAssessment.persisted.evidenceTier ?? "",
    entry.autoReview.proposedHumanReview.expectedSignal,
    entry.autoReview.proposedHumanReview.expectedHealth,
    entry.autoReview.proposedHumanReview.shouldBeRed,
    entry.autoReview.proposedHumanReview.summaryFairness,
    entry.autoReview.verdict,
    entry.autoReview.reviewPriority,
    entry.autoReview.confidence,
    entry.autoReview.proposedHumanReview.primaryUserFeeling,
    entry.autoReview.proposedHumanReview.keyEvidence.join(" | "),
    entry.autoReview.proposedHumanReview.notes,
  ]);

  return [headers, ...rows]
    .map((row) => row.map((value) => escape(value)).join(","))
    .join("\n");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolveInputPath(options.inputPath);
  const dataset = loadDataset(inputPath);
  const outputPath = path.resolve(
    options.outputPath ?? buildDefaultOutputPath(inputPath),
  );
  const csvPath = jsonPathToCsvPath(outputPath);

  const cases = dataset.cases.map((entry) => ({
    ...entry,
    autoReview: buildAutoReview(entry),
  }));

  const output: AutoReviewedRealEvalDataset = {
    ...dataset,
    cases,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
  fs.writeFileSync(csvPath, buildCsvIndex(output), "utf8");

  const highPriority = cases.filter(
    (entry) => entry.autoReview.reviewPriority === "high",
  );
  const verdictCounts = cases.reduce<Record<AutoReviewVerdict, number>>(
    (acc, entry) => {
      acc[entry.autoReview.verdict] += 1;
      return acc;
    },
    {
      likely_fair: 0,
      likely_false_red: 0,
      likely_undercalled: 0,
      likely_ambiguous: 0,
    },
  );

  console.log("Auto-review export complete");
  console.log(`Input: ${inputPath}`);
  console.log(`JSON: ${outputPath}`);
  console.log(`CSV: ${csvPath}`);
  console.log(`Cases: ${cases.length}`);
  console.log(`High-priority review cases: ${highPriority.length}`);
  console.log(`Verdicts: ${JSON.stringify(verdictCounts)}`);
}

main();
