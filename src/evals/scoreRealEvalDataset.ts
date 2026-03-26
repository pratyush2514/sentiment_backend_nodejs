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

interface RealEvalCase {
  caseId: string;
  channelId: string;
  channelName: string | null;
  currentSystemAssessment: {
    persisted: {
      signal: ChannelRiskSignal | null;
      health: ChannelRiskHealth | null;
      confidence: number | null;
      riskDrivers: Array<{ key?: string; label?: string; message?: string }> | null;
    };
    differsFromPersisted?: boolean;
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
  workspace: {
    workspaceId: string;
    teamName: string | null;
  };
  cases: RealEvalCase[];
}

interface CliOptions {
  inputPath?: string;
  failOnUnlabeled: boolean;
}

interface Metric {
  labeled: number;
  correct: number;
  mismatches: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    failOnUnlabeled: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--input":
        options.inputPath = next;
        index += 1;
        break;
      case "--fail-on-unlabeled":
        options.failOnUnlabeled = true;
        break;
      case "--help":
        console.log(`Score a labeled real eval dataset export.

Options:
  --input <path>           Path to the exported JSON dataset
  --fail-on-unlabeled      Exit non-zero if any cases are still unlabeled
`);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  return options;
}

function loadDataset(inputPath: string): RealEvalDataset {
  const raw = fs.readFileSync(inputPath, "utf8");
  return JSON.parse(raw) as RealEvalDataset;
}

function createMetric(): Metric {
  return { labeled: 0, correct: 0, mismatches: [] };
}

function printMetric(name: string, metric: Metric): void {
  const pct = metric.labeled === 0 ? 0 : (metric.correct / metric.labeled) * 100;
  console.log(`\n${name}`);
  console.log(`  labeled: ${metric.labeled}`);
  console.log(`  correct: ${metric.correct}`);
  console.log(`  accuracy: ${pct.toFixed(1)}%`);
  if (metric.mismatches.length > 0) {
    console.log("  mismatches:");
    metric.mismatches.forEach((line) => console.log(`  - ${line}`));
  }
}

function isSystemRed(entry: RealEvalCase): boolean {
  return (
    entry.currentSystemAssessment.persisted.health === "at-risk" ||
    entry.currentSystemAssessment.persisted.signal === "escalating"
  );
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

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolveInputPath(options.inputPath);
  const dataset = loadDataset(inputPath);

  const signalMetric = createMetric();
  const healthMetric = createMetric();
  const redMetric = createMetric();

  const summaryFairnessCounts: Record<SummaryFairness, number> = {
    fair: 0,
    mixed: 0,
    overstated: 0,
    understated: 0,
    unsupported: 0,
  };

  let unlabeledCount = 0;
  const falseRedFlags: string[] = [];
  const missedRedFlags: string[] = [];
  const stalePersistedCases: string[] = [];

  console.log("Real Eval Dataset Scorecard");
  console.log(`Workspace: ${dataset.workspace.workspaceId} (${dataset.workspace.teamName ?? "unknown"})`);
  console.log(`Dataset: ${inputPath}`);
  console.log(`Cases: ${dataset.cases.length}`);

  for (const entry of dataset.cases) {
    const review = entry.humanReview;
    const anyLabelPresent =
      review.expectedHealth !== null ||
      review.expectedSignal !== null ||
      review.shouldBeRed !== null ||
      review.summaryFairness !== null;

    if (!anyLabelPresent) {
      unlabeledCount += 1;
    }

    if (review.expectedSignal) {
      signalMetric.labeled += 1;
      if (entry.currentSystemAssessment.persisted.signal === review.expectedSignal) {
        signalMetric.correct += 1;
      } else {
        signalMetric.mismatches.push(
          `${entry.caseId}: expected signal=${review.expectedSignal}, got ${entry.currentSystemAssessment.persisted.signal ?? "null"}`,
        );
      }
    }

    if (review.expectedHealth) {
      healthMetric.labeled += 1;
      if (entry.currentSystemAssessment.persisted.health === review.expectedHealth) {
        healthMetric.correct += 1;
      } else {
        healthMetric.mismatches.push(
          `${entry.caseId}: expected health=${review.expectedHealth}, got ${entry.currentSystemAssessment.persisted.health ?? "null"}`,
        );
      }
    }

    if (review.shouldBeRed !== null) {
      redMetric.labeled += 1;
      const predictedRed = isSystemRed(entry);
      if (predictedRed === review.shouldBeRed) {
        redMetric.correct += 1;
      } else {
        redMetric.mismatches.push(
          `${entry.caseId}: expected shouldBeRed=${String(review.shouldBeRed)}, got ${String(predictedRed)}`,
        );
      }

      if (predictedRed && review.shouldBeRed === false) {
        falseRedFlags.push(entry.caseId);
      }

      if (!predictedRed && review.shouldBeRed === true) {
        missedRedFlags.push(entry.caseId);
      }
    }

    if (review.summaryFairness) {
      summaryFairnessCounts[review.summaryFairness] += 1;
    }

    if (entry.currentSystemAssessment.differsFromPersisted) {
      stalePersistedCases.push(entry.caseId);
    }
  }

  printMetric("signal", signalMetric);
  printMetric("health", healthMetric);
  printMetric("shouldBeRed", redMetric);

  console.log("\nsummaryFairness");
  (Object.keys(summaryFairnessCounts) as SummaryFairness[]).forEach((key) => {
    console.log(`  ${key}: ${summaryFairnessCounts[key]}`);
  });

  console.log("\nreviewCoverage");
  console.log(`  unlabeledCases: ${unlabeledCount}`);
  console.log(`  stalePersistedCases: ${stalePersistedCases.length}`);
  if (stalePersistedCases.length > 0) {
    console.log(`  staleCaseIds: ${stalePersistedCases.join(", ")}`);
  }

  console.log("\nredFlagQuality");
  console.log(`  falseRedFlags: ${falseRedFlags.length}`);
  if (falseRedFlags.length > 0) {
    console.log(`  falseRedCaseIds: ${falseRedFlags.join(", ")}`);
  }
  console.log(`  missedRedFlags: ${missedRedFlags.length}`);
  if (missedRedFlags.length > 0) {
    console.log(`  missedRedCaseIds: ${missedRedFlags.join(", ")}`);
  }

  if (options.failOnUnlabeled && unlabeledCount > 0) {
    process.exitCode = 1;
  }
}

main();
