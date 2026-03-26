/* eslint-disable no-console */
import { classifyMessageTriage, shouldRefreshThreadInsight } from "../services/messageTriage.js";
import { hybridEvalFixtures } from "./hybridCrucialMoments.fixtures.js";

type Dimension = "candidateKind" | "surfacePriority" | "stateTransition" | "shouldRefreshThreadInsight";

interface DimensionResult {
  correct: number;
  total: number;
  confusion: Map<string, number>;
  mismatches: string[];
}

function createDimensionResult(): DimensionResult {
  return {
    correct: 0,
    total: 0,
    confusion: new Map<string, number>(),
    mismatches: [],
  };
}

function recordDimension(
  result: DimensionResult,
  dimension: Dimension,
  fixtureId: string,
  expected: string,
  actual: string,
): void {
  result.total += 1;
  const key = `${expected} -> ${actual}`;
  result.confusion.set(key, (result.confusion.get(key) ?? 0) + 1);

  if (expected === actual) {
    result.correct += 1;
    return;
  }

  result.mismatches.push(`${fixtureId}: expected ${dimension}=${expected}, got ${actual}`);
}

function printDimension(name: Dimension, result: DimensionResult): void {
  const accuracy = result.total === 0 ? 0 : (result.correct / result.total) * 100;
  console.log(`\n${name}`);
  console.log(`  accuracy: ${result.correct}/${result.total} (${accuracy.toFixed(1)}%)`);

  const confusion = [...result.confusion.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([pair, count]) => `  ${pair}: ${count}`);

  if (confusion.length > 0) {
    console.log("  confusion:");
    confusion.forEach((line) => console.log(line));
  }

  if (result.mismatches.length > 0) {
    console.log("  mismatches:");
    result.mismatches.forEach((line) => console.log(`  - ${line}`));
  }
}

function main(): void {
  const candidateKind = createDimensionResult();
  const surfacePriority = createDimensionResult();
  const stateTransition = createDimensionResult();
  const refresh = createDimensionResult();

  console.log("Hybrid Crucial-Moment Triage Evaluation");
  console.log(`Fixtures: ${hybridEvalFixtures.length}`);

  for (const fixture of hybridEvalFixtures) {
    const triage = classifyMessageTriage({
      text: fixture.text,
      threadTs: fixture.threadTs ?? null,
    });
    const actualRefresh = shouldRefreshThreadInsight(triage, fixture.threadTs ?? null);

    recordDimension(
      candidateKind,
      "candidateKind",
      fixture.id,
      fixture.expected.candidateKind,
      triage.candidateKind,
    );
    recordDimension(
      surfacePriority,
      "surfacePriority",
      fixture.id,
      fixture.expected.surfacePriority,
      triage.surfacePriority,
    );
    recordDimension(
      stateTransition,
      "stateTransition",
      fixture.id,
      String(fixture.expected.stateTransition),
      String(triage.stateTransition),
    );
    recordDimension(
      refresh,
      "shouldRefreshThreadInsight",
      fixture.id,
      String(fixture.expected.shouldRefreshThreadInsight),
      String(actualRefresh),
    );
  }

  printDimension("candidateKind", candidateKind);
  printDimension("surfacePriority", surfacePriority);
  printDimension("stateTransition", stateTransition);
  printDimension("shouldRefreshThreadInsight", refresh);

  const totalCorrect =
    candidateKind.correct +
    surfacePriority.correct +
    stateTransition.correct +
    refresh.correct;
  const totalChecks =
    candidateKind.total +
    surfacePriority.total +
    stateTransition.total +
    refresh.total;

  console.log(`\nOverall labeled checks: ${totalCorrect}/${totalChecks} (${((totalCorrect / totalChecks) * 100).toFixed(1)}%)`);
  console.log("Use the mismatches above as calibration buckets, not as a single model-accuracy claim.");
}

main();
