import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import type { FathomParticipant, MeetingChannelLinkRow } from "../types/database.js";

const log = logger.child({ service: "meetingChannelResolver" });

export interface ResolvedMeetingChannel {
  channelId: string;
  digestEnabled: boolean;
  trackingEnabled: boolean;
  matchedBy: "rule" | "content" | "default";
}

interface ChannelMatchCandidate {
  channelId: string;
  channelName: string | null;
  score: number;
  reason: string;
  hasIdentitySignal: boolean;
}

/**
 * Resolve which Slack channel a Fathom meeting should be linked to.
 *
 * Strategy (in order):
 * 1. Explicit rules from meeting_channel_links (highest priority)
 * 2. Content-based auto-matching: channel name keywords, channel summary, participant overlap
 *
 * Returns the best matching channel metadata or null.
 */
export async function resolveChannelForMeeting(
  workspaceId: string,
  meeting: {
    title: string;
    participants: FathomParticipant[];
    recorderEmail?: string | null;
    summary?: string | null;
  },
): Promise<ResolvedMeetingChannel | null> {
  // Strategy 1: Explicit rules (always checked first)
  const ruleMatch = await matchByRules(workspaceId, meeting);
  if (ruleMatch) return ruleMatch;

  // Strategy 2: Content-based auto-matching
  const autoMatch = await matchByContent(workspaceId, meeting);
  if (autoMatch) return autoMatch;

  // Strategy 3: Default/fallback channel
  const conn = await db.getFathomConnection(workspaceId);
  if (conn?.default_channel_id) {
    log.info(
      { workspaceId, channelId: conn.default_channel_id, meetingTitle: meeting.title },
      "Meeting matched to default fallback channel",
    );
    return {
      channelId: conn.default_channel_id,
      digestEnabled: true,
      trackingEnabled: true,
      matchedBy: "default",
    };
  }

  log.debug(
    { workspaceId, meetingTitle: meeting.title },
    "No channel matched for meeting (rules + auto-matching + no default)",
  );
  return null;
}

// ─── Strategy 1: Explicit Rules ──────────────────────────────────────────────

async function matchByRules(
  workspaceId: string,
  meeting: {
    title: string;
    participants: FathomParticipant[];
    recorderEmail?: string | null;
  },
): Promise<ResolvedMeetingChannel | null> {
  const rules = await db.listMeetingChannelLinks(workspaceId);
  if (rules.length === 0) return null;

  const participantDomains = new Set(
    meeting.participants
      .map((p) => p.domain ?? extractDomain(p.email))
      .filter((d): d is string => d != null && d.length > 0),
  );

  for (const rule of rules) {
    if (matchesRule(rule, meeting.title, participantDomains, meeting.recorderEmail)) {
      log.info(
        { workspaceId, channelId: rule.channel_id, ruleId: rule.id, meetingTitle: meeting.title },
        "Meeting matched explicit channel rule",
      );
      return {
        channelId: rule.channel_id,
        digestEnabled: rule.digest_enabled,
        trackingEnabled: rule.tracking_enabled,
        matchedBy: "rule",
      };
    }
  }

  return null;
}

function matchesRule(
  rule: MeetingChannelLinkRow,
  meetingTitle: string,
  participantDomains: Set<string>,
  recorderEmail?: string | null,
): boolean {
  let hasMatchCriteria = false;
  let allCriteriaMatch = true;

  if (rule.domain_pattern) {
    hasMatchCriteria = true;
    const pattern = rule.domain_pattern.toLowerCase().trim();
    const matched = [...participantDomains].some((domain) => {
      if (pattern.startsWith("/") && pattern.endsWith("/")) {
        try {
          return new RegExp(pattern.slice(1, -1), "i").test(domain);
        } catch {
          return false;
        }
      }
      return domain.toLowerCase() === pattern;
    });
    if (!matched) allCriteriaMatch = false;
  }

  if (rule.title_pattern) {
    hasMatchCriteria = true;
    const pattern = rule.title_pattern.trim();
    let matched: boolean;
    if (pattern.startsWith("/") && pattern.endsWith("/")) {
      try {
        matched = new RegExp(pattern.slice(1, -1), "i").test(meetingTitle);
      } catch {
        matched = false;
      }
    } else {
      matched = meetingTitle.toLowerCase().includes(pattern.toLowerCase());
    }
    if (!matched) allCriteriaMatch = false;
  }

  if (rule.recorder_email_pattern && recorderEmail) {
    hasMatchCriteria = true;
    const matched = recorderEmail.toLowerCase().includes(rule.recorder_email_pattern.toLowerCase().trim());
    if (!matched) allCriteriaMatch = false;
  }

  return hasMatchCriteria && allCriteriaMatch;
}

// ─── Strategy 2: Content-Based Auto-Matching ─────────────────────────────────

async function matchByContent(
  workspaceId: string,
  meeting: {
    title: string;
    participants: FathomParticipant[];
    summary?: string | null;
  },
): Promise<ResolvedMeetingChannel | null> {
  // Get all ready channels for this workspace
  const allReady = await db.getReadyChannels();
  const channels = allReady.filter((c) => c.workspace_id === workspaceId);
  if (channels.length === 0) return null;

  const candidates: ChannelMatchCandidate[] = [];

  // Extract keywords from meeting data
  const meetingKeywords = extractKeywords(meeting.title);
  const summaryKeywords = meeting.summary ? extractKeywords(meeting.summary) : [];
  const allMeetingKeywords = new Set([...meetingKeywords, ...summaryKeywords]);

  const participantDomains = new Set(
    meeting.participants
      .map((p) => p.domain ?? extractDomain(p.email))
      .filter((d): d is string => d != null && d.length > 0),
  );

  const participantEmails = new Set(
    meeting.participants
      .map((p) => p.email?.toLowerCase())
      .filter((e): e is string => e != null),
  );

  for (const channel of channels) {
    let score = 0;
    const reasons: string[] = [];
    let hasIdentitySignal = false;

    // Signal 1: Channel name keyword match (weight: 3)
    if (channel.name) {
      const channelNameWords = channel.name.toLowerCase().split(/[_\-\s]+/).filter((w) => w.length > 2);
      for (const word of channelNameWords) {
        if (allMeetingKeywords.has(word)) {
          score += 3;
          reasons.push(`channel_name:"${word}"`);
        }
      }
    }

    // Signal 2: Channel summary keyword overlap (weight: 2)
    const channelState = await db.getChannelState(workspaceId, channel.channel_id);
    if (channelState?.running_summary) {
      const summaryWords = extractKeywords(channelState.running_summary);
      const overlap = summaryWords.filter((w) => allMeetingKeywords.has(w));
      if (overlap.length >= 2) {
        score += 2 * Math.min(overlap.length, 5);
        reasons.push(`summary_overlap:${overlap.length}`);
      }
    }

    // Signal 3: Channel member overlap with participants (weight: 5)
    if (participantEmails.size > 0) {
      const members = await db.getChannelMembers(workspaceId, channel.channel_id);
      const memberUserIds = new Set(members.map((m) => m.user_id));

      // Check if participant emails match any channel member profiles
      const profiles = await db.getUserProfiles(workspaceId, [...memberUserIds]);
      for (const profile of profiles) {
        if (profile.email && participantEmails.has(profile.email.toLowerCase())) {
          score += 5;
          reasons.push(`member_match:"${profile.display_name ?? profile.user_id}"`);
          hasIdentitySignal = true;
        }
      }
    }

    // Signal 4: Client role domain match (weight: 4)
    const followUpRule = await db.getFollowUpRule(workspaceId, channel.channel_id);
    if (followUpRule?.client_user_ids && followUpRule.client_user_ids.length > 0) {
      const clientProfiles = await db.getUserProfiles(workspaceId, followUpRule.client_user_ids);
      for (const cp of clientProfiles) {
        if (cp.email) {
          const clientDomain = extractDomain(cp.email);
          if (clientDomain && participantDomains.has(clientDomain)) {
            score += 4;
            reasons.push(`client_domain:"${clientDomain}"`);
            hasIdentitySignal = true;
          }
        }
      }
    }

    if (score > 0) {
      candidates.push({
        channelId: channel.channel_id,
        channelName: channel.name,
        score,
        reason: reasons.join(", "),
        hasIdentitySignal,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  const AUTO_MATCH_THRESHOLD = 5;
  if (best.score >= AUTO_MATCH_THRESHOLD && best.hasIdentitySignal) {
    log.info(
      {
        workspaceId,
        channelId: best.channelId,
        channelName: best.channelName,
        score: best.score,
        reason: best.reason,
        meetingTitle: meeting.title,
        candidateCount: candidates.length,
      },
      "Meeting auto-matched to channel via content analysis",
    );
    return {
      channelId: best.channelId,
      digestEnabled: true,
      trackingEnabled: true,
      matchedBy: "content",
    };
  }

  log.debug(
    {
      workspaceId,
      meetingTitle: meeting.title,
      bestScore: best.score,
      bestChannel: best.channelName,
      hasIdentitySignal: best.hasIdentitySignal,
      threshold: AUTO_MATCH_THRESHOLD,
    },
    "Best auto-match score below threshold, skipping",
  );
  return null;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Extract meaningful keywords from text (lowercased, deduped, stopwords removed).
 */
function extractKeywords(text: string): string[] {
  const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could", "and", "but", "or",
    "nor", "not", "no", "so", "for", "yet", "both", "either", "neither",
    "each", "every", "all", "any", "few", "more", "most", "other", "some",
    "such", "than", "too", "very", "just", "about", "above", "after",
    "before", "between", "from", "into", "through", "during", "with",
    "this", "that", "these", "those", "what", "which", "who", "whom",
    "how", "when", "where", "why", "here", "there", "then", "now",
    "call", "meeting", "sync", "update", "weekly", "daily", "team",
    "discussion", "review", "check", "status",
  ]);

  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i); // dedupe
}

/**
 * Resolve Fathom participant names/emails to Slack user IDs.
 */
export async function resolveParticipantsToSlackUsers(
  workspaceId: string,
  participants: FathomParticipant[],
): Promise<Map<string, string>> {
  const nameToSlackId = new Map<string, string>();

  const emails = participants
    .map((p) => p.email)
    .filter((e): e is string => e != null && e.length > 0);

  if (emails.length === 0) return nameToSlackId;

  const profiles = await db.getUserProfilesByEmails(workspaceId, emails);
  const emailToProfile = new Map(
    profiles
      .filter((p) => p.email)
      .map((p) => [p.email!.toLowerCase(), p]),
  );

  for (const participant of participants) {
    if (!participant.email) continue;
    const profile = emailToProfile.get(participant.email.toLowerCase());
    if (profile) {
      nameToSlackId.set(participant.name, profile.user_id);
      nameToSlackId.set(participant.name.trim().toLowerCase(), profile.user_id);
    }
  }

  log.info(
    { workspaceId, totalParticipants: participants.length, resolved: nameToSlackId.size },
    "Resolved meeting participants to Slack users",
  );

  return nameToSlackId;
}

function extractDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}
