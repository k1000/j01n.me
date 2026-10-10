import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportPublicKey, generateECDHKeyPair } from "@j01n/sdk/crypto";
import type { AgentIdentity } from "@j01n/sdk";
import type { RoomClient } from "@j01n/sdk";
import type { Participant, RoomStatusResponse } from "@j01n/sdk/types";

vi.mock("../herdr", () => ({ listHerdrPeers: vi.fn(), splitHerdrPane: vi.fn(), startHerdrAgent: vi.fn(), promptHerdrAgent: vi.fn() }));
import { listHerdrPeers, splitHerdrPane, startHerdrAgent, promptHerdrAgent } from "../herdr";
import { spawnAndInviteHerdr } from "../spawn-herdr";

const link = "https://j01n.me/room/demo#secret-kept-out-of-herdr";
const roomUrl = "https://j01n.me/r/demo";
const participant = (id: string): Participant => ({ id, joined_at: "now", last_seen_at: "now", last_read_seq: 0, state: "free", status: "joined", status_updated_at: "now" });
const hostStatus: RoomStatusResponse = {
  room: { room_id: "demo", name: "Demo", purpose: "test", host_id: "host", max_participants: 3 },
  participants: [participant("host")], message_count: 0, last_seq: 0, oldest_seq: 0,
  expires_at: "2099-01-01T00:00:00.000Z", closed: false,
};

describe("spawn Herdr Pi and invite", () => {
  const cwd = process.cwd();
  let dir: string;
  let sender: AgentIdentity;
  let recipient: AgentIdentity;
  let recipientKey: string;
  let registered = false;
  let joined = false;
  let sent: unknown[];
  let client: Pick<RoomClient, "invite" | "participantId" | "status">;

  beforeEach(async () => {
    process.chdir(mkdtempSync(join(tmpdir(), "j01n-spawn-test-")));
    dir = mkdtempSync(join(tmpdir(), "j01n-private-"));
    sent = [];
    registered = joined = false;
    vi.mocked(listHerdrPeers).mockReset().mockReturnValue([]);
    vi.mocked(splitHerdrPane).mockReset().mockReturnValue("wV:p5");
    vi.mocked(startHerdrAgent).mockReset();
    vi.mocked(promptHerdrAgent).mockReset().mockImplementation((_pane, message) => {
      if (message.includes("register")) {
        registered = true;
        writeFileSync(join(dir, ".j01n-agent-reviewer.json"), JSON.stringify(recipient));
      } else joined = true;
    });
    const senderKeys = await generateECDHKeyPair();
    const recipientKeys = await generateECDHKeyPair();
    sender = { name: "host", base: "https://j01n.me", agentToken: "host-token", privateJwk: await crypto.subtle.exportKey("jwk", senderKeys.privateKey) as JsonWebKey, publicJwk: await crypto.subtle.exportKey("jwk", senderKeys.publicKey) as JsonWebKey };
    recipient = { name: "reviewer", base: "https://j01n.me", agentToken: "reviewer-token", privateJwk: await crypto.subtle.exportKey("jwk", recipientKeys.privateKey) as JsonWebKey, publicJwk: await crypto.subtle.exportKey("jwk", recipientKeys.publicKey) as JsonWebKey };
    recipientKey = await exportPublicKey(recipientKeys.publicKey);
    client = { invite: { room_url: roomUrl }, participantId: "host", status: vi.fn(async () => ({ ...hostStatus, participants: joined ? [...hostStatus.participants, participant("reviewer")] : hostStatus.participants })) } as unknown as typeof client;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return registered ? Response.json({ public_key: recipientKey }) : Response.json({}, { status: 404 });
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "queued-1" });
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); process.chdir(cwd); });

  it("checks host/capacity before creating any pane", async () => {
    const notHost = { ...client, participantId: "guest" };
    await expect(spawnAndInviteHerdr(notHost, sender, link, "reviewer", "Review docs", dir)).rejects.toThrow("host");
    client.status = vi.fn(async () => ({ ...hostStatus, room: { ...hostStatus.room, max_participants: 1 } }));
    await expect(spawnAndInviteHerdr(client, sender, link, "reviewer", "Review docs", dir)).rejects.toThrow("capacity");
    expect(splitHerdrPane).not.toHaveBeenCalled();
  });

  it("refuses a friendly name that joined after preparation", async () => {
    client.status = vi.fn(async () => ({ ...hostStatus, participants: [...hostStatus.participants, participant("maya")] }));
    await expect(spawnAndInviteHerdr(client, sender, link, "reviewer", "builder", dir, undefined, undefined, "Maya")).rejects.toThrow("friendly name is already in the room");
    expect(splitHerdrPane).not.toHaveBeenCalled();
  });

  it("refuses a duplicate Herdr agent name before creating a pane", async () => {
    vi.mocked(listHerdrPeers).mockReturnValue([{ pane_id: "wV:p4", agent: "reviewer", agent_status: "idle" }]);
    await expect(spawnAndInviteHerdr(client, sender, link, "reviewer", "Review docs", dir)).rejects.toThrow("Herdr workspace");
    expect(splitHerdrPane).not.toHaveBeenCalled();
  });

  it("refuses a claimed inbox before creating a pane", async () => {
    registered = true;
    await expect(spawnAndInviteHerdr(client, sender, link, "reviewer", "Review docs", dir)).rejects.toThrow("already registered");
    expect(splitHerdrPane).not.toHaveBeenCalled();
  });

  it("verifies target registration before sending a sealed invite and confirms join", async () => {
    const result = await spawnAndInviteHerdr(client, sender, link, "reviewer", "Review docs", dir);
    expect(result).toEqual({ ok: true, pane_id: "wV:p5", invited: true, joined: true });
    expect(splitHerdrPane).toHaveBeenCalledWith(dir, "https://j01n.me");
    expect(startHerdrAgent).toHaveBeenCalledWith("wV:p5", "reviewer");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("secret-kept-out-of-herdr");
    expect(JSON.stringify(vi.mocked(promptHerdrAgent).mock.calls)).not.toContain("secret-kept-out-of-herdr");
    expect(vi.mocked(promptHerdrAgent).mock.calls[1][1]).toContain("Review docs");
  });

  it("joins as a friendly room id while preserving a unique global agent inbox", async () => {
    client.status = vi.fn(async () => ({ ...hostStatus, participants: joined ? [...hostStatus.participants, participant("maya")] : hostStatus.participants }));
    const result = await spawnAndInviteHerdr(client, sender, link, "reviewer", "builder", dir, undefined, undefined, "Maya", "Implement T4");
    expect(result.joined).toBe(true);
    expect(vi.mocked(promptHerdrAgent).mock.calls[0][1]).toContain("register reviewer host");
    expect(vi.mocked(promptHerdrAgent).mock.calls[1][1]).toContain("listen reviewer --capabilities code,shell,files --as maya --display-name Maya --role \"builder\"");
    expect(vi.mocked(promptHerdrAgent).mock.calls[1][1]).toContain("Task: Implement T4");
  });

  it("starts the peer in a given directory (its own worktree) and rejects one that does not exist", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "j01n-worktree-"));
    expect((await spawnAndInviteHerdr(client, sender, link, "reviewer", "Review docs", dir, worktree)).joined).toBe(true);
    expect(vi.mocked(splitHerdrPane).mock.calls[0][4]).toBe(worktree);
    await expect(spawnAndInviteHerdr(client, sender, link, "reviewer2", "Review docs", dir, "/no/such/worktree")).rejects.toThrow("existing absolute directory");
  });

  it("allows the joined host to use its own registered sender address", async () => {
    sender.name = "host-inbox";
    const result = await spawnAndInviteHerdr(client, sender, link, "reviewer", "Review docs", dir);
    expect(result.joined).toBe(true);
    expect(vi.mocked(promptHerdrAgent).mock.calls[0][1]).toContain("reviewer host-inbox");
  });

  it("waits for the outcome when the new agent registers and joins only after the prompt returns (slow Pi start-up)", async () => {
    vi.mocked(promptHerdrAgent).mockImplementation((_pane, message) => {
      setTimeout(() => {
        if (message.includes("register")) { registered = true; writeFileSync(join(dir, ".j01n-agent-reviewer.json"), JSON.stringify(recipient)); }
        else joined = true;
      }, 1500);
    });
    const result = await spawnAndInviteHerdr(client, sender, link, "reviewer", "Review docs", dir);
    expect(result).toMatchObject({ ok: true, invited: true, joined: true });
    expect(vi.mocked(promptHerdrAgent).mock.calls[1][1]).toContain("--capabilities");
  }, 15_000);

  it("reports a submitted invitation when the join prompt fails without repeating it", async () => {
    vi.mocked(promptHerdrAgent).mockImplementation((_pane, message) => {
      if (message.includes("register")) writeFileSync(join(dir, ".j01n-agent-reviewer.json"), JSON.stringify(recipient));
      else throw new Error("Herdr prompt timed out");
    });
    registered = true;
    // The fresh-address lookup must still see 404 until registration completes.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { sent.push(JSON.parse(String(init.body))); return Response.json({ id: "queued-1" }); }
      if (String(url).endsWith("/reviewer")) {
        const hasFile = vi.mocked(promptHerdrAgent).mock.calls.length > 0;
        return hasFile ? Response.json({ public_key: recipientKey }) : Response.json({}, { status: 404 });
      }
      return Response.json({}, { status: 404 });
    }));
    const result = await spawnAndInviteHerdr(client, sender, link, "reviewer", "Review docs", dir);
    expect(result).toMatchObject({ ok: false, pane_id: "wV:p5", step: "join", invited: true, joined: false, may_be_running: true });
    expect(sent).toHaveLength(1);
  });

  it("keeps a started pane but sends no invite when the registered key does not match its local identity", async () => {
    const otherKeys = await generateECDHKeyPair();
    recipientKey = await exportPublicKey(otherKeys.publicKey);
    const result = await spawnAndInviteHerdr(client, sender, link, "reviewer", "Review docs", dir);
    expect(result).toMatchObject({ ok: false, pane_id: "wV:p5", invited: false, step: "registration" });
    expect(sent).toEqual([]);
  });
});
