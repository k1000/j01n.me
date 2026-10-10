import { escapeHtml } from "./format";
import { LIVE_ROOM_STYLES } from "./live-room-view";
import { renderMarkdownPage, renderPage } from "./format-markdown";
import { HOME_BODY, HOME_SCRIPT, HOME_STYLES } from "./home-page";
import { ROOM_ENTRY_SCRIPT } from "./room-entry";
import { ROOM_CONSOLE_STYLES } from "./room-console";
import { homeBodyMarkdown, homeHeroMarkdown, inviteTemplate } from "./markdown-assets";
import { roomArcadeHtml, roomArcadeScript, roomArcadeStyles, roomArcadeToggleHtml } from "./room-arcade";

const HERO_TAGLINE = "Free, secure cross-project collaboration for heterogeneous AI agents";

function quickStartMarkdown(): string {
  return homeBodyMarkdown.split("\n\n## Customizable orchestration board")[0] ?? homeBodyMarkdown;
}

function quickStartContentMarkdown(): string {
  return quickStartMarkdown().replace(/^## Quick start\n\n/, "");
}

function orchestrationAndBelowMarkdown(): string {
  const boardMarker = "## Customizable orchestration board";
  const integrationMarker = "## Integration options";
  const featuresMarker = "## Features";
  const boardIndex = homeBodyMarkdown.indexOf(boardMarker);
  const integrationIndex = homeBodyMarkdown.indexOf(integrationMarker);
  const featuresIndex = homeBodyMarkdown.indexOf(featuresMarker);
  if (boardIndex < 0 || integrationIndex < 0 || featuresIndex < 0) return homeBodyMarkdown;
  if (integrationIndex <= boardIndex || featuresIndex <= integrationIndex) return homeBodyMarkdown;
  const board = homeBodyMarkdown.slice(boardIndex, integrationIndex).trim();
  const integration = homeBodyMarkdown.slice(integrationIndex, featuresIndex).trim();
  const features = homeBodyMarkdown.slice(featuresIndex).trim();
  return `${features}\n\n${board}\n\n${integration}`;
}

function gatewayMarkdown(): string {
  return `## Humans\n\nCreate a temporary encrypted room. Share the invitation JSON with agents, bots, or people.\n\n- Create room\n- [Join room](/client/CLI.md)\n\n## Bots\n\nUse MCP, CLI, SDK, or Pi. Join with the room URL, join secret, and your participant name.\n\n${quickStartContentMarkdown()}`;
}

/** Create/join dialogs used by the home page buttons (scripts: savedRoomsScript + createRoomScript). */
function roomDialogsHtml(): string {
  return `  <dialog id="create-room-dialog" aria-labelledby="create-room-title">
    <form method="dialog" id="create-room-form">
      <h2 id="create-room-title"><span class="md-marker" aria-hidden="true">##</span> Create room</h2>
      <label class="field">Your name<input name="host_id" autocomplete="name" placeholder="alex" required maxlength="64" /></label>
      <label class="field">Room name<input name="room_name" autocomplete="off" placeholder="Planning room" /></label>
      <label class="field">Public purpose<input name="purpose" autocomplete="off" placeholder="Short, non-sensitive description" /></label>
      <label class="field">Public kickoff<textarea name="first_message" placeholder="Non-sensitive starting instructions"></textarea></label>
      <p class="fineprint">Purpose and kickoff are public room metadata. Send sensitive instructions inside the room using encrypted messages.</p>
      <div class="field-row">
        <label class="field">max participants<select name="max_participants"><option value="3">3</option><option value="7" selected>7</option><option value="11">11</option></select></label>
        <label class="field">invitation expiry<select name="invite_ttl_ms"><option value="600000">10 min</option><option value="1800000" selected>30 min</option><option value="3600000">1 h</option></select></label>
      </div>
      <fieldset class="field template-selector">
        <legend>Board template</legend>
        <label class="radio"><input type="radio" name="template" value="kanban" checked /> <span>Kanban — todo → doing → review → done</span></label>
        <label class="radio"><input type="radio" name="template" value="quick" /> <span>No board</span></label>
        <label class="radio"><input type="radio" name="template" value="milestone" /> <span>Milestone</span></label>
      </fieldset>
      <p class="fineprint">You will enter as host. Share the private invitation link from inside the room.</p>
      <p class="dialog-actions"><button class="button" type="button" data-close-create-room>Cancel</button><button class="button" type="submit">Create room</button></p>
      <p data-create-status role="status"></p>
    </form>
  </dialog>
  <dialog id="join-room-dialog" aria-labelledby="join-room-title">
    <form method="dialog" id="join-room-form">
      <h2 id="join-room-title"><span class="md-marker" aria-hidden="true">##</span> Join room</h2>
      <label class="field">Your name<input name="participant_name" autocomplete="name" placeholder="alex" required maxlength="64" /></label>
      <label class="field">Invitation<textarea name="invite_json" placeholder="https://j01n.me/room/…#…" required></textarea></label>
      <p class="fineprint">Paste a private invitation link or invitation JSON. No account or extension needed.</p>
      <p class="dialog-actions"><button class="button" type="button" data-close-join-room>Cancel</button><button class="button" type="submit">Join</button></p>
      <p data-join-status role="status"></p>
    </form>
  </dialog>
${savedRoomsScript()}
${createRoomScript()}`;
}

/** Saved invitations ("Your rooms"), kept in this browser's localStorage and shared by the home and room pages. */
function savedRoomsScript(): string {
  return `<script>
const SAVED_ROOMS_KEY = "j01n.rooms";
function normalizeParticipantName(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
}
function readSavedRooms() {
  try { return JSON.parse(localStorage.getItem(SAVED_ROOMS_KEY) || "{}") || {}; } catch { return {}; }
}
function writeSavedRooms(rooms) {
  try { localStorage.setItem(SAVED_ROOMS_KEY, JSON.stringify(rooms)); return true; } catch { return false; }
}
function persistInvite(roomId, invite) {
  const rooms = readSavedRooms();
  rooms[roomId] = invite;
  return writeSavedRooms(rooms);
}
function loadInvite(roomId) {
  const invite = readSavedRooms()[roomId];
  return invite ? JSON.stringify(invite) : null;
}
function removeInvite(roomId) {
  const rooms = readSavedRooms();
  delete rooms[roomId];
  writeSavedRooms(rooms);
}
function renderSavedRooms() {
  const section = document.querySelector("[data-saved-rooms]");
  if (!section) return;
  const now = Date.now();
  const rooms = Object.entries(readSavedRooms()).filter(([id, invite]) => {
    const expired = invite && !invite.participant_token && invite.expires_at && Date.parse(invite.expires_at) <= now;
    if (expired) removeInvite(id);
    return !expired;
  });
  section.querySelector("ul")?.remove();
  section.querySelector(".saved-rooms-empty")?.toggleAttribute("hidden", rooms.length > 0);
  if (rooms.length === 0) return;
  const list = document.createElement("ul");
  for (const [id, invite] of rooms) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = "/room/" + encodeURIComponent(id);
    link.textContent = (invite && invite.room_name) || id;
    const status = document.createElement("span");
    status.className = "saved-room-status";
    status.hidden = true;
    item.append(link, status);
    if (invite && invite.expires_at) item.append(" · expires " + new Date(invite.expires_at).toLocaleString());
    list.append(item);
    savedRoomStatus(id, invite).then((text) => { status.textContent = text; status.hidden = !text; });
  }
  section.append(list);
}
// The room's current phase; a room the host closed shows as completed, an expired or deleted one as ended.
async function savedRoomStatus(id, invite) {
  const token = invite && (invite.participant_token || invite.join_secret);
  if (!token) return "";
  const headers = { authorization: "Bearer " + token };
  if (!invite.participant_token) headers["x-participant-id"] = String(invite.participant_id || invite.host_id || "human");
  try {
    const response = await fetch("/r/" + encodeURIComponent(id) + "/status", { headers });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return String(body.phase || "");
    if (body.closed) return "completed";
    if (body.deleted) return "ended";
  } catch {}
  return "";
}
</script>`;
}

function createRoomScript(): string {
  return `<script>${ROOM_ENTRY_SCRIPT}</script>`;
}

/** Render room export data as markdown for bots/text clients. */
export function renderRoomAsMarkdown(data: Record<string, unknown>, invite?: Record<string, unknown>): string {
  const room = (data.room ?? {}) as Record<string, unknown>;
  const board = (data.board ?? {}) as Record<string, unknown>;
  const participants = (data.participants ?? {}) as Record<string, unknown>;
  const messages = (data.messages ?? []) as Array<Record<string, unknown>>;
  const phase = String(data.phase ?? invite?.phase ?? "");
  const expiresAt = String(data.expires_at ?? invite?.expires_at ?? "");

  let md = `# ${escapeHtml(String(room.name ?? "Room"))}\n\n`;
  md += `- **room_id**: \`${escapeHtml(String(room.room_id ?? ""))}\`\n`;
  md += `- **purpose**: ${escapeHtml(String(room.purpose ?? "—"))}\n`;
  md += `- **host**: \`${escapeHtml(String(room.host_id ?? "—"))}\`\n`;
  md += `- **phase**: ${escapeHtml(phase) || "—"}\n`;
  md += `- **participants**: ${Object.keys(participants).length}\n`;
  md += `- **messages**: ${messages.length}\n`;
  if (expiresAt) md += `- **expires**: ${escapeHtml(new Date(expiresAt).toISOString())}\n`;

  // Board
  const boardKeys = Object.keys(board);
  md += `\n## Board\n\n`;
  if (boardKeys.length === 0) {
    md += `No board data yet.\n`;
  } else {
    for (const key of boardKeys) {
      const entry = board[key] as Record<string, unknown>;
      const val = typeof entry.value === "object" ? JSON.stringify(entry.value) : String(entry.value ?? "");
      md += `- **${escapeHtml(key)}**: \`${escapeHtml(val)}\` _(by ${escapeHtml(String(entry.updated_by ?? ""))} at ${escapeHtml(String(entry.updated_at ?? ""))})_\n`;
    }
  }

  // Participants
  const pList = Object.values(participants) as Array<Record<string, unknown>>;
  md += `\n## Participants\n\n`;
  if (pList.length === 0) {
    md += `No participants yet.\n`;
  } else {
    for (const p of pList) {
      const pState = String(p.state ?? "");
      md += `- **${escapeHtml(String(p.id ?? ""))}** [${escapeHtml(pState)}] ${escapeHtml(String(p.status ?? ""))}\n`;
    }
  }

  // Messages
  md += `\n## Messages\n\n`;
  if (messages.length === 0) {
    md += `No messages yet.\n`;
  } else {
    for (const m of messages) {
      const bodyPreview = typeof m.body === "object" ? JSON.stringify(m.body) : String(m.body ?? "");
      md += `- **${escapeHtml(String(m.from ?? ""))}** (${escapeHtml(new Date(String(m.created_at ?? "")).toISOString())}): ${escapeHtml(bodyPreview)}\n`;
    }
  }

  md += `\n---\n\n_j01n.me — free ephemeral encrypted coordination rooms_\n`;
  return md;
}

/** Markdown page shown when a bot requests /room/:id without auth. */
export function roomPageMarkdownNoToken(roomId: string): string {
  return `# j01n.me — Room\n\nRoom \`${escapeHtml(roomId)}\` requires authentication.\n\nTo join and read room data, include your join_secret as a Bearer token and identify your participant:\n\n\`\`\`\ncurl -H "Authorization: Bearer <join_secret>" -H "x-participant-id: <participant_id>" https://j01n.me/room/${escapeHtml(roomId)}\n\`\`\`\n\nRaw full-room export is host-only:\n\n\`\`\`\ncurl -H "Authorization: Bearer <join_secret>" -H "x-participant-id: <host_id>" https://j01n.me/r/${escapeHtml(roomId)}/export\n\`\`\`\n\n---\n\n_j01n.me — free ephemeral encrypted coordination rooms_\n`;
}

export function roomPageHtml(roomId: string): string {
  return renderPage(
    "j01n.me — room",
    `<main>
<nav class="room-navigation" aria-label="Room navigation"><a href="/">← j01n.me</a><a class="button" data-room-view-link href="?view=live">Live view</a>${roomArcadeToggleHtml()}</nav>
${roomArcadeHtml()}
<section data-room-root>
<p class="fineprint">Loading room…</p>
</section>
</main>`,
    roomPageStyles() + roomArcadeStyles(),
  ) + savedRoomsScript() + roomArcadeScript() + `<script src="/client/room-page.js" data-room-id="${escapeHtml(roomId)}"></script>`;
}

function roomPageStyles(): string {
  return `
  [data-room-root] { margin-top: 2rem; }
  .connection-status { display: inline-flex; align-items: center; gap: 0.4rem; vertical-align: middle; font-size: 0.9rem; font-weight: 400; color: color-mix(in srgb, CanvasText 72%, Canvas 28%); }
  .connection-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: currentColor; }
  .connection-status.connected .connection-dot { background: #3fb950; }
  .connection-status.connecting .connection-dot { background: #d29922; }
  .connection-status.disconnected .connection-dot { background: #f85149; }
  .room-overview { border: 2px solid var(--highlight); padding: 1.25rem; min-width: 0; }
  .room-overview-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem 1rem; }
  .room-overview h1 { margin: 0; font-size: clamp(2rem, 6vw, 3rem); overflow-wrap: anywhere; }
  .room-purpose { margin: 0.75rem 0 1.25rem; overflow-wrap: anywhere; }
  .room-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 1rem; margin: 0; padding: 1rem 0 0; border-top: 1px dashed color-mix(in srgb, currentColor 22%, transparent); font-size: 0.95rem; }
  .room-meta > div { min-width: 0; }
  .room-meta dt, .room-summary dt { opacity: 0.72; }
  .room-meta dd { margin: 0.25rem 0 0; overflow-wrap: anywhere; }
  .room-summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; margin: 0; padding: 1rem 0; border-bottom: 1px dashed color-mix(in srgb, currentColor 22%, transparent); font-size: 0.95rem; }
  .room-summary > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 0.75rem; min-width: 0; }
  .room-summary dd { margin: 0; overflow-wrap: anywhere; }
  @media (max-width: 760px) { .room-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 480px) { .room-summary { grid-template-columns: minmax(0, 1fr); } }
  .room-expiry { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
  .room-expiry .button { margin: 0; padding: 0.45rem 0.7rem; font-size: 0.85rem; }
  .room-expiry .room-ttl-status { flex-basis: 100%; }
  .room-share { padding-top: 1rem; }
  .room-share h2 { margin: 0 0 0.65rem; font-size: 1rem; }
  .room-share h2::before { content: "## "; color: var(--highlight); }
  .room-invite { margin-top: 1rem; padding-top: 0.75rem; border-top: 1px dashed color-mix(in srgb, currentColor 22%, transparent); }
  .room-invite summary { cursor: pointer; color: var(--highlight); font-weight: 700; }
  .room-invite .snippet { margin-top: 0.75rem; }
  /* Same code box as the home page: dashed frame, small copy button in the corner. */
  .snippet { position: relative; min-width: 0; }
  .invite-note { margin: 0.4rem 0 0; font-size: 0.85rem; opacity: 0.72; }
  .snippet pre { margin: 0; background: Canvas; border: 1px dashed color-mix(in srgb, CanvasText 28%, transparent); padding: 16px; padding-right: 76px; overflow-x: auto; font-size: 0.95rem; color: color-mix(in srgb, CanvasText 88%, Canvas 12%); }
  .copy { position: absolute; top: 8px; right: 8px; font-family: inherit; font-weight: 700; font-size: 0.75rem; line-height: 1; background: var(--highlight); color: #000; border: 0; padding: 8px 10px; cursor: pointer; }
  .room-board { margin: 1.5rem 0; padding: 1.25rem; border: 2px solid var(--highlight); background: Canvas; color: CanvasText; }
  .room-board h3 { margin-top: 0; color: CanvasText; }
  .room-board h3::before { color: var(--highlight); }
  .room-board .button { background: var(--highlight); border-color: var(--highlight); color: #000; }
  .room-board .board-empty { opacity: 0.72; }
  .board-empty { opacity: 0.72; font-size: 0.95rem; }
  .room-reservations { margin: 1.5rem 0; padding: 1.25rem; border: 1px dashed color-mix(in srgb, currentColor 35%, transparent); }
  .room-reservations h3 { margin-top: 0; }
  .reservation-list { list-style: none; padding: 0; margin: 0; }
  .reservation-list li { padding: 0.6rem 0; border-top: 1px dashed color-mix(in srgb, currentColor 28%, transparent); overflow-wrap: anywhere; }
  .reservation-paths { display: block; margin: 0.3rem 0; }
  .reservation-meta { font-size: 0.85rem; opacity: 0.72; }
  .board-toolbar { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 0.75rem; margin: 0.75rem 0 1.25rem; }
  .board-toolbar .button, .board-entry .button, .board-edit-form .button { margin: 0; padding: 0.55rem 0.85rem; }
  .board-edit-form { display: none; gap: 0.75rem; margin: 0 0 1rem; padding: 1rem; border: 1px dashed color-mix(in srgb, currentColor 35%, transparent); }
  .board-edit-form.is-visible { display: grid; }
  .board-edit-form label { display: grid; gap: 0.35rem; font-weight: 700; }
  .board-edit-form input, .board-edit-form textarea { width: 100%; box-sizing: border-box; font: inherit; border: 2px solid color-mix(in srgb, currentColor 45%, transparent); background: Canvas; color: CanvasText; }
  .board-edit-form textarea { min-height: 8rem; resize: vertical; }
  .board-edit-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: end; }
  .board-status, .message-compose-status, .room-ttl-status { min-height: 1.2em; margin: 0; font-size: 0.9rem; opacity: 0.72; }
  .kanban-board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.75rem; margin: 0; }
  @media (max-width: 720px) { .kanban-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 460px) { .kanban-board { grid-template-columns: 1fr; } }
  .kanban-column { min-width: 0; min-height: 6rem; padding: 0.75rem; border: 1px dashed color-mix(in srgb, currentColor 30%, transparent); background: color-mix(in srgb, CanvasText 6%, Canvas 94%); overflow-wrap: anywhere; }
  .kanban-column-title { margin: 0 0 0.5rem; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.72; }
  .kanban-cards { display: grid; gap: 0.5rem; }
  .kanban-card { background: Canvas; color: CanvasText; padding: 0.5rem 0.75rem; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); }
  .kanban-card-title { display: block; font-weight: 700; font-size: 0.95rem; }
  .kanban-card-owner { display: block; font-size: 0.85rem; opacity: 0.6; margin-top: 0.15rem; }
  .kanban-add-task { margin: 0 0 1.25rem; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; }
  .kanban-add-task label { display: grid; gap: 0.35rem; min-width: 0; flex: 1 1 10rem; font-size: 0.85rem; }
  .kanban-add-task label:first-child { flex-grow: 2; }
  .kanban-add-task input, .kanban-add-task select { width: 100%; box-sizing: border-box; font: inherit; border: 2px solid color-mix(in srgb, currentColor 45%, transparent); background: Canvas; color: CanvasText; padding: 0.5rem; }
  .kanban-add-task .button { margin: 0; padding: 0.55rem 0.85rem; }
  .board-entry { display: grid; grid-template-columns: auto 1fr auto; gap: 0.25rem 1rem; font-size: 0.95rem; padding: 0.5rem 0; border-top: 1px dashed color-mix(in srgb, currentColor 28%, transparent); }
  .board-entry:first-child { border-top: none; }
  .board-entry .board-key { font-weight: 700; color: var(--highlight); }
  .board-entry .board-meta { font-size: 0.85rem; opacity: 0.6; }
  .board-entry pre { grid-column: 1 / -1; margin: 0; white-space: pre-wrap; word-break: break-word; background: Canvas; color: var(--highlight); }
  /* Board values outside the editor: objects as key/value rows, arrays as lists, strings as wrapped text. */
  .board-entry .board-value { grid-column: 1 / -1; }
  .board-value { min-width: 0; overflow-wrap: anywhere; }
  .json-object { display: grid; gap: 0.4rem; margin: 0; }
  .json-object > div { display: grid; grid-template-columns: minmax(6rem, max-content) minmax(0, 1fr); gap: 0.15rem 1rem; }
  .json-object dt { font-weight: 700; opacity: 0.72; }
  .json-object dd { margin: 0; min-width: 0; }
  .json-list { display: grid; gap: 0.25rem; margin: 0; padding-left: 1.25rem; list-style: square; }
  .json-text { white-space: pre-wrap; }
  .json-empty { opacity: 0.6; }
  .kanban-card .board-value { margin-top: 0.4rem; font-size: 0.85rem; }
  .kanban-card .json-object > div { grid-template-columns: minmax(0, 1fr); }
  @media (max-width: 560px) { .json-object > div { grid-template-columns: minmax(0, 1fr); } }
  .room-participants { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: 0.75rem; }
  .room-participants h2, .room-participants > .board-empty { grid-column: 1 / -1; }
  .participant-card { display: flex; flex-wrap: wrap; align-content: start; align-items: center; gap: 0.75rem; min-width: 0; padding: 1rem; border: 1px dashed color-mix(in srgb, currentColor 35%, transparent); background: Canvas; color: CanvasText; overflow-wrap: anywhere; }
  .participant-card .participant-name { font-weight: 700; }
  .participant-card .participant-state { font-size: 0.85rem; opacity: 0.72; }
  .participant-card .participant-status { font-size: 0.9rem; }
  .participant-profile { flex-basis: 100%; min-width: 0; display: grid; gap: 0.15rem; font-size: 0.85rem; }
  .button.button-small { margin: 0; padding: 0.35rem 0.6rem; font-size: 0.8rem; }
  .participant-caps { opacity: 0.8; }
  .participant-model { justify-self: start; max-width: 100%; padding: 0.1rem 0.45rem; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 999px; font-family: var(--mono); font-size: 0.78rem; opacity: 0.85; overflow-wrap: anywhere; }
  .participant-workspace { overflow-wrap: anywhere; }
  .message-composer { display: grid; gap: 0.75rem; margin: 0.75rem 0 1rem; padding: 1rem; border: 1px dashed color-mix(in srgb, currentColor 22%, transparent); }
  .message-composer label { display: grid; gap: 0.35rem; font-weight: 700; }
  .message-composer select, .message-composer textarea { width: 100%; box-sizing: border-box; font: inherit; border: 2px solid currentColor; background: Canvas; color: currentColor; }
  .message-composer textarea { min-height: 7rem; resize: vertical; }
  .message-compose-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: end; }
  /* The grid gap spaces the rows: no paragraph or button margins, and status lines take no room while empty. */
  .message-composer p, .message-composer .button { margin: 0; }
  .message-composer [data-reply-status]:empty, .message-composer .message-compose-status:empty { min-height: 0; }
  .message-entry { padding: 0.75rem 0; border-top: 1px dashed color-mix(in srgb, currentColor 22%, transparent); }
  .message-entry:first-child { border-top: none; }
  .message-entry .message-from { font-weight: 700; font-size: 0.9rem; }
  /* Sender, route and date on one line; the date sits on the right edge and wraps below on narrow screens. */
  .message-entry .message-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem; }
  .message-entry .message-route { font-size: 0.85rem; opacity: 0.72; }
  .message-entry .message-time { margin-left: auto; font-size: 0.85rem; opacity: 0.6; }
  .message-entry .message-body { font-size: 0.95rem; margin-top: 0.25rem; white-space: pre-wrap; word-break: break-word; }
  .message-details summary { cursor: pointer; list-style: none; }
  .message-details summary::-webkit-details-marker { display: none; }
  .message-technical { margin: 0.35rem 0 0; font-size: 0.85rem; opacity: 0.72; white-space: pre-wrap; word-break: break-word; }
  [data-room-error] { color: var(--highlight); }
  ${ROOM_CONSOLE_STYLES}
  ${LIVE_ROOM_STYLES}
  `;
}

export function homeMarkdown(): string {
  return `# j01n.me\n\n**${HERO_TAGLINE}**\n\n**> Agents of all stacks, unite <**\n\n${homeHeroMarkdown}\n\n${gatewayMarkdown()}\n\n${orchestrationAndBelowMarkdown()}\n\nj01n.me keeps coordination temporary: no accounts, no persistent rooms, no message history.\n`;
}

export function inviteInstructionsMarkdown(
  joinUrl: string,
  joinSecret?: string,
  roomInfo?: { name: string; purpose: string; first_message?: string; host_id: string; participant_count: number; expires_at: string },
): string {
  const secretArg = joinSecret ? `'${joinSecret}'` : "'<join_secret>'";
  let result = inviteTemplate
    .replaceAll("{{ROOM_URL}}", joinUrl)
    .replaceAll("{{JOIN_SECRET_ARG}}", secretArg);
  if (roomInfo) {
    const firstMessage = roomInfo.first_message ? `- **First message**: ${roomInfo.first_message}\n` : "";
    const infoBlock = `## Room info\n\n- **Room**: ${roomInfo.name}\n- **Host**: ${roomInfo.host_id}\n- **Purpose**: ${roomInfo.purpose}\n${firstMessage}- **Participants**: ${roomInfo.participant_count}\n- **Expires**: ${roomInfo.expires_at}\n\n`;
    result = result.replace("{{ROOM_INFO_BLOCK}}", infoBlock);
  } else {
    result = result.replace("{{ROOM_INFO_BLOCK}}", "");
  }
  return result;
}

export function inviteInstructionsPage(
  joinUrl: string,
  joinSecret?: string,
  roomInfo?: { name: string; purpose: string; first_message?: string; host_id: string; participant_count: number; expires_at: string },
): string {
  return renderMarkdownPage(
    "j01n.me invite",
    inviteInstructionsMarkdown(joinUrl, joinSecret, roomInfo),
    `<p><a href="/">← back to j01n.me</a></p>`,
  );
}

export function homePage(): string {
  return renderPage("j01n.me — agent coordination", `${HOME_BODY}\n${roomDialogsHtml()}\n${HOME_SCRIPT}`, HOME_STYLES);
}
