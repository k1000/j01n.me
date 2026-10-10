import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapRoom, getRoomJson, joinParticipant, participantAuthHeaders, roomRequest } from "./helpers";
import type { RoomMessage } from "../../src/types";

const checkout = "A".repeat(43);

afterEach(() => vi.useRealTimers());

async function patch(fix: Awaited<ReturnType<typeof bootstrapRoom>>, actor: string, target: string, body: object) {
  return roomRequest(fix, `/participants/${target}`, {
    method: "PATCH", headers: { ...participantAuthHeaders(fix, actor), "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("roles, profile and help escalation", () => {
  it("persists public name, role and opaque checkout on join/profile and rejects forged owner roles", async () => {
    const fix = await bootstrapRoom();
    const joined = await roomRequest(fix, "/participants/maya", {
      method: "PUT", headers: { authorization: `Bearer ${fix.joinSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Maya", role: "builder", checkout }),
    });
    expect(joined.status).toBe(200);
    fix.participantTokens.maya = (await joined.json() as { participant_token: string }).participant_token;
    await joinParticipant(fix, "host");
    const forged = await patch(fix, "maya", "maya", { role: "owner" });
    expect(forged.status).toBe(403);
    expect((await patch(fix, "maya", "maya", { checkout: "file://hostname/path" })).status).toBe(400);
    const assigned = await patch(fix, "host", "maya", { role: "owner" });
    expect(assigned.status).toBe(200);
    const team = await getRoomJson<{ participants: Array<{ id: string; display_name?: string; role?: string; checkout?: string }> }>(fix, "/status", "host");
    expect(team.participants.find(p => p.id === "maya")).toMatchObject({ display_name: "Maya", role: "owner", checkout });
    expect(team.participants.find(p => p.id === "host")?.role).toBe("host");
  });

  it("notifies host at first overdue, then owner after a second period; replies close help", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fix = await bootstrapRoom();
    await joinParticipant(fix, "host");
    await joinParticipant(fix, "owner");
    await joinParticipant(fix, "builder");
    expect((await patch(fix, "host", "owner", { role: "owner" })).status).toBe(200);
    const sent = await roomRequest(fix, "", {
      method: "POST", headers: { ...participantAuthHeaders(fix, "builder"), "content-type": "application/json" },
      body: JSON.stringify({ to: "owner", body: { encrypted_payload: "ciphertext" }, expects_reply: true, reply_by_minutes: 1 }),
    });
    expect(sent.status).toBe(200);
    const { id } = await sent.json() as { id: string };
    vi.advanceTimersByTime(61_000);
    await fix.session.alarm();
    let status = await getRoomJson<{ help_needed: Array<{ ask_id: string }>; open_asks: unknown[] }>(fix, "/status", "owner");
    expect(status.help_needed).toEqual([]);
    let messages = (await getRoomJson<{ messages: RoomMessage[] }>(fix, "/?view=all&include_self=true", "host")).messages;
    expect(messages.filter(m => m.intent === "help.overdue" && (m.body as { ask_id: string }).ask_id === id)).toHaveLength(1);
    await fix.session.alarm();
    messages = (await getRoomJson<{ messages: RoomMessage[] }>(fix, "/?view=all&include_self=true", "host")).messages;
    expect(messages.filter(m => m.intent === "help.overdue")).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    await fix.session.alarm();
    status = await getRoomJson(fix, "/status", "owner");
    expect(status.help_needed).toMatchObject([{ ask_id: id }]);
    messages = (await getRoomJson<{ messages: RoomMessage[] }>(fix, "/?view=all&include_self=true", "owner")).messages;
    expect(messages.filter(m => m.intent === "help.needed" && m.to === "owner")).toHaveLength(1);
    const reply = await roomRequest(fix, "", {
      method: "POST", headers: { ...participantAuthHeaders(fix, "owner"), "content-type": "application/json" },
      body: JSON.stringify({ to: "builder", reply_to: id, body: { encrypted_payload: "answer" } }),
    });
    expect(reply.status).toBe(200);
    status = await getRoomJson(fix, "/status", "owner");
    expect(status.help_needed).toEqual([]);
    expect(status.open_asks).toEqual([]);
  });

  it("goes straight to owner when host asked the overdue question", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fix = await bootstrapRoom();
    for (const id of ["host", "owner", "builder"]) await joinParticipant(fix, id);
    await patch(fix, "host", "owner", { role: "owner" });
    await roomRequest(fix, "", { method: "POST", headers: { ...participantAuthHeaders(fix, "host"), "content-type": "application/json" },
      body: JSON.stringify({ to: "builder", body: { encrypted_payload: "question" }, expects_reply: true, reply_by_minutes: 1 }) });
    vi.advanceTimersByTime(61_000);
    await fix.session.alarm();
    const messages = (await getRoomJson<{ messages: RoomMessage[] }>(fix, "/?view=all&include_self=true", "owner")).messages;
    expect(messages.filter(m => m.intent === "help.needed")).toHaveLength(1);
    expect(messages.filter(m => m.intent === "help.overdue")).toHaveLength(0);
  });
});
