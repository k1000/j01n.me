import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const argv = process.argv;
const exitCode = process.exitCode;
let dir: string;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("standalone CLI create --join", () => {
  it("auto-joins once and returns a safe handle while keeping the host identity private", async () => {
    dir = mkdtempSync(join(tmpdir(), "j01n-create-"));
    vi.stubEnv("J01N_KEY_DIR", dir);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ access: "https://j01n.me/r/room-1", join_secret: "private-room-secret", host_joined: true, cursor: 0, participant_token: "host-token" });
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.argv = [process.execPath, "cli.ts", "create", JSON.stringify({ host_id: "host" }), "--join"];
    await import("../src/cli");
    await vi.waitFor(() => expect(output).toHaveBeenCalled());
    expect(errors).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({ room_id: "room-1", participant_id: "host", host_joined: true });
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/private-room-secret|host-token/);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.host_public_key).toBeTruthy();
    const saved = readdirSync(dir).find((file) => file.endsWith("-host.json"))!;
    expect(statSync(join(dir, saved)).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, saved), "utf8")).joinSecret).toBe("private-room-secret");
  });

  it("does not print credentials or persist an identity when host auto-join is unavailable", async () => {
    dir = mkdtempSync(join(tmpdir(), "j01n-create-"));
    vi.stubEnv("J01N_KEY_DIR", dir);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access: "https://j01n.me/r/room-1", join_secret: "private-room-secret", host_joined: false })));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.argv = [process.execPath, "cli.ts", "create", JSON.stringify({ host_id: "host" }), "--join"];
    await import("../src/cli");
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(JSON.stringify(errors.mock.calls)).toMatch(/did not auto-join/);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("private-room-secret");
    expect(output).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
});
