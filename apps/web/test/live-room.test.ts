import { describe, expect, it, vi } from "vitest";
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
    expect(LIVE_ROOM_STYLES).toContain('--live-bg: #121212');
    expect(LIVE_ROOM_STYLES).toContain('--live-accent: #ffebc4');
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
