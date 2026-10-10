// Room arcade: an optional pixel-art view of the room (players, their state, the board) drawn on a canvas.
// It reads the room page's snapshot through window.j01nArcade.update(); it has no data access of its own.

export function roomArcadeHtml(): string {
  return `<section id="room-arcade" class="room-arcade" aria-label="Room arcade" hidden>
<div class="arcade-frame"><canvas width="384" height="216" role="img" aria-label="Room arcade"></canvas><button class="arcade-close" type="button" data-arcade-close aria-label="Close arcade" title="Close arcade (Esc)"></button></div>
</section>`;
}

export function roomArcadeToggleHtml(): string {
  return `<button class="arcade-toggle" type="button" data-arcade-open aria-controls="room-arcade" aria-expanded="false" hidden>▶ ARCADE</button>`;
}

export function roomArcadeStyles(): string {
  return `
  .room-nav { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .arcade-toggle { font: 700 0.85rem/1 var(--body, ui-monospace, monospace); letter-spacing: 0.08em; background: #121212; color: #fdedcc; border: 1px solid #6e6656; padding: 0.5rem 0.75rem; cursor: pointer; }
  .arcade-toggle[aria-expanded="true"] { background: #fdedcc; color: #121212; }
  .arcade-toggle[hidden], .room-arcade[hidden] { display: none; }
  .room-arcade { margin: 1rem 0 1.5rem; }
  .arcade-frame { position: relative; width: fit-content; max-width: 100%; margin: 0 auto; border: 2px solid #b3a88f; background: #121212; box-shadow: 0 0 0 6px #121212, 0 0 0 7px #3a352c; line-height: 0; }
  .arcade-frame canvas { display: block; max-width: 100%; height: auto; image-rendering: pixelated; image-rendering: crisp-edges; }
  /* CRT: one dark line per canvas pixel row, plus a soft vignette. --px is the on-screen size of one pixel. */
  .arcade-frame::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(transparent 50%, rgba(0, 0, 0, 0.22) 50%) 0 0 / 100% var(--px, 2px),
      radial-gradient(ellipse at center, transparent 62%, rgba(0, 0, 0, 0.45) 100%); }
  .arcade-close { position: absolute; z-index: 1; top: 0; right: 0; width: calc(100% * 16 / 384); height: calc(100% * 16 / 216); padding: 0; border: 0; background: transparent; cursor: pointer; }
  .arcade-close:focus-visible { outline: 2px solid #fdedcc; outline-offset: -2px; }
  `;
}

export function roomArcadeScript(): string {
  return `<script>${ARCADE_JS}</script>`;
}

// Plain browser JS. No backticks or dollar-brace in here: it sits inside a template literal.
const ARCADE_JS = String.raw`
(() => {
  const W = 384, H = 216, KEY = "j01n-arcade";
  // One hue, five shades: background, shadow, dim, mid, bright.
  const PAL = ["#121212", "#3a352c", "#6e6656", "#b3a88f", "#fdedcc"];
  // 5x7 bitmap font: 7 rows per glyph, each row a base-32 digit whose 5 bits are the pixels, left to right.
  const FONT = {
    A: "ehhvhhh", B: "uhhuhhu", C: "ehggghe", D: "sihhhis", E: "vgguggv", F: "vgguggg", G: "ehgnhhf",
    H: "hhhvhhh", I: "e44444e", J: "72222ic", K: "hikokih", L: "ggggggv", M: "hrllhhh", N: "hhpljhh",
    O: "ehhhhhe", P: "uhhuggg", Q: "ehhhlid", R: "uhhukih", S: "fgge11u", T: "v444444", U: "hhhhhhe",
    V: "hhhhha4", W: "hhhllla", X: "hha4ahh", Y: "hha4444", Z: "v1248gv",
    "0": "ehjlphe", "1": "4c4444e", "2": "eh1248v", "3": "v2421he", "4": "26aiv22", "5": "vgu11he",
    "6": "68guhhe", "7": "v124888", "8": "ehhehhe", "9": "ehhf12c",
    " ": "0000000", ":": "0cc0cc0", ".": "00000cc", ",": "0000c48", "-": "000e000", "+": "044v440",
    "/": "11248gg", "!": "4444404", "?": "eh12404", "_": "000000v", "(": "2488842", ")": "8422248",
    "'": "4480000", "#": "aavavaa", "@": "eh1dlle", "%": "op248j3", "*": "04lel40", "=": "00v0v00",
    ">": "8421248", "<": "248g842", "[": "e88888e", "]": "e22222e", "&": "cik8lid", '"': "aaa0000",
  };
  // Sprites: one character per pixel, a digit is a shade, "." is transparent.
  // e = human eye (dark, skin when closed), f = robot eye (bright, dark when closed), S = cabinet screen.
  const HEADS = [
    ["....222222....", "...22222222...", "..2222222222..", "..2224444222..", "..2444444442..", "..24e4444e42..", "..2444444442..", "...44444444...", "....444444...."],
    ["..2..2..2..2..", "..2222222222..", "..2222222222..", "..2442442442..", "..2444444442..", "..24e4444e42..", "..2444444442..", "...44444444...", "....444444...."],
    ["....222222....", "...22222222...", "..2222222222..", ".222444444222.", ".224444444422.", ".224e4444e422.", ".224444444422.", ".222444444222.", ".22..4444..22."],
    ["......22......", ".....2222.....", "...22222222...", "..2244444422..", "..2444444442..", "..24e4444e42..", "..2444444442..", "...44444444...", "....444444...."],
    ["......44......", "......33......", "..3333333333..", "..3111111113..", "..31f1111f13..", "..3111111113..", "..3311111133..", "...33333333...", "....333333...."],
  ];
  const BODY = ["...33333333...", "..3333333333..", ".333333333333.", ".333333333333.", ".333333333333."];
  const CABINET = [
    "..22222222222222..", ".2333333333333332.", "211111111111111112", "212222222222222212", "211111111111111112",
    ".1222222222222221.", ".1211111111111121.", ".121SSSSSSSSSS121.", ".121SSSSSSSSSS121.", ".121SSSSSSSSSS121.",
    ".121SSSSSSSSSS121.", ".121SSSSSSSSSS121.", ".1211111111111121.", ".1222222222222221.", ".1242424242222221.",
    ".1222222222222221.", ".1111111111111111.", "..11111111111111..",
  ];
  const CHAIR = [
    "...11111111...", "..1222222221..", "..1222222221..", "..1222222221..", "..1222222221..", "..1222222221..",
    "..1222222221..", ".112222222211.", ".121111111121.", ".122222222221.", ".111111111111.", "..1........1..",
    "..1........1..", ".11........11.",
  ];
  const CROWN = ["4..4..4", "44.4.44", "4444444", "4444444"];
  const BUBBLE = [".4444444.", "444444444", "444444444", "444444444", ".4444444.", ".44......", ".4......."];
  const ENVELOPE = ["444444444", "44.....44", "4.4...4.4", "4..4.4..4", "4...4...4", "4.......4", "444444444"];
  const ARROW = ["4...", "44..", "444.", "4444", "444.", "44..", "4..."];
  const ZED = ["444", "..4", ".4.", "444"];
  const COLS = [["todo", "TODO", 2], ["doing", "DOING", 3], ["review", "REVIEW", 3], ["done", "DONE", 4]];

  const section = document.getElementById("room-arcade");
  const toggle = document.querySelector("[data-arcade-open]");
  const canvas = section && section.querySelector("canvas");
  if (!section || !toggle || !canvas) return;
  const frameEl = section.querySelector(".arcade-frame");
  const closeButton = section.querySelector("[data-arcade-close]");
  const ctx = canvas.getContext("2d");
  const reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  let view = null;      // what the arcade draws, derived from the room snapshot
  let live = "connecting";
  let banners = [];     // [{ text, start }]
  let doneFlashAt = 0, mailAt = 0;
  let running = false, lastFrame = 0, ready = false;

  function px(x, y, w, h, shade) { ctx.fillStyle = PAL[shade]; ctx.fillRect(x, y, w, h); }
  function sprite(rows, x, y, dim, map, k = 1) {
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        let ch = rows[r][c];
        if (map && ch in map) ch = map[ch];
        if (ch !== ".") px(x + c * k, y + r * k, k, k, Math.max(1, Number(ch) - dim));
      }
    }
  }
  function clean(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[^ -~]/g, "").toUpperCase(); }
  function textW(s) { return s.length ? s.length * 6 - 1 : 0; }
  function fit(s, w) { const n = Math.floor((w + 1) / 6); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "." : s; }
  function text(s, x, y, shade) {
    for (const ch of s) {
      const g = FONT[ch];
      if (g) for (let r = 0; r < 7; r++) {
        const bits = parseInt(g[r], 32);
        for (let c = 0; c < 5; c++) if (bits & (16 >> c)) px(x + c, y + r, 1, 1, shade);
      }
      x += 6;
    }
  }
  function textC(s, cx, y, shade) { text(s, Math.round(cx - textW(s) / 2), y, shade); }
  function hash(s) { let h = 5381; for (const ch of String(s)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return h; }
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function isStale(p) { return Date.now() - Date.parse(p.last_seen_at || p.joined_at || "") > 5 * 60000; }

  function deriveView(snap, selfId, extract) {
    const ex = typeof extract === "function" ? extract : (v) => v;
    const all = Object.values(snap.participants || {});
    const players = all.filter((p) => !p.left_at).concat(all.filter((p) => p.left_at));
    const board = snap.board || {};
    const columns = ex(board.columns && board.columns.value);
    let kanban = null;
    if (columns && typeof columns === "object" && !Array.isArray(columns) && COLS.some((c) => c[0] in columns)) {
      const tasks = ex(board.tasks && board.tasks.value) || {};
      const cols = COLS.map(([key, label, shade]) => {
        const ids = Array.isArray(columns[key]) ? columns[key] : [];
        const owners = ids.map((id) => { const t = tasks[id]; return t && typeof t === "object" && t.owner ? clean(t.owner).charAt(0) : ""; });
        return { key, label, shade, ids, owners };
      });
      const total = cols.reduce((n, c) => n + c.ids.length, 0);
      kanban = { cols, done: cols[3].ids.length, total };
    }
    const keys = Object.keys(board);
    const lastEntry = keys.map((k) => board[k]).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    return {
      room: snap.room || {}, phase: snap.phase || "", expiresAt: snap.expires_at || "", self: selfId,
      players, kanban, keys, lastBy: lastEntry ? lastEntry.updated_by : "", messages: (snap.messages || []).length,
    };
  }

  function announce(prev, next) {
    const now = Date.now();
    const before = Object.fromEntries(prev.players.map((p) => [p.id, p]));
    for (const p of next.players) {
      const was = before[p.id];
      if (!was && !p.left_at) banners.push({ text: "PLAYER ENTERED: " + clean(p.id), start: 0 });
      else if (was && !was.left_at && p.left_at) banners.push({ text: clean(p.id) + ": GAME OVER", start: 0 });
    }
    if (prev.kanban && next.kanban && next.kanban.done > prev.kanban.done) doneFlashAt = now;
    if (next.messages > prev.messages) mailAt = now;
  }

  function drawTop(now, t) {
    const v = view;
    px(367, 0, 1, 16, 2);
    text("X", 373, 5, 4);
    let ttl = "--:--";
    const left = Date.parse(v.expiresAt) - now;
    if (left > 0) {
      const s = Math.floor(left / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      ttl = h >= 24 ? Math.floor(h / 24) + "D" : h > 0 ? h + ":" + pad2(m) + ":" + pad2(s % 60) : pad2(m) + ":" + pad2(s % 60);
    }
    ttl = "TTL " + ttl;
    const ttlX = 361 - textW(ttl);
    text(ttl, ttlX, 5, 4);
    const label = live === "connected" ? "LIVE" : live === "connecting" ? "WAIT" : "OFF";
    const liveShade = live === "connected" ? 4 : 2;
    const labelX = ttlX - 12 - textW(label);
    text(label, labelX, 5, liveShade);
    if (live !== "connected" || Math.floor(t / 600) % 2 === 0) px(labelX - 6, 7, 3, 3, liveShade);
    const mailHot = now - mailAt < 4000;
    sprite(ENVELOPE, labelX - 19, 5, mailHot && Math.floor(t / 250) % 2 === 0 ? 0 : 2);
    const phase = "PHASE:" + (clean(v.phase) || "-");
    const phaseX = Math.round(192 - textW(phase) / 2);
    text(phase, phaseX, 5, 4);
    text(fit("J01N " + clean(v.room.name || "ROOM"), phaseX - 16), 5, 5, 4);
    px(0, 16, W, 1, 2);
  }

  // A seat is 42px wide; k is the sprite scale (2 for up to five players, 1 for more).
  function drawSeat(p, x, y, t, k) {
    const ox = x + 21 - 9 * k;   // cabinet left edge; the 14px character sits 2 sprite pixels in
    const cx = ox + 2 * k;
    const nameY = y + 39 * k + 4;
    if (p.left_at) {
      sprite(CHAIR, cx, y + 20 * k, 0, null, k);
      textC("GAME", x + 21, nameY - 2, 2);
      textC("OVER", x + 21, nameY + 7, 2);
      return;
    }
    const stale = isStale(p);
    const busy = p.state === "busy" && !stale;
    const dim = stale ? 1 : 0;
    const h = hash(p.id);
    const head = HEADS[h % HEADS.length];
    const frame = Math.floor(t / 150);
    const closed = stale || (!reduceMotion && (Math.floor(t / 100) + h) % 37 === 0);
    sprite(head.concat(BODY), cx, y + 10 * k, dim, closed ? { e: "4", f: "1" } : { e: "1", f: "4" }, k);
    // Cabinet in front; its screen glows while the player works.
    sprite(CABINET, ox, y + 21 * k, dim, { S: busy ? "3" : stale ? "1" : "2" }, k);
    if (busy) {
      for (let i = 0; i < 10; i++) px(ox + (4 + i) * k, y + (30 + Math.round(Math.sin((i + frame) * 0.9) * 1.6)) * k, k, k, 4);
    } else if (!stale) {
      px(ox + 4 * k, y + 30 * k, 10 * k, k, 3);
    }
    const tap = busy && !reduceMotion ? frame % 2 : 0;
    px(ox + 4 * k, y + (20 + tap) * k, 3 * k, 2 * k, 4 - dim);
    px(ox + 11 * k, y + (20 + (busy && !reduceMotion ? 1 - tap : 0)) * k, 3 * k, 2 * k, 4 - dim);
    const isHost = p.id === view.room.host_id;
    if (isHost) sprite(CROWN, cx + 4 * k, y + 5 * k, dim, null, k);
    if (p.id === view.self && Math.floor(t / 500) % 2 === 0) text("1UP", cx + 7 * k - 13, y + (isHost ? 5 : 10) * k - 9, 4); // left of centre, clear of the bubble
    if (busy) {
      // At 2x the bubble tucks in over the head so the last seat stays clear of the board divider.
      const bx = cx + (k === 2 ? 9 : 13) * k, by = k === 2 ? y - 4 : y;
      sprite(BUBBLE, bx, by, 0, null, k);
      const dots = reduceMotion ? 3 : 1 + (Math.floor(t / 300) % 3);
      for (let d = 0; d < dots; d++) px(bx + (2 + d * 2) * k, by + 2 * k, k, k, 1);
    }
    if (stale) {
      const lift = reduceMotion ? 0 : Math.floor(t / 400) % 4;
      sprite(ZED, cx + 13 * k, y + (4 - lift) * k, 1, null, k);
      sprite(ZED, cx + 17 * k, y - lift * k, 0, null, k);
    }
    textC(fit(clean(p.id), 41), x + 21, nameY, busy ? 4 : stale ? 2 : 3);
  }

  function drawPlayers(t) {
    for (let gy = 28; gy < 181; gy += 12) for (let gx = 11; gx < 215; gx += 12) px(gx, gy, 1, 1, 1);
    const list = view.players;
    if (!list.length) {
      if (Math.floor(t / 600) % 2 === 0) textC("WAITING FOR PLAYERS", 107, 95, 3);
      return;
    }
    const seats = list.length > 10 ? list.slice(0, 9) : list;
    const count = seats.length + (list.length > 10 ? 1 : 0);
    const rows = count > 5 ? 2 : 1;
    const k = rows === 1 ? 2 : 1;
    const seatH = 39 * k + 20;
    const top = 17 + Math.floor((164 - (rows * seatH + (rows - 1) * 2)) / 2);
    for (let i = 0; i < count; i++) {
      const row = i < 5 ? 0 : 1;
      const inRow = row === 0 ? Math.min(5, count) : count - 5;
      const x = Math.floor((215 - inRow * 42) / 2) + (i - row * 5) * 42;
      const y = top + row * (seatH + 2);
      if (i < seats.length) drawSeat(seats[i], x, y, t, k);
      else textC("+" + (list.length - 9), x + 21, y + 20 * k, 3);
    }
  }

  function drawBoard(now, t) {
    const X = 216;
    px(215, 17, 1, 165, 2);
    const k = view.kanban;
    if (k) {
      k.cols.forEach((col, i) => {
        const cx = X + i * 42;
        textC(col.label, cx + 21, 24, 3);
        if (i > 0) px(cx, 38, 1, 116, 2);
        const shown = Math.min(col.ids.length, 8);
        for (let j = 0; j < shown; j++) {
          const by = 152 - (j + 1) * 13 + 1;
          let shade = col.shade;
          const flashing = col.key === "done" && j === shown - 1 && now - doneFlashAt < 1200;
          if (flashing && !reduceMotion && Math.floor((now - doneFlashAt) / 150) % 2) shade = 2;
          px(cx + 6, by, 30, 12, shade);
          px(cx + 6, by, 30, 1, Math.min(4, shade + 1));
          px(cx + 6, by + 11, 30, 1, Math.max(1, shade - 1));
          if (col.key === "doing" && col.owners[j]) text(col.owners[j], cx + 19, by + 3, 1);
          if (flashing) textC("+1", cx + 21, by - 10 - (reduceMotion ? 0 : Math.floor((now - doneFlashAt) / 120)), 4);
        }
        if (col.ids.length > 8) textC("+" + (col.ids.length - 8), cx + 21, 39, 3);
      });
      textC("SCORE " + pad2(k.done) + "/" + pad2(k.total), X + 84, 166, 4);
    } else if (view.keys.length) {
      text("INVENTORY", X + 8, 24, 3);
      const shown = view.keys.slice(0, 11);
      shown.forEach((key, i) => {
        const y = 38 + i * 10;
        px(X + 10, y + 1, 1, 5, 3); px(X + 9, y + 2, 3, 3, 3); px(X + 8, y + 3, 5, 1, 3);
        text(fit(clean(key), 144), X + 17, y, 4);
      });
      if (view.keys.length > shown.length) text("+" + (view.keys.length - shown.length) + " MORE", X + 17, 38 + shown.length * 10, 2);
      if (view.lastBy) text(fit("UPD BY " + clean(view.lastBy), 152), X + 8, 166, 2);
    } else if (Math.floor(t / 600) % 2 === 0) {
      textC("INSERT TASKS", X + 84, 95, 3);
    }
  }

  function drawBanner(now) {
    px(0, 182, W, 1, 2);
    while (banners.length && banners[0].start && now - banners[0].start > 2600) banners.shift();
    if (!banners.length) return;
    const b = banners[0];
    if (!b.start) b.start = now;
    const slide = reduceMotion ? 0 : Math.max(0, 1 - (now - b.start) / 300);
    px(0, 183, W, 12, 4);
    text(fit(b.text, W - 8), Math.round((W - textW(b.text)) / 2 + slide * W), 186, 0);
  }

  function drawTicker(t) {
    px(0, 195, W, 1, 2);
    sprite(ARROW, 6, 203, 1);
    const items = view.players.filter((p) => !p.left_at && p.status)
      .sort((a, b) => (b.state === "busy") - (a.state === "busy"))
      .map((p) => clean(p.id) + ": " + clean(p.status));
    if (!items.length) { text("NO STATUS YET", 14, 203, 2); return; }
    const line = items.join("   +   ");
    const room = W - 18;
    if (reduceMotion || textW(line) <= room) { text(fit(line, room), 14, 203, 3); return; }
    const loop = textW(line) + 40;
    const offset = Math.floor(t / 40) % loop;
    ctx.save();
    ctx.beginPath(); ctx.rect(14, 196, room, 20); ctx.clip();
    text(line, 14 - offset, 203, 3);
    text(line, 14 - offset + loop, 203, 3);
    ctx.restore();
  }

  function draw() {
    const now = Date.now();
    const t = reduceMotion ? 0 : now;
    px(0, 0, W, H, 0);
    if (!view) { textC("LOADING...", W / 2, 104, 3); return; }
    drawTop(now, t);
    drawPlayers(t);
    drawBoard(now, t);
    drawBanner(now);
    drawTicker(t);
  }

  function tick(stamp) {
    if (!running) return;
    requestAnimationFrame(tick);
    if (stamp - lastFrame < (reduceMotion ? 1000 : 100)) return;
    lastFrame = stamp;
    draw();
  }
  function start() {
    if (running || section.hidden || document.hidden) return;
    running = true;
    requestAnimationFrame(tick);
  }
  function stop() { running = false; }

  // Scaling by whole device pixels keeps every pixel the same size (on a 2x screen that allows 1.5x steps);
  // narrower than one device pixel per pixel, it simply shrinks.
  function fitScale() {
    const avail = section.clientWidth - 4;
    const dpr = window.devicePixelRatio || 1;
    const devicePixels = Math.min(6, Math.floor((avail * dpr) / W));
    const scale = devicePixels >= 1 ? devicePixels / dpr : avail / W;
    canvas.style.width = W * scale + "px";
    frameEl.style.setProperty("--px", scale + "px");
  }

  function setOpen(open, remember) {
    section.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (remember) { try { localStorage.setItem(KEY, open ? "open" : "closed"); } catch {} }
    if (open) { fitScale(); draw(); start(); } else stop();
  }

  function close() { setOpen(false, true); toggle.focus(); }
  toggle.addEventListener("click", () => setOpen(section.hidden, true));
  closeButton.addEventListener("click", close);
  section.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  window.addEventListener("resize", () => { if (!section.hidden) fitScale(); });

  window.j01nArcade = {
    update(snap, selfId, extract) {
      const next = deriveView(snap || {}, String(selfId || ""), extract);
      if (view) announce(view, next);
      view = next;
      const active = next.players.filter((p) => !p.left_at);
      const k = next.kanban;
      canvas.setAttribute("aria-label", "Room arcade: " + active.length + " participants, " +
        active.filter((p) => p.state === "busy").length + " busy" + (k ? "; board " + k.done + " of " + k.total + " done" : ""));
      if (!ready) {
        // Show the toggle once the room has loaded, and reopen the arcade if the viewer left it open.
        ready = true;
        toggle.hidden = false;
        let open = false;
        try { open = localStorage.getItem(KEY) === "open"; } catch {}
        setOpen(open, false);
      } else if (!section.hidden) draw();
    },
    setLive(state) { live = state; },
  };
})();
`;
