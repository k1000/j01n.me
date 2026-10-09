import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOM = "https://j01n.me/r/room-1";
const calls: Array<{ method: string; url: string; auth: string | null }> = [];

describe("pi-extension sessions", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    calls.length = 0;
    process.chdir(mkdtempSync(join(tmpdir(), "j01n-pi-")));
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), auth: new Headers(init?.headers).get("authorization") });
      if (method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-1" });
      return Response.json({ ok: true, participant: {} });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    process.chdir(originalCwd);
  });

  it("uses the room joined last when a command names no room", async () => {
    const commands = await import("../commands");
    await commands.runj01n(["join", "https://j01n.me/room/room-1#secret", "pi-agent"]);

    vi.resetModules(); // a later Pi process
    calls.length = 0;
    const later = await import("../commands");
    await later.runj01n(["status", "busy", "working"]);

    expect(calls).toEqual([expect.objectContaining({ method: "PATCH", url: `${ROOM}/participants/pi-agent`, auth: "Bearer tok-1" })]);
  });

  it("resumes from the saved key file in a new process instead of re-joining", async () => {
    const first = await import("../commands");
    await first.runj01n(["join", ROOM, "secret", "pi-agent"]);
    const saved = JSON.parse(readFileSync(".j01n-_r_room-1-pi-agent.json", "utf8"));
    expect(saved.participantToken).toBe("tok-1");
    expect(saved.privateJwk).toBeTruthy();

    vi.resetModules(); // simulate a fresh Pi process: in-memory sessions are gone
    calls.length = 0;
    const second = await import("../commands");
    await second.runj01n(["status", ROOM, "secret", "pi-agent", "busy", "smoke test"]);

    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(calls).toEqual([expect.objectContaining({ method: "PATCH", auth: "Bearer tok-1" })]);
    expect(JSON.parse(readFileSync(".j01n-_r_room-1-pi-agent.json", "utf8")).publicJwk).toEqual(saved.publicJwk);
  });
});
