import { describe, expect, it } from "vitest";
import {
  normalizeBoardKey,
  normalizeHostId,
  normalizeMaxParticipants,
  normalizeModel,
  normalizeParticipantId,
  normalizeProvider,
  normalizeRoomId,
  normalizeRoomName,
  normalizeSkills,
  normalizeState,
  normalizeStatus,
} from "../src/validation";

describe("normalizeParticipantId", () => {
  it("returns sanitized id for valid string", () => {
    expect(normalizeParticipantId("agent-a")).toBe("agent-a");
  });

  it("trims whitespace", () => {
    expect(normalizeParticipantId("  agent-a  ")).toBe("agent-a");
  });

  it("sanitizes invalid characters", () => {
    expect(normalizeParticipantId("alice@host!")).toBe("alice-host-");
  });

  it("returns 400 Response for empty/non-string input", () => {
    for (const value of ["", "   ", null, undefined, 42, {}]) {
      const result = normalizeParticipantId(value);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    }
  });
});

describe("normalizeBoardKey", () => {
  it("returns sanitized key for valid string", () => {
    expect(normalizeBoardKey("task-1")).toBe("task-1");
  });

  it("returns 400 for empty input", () => {
    const result = normalizeBoardKey("");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("returns 400 for non-string input", () => {
    expect(normalizeBoardKey(null)).toBeInstanceOf(Response);
    expect(normalizeBoardKey(undefined)).toBeInstanceOf(Response);
  });
});

describe("normalizeRoomId", () => {
  it("returns sanitized id when provided", () => {
    expect(normalizeRoomId("my-room")).toBe("my-room");
  });

  it("removes URL/path-problematic characters from provided ids", () => {
    expect(normalizeRoomId("bad/room%id.\"x")).toBe("bad-room-id--x");
  });

  it("generates a random id when value is empty or undefined", () => {
    expect(normalizeRoomId(undefined)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(normalizeRoomId("")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates a random id when sanitization yields empty", () => {
    expect(normalizeRoomId("   ")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("normalizeHostId", () => {
  it("returns sanitized id", () => {
    expect(normalizeHostId("alice")).toBe("alice");
  });

  it("defaults to 'host' when empty/undefined", () => {
    expect(normalizeHostId(undefined)).toBe("host");
    expect(normalizeHostId("")).toBe("host");
  });
});

describe("normalizeRoomName", () => {
  it("returns trimmed name", () => {
    expect(normalizeRoomName("  My Room  ")).toBe("My Room");
  });

  it("defaults to 'j01n rendezvous' when empty", () => {
    expect(normalizeRoomName(undefined)).toBe("j01n rendezvous");
    expect(normalizeRoomName("")).toBe("j01n rendezvous");
  });

  it("truncates to MAX_ROOM_NAME_LENGTH (80)", () => {
    expect(normalizeRoomName("x".repeat(200)).length).toBe(80);
  });
});

describe("normalizeMaxParticipants", () => {
  it("uses default 16 when undefined", () => {
    expect(normalizeMaxParticipants(undefined)).toBe(16);
  });

  it("clamps to minimum of 2", () => {
    expect(normalizeMaxParticipants(0)).toBe(2);
    expect(normalizeMaxParticipants(1)).toBe(2);
  });

  it("clamps to maximum of 64", () => {
    expect(normalizeMaxParticipants(1000)).toBe(64);
  });

  it("truncates fractional values", () => {
    expect(normalizeMaxParticipants(7.9)).toBe(7);
  });
});

describe("normalizeState", () => {
  it("passes through valid states", () => {
    expect(normalizeState("free")).toBe("free");
    expect(normalizeState("busy")).toBe("busy");
  });

  it("returns undefined for missing", () => {
    expect(normalizeState(undefined)).toBeUndefined();
  });

  it("returns 400 for invalid state", () => {
    const result = normalizeState("offline");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });
});

describe("normalizeStatus / normalizeModel", () => {
  it("trims and slices status to 240 chars", () => {
    expect(normalizeStatus("  ok  ")).toBe("ok");
    expect((normalizeStatus("x".repeat(500)) as string).length).toBe(240);
  });

  it("returns 400 for non-string status", () => {
    expect(normalizeStatus(42)).toBeInstanceOf(Response);
  });

  it("returns trimmed model or undefined for empty", () => {
    expect(normalizeModel("gpt-5")).toBe("gpt-5");
    expect(normalizeModel("  ")).toBeUndefined();
  });

  it("returns 400 for non-string model", () => {
    expect(normalizeModel(true)).toBeInstanceOf(Response);
  });

  it("returns trimmed provider or undefined for empty", () => {
    expect(normalizeProvider("  anthropic ")).toBe("anthropic");
    expect(normalizeProvider("   ")).toBeUndefined();
  });

  it("returns 400 for non-string provider", () => {
    expect(normalizeProvider(42)).toBeInstanceOf(Response);
  });
});

describe("normalizeSkills", () => {
  it("filters, trims, dedupes, and caps the list", () => {
    expect(normalizeSkills(["ts", " ts ", "go", ""])).toEqual(["ts", "go"]);
  });

  it("returns undefined for missing", () => {
    expect(normalizeSkills(undefined)).toBeUndefined();
  });

  it("returns 400 when not an array", () => {
    expect(normalizeSkills("ts")).toBeInstanceOf(Response);
  });

  it("ignores non-string entries", () => {
    expect(normalizeSkills(["ts", 1, null, "go"])).toEqual(["ts", "go"]);
  });

  it("caps at MAX_SKILLS_COUNT (32)", () => {
    const many = Array.from({ length: 50 }, (_, i) => `skill-${i}`);
    expect((normalizeSkills(many) as string[]).length).toBe(32);
  });
});
