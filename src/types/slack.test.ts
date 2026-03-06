import { describe, it, expect } from "vitest";
import { isHumanMessage, isProcessableHumanMessageEvent, isBotJoinEvent } from "./slack.js";

describe("isHumanMessage", () => {
  it("returns true for a valid human message", () => {
    const msg = { ts: "1234567890.123456", text: "hello world", user: "U12345" };
    expect(isHumanMessage(msg)).toBe(true);
  });

  it("returns false when ts is missing", () => {
    const msg = { text: "hello", user: "U12345" };
    expect(isHumanMessage(msg)).toBe(false);
  });

  it("returns false when text is missing", () => {
    const msg = { ts: "1234567890.123456", user: "U12345" };
    expect(isHumanMessage(msg)).toBe(false);
  });

  it("returns false when text is empty", () => {
    const msg = { ts: "1234567890.123456", text: "", user: "U12345" };
    expect(isHumanMessage(msg)).toBe(false);
  });

  it("returns false when user is missing", () => {
    const msg = { ts: "1234567890.123456", text: "hello" };
    expect(isHumanMessage(msg)).toBe(false);
  });

  it("returns false for bot messages", () => {
    const msg = { ts: "1234567890.123456", text: "hello", user: "U12345", bot_id: "B12345" };
    expect(isHumanMessage(msg)).toBe(false);
  });

  it("returns false for messages with subtypes", () => {
    const msg = { ts: "1234567890.123456", text: "hello", user: "U12345", subtype: "channel_join" };
    expect(isHumanMessage(msg)).toBe(false);
  });
});

describe("isProcessableHumanMessageEvent", () => {
  it("returns true for a valid message event", () => {
    const event = {
      type: "message",
      ts: "1234567890.123456",
      text: "hello",
      user: "U12345",
      channel: "C12345",
    };
    expect(isProcessableHumanMessageEvent(event)).toBe(true);
  });

  it("returns false when type is not message", () => {
    const event = {
      type: "reaction_added",
      ts: "1234567890.123456",
      text: "hello",
      user: "U12345",
      channel: "C12345",
    };
    expect(isProcessableHumanMessageEvent(event)).toBe(false);
  });

  it("returns false when channel is missing", () => {
    const event = {
      type: "message",
      ts: "1234567890.123456",
      text: "hello",
      user: "U12345",
    };
    expect(isProcessableHumanMessageEvent(event)).toBe(false);
  });

  it("returns false for bot messages", () => {
    const event = {
      type: "message",
      ts: "1234567890.123456",
      text: "hello",
      user: "U12345",
      channel: "C12345",
      bot_id: "B12345",
    };
    expect(isProcessableHumanMessageEvent(event)).toBe(false);
  });
});

describe("isBotJoinEvent", () => {
  it("returns true for member_joined_channel with matching bot user", () => {
    const event = {
      type: "member_joined_channel",
      user: "UBOTID",
      channel: "C12345",
    };
    expect(isBotJoinEvent(event, "UBOTID")).toBe(true);
  });

  it("returns false when user does not match bot ID", () => {
    const event = {
      type: "member_joined_channel",
      user: "UOTHER",
      channel: "C12345",
    };
    expect(isBotJoinEvent(event, "UBOTID")).toBe(false);
  });

  it("returns false when type is not member_joined_channel", () => {
    const event = {
      type: "message",
      user: "UBOTID",
      channel: "C12345",
    };
    expect(isBotJoinEvent(event, "UBOTID")).toBe(false);
  });

  it("returns false when botUserId is empty", () => {
    const event = {
      type: "member_joined_channel",
      user: "UBOTID",
      channel: "C12345",
    };
    expect(isBotJoinEvent(event, "")).toBe(false);
  });
});
