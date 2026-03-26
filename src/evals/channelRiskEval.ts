import { buildChannelRiskState } from "../services/channelRisk.js";
import { logger } from "../utils/logger.js";
import {
  buildChannelHealthRow,
  channelRiskEvalFixtures,
} from "./channelRiskEval.fixtures.js";

interface Metric {
  correct: number;
  total: number;
  mismatches: string[];
}

function createMetric(): Metric {
  return { correct: 0, total: 0, mismatches: [] };
}

function recordMetric(
  metric: Metric,
  passed: boolean,
  failureMessage: string,
): void {
  metric.total += 1;
  if (passed) {
    metric.correct += 1;
    return;
  }

  metric.mismatches.push(failureMessage);
}

function printMetric(name: string, metric: Metric): void {
  const accuracy =
    metric.total === 0 ? 0 : (metric.correct / metric.total) * 100;
  logger.debug(`\n${name}`);
  logger.info(
    `  accuracy: ${metric.correct}/${metric.total} (${accuracy.toFixed(1)}%)`,
  );
  if (metric.mismatches.length > 0) {
    logger.info("  mismatches:");
    metric.mismatches.forEach((mismatch) => logger.info(`  - ${mismatch}`));
  }
}

function main(): void {
  const signalMetric = createMetric();
  const healthMetric = createMetric();
  const confidenceMetric = createMetric();

  logger.info("Channel Risk Evaluation");
  logger.info(`Fixtures: ${channelRiskEvalFixtures.length}`);

  for (const fixture of channelRiskEvalFixtures) {
    const result = buildChannelRiskState(buildChannelHealthRow(fixture.row), {
      effectiveChannelMode: fixture.effectiveChannelMode ?? "collaboration",
    });

    recordMetric(
      signalMetric,
      result.signal === fixture.expected.signal,
      `${fixture.id}: expected signal=${fixture.expected.signal}, got ${result.signal}`,
    );
    recordMetric(
      healthMetric,
      result.health === fixture.expected.health,
      `${fixture.id}: expected health=${fixture.expected.health}, got ${result.health}`,
    );

    const minConfidence = fixture.expected.minConfidence ?? 0;
    const maxConfidence = fixture.expected.maxConfidence ?? 1;
    const confidencePassed =
      result.signalConfidence >= minConfidence &&
      result.signalConfidence <= maxConfidence;
    recordMetric(
      confidenceMetric,
      confidencePassed,
      `${fixture.id}: expected confidence in [${minConfidence.toFixed(2)}, ${maxConfidence.toFixed(2)}], got ${result.signalConfidence.toFixed(2)}`,
    );
  }

  printMetric("signal", signalMetric);
  printMetric("health", healthMetric);
  printMetric("confidence-range", confidenceMetric);

  const totalCorrect =
    signalMetric.correct + healthMetric.correct + confidenceMetric.correct;
  const totalChecks =
    signalMetric.total + healthMetric.total + confidenceMetric.total;
  logger.info(
    `\nOverall labeled checks: ${totalCorrect}/${totalChecks} (${((totalCorrect / totalChecks) * 100).toFixed(1)}%)`,
  );
  logger.info(
    "Use these fixtures to catch false red flags before changing severity rules.",
  );
}
// proper way to exit the way is the. 
main();
