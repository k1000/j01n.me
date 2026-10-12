import { describe, expect, it, vi } from "vitest";
import {
  coerceUsageSnapshot, applyUsageDelta, estimateCost, formatActiveTime, formatCost, formatTokens, formatUsage,
  ratesForModel, roomUsage, sealUsage, usageCost, usageTotals,
} from "@j01n/sdk/metrics";
import { roomPageHtml } from "../src/html";
import app from "../src/index";
import { LIVE_ROOM_STYLES } from "../src/live-room-view";
import { ROOM_CONSOLE_STYLES } from "../src/room-console";

const roomPageScript = await (await app.request("/client/room-page.js")).text();

function browserFunctions(start: string, end: string, context: Record<string, unknown>, returned: string) {
  const html = roomPageScript;
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const profileHelpers = start.includes("renderLiveRoom(")
    ? html.slice(html.indexOf("  function participantLabel("), html.indexOf("  function showBrowserNotification("))
    : "";
  return new Function(...Object.keys(context), profileHelpers + html.slice(from, to) + returned)(...Object.values(context));
}

const escape = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

describe("optional live room view", () => {
  it("follows the charcoal-and-cream monospace reference without rounded surfaces or shadows", () => {
    expect(LIVE_ROOM_STYLES).toContain('body.live-room-page {');
    expect(LIVE_ROOM_STYLES).toContain('--live-bg: var(--console-ink)');
    expect(LIVE_ROOM_STYLES).toContain('--live-accent: var(--console-cream)');
    expect(LIVE_ROOM_STYLES).toContain('font-family: var(--live-mono)');
    // Square and flat, with one deliberate exception: the 8px participant state dot.
    expect([...LIVE_ROOM_STYLES.matchAll(/border-radius:\s*([^;}]+)/g)].map(match => match[1].trim())).toEqual(['0', '50%']);
    expect([...LIVE_ROOM_STYLES.matchAll(/box-shadow:\s*([^;}]+)/g)].map(match => match[1].trim())).toEqual(['none']);
    expect(LIVE_ROOM_STYLES).not.toContain('prefers-color-scheme');
  });

  it("offers a query-selected live view without replacing the standard page or exposing all private traffic", () => {
    const html = roomPageHtml("room-1");
    expect(html).toContain('data-room-view-link');
    expect(roomPageScript).toContain('new URLSearchParams(window.location.search).get("view") === "live"');
    expect(roomPageScript).toContain('window.location.pathname + window.location.search');
    expect(html).toContain('prefers-reduced-motion: reduce');
    expect(roomPageScript).toContain('function renderLiveRoom(');
    expect(roomPageScript).not.toContain('include_all=true');
    expect(roomPageScript).not.toContain('/export');
  });

  it("renders board versions, all board keys beside kanban, participant state and a decrypted timeline safely", async () => {
    const focus = vi.fn();
    const messageElement = { dataset: { messageId: 'message-1' }, open: false, querySelector: () => ({ focus }) };
    const root = { innerHTML: "", querySelectorAll: (selector: string) => selector.includes('[open]') ? [{ dataset: messageElement.dataset }] : [messageElement] };
    const renderMessage = vi.fn(async () => '<details class="message-entry">Opened message</details>');
    const { renderLiveRoom } = browserFunctions("  async function renderLiveRoom(", "  function subscribeRoomEvents(", {
      root, esc: escape, escAttr: escape, extractValue: (value: unknown) => value,
      renderBoardValue: (value: unknown) => escape(JSON.stringify(value)),
      renderKanbanBoard: () => '<div class="kanban-board">Kanban tasks</div>', renderMessage,
      liveActivity: [], participantId: "viewer", updateConnectionStatus: vi.fn(), connectionState: "connected",
      document: { activeElement: { closest: () => messageElement } },
    }, "return { renderLiveRoom };");
    await renderLiveRoom({
      room: { name: '<img src=x onerror=alert(1)>', purpose: 'Review the release' }, phase: 'active',
      board: { columns: { value: { todo: [] }, version: 2 }, tasks: { value: {}, version: 1 },
        kickoff: { value: 'Review carefully', version: 3, updated_by: 'host' } },
      participants: { viewer: { id: 'viewer', state: 'free', status: 'Watching', model: 'Browser' },
        agent: { id: 'agent', state: 'busy', status: 'Testing' }, gone: { id: 'gone', state: 'free', left_at: '2026-01-01' } },
      messages: [{ id: 'message-1', from: 'agent', body: { text: 'hello' } }],
    });
    expect(root.innerHTML).toContain('Kanban tasks');
    expect(root.innerHTML).toContain('kickoff');
    expect(root.innerHTML).toContain('v3');
    expect(root.innerHTML).toContain('Testing');
    expect(root.innerHTML).toContain('Left');
    expect(root.innerHTML).toContain('Opened message');
    expect(root.innerHTML).toContain('&lt;img');
    expect(root.innerHTML).not.toContain('<img');
    expect(root.innerHTML).not.toContain('data-board-form');
    expect(root.innerHTML).not.toContain('data-message-form');
    expect(root.innerHTML).toContain('aria-labelledby="live-board-title"');
    expect(renderMessage).toHaveBeenCalledTimes(1);
    expect(messageElement.open).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("shows board values as text, key/value rows and lists, escaped, outside the editor", () => {
    const { renderValue, taskExtras } = browserFunctions("  function renderValue(", "  function wrapBoardValue(", { esc: escape }, "return { renderValue, taskExtras };");
    const html = renderValue({ goal: "Ship <b>it</b>", rules: ["one", "two"], tasks: { a: { status: "done", n: 3 } }, none: [], empty: {}, nothing: null });
    expect(html).toContain('<dt>goal</dt><dd><span class="json-text">Ship &lt;b>it&lt;/b></span></dd>');
    expect(html).toContain('<ul class="json-list"><li><span class="json-text">one</span></li><li><span class="json-text">two</span></li></ul>');
    expect(html).toContain('<dt>a</dt><dd><dl class="json-object"><div><dt>status</dt><dd><span class="json-text">done</span></dd></div>');
    expect(html).toContain('<span class="json-empty">none</span>');
    expect(html).toContain('<span class="json-empty">empty</span>');
    expect(html).toContain('<span class="json-text">null</span>');
    expect(html).not.toContain("<b>");
    expect(taskExtras({ title: "T", owner: "o", description: "d", state: "todo", status: "done" })).toEqual({ status: "done" });
    expect(taskExtras({ title: "T" })).toBeNull();
  });

  it("shows useful empty states", async () => {
    const root = { innerHTML: "", querySelectorAll: () => [] };
    const { renderLiveRoom } = browserFunctions("  async function renderLiveRoom(", "  function subscribeRoomEvents(", {
      root, esc: escape, escAttr: escape, extractValue: (value: unknown) => value,
      renderBoardValue: JSON.stringify, renderKanbanBoard: vi.fn(), renderMessage: vi.fn(),
      liveActivity: [], participantId: 'viewer', updateConnectionStatus: vi.fn(), connectionState: 'connecting',
      document: { activeElement: null },
    }, "return { renderLiveRoom };");
    await renderLiveRoom({ room: {}, board: {}, participants: {}, messages: [] });
    for (const text of ['No board data yet', 'No participants yet', 'No messages yet', 'Waiting for room events']) {
      expect(root.innerHTML).toContain(text);
    }
  });

  it("coalesces bursts and finishes a newer snapshot before releasing refresh callers", async () => {
    let release: (() => void) | undefined;
    const fetchRoomSnapshot = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
    const { refreshRoom } = browserFunctions('  let refreshInFlight;', '  async function fetchRoomSnapshot(', {
      fetchRoomSnapshot,
    }, 'return { refreshRoom };');
    const first = refreshRoom();
    expect(refreshRoom()).toBe(first);
    expect(refreshRoom()).toBe(first);
    expect(fetchRoomSnapshot).toHaveBeenCalledTimes(1);
    release?.();
    await first;
    expect(fetchRoomSnapshot).toHaveBeenCalledTimes(2);
    await refreshRoom();
    expect(fetchRoomSnapshot).toHaveBeenCalledTimes(3);
  });

  it("does not discard a queued newer snapshot when the in-flight one fails", async () => {
    let fail: ((error: Error) => void) | undefined;
    const fetchRoomSnapshot = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; })).mockResolvedValue(undefined);
    const { refreshRoom } = browserFunctions('  let refreshInFlight;', '  async function fetchRoomSnapshot(', {
      fetchRoomSnapshot,
    }, 'return { refreshRoom };');
    const first = refreshRoom();
    expect(refreshRoom()).toBe(first);
    fail?.(new Error('temporary failure'));
    await expect(first).resolves.toBeUndefined();
    expect(fetchRoomSnapshot).toHaveBeenCalledTimes(2);
  });

  it("surfaces an unqueued failure without auto-retry loops and permits explicit recovery", async () => {
    const fetchRoomSnapshot = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const { refreshRoom } = browserFunctions('  let refreshInFlight;', '  async function fetchRoomSnapshot(', {
      fetchRoomSnapshot,
    }, 'return { refreshRoom };');
    await expect(refreshRoom()).rejects.toThrow('offline');
    expect(fetchRoomSnapshot).toHaveBeenCalledTimes(1);
    await expect(refreshRoom()).resolves.toBeUndefined();
    expect(fetchRoomSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps a bounded, metadata-only event list", () => {
    const { recordRoomActivity, liveActivity } = browserFunctions('  const liveActivity = [];', '  async function renderLiveRoom(', {},
      'return { recordRoomActivity, liveActivity };');
    for (let i = 0; i < 30; i++) recordRoomActivity({ data: JSON.stringify({ message: { from: 'agent', body: { text: 'private payload' } } }) }, 'message');
    expect(liveActivity).toHaveLength(12);
    expect(JSON.stringify(liveActivity)).not.toContain('private payload');
    recordRoomActivity({ data: '{invalid' }, 'participant');
    expect(liveActivity[0].text).toBe('Participant · updated');
  });

  it("refreshes on the server's message event and catches up after every reconnect", async () => {
    const handlers = new Map<string, () => void>();
    class FakeEventSource {
      static CLOSED = 2;
      readyState = 0;
      addEventListener(name: string, handler: () => void) { handlers.set(name, handler); }
    }
    const refreshRoom = vi.fn(async () => {});
    const updateConnectionStatus = vi.fn();
    const recordRoomActivity = vi.fn();
    const { subscribeRoomEvents } = browserFunctions('  function subscribeRoomEvents(', '  function showRoomEventError(', {
      EventSource: FakeEventSource, roomEvents: undefined, rid: 'room-1', authToken: () => 'token', participantId: 'viewer',
      updateConnectionStatus, refreshRoom, showRoomEventError: vi.fn(), unreadCount: 0,
      updateTitle: vi.fn(), showBrowserNotification: vi.fn(), recordRoomActivity,
    }, 'return { subscribeRoomEvents };');
    subscribeRoomEvents();
    expect(handlers.has('message')).toBe(true);
    expect(handlers.has('changed')).toBe(false);
    handlers.get('open')?.();
    handlers.get('message')?.();
    handlers.get('board')?.();
    handlers.get('participant')?.();
    handlers.get('error')?.();
    handlers.get('open')?.();
    expect(refreshRoom).toHaveBeenCalledTimes(5);
    expect(updateConnectionStatus).toHaveBeenCalledWith('connecting');
    expect(updateConnectionStatus).toHaveBeenCalledWith('connected');
    expect(recordRoomActivity).toHaveBeenCalledTimes(3);
  });
});

// ── Participant usage display (t4) ───────────────────────────────────────────
// Storage is t1's contract: board key usage.<participant> holds ONE room seal (jsk1:) of a cumulative
// UsageSnapshot. The live view opens it, aggregates client-side and must format exactly like @j01n/sdk/metrics.
const USAGE_NOW = Date.parse("2026-10-11T12:00:00.000Z");

// A board-editor write wraps the value in a "ui:" envelope; the SDK writes the bare room seal.
const uiWrapped = (value: unknown) => ({ encrypted_payload: "ui:" + Buffer.from(JSON.stringify(value)).toString("base64") });

// One room's worth of reports, stamped against `now` so the stale checks stay deterministic.
function usageRoom(now: number) {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const snapshots: Record<string, unknown> = {
    "jsk1:worker-1": { participant: "worker-1", reports: 3, updated_at: ago(2), active_ms: 7_500_000, input_tokens: 12_300, output_tokens: 4_500, cost_usd: 0, model: "qwen3.8-flash", provider: "qwen" },
    "jsk1:worker-2": { participant: "worker-2", reports: 1, updated_at: ago(40), active_ms: 600_000, input_tokens: 2_000_000, output_tokens: 150_000, cost_usd: 12.5 },
    "jsk1:ghost": { participant: "someone-else", reports: 1, updated_at: ago(0), active_ms: 1_000, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    "jsk1:bad": { participant: "bad", reports: 1, updated_at: ago(1), active_ms: -5 },
    "jsk1:escaped": { participant: "escaped", reports: 2, updated_at: ago(3), active_ms: 90_000, input_tokens: 1_000, output_tokens: 10, cost_usd: 0, model: "<img src=x onerror=alert(1)>" },
  };
  return {
    board: {
      "usage.worker-1": { value: "jsk1:worker-1", version: 4, updated_by: "worker-1" },
      "usage.worker-2": { value: { encrypted_payload: "jsk1:worker-2" }, version: 2, updated_by: "worker-2" },
      "usage.ghost": { value: "jsk1:ghost", version: 9, updated_by: "ghost" },
      "usage.bad": { value: "jsk1:bad", version: 1, updated_by: "bad" },
      "usage.escaped": { value: "jsk1:escaped", version: 1, updated_by: "escaped" },
      "usage.reporter": { value: uiWrapped(snapshots["jsk1:worker-1"]), version: 3, updated_by: "reporter" },
      "usage.not an id": { value: "not a usage key", version: 1, updated_by: "someone" },
      kickoff: { value: "Review carefully", version: 3, updated_by: "host" },
      columns: { value: { todo: [], doing: [], review: [], done: [] }, version: 1, updated_by: "host" },
    },
    people: {
      "worker-1": { id: "worker-1", state: "free" },
      "worker-3": { id: "worker-3", state: "busy", status: "Testing" },
      leaver: { id: "leaver", left_at: ago(5) },
    },
    // A seal only opens with this room's secret; anything else stays unreadable.
    openSealed: async (payload: string) => {
      if (!(payload in snapshots)) throw new Error("not decryptable with this room key");
      return snapshots[payload];
    },
  };
}

const USAGE_EXPOSED = "return { usageParticipant, parseUsageSnapshot, usageRatesForModel, estimateUsageCost, usageCostOf, usageCostEstimated, usageTotals, formatUsageTime, formatUsageTokens, formatUsageCost, formatUsageLine, usageAgo, collectRoomUsage, renderUsageSection };";

function usageHelpers(openSealed: (payload: string) => Promise<unknown>) {
  return browserFunctions('  const USAGE_KEY_PREFIX = "usage.";', "  function showBrowserNotification(",
    { esc: escape, escAttr: escape, openSealedKickoff: openSealed }, USAGE_EXPOSED) as any;
}

// The page's own room-seal opener (real WebCrypto, the same HKDF the SDK uses), lifted out of the served script.
function pageSealOpener(joinSecret: string, roomId: string) {
  const html = roomPageScript;
  const start = html.indexOf("  async function openSealedKickoff(");
  const end = html.indexOf("  function isExpiredTimestamp(", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return new Function("joinSecret", "rid", "crypto", html.slice(start, end) + "return openSealedKickoff;")(
    joinSecret, roomId, crypto) as (payload: string) => Promise<unknown>;
}

describe("live room usage display", () => {
  it("styles the usage panel with the live palette and no new surfaces", () => {
    expect(LIVE_ROOM_STYLES).toContain(".live-usage-list { display: grid;");
    expect(LIVE_ROOM_STYLES).toContain(".live-usage-total { display: flex;");
    expect(LIVE_ROOM_STYLES).toMatch(/\.live-usage-stale \{ color: var\(--live-amber\)/);
    expect(LIVE_ROOM_STYLES).toMatch(/\.live-usage-row strong \{ color: var\(--live-accent\)/);
    // The stats bar grows to eight cells once usage reports land, so it flows instead of clipping.
    expect(LIVE_ROOM_STYLES).toContain(".live-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))");
    // Live tokens are local; the console tokens come from the shared homepage palette.
    expect(LIVE_ROOM_STYLES).toContain('--live-bg: var(--console-ink)');
    for (const token of new Set([...LIVE_ROOM_STYLES.matchAll(/var\((--live-[a-z-]+)\)/g)].map(match => match[1]))) {
      expect(LIVE_ROOM_STYLES).toContain(`${token}:`);
    }
    // Square and flat, with one deliberate exception: the 8px participant state dot.
    expect([...LIVE_ROOM_STYLES.matchAll(/border-radius:\s*([^;}]+)/g)].map(match => match[1].trim())).toEqual(['0', '50%']);
    expect([...LIVE_ROOM_STYLES.matchAll(/box-shadow:\s*([^;}]+)/g)].map(match => match[1].trim())).toEqual(['none']);
  });

  it("recognises only well-formed usage keys", () => {
    const helpers = usageHelpers(async () => null);
    expect(helpers.usageParticipant("usage.worker-1")).toBe("worker-1");
    expect(helpers.usageParticipant("usage.a_b-C9")).toBe("a_b-C9");
    expect(helpers.usageParticipant("usage.")).toBeNull();
    expect(helpers.usageParticipant("usage.not an id")).toBeNull();
    expect(helpers.usageParticipant("usage.<script>")).toBeNull();
    expect(helpers.usageParticipant("tasks")).toBeNull();
  });

  it("keeps the board key as the identity, marks gaps and stale reports and skips unreadable keys", async () => {
    const room = usageRoom(USAGE_NOW);
    const helpers = usageHelpers(room.openSealed);
    const usage = await helpers.collectRoomUsage({ board: room.board, participants: room.people }, USAGE_NOW);
    // "bad" has a usage key that will not decode, so it contributes no row at all.
    expect(usage.rows.map((row: { participant: string }) => row.participant)).toEqual(["escaped", "ghost", "reporter", "worker-1", "worker-2", "worker-3"]);
    const rowOf = (id: string) => usage.rows.find((row: { participant: string }) => row.participant === id)!;
    // The one key that claims somebody else still counts, and never under another name.
    expect(rowOf("ghost").snapshot!.participant).toBe("ghost");
    // A "ui:"-wrapped snapshot from the board editor opens as well as the bare seal the SDK writes.
    expect(rowOf("reporter").snapshot).toMatchObject({ reports: 3, input_tokens: 12_300 });
    expect(rowOf("worker-1").snapshot).toMatchObject({ reports: 3, model: "qwen3.8-flash", provider: "qwen" });
    expect(rowOf("worker-1").stale).toBe(false);
    expect(rowOf("worker-1").version).toBe(4);
    expect(rowOf("worker-2").stale).toBe(true);
    expect(rowOf("worker-3")).toMatchObject({ snapshot: null, stale: true, version: 0 });
    expect(usage.reported).toBe(5);
    expect(usage.stale).toBe(2);
    expect(usage.totals).toEqual({
      participants: 5, active_ms: 15_691_000, input_tokens: 2_025_600, output_tokens: 159_010,
      tokens: 2_184_610, cost_usd: 12.5,
    });
    // Reported cost is an invoice; rows without one are estimated so the room total is not silently $12.50.
    expect(usage.display.estimated).toBe(true);
    expect(usage.display.cost_usd).toBeCloseTo(12.5 + 0.00909 + 0.00104 + 0.00909, 8);
  });

  it("formats and aggregates exactly like @j01n/sdk/metrics", () => {
    const ago = (minutes: number) => new Date(USAGE_NOW - minutes * 60_000).toISOString();
    const helpers = usageHelpers(async () => null);
    for (const ms of [0, -1, 999, 45_000, 60_000, 61_000, 754_000, 7_500_000, 86_399_000, 86_400_000, 273_600_000, NaN, Infinity]) {
      expect(helpers.formatUsageTime(ms)).toBe(formatActiveTime(ms));
    }
    for (const tokens of [0, -5, 1, 873, 999.4, 1000, 12_345, 999_999, 1_000_000, 12_345_678, 999_999_999, 1_000_000_000, 2_500_000_000, NaN]) {
      expect(helpers.formatUsageTokens(tokens)).toBe(formatTokens(tokens));
    }
    for (const usd of [0, -3, 0.00004, 0.00104, 0.00909, 0.5, 0.99996, 1, 12.51013, 999.994, 1000, 1234.56, NaN]) {
      expect(helpers.formatUsageCost(usd)).toBe(formatCost(usd));
    }
    for (const model of [undefined, "", "QWEN3.8-FLASH", "qwen3-max", "claude-sonnet-4", "claude-opus-4.1", "gpt-5-mini",
      "gpt-4.1", "gpt-4o", "gemini-2.5-flash", "gemini-pro-2.5", "deepseek-v3", "llama-3.3", "o3", "unknown", "gpt-4.1-mini"]) {
      expect(helpers.usageRatesForModel(model)).toEqual(ratesForModel(model));
    }
    const costFixtures = [
      { participant: "a", reports: 1, updated_at: ago(1), active_ms: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      { participant: "b", reports: 1, updated_at: ago(1), active_ms: 1_000, input_tokens: 1_000_000, output_tokens: 0, cost_usd: 0, model: "claude-sonnet-4" },
      { participant: "c", reports: 1, updated_at: ago(1), active_ms: 2_000, input_tokens: 12_300, output_tokens: 4_500, cost_usd: 0, model: "qwen3.8-flash" },
      { participant: "d", reports: 1, updated_at: ago(1), active_ms: 3_000, input_tokens: 5_000_000, output_tokens: 250_000, cost_usd: 42.5, model: "gpt-5" },
    ];
    for (const snapshot of costFixtures) {
      expect(helpers.estimateUsageCost(snapshot)).toBe(estimateCost(snapshot, ratesForModel(snapshot.model)));
      expect(helpers.usageCostOf(snapshot)).toBe(snapshot.cost_usd > 0 ? snapshot.cost_usd : estimateCost(snapshot, ratesForModel(snapshot.model)));
      expect(helpers.usageCostEstimated(snapshot)).toBe(!(snapshot.cost_usd > 0));
    }
    expect(helpers.usageTotals(costFixtures)).toEqual(usageTotals(costFixtures));
    for (const snapshot of costFixtures) expect(helpers.formatUsageLine(snapshot)).toBe(formatUsage(snapshot));
    expect(helpers.formatUsageLine({ active_ms: 7_500_000, input_tokens: 12_300, output_tokens: 4_500, cost_usd: 0.42 }))
      .toBe("2h 05m active · 12.3k in / 4.5k out · $0.42");
  });

  it("accepts and rejects the same snapshots as the SDK", () => {
    const ago = (minutes: number) => new Date(USAGE_NOW - minutes * 60_000).toISOString();
    const helpers = usageHelpers(async () => null);
    const fixtures: unknown[] = [
      { participant: "a", reports: 0, updated_at: ago(1), active_ms: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      { participant: "a", reports: 2, updated_at: ago(1), active_ms: 5, input_tokens: 6, output_tokens: 7, cost_usd: 8, model: "m", provider: "p" },
      { reports: 1, updated_at: ago(1) },
      { participant: "a", reports: 1, updated_at: ago(1), active_ms: 1e9 },
      { participant: "a", reports: 1, updated_at: ago(1), unknown_field: 1 },
      { participant: "a", reports: 1, updated_at: ago(1), at: ago(1) },
      { participant: "a", reports: 1.5, updated_at: ago(1) },
      { participant: "a", reports: 1, updated_at: ago(1), active_ms: -1 },
      { participant: "a", reports: 1, updated_at: ago(1), cost_usd: "1" },
      { participant: "a", reports: 1, updated_at: ago(1), model: "   " },
      { participant: "  ", reports: 1, updated_at: ago(1) },
      { participant: "a", reports: 1, updated_at: "not a date" },
      {}, null, "jsk1:x", [], 42, "", true,
    ];
    for (const fixture of fixtures) {
      expect(helpers.parseUsageSnapshot(fixture, "a")).toEqual(coerceUsageSnapshot(fixture, "a"));
    }
    // Without a participant in the payload the board key supplies the name, and an unusable id stays null.
    expect(helpers.parseUsageSnapshot({ reports: 1, updated_at: ago(1) }, "worker-9"))
      .toEqual({ participant: "worker-9", reports: 1, updated_at: ago(1), active_ms: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    expect(helpers.parseUsageSnapshot({ reports: 1, updated_at: ago(1) }, "not an id")).toBeNull();
    expect(helpers.parseUsageSnapshot({ reports: 1 }, "a")!.reports).toBe(1);
    expect(coerceUsageSnapshot({ reports: 1 }, "a")!.reports).toBe(1);
  });

  it("renders one card per participant with a stale badge, a room total and never the ciphertext", async () => {
    const room = usageRoom(USAGE_NOW);
    const helpers = usageHelpers(room.openSealed);
    const usage = await helpers.collectRoomUsage({ board: room.board, participants: room.people }, USAGE_NOW);
    const html = helpers.renderUsageSection(usage);
    expect(html).toContain('<section class="live-panel live-usage" aria-labelledby="live-usage-title"');
    expect(html).toContain("Participant usage");
    expect(html).toContain("self-reported · sealed with the room key");
    expect(html).toContain("<strong>worker-1</strong><small>qwen/qwen3.8-flash</small>");
    expect(html).toContain("2h 05m active · 12.3k in / 4.5k out · $0.0091");
    expect(html).toContain("<small>cost estimated</small>");
    expect(html).toContain("3 reports · updated 2m 00s ago");
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('<span class="live-usage-stale">stale</span>');
    expect(html).toContain("no usage reported");
    expect(html).toContain("waiting for the first report");
    // The unreadable key is skipped silently: no row for it, and no hint that it holds anything.
    expect(html).not.toContain("<strong>bad</strong>");
    expect(html).toContain("<strong>Room total</strong>");
    expect(html).toContain("5 of 6 reported · 2 stale");
    expect(html).not.toContain("jsk1:");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)>");
  });

  it("says so when nothing has been reported yet", async () => {
    const helpers = usageHelpers(async () => null);
    const usage = await helpers.collectRoomUsage({ board: {}, participants: {} }, USAGE_NOW);
    expect(usage.rows).toEqual([]);
    expect(usage.totals).toMatchObject({ participants: 0, tokens: 0, cost_usd: 0 });
    expect(helpers.renderUsageSection(usage)).toContain("No usage reported yet");
    expect(helpers.renderUsageSection(usage)).toContain("live-empty");
  });

  it("shows usage in the live view without leaking seals into the board cards", async () => {
    const root = { innerHTML: "", querySelectorAll: () => [] };
    const room = usageRoom(Date.now());
    const render = browserFunctions("  async function renderLiveRoom(", "  function subscribeRoomEvents(", {
      root, esc: escape, escAttr: escape, extractValue: (value: unknown) => value,
      renderBoardValue: (value: unknown) => escape(JSON.stringify(value)),
      renderKanbanBoard: () => '<div class="kanban-board">Kanban tasks</div>', renderMessage: async () => "",
      liveActivity: [], participantId: "worker-1", updateConnectionStatus: vi.fn(), connectionState: "connected",
      document: { activeElement: null }, openSealedKickoff: room.openSealed,
    }, "return { renderLiveRoom };");
    await render.renderLiveRoom({
      room: { name: "Usage room" }, phase: "active", board: room.board, participants: room.people, messages: [],
    });
    expect(root.innerHTML).toContain("Participant usage");
    expect(root.innerHTML).toContain("2h 05m active · 12.3k in / 4.5k out · $0.0091");
    expect(root.innerHTML).toContain("<dt>Usage reported</dt><dd>5 of 6</dd>");
    expect(root.innerHTML).toContain("<dt>Room active time</dt><dd>4h 21m</dd>");
    expect(root.innerHTML).toContain("<dt>Room tokens</dt><dd>2.18M</dd>");
    expect(root.innerHTML).toContain("<dt>Room cost</dt><dd>$12.52 est.</dd>");
    // Usage keys get their own panel instead of a ciphertext dump among the board cards.
    expect(root.innerHTML).not.toContain("<h3>usage.worker-1</h3>");
    expect(root.innerHTML).not.toContain("jsk1:");
    expect(root.innerHTML).toContain("<h3>kickoff</h3>");
    expect(root.innerHTML).toContain("<h3>usage.not an id</h3>");
    expect(root.innerHTML).toContain("3 keys");
  });

  it("opens the SDK's own room seal, so the browser shows exactly what the client wrote", async () => {
    const joinSecret = "usage-room-secret-0123456789";
    const roomId = "usage-room";
    const snapshot = applyUsageDelta("worker-9", null, { active_ms: 750_000, input_tokens: 12_300, output_tokens: 4_500, model: "qwen3.8-flash", provider: "qwen" });
    const sealed = await sealUsage(snapshot, joinSecret, roomId);
    expect(sealed.slice(0, 5)).toBe("jsk1:");
    const board = { "usage.worker-9": { value: sealed, version: 1, updated_by: "worker-9", updated_at: new Date(USAGE_NOW).toISOString() } };

    const helpers = usageHelpers(pageSealOpener(joinSecret, roomId));
    const usage = await helpers.collectRoomUsage({ board, participants: { "worker-9": { id: "worker-9" } } }, USAGE_NOW);
    expect(usage.rows[0].snapshot).toMatchObject({ participant: "worker-9", reports: 1, active_ms: 750_000, input_tokens: 12_300, output_tokens: 4_500 });
    // Nothing was reported as a cost, so the room total is the SDK's own estimate for this model.
    expect(usage.display.estimated).toBe(true);
    expect(usage.display.cost_usd).toBe(usageCost(snapshot));
    const read = await roomUsage(board, { joinSecret, roomId, participants: ["worker-9"] });
    expect(usage.totals).toEqual(read.totals);
    expect(usage.rows.map((row: { participant: string }) => row.participant)).toEqual(read.rows.map(row => row.participant));
    expect(usage.reported).toBe(read.reported);

    // A viewer without this room's secret skips the row entirely and never invents numbers.
    const stranger = usageHelpers(pageSealOpener("another-secret", roomId));
    const closed = await stranger.collectRoomUsage({ board, participants: {} }, USAGE_NOW);
    expect(closed.rows).toEqual([]);
    expect(closed.reported).toBe(0);
    expect(stranger.renderUsageSection(closed)).toContain("No usage reported yet");
  });

  it("keeps the stats bar unchanged while no participant has reported", async () => {
    const root = { innerHTML: "", querySelectorAll: () => [] };
    const render = browserFunctions("  async function renderLiveRoom(", "  function subscribeRoomEvents(", {
      root, esc: escape, escAttr: escape, extractValue: (value: unknown) => value,
      renderBoardValue: (value: unknown) => escape(JSON.stringify(value)), renderKanbanBoard: () => "",
      renderMessage: async () => "", liveActivity: [], participantId: "viewer", updateConnectionStatus: vi.fn(),
      connectionState: "connected", document: { activeElement: null },
    }, "return { renderLiveRoom };");
    await render.renderLiveRoom({ room: { name: "Quiet room" }, phase: "active", board: {}, participants: { viewer: { id: "viewer" } }, messages: [] });
    expect(root.innerHTML).not.toContain("Room active time");
    expect(root.innerHTML).not.toContain("Room tokens");
    expect(root.innerHTML).toContain("Participant usage");
    expect(root.innerHTML).toContain("no usage reported");
  });
});

describe("live participant state", () => {
  async function renderPeople(participants: Record<string, Record<string, unknown>>) {
    const root = { innerHTML: "", querySelectorAll: () => [] };
    const { renderLiveRoom } = browserFunctions("  async function renderLiveRoom(", "  function subscribeRoomEvents(", {
      root, esc: escape, escAttr: escape, extractValue: (value: unknown) => value,
      renderBoardValue: () => "", renderKanbanBoard: () => "", renderMessage: async () => "",
      liveActivity: [], participantId: "viewer", updateConnectionStatus: vi.fn(), connectionState: "connected",
      document: { activeElement: null },
    }, "return { renderLiveRoom };");
    await renderLiveRoom({ room: {}, phase: "open", board: {}, participants, messages: [] });
    return root.innerHTML;
  }

  it("marks the busy card with data-state, a state dot and an accessible label", async () => {
    const html = await renderPeople({ agent: { id: "agent", display_name: "Agent", state: "busy", status: "Testing", role: "builder" } });
    expect(html).toContain('<article class="live-person" data-state="busy"');
    expect(html).toContain('<span class="live-state" data-state="busy" aria-hidden="true">Busy</span>');
    expect(html).toContain('aria-label="Agent · Busy — Testing"');
  });

  it("renders free, left and unknown states, and left_at wins over the last known state", async () => {
    const html = await renderPeople({
      free: { id: "free", state: "free" },
      gone: { id: "gone", state: "busy", left_at: "2026-01-01" },
      odd: { id: "odd", state: "waiting" },
    });
    expect(html).toContain('<article class="live-person" data-state="free"');
    expect(html).toContain(">Available</span>");
    expect(html).toContain('<article class="live-person" data-state="left"');
    expect(html).toContain(">Left</span>");
    expect(html).toContain('data-state="waiting"');
    expect((html.match(/<article class="live-person"/g) ?? []).length).toBe(3);
    // Every card carries the state twice: on the article for the wash, on the dot for the pulse.
    expect((html.match(/data-state="/g) ?? []).length).toBe(6);
  });

  it("escapes the accessible label so a display name cannot open a new attribute", async () => {
    const html = await renderPeople({ agent: { id: "agent", display_name: 'A" onmouseover="alert(1)', state: "busy" } });
    expect(html).toContain('aria-label="A&quot; onmouseover=&quot;alert(1) · Busy"');
    expect(html).not.toContain('onmouseover="alert');
  });

  it("styles the dot as the only round surface and pauses it under prefers-reduced-motion", () => {
    expect(LIVE_ROOM_STYLES).toMatch(/& \.live-person \{[^}]*position: relative/);
    expect(LIVE_ROOM_STYLES).toMatch(/& \.live-state \{[^}]*position: absolute[^}]*top: var\(--live-state-top\)[^}]*right: var\(--live-state-right\)/);
    // Reusable off the people list too: task cards are positioned hosts, and .live-state-inline opts out of the corner.
    expect(LIVE_ROOM_STYLES).toMatch(/& \.kanban-card \{[^}]*position: relative/);
    expect(LIVE_ROOM_STYLES).toContain('& .live-state.live-state-inline { position: static; }');
    expect(LIVE_ROOM_STYLES).toMatch(/& \.live-state::before \{[^}]*width: 8px[^}]*height: 8px[^}]*border-radius: 50%/);
    expect(LIVE_ROOM_STYLES).toContain('& .live-state[data-state="busy"]::before { background: var(--live-accent); animation: live-state-pulse 2s ease-in-out infinite; }');
    expect(LIVE_ROOM_STYLES).toContain('& .live-person[data-state="busy"] { padding-block: 0.85rem; background: color-mix(in srgb, var(--live-accent) 6%, transparent); border-left: 2px solid var(--live-accent);');
    // A resting room stays quiet: dim outline for free, flat gray for left.
    expect(LIVE_ROOM_STYLES).toMatch(/& \.live-state\[data-state="free"\]::before \{ background: transparent; outline: 1px solid var\(--live-muted\)/);
    expect(LIVE_ROOM_STYLES).toMatch(/& \.live-state\[data-state="left"\]::before \{ background: var\(--live-line\); \}/);
    const pulse = LIVE_ROOM_STYLES.slice(LIVE_ROOM_STYLES.indexOf("@keyframes live-state-pulse"));
    expect(pulse).toMatch(/transform: scale\(1\)[^}]*outline: 1px solid transparent/);
    // The glow is an animated outline, so the page keeps its flat, shadowless terminal look.
    expect(pulse).toMatch(/transform: scale\(1\.3\)[^}]*outline: 1px solid color-mix\(in srgb, var\(--live-accent\) 55%, transparent\)/);
    expect(LIVE_ROOM_STYLES).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ & \* \{ animation: none !important; \} \}/);
    expect(LIVE_ROOM_STYLES).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ & \.live-state\[data-state="busy"\]::before \{ animation: none; transform: none; outline: 0; \} \}/);
  });
});

describe("task card details modal", () => {
  const MODAL_START = "  const TASK_HELD_STATES";
  const MODAL_END = "  function extractValue(";
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  type CardEvent = { target: { closest: (selector: string) => unknown } };
  type BoardEntry = { value: unknown; version: number; updated_by?: string };

  function modalHarness(board: Record<string, unknown> = {}, options: { isHost?: boolean; messages?: unknown[]; participants?: Record<string, unknown>; decrypt?: (message: { id?: string }) => Promise<{ ok: boolean; value?: unknown }> } = {}) {
    const dialogEvents: Record<string, ((event: never) => void)[]> = {};
    const closeEvents: Record<string, (() => void)[]> = {};
    const closeButton = { addEventListener: (type: string, handler: () => void) => { (closeEvents[type] ||= []).push(handler); } };
    const dialog = {
      open: false,
      showModal: vi.fn(),
      focus: vi.fn(),
      classList: { add: vi.fn() },
      addEventListener: (type: string, handler: (event: never) => void) => { (dialogEvents[type] ||= []).push(handler); },
      querySelectorAll: (selector: string) => (selector === "[data-task-modal-close]" ? [closeButton] : []),
    };
    const host = {
      innerHTML: "", dataset: {} as Record<string, string>, className: "",
      contains: () => false,
      querySelector: (selector: string) => (selector === "[data-task-modal]" ? dialog : null),
    };
    const cardHandlers: Record<string, (event: CardEvent) => void> = {};
    const card = { dataset: { taskCard: "t4" }, addEventListener: (type: string, handler: (event: CardEvent) => void) => { cardHandlers[type] = handler; } };
    const returnFocus = { focus: vi.fn() };
    const document = { activeElement: returnFocus, body: { contains: () => true, appendChild: vi.fn() }, createElement: () => host };
    const root = { querySelectorAll: (selector: string) => (selector === "[data-task-card]" ? [card] : []) };
    const latest = { board, participants: options.participants || {}, messages: options.messages || [] };
    const functions = browserFunctions(MODAL_START, MODAL_END, {
      document, root, latest, isHost: options.isHost === true,
      decryptMessageBody: options.decrypt || (async () => ({ ok: false })),
      esc: escape, escAttr: escape, extractValue: (value: unknown) => value, boardDisplayValue: (value: unknown) => value,
    }, "return { taskStatusOf, taskStatusDot, taskCanEdit, taskEditHtml, taskCardModel, taskDetailsHtml, taskVerdictLines, buildTaskCardModel, wireTaskCards, openTaskCard, renderTaskModal, closeTaskCard };");
    return { ...functions, card, cardHandlers, dialog, dialogEvents, closeButton, closeEvents, host, returnFocus };
  }

  const claimedTask: Record<string, unknown> = {
    title: "Task details modal", status: "claimed", owner: "worker-4", role: "builder",
    files: ["apps/web/src/room-page.js"], depends_on: ["t3"], needs: ["frontend"],
    contract: "Ship <b>the</b> modal contract", brief: "click opens a dialog",
  };

  it("opens the details modal from a card click, escaped, with the contract and t3's status dot", async () => {
    const room = modalHarness({ "task.t4": { value: claimedTask, version: 3, updated_by: "worker-4" } });
    room.wireTaskCards();
    room.cardHandlers.click({ target: { closest: () => null } });
    await settle();
    expect(room.host.innerHTML).toContain('data-task-modal');
    expect(room.host.innerHTML).toContain("Ship &lt;b>the&lt;/b> modal contract");
    expect(room.host.innerHTML).not.toContain("<b>the</b>");
    expect(room.host.innerHTML).toContain("click opens a dialog");
    expect(room.host.innerHTML).toContain("apps/web/src/room-page.js");
    expect(room.host.innerHTML).toContain('data-state="busy"');
    expect(room.host.innerHTML).toContain('class="live-state live-state-inline"');
    expect(room.host.innerHTML).toContain("v3 · worker-4");
    expect(room.dialog.showModal).toHaveBeenCalled();
    expect(room.dialog.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("leaves clicks on card controls to the controls", async () => {
    const room = modalHarness({ "task.t4": { value: claimedTask, version: 1 } });
    room.wireTaskCards();
    room.cardHandlers.click({ target: { closest: (selector: string) => (selector.includes("button") ? {} : null) } });
    await settle();
    expect(room.host.innerHTML).toBe("");
    expect(room.dialog.showModal).not.toHaveBeenCalled();
  });

  it("closes on Escape, on the backdrop and on the close button, and returns focus", async () => {
    const room = modalHarness({ "task.t4": { value: { title: "Quiet task", status: "open" }, version: 1 } });
    room.wireTaskCards();
    room.cardHandlers.click({ target: { closest: () => null } });
    await settle();
    expect(room.host.innerHTML).toContain("data-task-modal");
    room.dialogEvents.keydown[0]({ key: "Escape" } as never);
    expect(room.host.innerHTML).toBe("");
    expect(room.returnFocus.focus).toHaveBeenCalledWith({ preventScroll: true });

    room.cardHandlers.click({ target: { closest: () => null } });
    await settle();
    room.dialogEvents.click[0]({ target: room.dialog } as never);
    expect(room.host.innerHTML).toBe("");

    room.cardHandlers.click({ target: { closest: () => null } });
    await settle();
    room.closeEvents.click[0]();
    expect(room.host.innerHTML).toBe("");
  });

  it("ignores a click on card content that is not the backdrop", async () => {
    const room = modalHarness({ "task.t4": { value: { title: "Quiet task", status: "open" }, version: 1 } });
    room.wireTaskCards();
    room.cardHandlers.click({ target: { closest: () => null } });
    await settle();
    room.dialogEvents.click[0]({ target: { closest: () => null } } as never);
    expect(room.host.innerHTML).toContain("data-task-modal");
  });

  it("shows Edit only for open cards, and warns the host before rewriting a claimed contract", () => {
    const room = modalHarness();
    expect(room.taskEditHtml(claimedTask, { id: "t4", boardKey: "task.t4", small: true, viewer: { isHost: false } })).toBe("");
    expect(room.taskEditHtml({ title: "Shipped", status: "done", owner: "worker-4" }, { id: "t1", viewer: { isHost: false } })).toBe("");
    const open = room.taskEditHtml({ title: "Fresh", status: "open" }, { id: "t5", boardKey: "task.t5", viewer: { isHost: false } });
    expect(open).toContain('data-edit-board-key="task.t5"');
    expect(open).not.toContain("task-edit-confirm");
    const armed = room.taskEditHtml(claimedTask, { id: "t4", boardKey: "task.t4", small: true, viewer: { isHost: true } });
    expect(armed).toContain('data-task-edit-ask="t4"');
    expect(armed).toContain("task is claimed by worker-4; editing rewrites their contract");
    expect(armed).toContain("<span class=\"task-edit-confirm\"");
    expect(armed).toContain("hidden");
    expect(armed).toContain('data-edit-board-key="task.t4"');
    expect(room.taskEditHtml({ title: "Stuck", status: "blocked", owner: "worker-9" }, { id: "t6", viewer: { isHost: true } }))
      .toContain("task is claimed by worker-9; editing rewrites their contract");
  });

  it("keeps the sprint board honest: cards are clickable, claimed cards have no Edit for readers", () => {
    const board = () => [["task.t3", { value: { title: "Busy dot", status: "claimed", owner: "worker-3", files: ["apps/web/src/live-room-view.ts"], depends_on: [] }, version: 2 }],
      ["task.t5", { value: { title: "Fresh", status: "open", files: [], depends_on: [] }, version: 1 }]];
    const reader = browserFunctions("  function renderSprintTaskBoard(", MODAL_END, {
      esc: escape, escAttr: escape, boardDisplayValue: (value: unknown) => value,
      renderValue: (value: unknown) => escape(JSON.stringify(value)), isHost: false,
    }, "return { renderSprintTaskBoard };").renderSprintTaskBoard(board() as never);
    expect(reader).toContain('data-task-card="t3"');
    expect(reader).toContain('tabindex="0"');
    expect(reader).not.toContain('data-edit-board-key="task.t3"');
    expect(reader).toContain('data-edit-board-key="task.t5"');
    const host = browserFunctions("  function renderSprintTaskBoard(", MODAL_END, {
      esc: escape, escAttr: escape, boardDisplayValue: (value: unknown) => value,
      renderValue: (value: unknown) => escape(JSON.stringify(value)), isHost: true,
    }, "return { renderSprintTaskBoard };").renderSprintTaskBoard(board() as never);
    expect(host).toContain('data-task-edit-ask="t3"');
    expect(host).toContain("task is claimed by worker-3; editing rewrites their contract");
  });

  it("shows a finished task's evidence: summary, commits, tests and the contract check", () => {
    const room = modalHarness();
    const done = {
      title: "Busy dot", status: "done", owner: "worker-3", role: "builder", files: ["apps/web/src/live-room-view.ts"],
      depends_on: ["t4"], summary: "dot + wash",
      evidence: { commits: ["77733ed", "abcdef0"], tests: "npx vitest run apps/web/test/live-room.test.ts -> 24 passed", contract: "pnpm check:contract --peer passed" },
    };
    const model = room.taskCardModel("t3", { board: { "task.t3": { value: done, version: 4, updated_by: "worker-3" }, "task.t4": { value: { title: "Modal", status: "done" }, version: 2 } }, participants: { "worker-3": { id: "worker-3", display_name: "Wren" } } });
    const html = room.taskDetailsHtml(model);
    expect(html).toContain("Done evidence");
    expect(html).toContain("77733ed");
    expect(html).toContain("abcdef0");
    expect(html).toContain("24 passed");
    expect(html).toContain("pnpm check:contract --peer passed");
    expect(html).toContain("dot + wash");
    expect(html).toContain("Wren");
    expect(html).toContain('data-done="true"');
    expect(room.taskDetailsHtml({ ...model, status: "claimed", done: null })).not.toContain("Done evidence");
  });

  it("carries only the compare verdicts that name the task", async () => {
    const room = modalHarness();
    const messages = [
      { id: "m-1", seq: 4, from: "hermes-bot", intent: "compare.request", body: { a: "t4 before the dialog", b: "t4 with a dialog", criteria: ["clarity"] } },
      { id: "m-2", seq: 5, from: "worker-2", intent: "compare.verdict", body: { of: "m-1", winner: "B", reason: "clearer on both criteria" } },
      { id: "m-3", seq: 6, from: "worker-1", intent: "compare.verdict", body: { of: "m-9", winner: "A", reason: "unrelated to t9" } },
      { id: "m-4", seq: 7, from: "worker-3", intent: "task.done", body: { task_id: "t4", text: "names t4 but is not a verdict" } },
    ];
    expect(await room.taskVerdictLines("t4", messages, (message: { body: unknown }) => message.body)).toEqual([
      { seq: 5, from: "worker-2", winner: "B", reason: "clearer on both criteria", of: "m-1", request: 4 },
    ]);
    const model = room.taskCardModel("t4", { board: { "task.t4": { value: claimedTask, version: 3 } }, participants: {} });
    const html = room.taskDetailsHtml({ ...model, verdicts: [{ seq: 5, from: "worker-2", winner: "B", reason: "clearer on both criteria", of: "m-1", request: 4 }] });
    expect(html).toContain("Compare verdicts");
    expect(html).toContain("clearer on both criteria");
    expect(html).toContain("on request #4");
  });

  it("opens sealed verdicts through the timeline's own decryption path", async () => {
    const messages = [
      { id: "m-1", seq: 2, from: "peer", intent: "compare.request", body: { encrypted: true } },
      { id: "m-2", seq: 3, from: "peer", intent: "compare.verdict", body: { encrypted: true } },
      { id: "m-3", seq: 4, from: "peer", intent: "compare.verdict", body: { encrypted: true } },
    ];
    const room = modalHarness({ "task.t4": { value: { title: "Modal", status: "open" }, version: 1 } }, {
      messages,
      decrypt: async (message) => (message.id === "m-2"
        ? { ok: true, value: { of: "m-1", winner: "B", reason: "task.t4 reads better in a dialog" } }
        : message.id === "m-1" ? { ok: true, value: { a: "inline details", b: "modal" } } : { ok: false }),
    });
    const model = await room.buildTaskCardModel("t4");
    expect(model.verdicts).toEqual([{ seq: 3, from: "peer", winner: "B", reason: "task.t4 reads better in a dialog", of: "m-1", request: 2 }]);
    const unreadable = modalHarness({ "task.t4": { value: { title: "Modal", status: "open" }, version: 1 } }, { messages });
    expect(await unreadable.buildTaskCardModel("t4")).toMatchObject({ verdicts: [] });
  });

  it("gives the console view the same state dot as the live view, from one @keyframes", () => {
    expect(ROOM_CONSOLE_STYLES).toMatch(/& \.live-state::before \{[^}]*border-radius: 50%/);
    expect(ROOM_CONSOLE_STYLES).toMatch(/& \.live-state\[data-state=busy\]::before \{[^}]*animation: live-state-pulse/);
    expect(ROOM_CONSOLE_STYLES).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?& \.live-state\[data-state=busy\]::before \{ animation: none;/);
    // Both style strings land in the same <style>, so the pulse animation must stay defined exactly once.
    expect(ROOM_CONSOLE_STYLES).not.toMatch(/@keyframes live-state-pulse/);
    expect(LIVE_ROOM_STYLES).toMatch(/@keyframes live-state-pulse/);
  });

  it("refreshes an open dialog in place and drops it when the task is gone", async () => {
    const board: Record<string, BoardEntry | undefined> = { "task.t4": { value: claimedTask, version: 3, updated_by: "worker-4" } };
    const room = modalHarness(board);
    room.wireTaskCards();
    room.cardHandlers.click({ target: { closest: () => null } });
    await settle();
    const first = room.host.innerHTML;
    expect(room.host.dataset.taskModalSignature).toBeTruthy();
    await room.renderTaskModal();
    expect(room.host.innerHTML).toBe(first);
    board["task.t4"] = { value: { ...claimedTask, status: "done", summary: "shipped" }, version: 4, updated_by: "worker-4" };
    await room.renderTaskModal();
    expect(room.host.innerHTML).toContain("shipped");
    expect(room.dialog.showModal).toHaveBeenCalledTimes(1);
    delete board["task.t4"];
    await room.renderTaskModal();
    expect(room.host.innerHTML).toBe("");
  });
});
