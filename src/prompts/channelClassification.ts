export interface ChannelClassificationContext {
  channelName: string;
  channelDescription: string | null;
  channelTopic: string | null;
  memberCount: number;
  memberDomains: string[]; // unique email domains of members
  externalDomains: string[]; // domains that don't match the workspace's primary domain
  recentMessages: string[]; // last 30-50 messages as "Speaker: text"
  existingSummary: string | null;
  botMessageRatio: number; // 0-1, ratio of bot/system messages
}

export function buildChannelClassificationPrompt(context: ChannelClassificationContext): {
  system: string;
  user: string;
} {
  const system = `You are an expert at classifying Slack channels by their purpose and audience.

## Task
Given a Slack channel's metadata, member composition, and recent messages, classify the channel into exactly one category.

## Categories
- **client_delivery**: Active project delivery channel for a specific external client. Team discusses deliverables, timelines, blockers. Client contacts may be mentioned by name. Messages reference "the client", deliverables, sprints, deadlines.
- **client_support**: Reactive support channel for external clients. Contains tickets, bug reports, feature requests, troubleshooting conversations. Often has SLA-sensitive exchanges.
- **internal_engineering**: Technical team channel for engineering work. Discussions about code, deployments, architecture, debugging, pull requests, CI/CD. No external client involvement.
- **internal_operations**: Non-technical internal work. HR, finance, marketing, sales discussions, internal processes, company updates.
- **internal_social**: Casual/social channel. General chat, random, watercooler, off-topic, team bonding. Low business signal.
- **automated**: Primarily bot/system messages. CI alerts, monitoring, deployment notifications, automated workflows. Very low human conversation ratio.

## Classification Signals (ranked by reliability)
1. **Channel description/topic** — if set, often explicitly states the purpose
2. **External domains in members** — external email domains = likely client channel
3. **Message content patterns** — client references, technical jargon, casual tone, automated formatting
4. **Channel name conventions** — "client-", "ext-", "support-" patterns
5. **Bot message ratio** — high ratio = likely automated

## Rules
- Choose the SINGLE best category. If genuinely ambiguous, prefer "client_delivery" over "internal_engineering" when external contacts are present.
- If there is insufficient data to classify confidently, return lower confidence (< 0.5) rather than guessing.
- Detect the client/company name if this is a client channel.
- Extract 3-5 topic keywords that describe what this channel discusses.
- Do NOT invent information not supported by the data.
- Return valid JSON only.

## Output Format
{
  "channel_type": "client_delivery" | "client_support" | "internal_engineering" | "internal_operations" | "internal_social" | "automated",
  "client_name": "string or null",
  "topics": ["keyword1", "keyword2", "keyword3"],
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explaining why this classification"
}`;

  const parts: string[] = [];

  parts.push(`## Channel: #${context.channelName}`);

  if (context.channelDescription) {
    parts.push(`Description: ${context.channelDescription}`);
  }
  if (context.channelTopic) {
    parts.push(`Topic: ${context.channelTopic}`);
  }

  parts.push(`Members: ${context.memberCount}`);

  if (context.memberDomains.length > 0) {
    parts.push(`Member email domains: ${context.memberDomains.join(", ")}`);
  }
  if (context.externalDomains.length > 0) {
    parts.push(`External domains (non-workspace): ${context.externalDomains.join(", ")}`);
  }

  parts.push(`Bot/system message ratio: ${Math.round(context.botMessageRatio * 100)}%`);

  if (context.existingSummary) {
    parts.push(`\n## Channel Summary (AI-generated)\n${context.existingSummary.slice(0, 500)}`);
  }

  if (context.recentMessages.length > 0) {
    parts.push(`\n## Recent Messages (${context.recentMessages.length} messages)`);
    for (const msg of context.recentMessages.slice(0, 40)) {
      parts.push(msg.slice(0, 200));
    }
  }

  const user = parts.join("\n");

  return { system, user };
}
