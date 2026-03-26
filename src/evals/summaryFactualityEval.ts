/* eslint-disable no-console */
import {
  buildChannelSummaryFromFacts,
  buildThreadSummary,
  filterSupportedEvidenceFacts,
} from "../services/summarizer.js";
import {
  channelSummaryFactualityFixtures,
  threadSummaryFactualityFixtures,
} from "./summaryFactuality.fixtures.js";

interface Metric {
  correct: number;
  total: number;
  mismatches: string[];
}

function createMetric(): Metric {
  return { correct: 0, total: 0, mismatches: [] };
}

function record(metric: Metric, passed: boolean, failureMessage: string): void {
  metric.total += 1;
  if (passed) {
    metric.correct += 1;
    return;
  }

  metric.mismatches.push(failureMessage);
}

function printMetric(name: string, metric: Metric): void {
  const accuracy = metric.total === 0 ? 0 : (metric.correct / metric.total) * 100;
  console.log(`\n${name}`);
  console.log(`  accuracy: ${metric.correct}/${metric.total} (${accuracy.toFixed(1)}%)`);
  if (metric.mismatches.length > 0) {
    console.log("  mismatches:");
    metric.mismatches.forEach((mismatch) => console.log(`  - ${mismatch}`));
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function main(): void {
  const supportedFactMetric = createMetric();
  const summaryRenderMetric = createMetric();

  console.log("Summary Factuality Evaluation");
  console.log(
    `Channel fixtures: ${channelSummaryFactualityFixtures.length}, thread fixtures: ${threadSummaryFactualityFixtures.length}`,
  );

  for (const fixture of channelSummaryFactualityFixtures) {
    const allowedTs = new Set(fixture.allowedTs);
    const supportedTopics = filterSupportedEvidenceFacts(fixture.topics, allowedTs, 6);
    const supportedBlockers = filterSupportedEvidenceFacts(fixture.blockers, allowedTs, 6);
    const supportedResolutions = filterSupportedEvidenceFacts(fixture.resolutions, allowedTs, 6);
    const supportedDecisions = filterSupportedEvidenceFacts(fixture.decisions, allowedTs, 6);

    record(
      supportedFactMetric,
      arraysEqual(supportedTopics.map((fact) => fact.text), fixture.expected.topics),
      `${fixture.id}: supported topics mismatch`,
    );
    record(
      supportedFactMetric,
      arraysEqual(supportedBlockers.map((fact) => fact.text), fixture.expected.blockers),
      `${fixture.id}: supported blockers mismatch`,
    );
    record(
      supportedFactMetric,
      arraysEqual(supportedResolutions.map((fact) => fact.text), fixture.expected.resolutions),
      `${fixture.id}: supported resolutions mismatch`,
    );
    record(
      supportedFactMetric,
      arraysEqual(supportedDecisions.map((fact) => fact.text), fixture.expected.decisions),
      `${fixture.id}: supported decisions mismatch`,
    );

    const summary = buildChannelSummaryFromFacts({
      topics: supportedTopics,
      blockers: supportedBlockers,
      resolutions: supportedResolutions,
      decisions: supportedDecisions,
      fallbackSummary: fixture.fallbackSummary,
    });

    const includesPassed = fixture.expected.summaryIncludes.every((phrase) => summary.includes(phrase));
    const excludesPassed = (fixture.expected.summaryExcludes ?? []).every(
      (phrase) => !summary.includes(phrase),
    );
    record(
      summaryRenderMetric,
      includesPassed && excludesPassed,
      `${fixture.id}: summary render mismatch`,
    );
  }

  for (const fixture of threadSummaryFactualityFixtures) {
    const summary = buildThreadSummary(fixture.input);
    const passed = fixture.expected.summaryIncludes.every((phrase) => summary.includes(phrase));
    record(
      summaryRenderMetric,
      passed,
      `${fixture.id}: thread summary render mismatch`,
    );
  }

  printMetric("supported-fact filtering", supportedFactMetric);
  printMetric("summary rendering", summaryRenderMetric);

  const totalCorrect = supportedFactMetric.correct + summaryRenderMetric.correct;
  const totalChecks = supportedFactMetric.total + summaryRenderMetric.total;
  console.log(
    `\nOverall labeled checks: ${totalCorrect}/${totalChecks} (${((totalCorrect / totalChecks) * 100).toFixed(1)}%)`,
  );
  console.log("This eval is meant to catch unsupported summary claims before they reach the UI.");
}

main();
