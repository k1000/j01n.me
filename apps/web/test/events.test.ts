import { describe, expect, it } from "vitest";
import { RoomEvents } from "../src/room/events";
import type { RoomMessage } from "../src/types";

const decoder = new TextDecoder();

async function readEvent(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response body");
  try {
    const chunk = await reader.read();
    return decoder.decode(chunk.value);
  } finally {
    await reader.cancel();
  }
}

function message(overrides: Partial<RoomMessage>): RoomMessage {
  return {
    id: "msg-1",
    seq: 1,
    from: "agent-a",
    to: "all",
    reply_to: null,
    intent: "notify",
    priority: "normal",
    body: {},
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("RoomEvents", () => {
  it("sends a ready event when a participant subscribes", async () => {
    const events = new RoomEvents();
    const response = events.subscribe("agent-a", false, 7);

    const ready = await readEvent(response);

    expect(ready).toContain("event: ready");
    expect(ready).toContain('"last_seq":7');
  });

  it("notifies subscribers about visible messages", async () => {
    const events = new RoomEvents();
    const response = events.subscribe("agent-b", false, 0);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");

    await reader.read(); // ready
    events.notifyMessage(message({ from: "agent-a", to: "agent-b" }), 2);
    const changed = decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(changed).toContain("event: message");
    expect(changed).toContain('"last_seq":2');
    expect(changed).toContain('"from":"agent-a"');
    expect(changed).toContain('"to":"agent-b"');
  });

  it("does not expose someone else's direct messages to a normal room viewer", async () => {
    const events = new RoomEvents();
    const response = events.subscribe("viewer", true, 0);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");
    await reader.read(); // ready
    events.notifyMessage(message({ id: "private", to: "agent-b" }), 1);
    events.notifyMessage(message({ id: "public", to: "all" }), 2);
    const visible = decoder.decode((await reader.read()).value);
    await reader.cancel();
    expect(visible).toContain('"id":"public"');
    expect(visible).not.toContain('"id":"private"');
  });

  it("does not echo self messages unless includeSelf is enabled", async () => {
    const events = new RoomEvents();
    const response = events.subscribe("agent-a", false, 0);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");

    await reader.read(); // ready
    events.notifyMessage(message({ from: "agent-a" }), 2);
    const race = await Promise.race([
      reader.read().then(() => "unexpected"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10)),
    ]);
    await reader.cancel();

    expect(race).toBe("timeout");
  });

  it("includeAll subscribers receive messages addressed to others, including self", async () => {
    const events = new RoomEvents();
    const response = events.subscribe("host", true, 0, true);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");

    await reader.read(); // ready
    events.notifyMessage(message({ from: "host" }), 1);
    const selfEcho = decoder.decode((await reader.read()).value);
    events.notifyMessage(message({ from: "agent-a", to: "agent-b" }), 2);
    const otherDirect = decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(selfEcho).toContain("event: message");
    expect(otherDirect).toContain('"last_seq":2');
    expect(otherDirect).toContain('"from":"agent-a"');
  });

  it("notifies board updates with normalized key arrays", async () => {
    const events = new RoomEvents();
    const response = events.subscribe("agent-a", false, 0);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");

    await reader.read(); // ready
    events.notifyBoard("tasks", "agent-b");
    const board = decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(board).toContain("event: board");
    expect(board).toContain('"keys":["tasks"]');
    expect(board).toContain('"updated_by":"agent-b"');
  });
});
