/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import {
  classifyMessageTriage,
  shouldRefreshThreadInsight,
  type MessageTriageResult,
} from "../services/messageTriage.js";

interface CliOptions {
  inputPath?: string;
  outputPath?: string;
  limitConversations: number;
  minMessages: number;
  maxMessagesPerConversation: number;
}

interface ConversationMessage {
  ts: string;
  user: string;
  text: string;
  triage: MessageTriageResult;
  shouldRefreshThreadInsight: boolean;
}

interface ExternalSlackCorpusCase {
  caseId: string;
  sourceType: "external_unlabeled";
  corpus: "msr_slack_disentangled";
  teamDomain: string;
  channelName: string;
  year: string;
  sourceFile: string;
  conversationId: string;
  utteranceCount: number;
  participantCount: number;
  participants: string[];
  startTs: string | null;
  endTs: string | null;
  preview: string;
  triageSummary: {
    candidateKindCounts: Record<string, number>;
    signalTypeCounts: Record<string, number>;
    surfacePriorityCounts: Record<string, number>;
    stateTransitionCounts: Record<string, number>;
    refreshEligibleCount: number;
    questionLikeCount: number;
    requestCount: number;
    decisionCount: number;
    resolutionCount: number;
    humanRiskCount: number;
    operationalIncidentCount: number;
    containsCodeFence: boolean;
    containsUrl: boolean;
  };
  messages: ConversationMessage[];
}

interface ExternalSlackCorpusExport {
  generatedAt: string;
  warning: string;
  source: "msr_slack_disentangled";
  inputPath: string;
  cases: ExternalSlackCorpusCase[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limitConversations: 200,
    minMessages: 3,
    maxMessagesPerConversation: 40,
  };

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
      case "--limit-conversations":
        options.limitConversations = clampInt(next, 1, 5000, 200);
        index += 1;
        break;
      case "--min-messages":
        options.minMessages = clampInt(next, 1, 100, 3);
        index += 1;
        break;
      case "--max-messages":
        options.maxMessagesPerConversation = clampInt(next, 1, 500, 40);
        index += 1;
        break;
      case "--help":
        printUsage();
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

function printUsage(): void {
  console.log(`Export the MSR Slack disentangled corpus into external unlabeled eval cases.

Options:
  --input <path>               Root dataset directory or extracted repo path
  --output <path>              JSON output path
  --limit-conversations <n>    Number of conversations to export (default: 200)
  --min-messages <n>           Minimum utterances per conversation (default: 3)
  --max-messages <n>           Maximum utterances stored per conversation (default: 40)
`);
}

function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function resolveInputPath(inputPath?: string): string {
  if (inputPath) {
    return path.resolve(inputPath);
  }

  const candidates = [
    path.resolve(
      "/tmp/msr-slack-repo/Software-related-Slack-Chats-with-Disentangled-Conversations-2.0.0/data",
    ),
    path.resolve(process.cwd(), "tmp/msr-slack-data"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new Error(
    "Could not find the MSR Slack dataset root. Re-run with --input pointing to the extracted data directory.",
  );
}

function buildDefaultOutputPath(): string {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return path.resolve(
    process.cwd(),
    "tmp/evals",
    `external-msr-slack-${stamp}.json`,
  );
}

function decodeXmlEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function extractSingleTag(xml: string, tagName: string): string {
  const match = xml.match(
    new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"),
  );
  return decodeXmlEntities((match?.[1] ?? "").trim());
}

function collectXmlFiles(rootPath: string): string[] {
  const files: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const stat = fs.statSync(current);

    if (stat.isDirectory()) {
      const entries = fs.readdirSync(current).map((entry) => path.join(current, entry));
      stack.push(...entries);
      continue;
    }

    if (current.endsWith(".xml")) {
      files.push(current);
    }
  }

  return files.sort();
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function buildCsvIndex(data: ExternalSlackCorpusExport): string {
  const headers = [
    "caseId",
    "teamDomain",
    "channelName",
    "year",
    "conversationId",
    "utteranceCount",
    "participantCount",
    "questionLikeCount",
    "requestCount",
    "decisionCount",
    "resolutionCount",
    "humanRiskCount",
    "operationalIncidentCount",
    "refreshEligibleCount",
    "containsCodeFence",
    "containsUrl",
    "preview",
  ];

  const escape = (value: unknown) =>
    `"${String(value ?? "").replaceAll(`"`, `""`)}"`;

  const rows = data.cases.map((entry) => [
    entry.caseId,
    entry.teamDomain,
    entry.channelName,
    entry.year,
    entry.conversationId,
    entry.utteranceCount,
    entry.participantCount,
    entry.triageSummary.questionLikeCount,
    entry.triageSummary.requestCount,
    entry.triageSummary.decisionCount,
    entry.triageSummary.resolutionCount,
    entry.triageSummary.humanRiskCount,
    entry.triageSummary.operationalIncidentCount,
    entry.triageSummary.refreshEligibleCount,
    entry.triageSummary.containsCodeFence,
    entry.triageSummary.containsUrl,
    entry.preview,
  ]);

  return [headers, ...rows]
    .map((row) => row.map((value) => escape(value)).join(","))
    .join("\n");
}

function jsonPathToCsvPath(jsonPath: string): string {
  return jsonPath.endsWith(".json")
    ? jsonPath.replace(/\.json$/u, ".csv")
    : `${jsonPath}.csv`;
}

function parseConversationMessages(xml: string): Array<{
  conversationId: string;
  ts: string;
  user: string;
  text: string;
}> {
  const matches = xml.matchAll(
    /<message\s+conversation_id="([^"]+)"[^>]*>\s*<ts>([\s\S]*?)<\/ts>\s*<user>([\s\S]*?)<\/user>\s*<text>([\s\S]*?)<\/text>\s*<\/message>/g,
  );

  const results: Array<{
    conversationId: string;
    ts: string;
    user: string;
    text: string;
  }> = [];

  for (const match of matches) {
    const [, conversationId, ts, user, text] = match;
    results.push({
      conversationId: conversationId?.trim() ?? "",
      ts: decodeXmlEntities(ts?.trim() ?? ""),
      user: decodeXmlEntities(user?.trim() ?? ""),
      text: decodeXmlEntities(text?.trim() ?? ""),
    });
  }

  return results;
}

function buildConversationCase(
  sourceFile: string,
  teamDomain: string,
  channelName: string,
  year: string,
  conversationId: string,
  messages: Array<{ ts: string; user: string; text: string }>,
  maxMessagesPerConversation: number,
): ExternalSlackCorpusCase {
  const trimmedMessages = messages.slice(0, maxMessagesPerConversation);
  const enriched = trimmedMessages.map((message) => {
    const triage = classifyMessageTriage({
      text: message.text,
      threadTs: conversationId,
      channelName,
    });
    return {
      ...message,
      triage,
      shouldRefreshThreadInsight: shouldRefreshThreadInsight(triage, conversationId),
    };
  });

  const candidateKindCounts: Record<string, number> = {};
  const signalTypeCounts: Record<string, number> = {};
  const surfacePriorityCounts: Record<string, number> = {};
  const stateTransitionCounts: Record<string, number> = {};

  let refreshEligibleCount = 0;
  let questionLikeCount = 0;
  let requestCount = 0;
  let decisionCount = 0;
  let resolutionCount = 0;
  let humanRiskCount = 0;
  let operationalIncidentCount = 0;
  let containsCodeFence = false;
  let containsUrl = false;

  for (const message of enriched) {
    candidateKindCounts[message.triage.candidateKind] =
      (candidateKindCounts[message.triage.candidateKind] ?? 0) + 1;
    signalTypeCounts[message.triage.signalType] =
      (signalTypeCounts[message.triage.signalType] ?? 0) + 1;
    surfacePriorityCounts[message.triage.surfacePriority] =
      (surfacePriorityCounts[message.triage.surfacePriority] ?? 0) + 1;
    if (message.triage.stateTransition) {
      stateTransitionCounts[message.triage.stateTransition] =
        (stateTransitionCounts[message.triage.stateTransition] ?? 0) + 1;
    }
    if (message.shouldRefreshThreadInsight) {
      refreshEligibleCount += 1;
    }
    if (message.triage.reasonCodes.includes("question")) {
      questionLikeCount += 1;
    }
    if (message.triage.signalType === "request") {
      requestCount += 1;
    }
    if (message.triage.signalType === "decision") {
      decisionCount += 1;
    }
    if (message.triage.signalType === "resolution") {
      resolutionCount += 1;
    }
    if (message.triage.signalType === "human_risk") {
      humanRiskCount += 1;
    }
    if (message.triage.signalType === "operational_incident") {
      operationalIncidentCount += 1;
    }
    if (message.text.includes("```")) {
      containsCodeFence = true;
    }
    if (/(https?:\/\/|www\.)/i.test(message.text)) {
      containsUrl = true;
    }
  }

  const participants = [...new Set(enriched.map((message) => message.user))].sort();
  const preview = enriched
    .slice(0, 3)
    .map((message) => `${message.user}: ${message.text}`)
    .join(" ")
    .replace(/\s+/gu, " ")
    .slice(0, 260);

  const relativeFile = sourceFile.split("/data/").pop() ?? path.basename(sourceFile);
  const safeChannel = channelName.replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/gu, "");

  return {
    caseId: `${teamDomain}-${safeChannel || "channel"}-${year}-conv-${conversationId}`,
    sourceType: "external_unlabeled",
    corpus: "msr_slack_disentangled",
    teamDomain,
    channelName,
    year,
    sourceFile: relativeFile,
    conversationId,
    utteranceCount: messages.length,
    participantCount: participants.length,
    participants,
    startTs: messages[0]?.ts ?? null,
    endTs: messages[messages.length - 1]?.ts ?? null,
    preview,
    triageSummary: {
      candidateKindCounts,
      signalTypeCounts,
      surfacePriorityCounts,
      stateTransitionCounts,
      refreshEligibleCount,
      questionLikeCount,
      requestCount,
      decisionCount,
      resolutionCount,
      humanRiskCount,
      operationalIncidentCount,
      containsCodeFence,
      containsUrl,
    },
    messages: enriched,
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolveInputPath(options.inputPath);
  const outputPath = path.resolve(options.outputPath ?? buildDefaultOutputPath());
  const csvPath = jsonPathToCsvPath(outputPath);
  const xmlFiles = collectXmlFiles(inputPath);

  const cases: ExternalSlackCorpusCase[] = [];

  for (const xmlFile of xmlFiles) {
    const xml = fs.readFileSync(xmlFile, "utf8");
    const teamDomain = extractSingleTag(xml, "team_domain");
    const channelName = extractSingleTag(xml, "channel_name");
    const yearMatch = xmlFile.match(/\/(\d{4})\//);
    const year = yearMatch?.[1] ?? "unknown";
    const messages = parseConversationMessages(xml);
    const grouped = new Map<
      string,
      Array<{ ts: string; user: string; text: string }>
    >();

    for (const message of messages) {
      const bucket = grouped.get(message.conversationId) ?? [];
      bucket.push({
        ts: message.ts,
        user: message.user,
        text: message.text,
      });
      grouped.set(message.conversationId, bucket);
    }

    for (const [conversationId, conversationMessages] of grouped.entries()) {
      if (conversationMessages.length < options.minMessages) {
        continue;
      }

      cases.push(
        buildConversationCase(
          xmlFile,
          teamDomain,
          channelName,
          year,
          conversationId,
          conversationMessages,
          options.maxMessagesPerConversation,
        ),
      );
    }
  }

  const selectedCases = cases
    .sort((left, right) => {
      const hashDelta = stableHash(left.caseId) - stableHash(right.caseId);
      if (hashDelta !== 0) return hashDelta;
      return right.utteranceCount - left.utteranceCount;
    })
    .slice(0, options.limitConversations);

  const output: ExternalSlackCorpusExport = {
    generatedAt: new Date().toISOString(),
    warning:
      "This is an external unlabeled robustness corpus. Use it for thread/message robustness, not as your product-truth benchmark.",
    source: "msr_slack_disentangled",
    inputPath,
    cases: selectedCases,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
  fs.writeFileSync(csvPath, buildCsvIndex(output), "utf8");

  console.log("MSR Slack external corpus export complete");
  console.log(`Input: ${inputPath}`);
  console.log(`XML files scanned: ${xmlFiles.length}`);
  console.log(`Cases exported: ${selectedCases.length}`);
  console.log(`JSON: ${outputPath}`);
  console.log(`CSV: ${csvPath}`);
}

main();
