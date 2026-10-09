import { describe, expect, it } from "vitest";
import { parseArgs, splitArgs } from "../args";

describe("pi-extension args", () => {
  it("parses room-url command form", () => {
    expect(parseArgs(["send", "https://j01n.me/r/room", "secret", "agent-a", "all", '{"text":"hi"}'])).toEqual({
      cmd: "send",
      roomUrlOrInvite: "https://j01n.me/r/room",
      joinSecret: "secret",
      me: "agent-a",
      rest: ["all", '{"text":"hi"}'],
    });
  });

  it("parses a room link like an invite (the link carries its secret)", () => {
    expect(parseArgs(["join", "https://j01n.me/room/abc#secret", "pi-agent"], {})).toMatchObject({
      cmd: "join", roomUrlOrInvite: "https://j01n.me/room/abc#secret", me: "pi-agent",
    });
  });

  it("parses invite-file command form", () => {
    expect(parseArgs(["read", "room.json", "agent-b"])).toEqual({
      cmd: "read",
      roomUrlOrInvite: "room.json",
      me: "agent-b",
      rest: [],
    });
  });

  it("defaults create to the hosted j01n.me service", () => {
    expect(parseArgs(["create", '{"host_id":"agent-a"}'])).toEqual({
      cmd: "create",
      rest: ['{"host_id":"agent-a"}'],
    });
  });

  it("still accepts an explicit create base URL", () => {
    expect(parseArgs(["create", "http://localhost:8787", '{"host_id":"agent-a"}'])).toEqual({
      cmd: "create",
      roomUrlOrInvite: "http://localhost:8787",
      rest: ['{"host_id":"agent-a"}'],
    });
  });

  it("uses env room values for compact send commands", () => {
    expect(parseArgs(["send", "all", "{}"], {
      ROOM_URL: "https://j01n.me/r/env-room",
      JOIN_SECRET: "env-secret",
      ME: "agent-env",
    })).toEqual({
      cmd: "send",
      roomUrlOrInvite: "https://j01n.me/r/env-room",
      joinSecret: "env-secret",
      me: "agent-env",
      rest: ["all", "{}"],
    });
  });

  it("splits quoted command strings", () => {
    expect(splitArgs("send room.json agent-a all '{\"text\":\"hello world\"}'")).toEqual([
      "send",
      "room.json",
      "agent-a",
      "all",
      '{"text":"hello world"}',
    ]);
  });
});
