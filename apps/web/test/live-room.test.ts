import { describe, expect, it, vi } from "vitest";
import {
  coerceUsageSnapshot, applyUsageDelta, estimateCost, formatActiveTime, formatCost, formatTokens, formatUsage,
  ratesForModel, roomUsage, sealUsage, usageCost, usageTotals,
} from "@j01n/sdk/metrics";
import { roomPageHtml } from "../src/html";
import app from "../src/index";
import { LIVE_ROOM_STYLES } from "../src/live-room-view";

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
    expect([...LIVE_ROOM_STYLES.matchAll(/border-radius:\s*([^;}]+)/g)].map(match => match[1].trim())).toEqual(['0']);
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
    expect([...LIVE_ROOM_STYLES.matchAll(/border-radius:\s*([^;}]+)/g)].map(match => match[1].trim())).toEqual(['0']);
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
