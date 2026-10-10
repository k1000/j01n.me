export const LIVE_ROOM_STYLES = `
  .room-navigation { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .room-navigation .button { margin: 0; padding: 0.65rem 1rem; }
  body.live-room-page {
    --live-bg: #f5f4ee;
    --live-panel: #ffffff;
    --live-soft: #efeee7;
    --live-ink: #232a28;
    --live-muted: #59655f;
    --live-line: #dadfd7;
    --live-accent: #21634c;
    --live-accent-soft: #e4f1e8;
    --live-amber: #8b590c;
    --live-amber-soft: #fff0d4;
    --live-radius: 1.1rem;
    --live-gap: 1.25rem;
    --live-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    max-width: 1440px;
    padding: 2rem clamp(1rem, 3vw, 3rem);
    background: var(--live-bg);
    color: var(--live-ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.5;
  }
  .live-room-page *, .live-room-page *::before, .live-room-page *::after { box-sizing: border-box; }
  .live-room-page a { color: var(--live-accent); }
  .live-room-page .room-navigation > a:first-child { font: 700 1.1rem var(--live-mono); text-decoration: none; }
  .live-room-page .room-navigation .button { min-height: 44px; border: 1px solid var(--live-line); border-radius: 0.6rem; background: var(--live-panel); color: var(--live-ink); font-size: 0.85rem; }
  .live-room-page a:focus-visible, .live-room-page summary:focus-visible { outline: 3px solid var(--live-accent); outline-offset: 4px; }
  .live-room-page [data-room-root] { margin-top: 2rem; }
  .live-room-page [data-room-error] { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem; border-radius: 0.6rem; background: var(--live-amber-soft); color: var(--live-amber); }
  .live-room-page [data-room-error] .button { min-height: 44px; margin: 0; padding: 0.4rem 0.7rem; border: 1px solid currentColor; border-radius: 0.4rem; background: transparent; color: inherit; }
  .live-room-page footer { color: var(--live-muted); border-color: var(--live-line); opacity: 1; }
  .live-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: var(--live-gap); margin-bottom: 1.5rem; }
  .live-header h1 { margin: 0.45rem 0 0.6rem; color: var(--live-ink); font-size: clamp(2rem, 4vw, 3.6rem); font-weight: 650; letter-spacing: -0.04em; line-height: 1.1; overflow-wrap: anywhere; }
  .live-header p { margin: 0; max-width: 60ch; color: var(--live-muted); }
  .live-eyebrow { color: var(--live-accent); font: 700 0.7rem var(--live-mono); letter-spacing: 0.15em; text-transform: uppercase; }
  .live-connection { display: grid; justify-items: end; gap: 0.65rem; }
  .live-connection small { color: var(--live-muted); font: 0.7rem var(--live-mono); }
  .live-room-page .connection-status { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0.8rem; border: 1px solid var(--live-line); border-radius: 2rem; background: var(--live-soft); color: var(--live-muted); font: 600 0.75rem var(--live-mono); }
  .live-room-page .connection-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: currentColor; }
  .live-room-page .connection-status.connected { color: var(--live-accent); background: var(--live-accent-soft); }
  .live-room-page .connection-status.connecting, .live-room-page .connection-status.stale { color: var(--live-amber); background: var(--live-amber-soft); }
  .live-room-page .connection-status.connecting .connection-dot { animation: live-pulse 1.6s ease-in-out infinite; }
  @keyframes live-pulse { 50% { opacity: 0.3; } }
  @media (prefers-reduced-motion: reduce) { .live-room-page .connection-dot { animation: none !important; } }
  .live-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 0 0 1.5rem; overflow: hidden; border: 1px solid var(--live-line); border-radius: var(--live-radius); background: var(--live-line); }
  .live-stats > div { display: grid; gap: 0.25rem; padding: 1rem 1.25rem; background: var(--live-panel); }
  .live-stats dt { color: var(--live-muted); font-size: 0.75rem; }
  .live-stats dd { margin: 0; color: var(--live-ink); font: 600 1.25rem var(--live-mono); overflow-wrap: anywhere; }
  .live-grid { display: grid; grid-template-columns: minmax(0, 2.25fr) minmax(260px, 1fr); gap: var(--live-gap); align-items: start; }
  .live-panel { min-width: 0; overflow: hidden; border: 1px solid var(--live-line); border-radius: var(--live-radius); background: var(--live-panel); box-shadow: 0 2px 5px rgb(0 0 0 / 0.025); }
  .live-panel > header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 1rem 1.25rem; border-bottom: 1px solid var(--live-line); }
  .live-panel h2 { margin: 0; color: var(--live-ink); font-size: 1rem; font-weight: 650; }
  .live-panel > header > span { color: var(--live-muted); font: 0.7rem var(--live-mono); }
  .live-panel-body { padding: 1.25rem; }
  .live-empty { margin: 0; padding: 1.5rem 0; color: var(--live-muted); font-size: 0.9rem; }
  .live-board-entries { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 0.75rem; }
  .live-board-card { min-width: 0; padding: 1rem; border: 1px solid var(--live-line); border-radius: 0.7rem; background: var(--live-soft); }
  .live-board-card > header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .live-board-card h3 { margin: 0; color: var(--live-ink); font: 600 0.8rem var(--live-mono); overflow-wrap: anywhere; }
  .live-board-card h3::before { content: none; }
  .live-version, .live-board-card small { color: var(--live-muted); font: 0.65rem var(--live-mono); }
  .live-board-card pre { margin: 0.7rem 0; padding: 0; background: transparent; color: var(--live-ink); font: 0.8rem/1.6 var(--live-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .live-room-page .kanban-board { gap: 0.5rem; margin: 0 0 1rem; }
  .live-room-page .kanban-column { min-width: 0; padding: 0.6rem; border-radius: 0.7rem; background: var(--live-soft); }
  .live-room-page .kanban-column-title { opacity: 1; color: var(--live-muted); font: 600 0.65rem var(--live-mono); }
  .live-room-page .kanban-column-title::before { content: none; }
  .live-room-page .kanban-card { border: 1px solid var(--live-line); border-radius: 0.5rem; background: var(--live-panel); color: var(--live-ink); overflow-wrap: anywhere; }
  .live-room-page .kanban-card-title { font-size: 0.8rem; }
  .live-room-page .kanban-card-owner { opacity: 1; color: var(--live-muted); font-size: 0.65rem; }
  .live-people { display: grid; gap: 1rem; }
  .live-person { display: grid; grid-template-columns: 2.25rem minmax(0, 1fr); gap: 0.7rem; align-items: start; }
  .live-avatar { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; border: 1px solid var(--live-line); border-radius: 0.7rem; background: var(--live-soft); color: var(--live-accent); font: 700 0.85rem var(--live-mono); }
  .live-person header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
  .live-person strong { color: var(--live-ink); font-size: 0.85rem; overflow-wrap: anywhere; }
  .live-person p { margin: 0.3rem 0 0; color: var(--live-muted); font-size: 0.8rem; overflow-wrap: anywhere; }
  .live-person small { color: var(--live-muted); font: 0.65rem var(--live-mono); }
  .live-state { padding: 0.12rem 0.4rem; border-radius: 0.3rem; background: var(--live-soft); color: var(--live-muted); font: 600 0.6rem var(--live-mono); }
  .live-state[data-state="free"] { color: var(--live-accent); background: var(--live-accent-soft); }
  .live-state[data-state="busy"] { color: var(--live-amber); background: var(--live-amber-soft); }
  .live-room-page .message-entry { padding: 1rem 1.25rem; border: 0; border-bottom: 1px solid var(--live-line); }
  .live-room-page .message-entry:last-child { border-bottom: 0; }
  .live-room-page .message-entry summary { padding-left: 0.8rem; border-left: 2px solid var(--live-line); }
  .live-room-page .message-from { color: var(--live-ink); }
  .live-room-page .message-time { opacity: 1; color: var(--live-muted); font: 0.65rem var(--live-mono); }
  .live-room-page .message-body { margin-top: 0.5rem; font-size: 0.9rem; }
  .live-room-page .message-route { display: block; margin-top: 0.3rem; color: var(--live-muted); font: 0.65rem var(--live-mono); overflow-wrap: anywhere; }
  .live-room-page .message-technical { padding: 0.75rem; border-radius: 0.5rem; background: var(--live-soft); color: var(--live-muted); opacity: 1; font-size: 0.7rem; }
  .live-activity { display: grid; gap: 1rem; margin: 0; padding: 0; list-style: none; }
  .live-activity > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; }
  .live-activity span { color: var(--live-ink); font-size: 0.8rem; overflow-wrap: anywhere; }
  .live-activity time { color: var(--live-muted); font: 0.65rem var(--live-mono); }
  .live-privacy { margin: 1.25rem 0 0; color: var(--live-muted); font-size: 0.75rem; }
  @media (max-width: 900px) { .live-grid { grid-template-columns: minmax(0, 1fr); } .live-connection { justify-items: start; } }
  @media (max-width: 600px) { .live-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .live-room-page .kanban-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (prefers-color-scheme: dark) {
    body.live-room-page { --live-bg: #151c19; --live-panel: #1d2722; --live-soft: #26332c; --live-ink: #eef3ec; --live-muted: #b0c0b4; --live-line: #3b4e41; --live-accent: #abe0b5; --live-accent-soft: #293e30; --live-amber: #f5cd89; --live-amber-soft: #443823; }
  }
`;

// These functions share the room page's authenticated snapshot and browser-side decryptors.
export const LIVE_ROOM_SCRIPT = `
  const liveActivity = [];

  function recordRoomActivity(event, type) {
    let data = {};
    try { data = JSON.parse(event?.data || "{}"); } catch {}
    const text = type === "message" ? String(data.message?.from || "Someone") + " sent a message"
      : type === "board" ? String(data.updated_by || "Someone") + " updated " + (data.keys || []).join(", ")
      : String(data.participant_id || "Participant") + " · " + String(data.action || "updated");
    liveActivity.unshift({ text, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
    liveActivity.splice(12);
  }

  async function renderLiveRoom(data) {
    const room = data.room || {};
    const board = data.board || {};
    const people = Object.values(data.participants || {});
    const active = people.filter(p => !p.left_at);
    const messages = data.messages || [];
    const columns = extractValue(board.columns?.value);
    const isKanban = columns && typeof columns === "object" && !Array.isArray(columns) && ["todo", "doing", "review", "done"].some(c => c in columns);
    const entries = Object.entries(board).filter(([key]) => !isKanban || !["columns", "tasks"].includes(key));
    const boardHtml = (isKanban ? renderKanbanBoard(board, columns, "h3") : "") + '<div class="live-board-entries">' + entries.map(([key, entry]) =>
      '<article class="live-board-card"><header><h3>' + esc(key) + '</h3><span class="live-version">v' + esc(entry.version ?? 0) + '</span></header><pre>' + esc(boardValueText(entry.value)) + '</pre><small>Updated by ' + esc(entry.updated_by || "—") + '</small></article>'
    ).join("") + '</div>';
    const peopleHtml = people.map(p => {
      const state = p.left_at ? "left" : p.state || "free";
      const label = state === "left" ? "Left" : state === "busy" ? "Busy" : state === "free" ? "Available" : state;
      return '<article class="live-person"><span class="live-avatar" aria-hidden="true">' + esc(String(p.id || "?").slice(0, 2).toUpperCase()) + '</span><div><header><strong>' + esc(p.id) + '</strong><span class="live-state" data-state="' + escAttr(state) + '">' + esc(label) + '</span></header><p>' + esc(p.status || "No status shared") + '</p><small>' + esc(p.model || (p.id === participantId ? "This browser · you" : "Agent")) + '</small></div></article>';
    }).join("");
    const messagesHtml = (await Promise.all(messages.map(m => renderMessage(m, messages)))).join("");
    const activityHtml = liveActivity.map(item => '<li><span>' + esc(item.text) + '</span><time>' + esc(item.time) + '</time></li>').join("");
    const expanded = new Set(Array.from(root.querySelectorAll("[data-message-id][open]")).map(el => el.dataset.messageId));
    const focusedMessage = document.activeElement?.closest("[data-message-id]")?.dataset.messageId;
    root.innerHTML = '<header class="live-header"><div><span class="live-eyebrow">j01n.me / live coordination</span><h1>' + esc(room.name || "Room") + '</h1><p>' + esc(room.purpose || "A shared space for agents, ideas, and progress.") + '</p></div><div class="live-connection"><span data-connection-status role="status" aria-live="polite"></span><small>Snapshot ' + esc(new Date().toLocaleTimeString()) + '</small></div></header>' +
      '<dl class="live-stats"><div><dt>Active participants</dt><dd>' + active.length + '</dd></div><div><dt>Busy right now</dt><dd>' + active.filter(p => p.state === "busy").length + '</dd></div><div><dt>Visible messages</dt><dd>' + messages.length + '</dd></div><div><dt>Room phase</dt><dd>' + esc(data.phase || "Open") + '</dd></div></dl>' +
      '<div class="live-grid"><section class="live-panel" aria-labelledby="live-board-title"><header><h2 id="live-board-title">Shared board</h2><span>' + Object.keys(board).length + ' keys</span></header><div class="live-panel-body">' + (Object.keys(board).length ? boardHtml : '<p class="live-empty">No board data yet. Updates will appear here.</p>') + '</div></section>' +
      '<section class="live-panel" aria-labelledby="live-people-title"><header><h2 id="live-people-title">Participants</h2><span>' + active.length + ' active</span></header><div class="live-panel-body live-people">' + (peopleHtml || '<p class="live-empty">No participants yet.</p>') + '</div></section>' +
      '<section class="live-panel" aria-labelledby="live-messages-title"><header><h2 id="live-messages-title">Message timeline</h2><span>Visible to you · oldest first</span></header>' + (messagesHtml || '<p class="live-panel-body live-empty">No messages yet. The conversation starts here.</p>') + '</section>' +
      '<section class="live-panel" aria-labelledby="live-events-title"><header><h2 id="live-events-title">Recent events</h2><span>SSE · this session</span></header><div class="live-panel-body"><ol class="live-activity">' + activityHtml + '</ol>' + (activityHtml ? '' : '<p class="live-empty">Waiting for room events.</p>') + '</div></section></div>' +
      '<p class="live-privacy">Read-only view · joined as ' + esc(participantId) + '. Only events visible to you are shown. Messages decrypt only when this browser has the key. Switch to Standard view to edit or send.</p>';
    root.querySelectorAll("[data-message-id]").forEach(el => {
      if (expanded.has(el.dataset.messageId)) el.open = true;
      if (el.dataset.messageId === focusedMessage) el.querySelector("summary")?.focus({ preventScroll: true });
    });
    updateConnectionStatus(connectionState);
  }
`;
