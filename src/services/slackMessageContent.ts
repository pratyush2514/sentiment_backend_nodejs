import type {
  SlackFile,
  SlackHistoryMessage,
  SlackMessageAttachment,
  SlackMessageBlock,
  SlackMessageEvent,
} from "../types/slack.js";

type SlackRichMessage = Pick<
  SlackMessageEvent,
  "text" | "attachments" | "blocks" | "files"
> &
  Pick<SlackHistoryMessage, "text" | "attachments" | "blocks" | "files">;

function pushTextPart(
  parts: string[],
  seen: Set<string>,
  value: unknown,
): void {
  if (typeof value !== "string") {
    return;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  if (seen.has(trimmed)) {
    return;
  }

  seen.add(trimmed);
  parts.push(trimmed);
}

function collectSlackNodeText(
  node: unknown,
  parts: string[],
  seen: Set<string>,
): void {
  if (!node) {
    return;
  }

  if (typeof node === "string") {
    pushTextPart(parts, seen, node);
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item) => collectSlackNodeText(item, parts, seen));
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  const candidate = node as Record<string, unknown>;

  pushTextPart(parts, seen, candidate.title);
  pushTextPart(parts, seen, candidate.pretext);
  pushTextPart(parts, seen, candidate.text);
  pushTextPart(parts, seen, candidate.value);

  if (typeof candidate.text !== "string") {
    pushTextPart(parts, seen, candidate.fallback);
  }

  if (
    typeof candidate.url === "string" &&
    candidate.url.trim().length > 0 &&
    typeof candidate.text !== "string"
  ) {
    pushTextPart(parts, seen, `<${candidate.url}>`);
  }

  if (candidate.text && typeof candidate.text === "object") {
    collectSlackNodeText(candidate.text, parts, seen);
  }

  if ("fields" in candidate) {
    collectSlackNodeText(candidate.fields, parts, seen);
  }

  if ("elements" in candidate) {
    collectSlackNodeText(candidate.elements, parts, seen);
  }

  if ("accessory" in candidate) {
    collectSlackNodeText(candidate.accessory, parts, seen);
  }
}

export function extractSlackMessageText(message: SlackRichMessage): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  pushTextPart(parts, seen, message.text);

  if (Array.isArray(message.attachments)) {
    message.attachments.forEach((attachment: SlackMessageAttachment) => {
      collectSlackNodeText(attachment, parts, seen);
    });
  }

  if (Array.isArray(message.blocks)) {
    message.blocks.forEach((block: SlackMessageBlock) => {
      collectSlackNodeText(block, parts, seen);
    });
  }

  return parts.join("\n");
}

export function hasSlackMessageBody(
  message: Pick<SlackRichMessage, "text" | "attachments" | "blocks" | "files">,
): boolean {
  return (
    (Array.isArray(message.files) && message.files.length > 0) ||
    extractSlackMessageText(message).length > 0
  );
}

export function mapSlackFiles(
  files?: SlackFile[] | null,
):
  | Array<{
      name: string;
      title?: string;
      mimetype?: string;
      filetype?: string;
      size?: number;
      permalink?: string;
    }>
  | null {
  if (!files || files.length === 0) {
    return null;
  }

  return files.map((file) => ({
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    filetype: file.filetype,
    size: file.size,
    permalink: file.permalink,
  }));
}
