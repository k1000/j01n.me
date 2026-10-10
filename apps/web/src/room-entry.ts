export const ROOM_ENTRY_SCRIPT = String.raw`
(() => {
  const dialog = document.getElementById("create-room-dialog");
  const form = document.getElementById("create-room-form");
  const status = dialog?.querySelector("[data-create-status]");
  const joinDialog = document.getElementById("join-room-dialog");
  const joinForm = document.getElementById("join-room-form");
  const joinStatus = joinDialog?.querySelector("[data-join-status]");
  let createdRoom;
  const open = () => { if (!createdRoom) { form?.reset(); if (status) status.textContent = ""; } dialog?.showModal(); };
  const openJoin = () => { joinForm?.reset(); if (joinStatus) joinStatus.textContent = ""; joinDialog?.showModal(); };
  document.querySelectorAll("[data-open-create-room]").forEach(button => button.addEventListener("click", open));
  document.querySelectorAll("[data-open-join-room]").forEach(button => button.addEventListener("click", openJoin));
  dialog?.querySelector("[data-close-create-room]")?.addEventListener("click", () => dialog.close());
  joinDialog?.querySelector("[data-close-join-room]")?.addEventListener("click", () => joinDialog.close());
  renderSavedRooms();

  function enterInvite(raw, targetStatus, name) {
    try {
      if (!raw.trim()) throw new Error("Paste a private invitation link or JSON first.");
      let source;
      if (raw.trim().startsWith("{")) source = JSON.parse(raw);
      else {
        const link = new URL(raw.trim(), location.origin);
        source = { access: link.origin + link.pathname, join_secret: link.hash.slice(1) };
      }
      const url = new URL(source.access || source.room_url);
      const match = url.pathname.match(/^\/(?:r|room)\/([A-Za-z0-9_-]+)\/?$/);
      if (!match || url.username || url.password || ![location.origin, "https://j01n.me"].includes(url.origin)) throw new Error("Use an invitation from this j01n.me service.");
      if (typeof source.join_secret !== "string" || !source.join_secret) throw new Error("The invitation must include a join secret.");
      const participantName = normalizeParticipantName(name);
      const saved = readSavedRooms()[match[1]];
      if (saved?.participant_token) {
        if (participantName && saved.participant_id !== participantName) throw new Error('This browser is already joined as ' + saved.participant_id + '. Resume it from Your rooms, or use a separate browser profile for another name.');
        window.location.href = '/room/' + encodeURIComponent(match[1]);
        return true;
      }
      if (source.expires_at && (!Number.isFinite(Date.parse(source.expires_at)) || Date.parse(source.expires_at) <= Date.now())) throw new Error('Invitation expired or invalid. Ask the host for a new one.');
      // An invitation must not import the sender's participant token or identity.
      const invite = { access: url.origin + "/r/" + match[1], join_secret: source.join_secret,
        ...(source.expires_at ? { expires_at: source.expires_at } : {}),
        ...(source.room_name ? { room_name: source.room_name } : {}),
        ...(participantName ? { participant_id: participantName } : {}) };
      if (!persistInvite(match[1], invite)) {
        if (targetStatus) {
          targetStatus.textContent = 'This browser could not save access. Copy this private invitation and use a browser with working storage. Do not share it publicly.';
          if (targetStatus.append) {
            const label = document.createElement('label'); label.textContent = 'Private invitation JSON';
            const copy = document.createElement('textarea'); copy.readOnly = true; copy.value = JSON.stringify(invite, null, 2); label.append(copy); targetStatus.append(label);
          } else targetStatus.textContent += '\nPrivate invitation JSON: ' + JSON.stringify(invite);
        }
        return false;
      }
      window.location.href = "/room/" + encodeURIComponent(match[1]);
      return true;
    } catch (error) {
      if (targetStatus) targetStatus.textContent = error.message;
      return false;
    }
  }

  async function postRoom(body) {
    const response = await fetch("/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "Failed to create room.");
    return json;
  }

  const mc = document.modelContext;
  if (mc && typeof mc.registerTool === "function") {
    const tools = [
      {
        name: "create_room",
        description: "Create a room with a Kanban board and enter it here as host. Returns a private invitation link for people or agents.",
        inputSchema: { type: "object", properties: { host_id: { type: "string" }, room_name: { type: "string" }, purpose: { type: "string" },
          template: { type: "string", enum: ["quick", "kanban", "milestone"] }, max_participants: { type: "integer", minimum: 2, maximum: 64 },
          invite_ttl_minutes: { type: "integer", minimum: 1, maximum: 60 } } },
        execute: async (args = {}) => {
          const name = args.host_id || "human";
          if (!createdRoom) createdRoom = { name, invite: await postRoom({ host_id: name, template: args.template || 'kanban', max_participants: args.max_participants || 7,
            invite_ttl_ms: (args.invite_ttl_minutes || 30) * 60000, room_name: args.room_name, purpose: args.purpose }) };
          const outcome = { textContent: '' };
          if (!enterInvite(JSON.stringify(createdRoom.invite), outcome, createdRoom.name)) throw new Error(outcome.textContent);
          return JSON.stringify({ invite_link: createdRoom.invite.invite_link, next: 'Opening your room console.' });
        },
      },
      {
        name: "join_room",
        description: "Open a room from a private invitation link or invitation JSON, using your own participant name.",
        inputSchema: { type: "object", properties: { invite_json: { type: "string" }, participant_id: { type: "string" } }, required: ["invite_json"] },
        execute: async ({ invite_json, participant_id }) => {
          const outcome = { textContent: "" };
          if (!enterInvite(String(invite_json || ""), outcome, participant_id)) throw new Error(outcome.textContent);
          return "Opening the room. Use read_room once it has loaded.";
        },
      },
    ];
    for (const tool of tools) try { Promise.resolve(mc.registerTool(tool)).catch(() => {}); } catch {}
  }

  form?.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    if (submit?.disabled) return;
    const data = new FormData(form);
    const name = String(data.get("host_id") || "").trim();
    if (!name) { status.textContent = "Your name is required."; return; }
    try {
      submit.disabled = true; submit.textContent = "Creating…"; status.textContent = "";
      if (!createdRoom) {
        const invite = await postRoom({ host_id: name, room_name: String(data.get("room_name") || "").trim(),
          purpose: String(data.get("purpose") || "").trim(), entry_message: String(data.get("first_message") || "").trim(),
          template: String(data.get("template") || "kanban"), max_participants: Number(data.get("max_participants")),
          invite_ttl_ms: Number(data.get("invite_ttl_ms")) });
        createdRoom = { invite, name };
        for (const control of form.elements) if (control.name) control.disabled = true;
      }
      enterInvite(JSON.stringify(createdRoom.invite), status, createdRoom.name);
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; submit.textContent = createdRoom ? 'Open created room' : 'Create room'; }
  });

  joinForm?.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(joinForm);
    enterInvite(String(data.get("invite_json") || ""), joinStatus, String(data.get("participant_name") || "").trim());
  });
})();
`;
