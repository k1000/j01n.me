import { expect, test, type Page } from "@playwright/test";
import { joinRoom, parseInviteLink } from "@j01n/sdk";
import AxeBuilder from "@axe-core/playwright";

const pageErrors: string[] = [];
test.beforeEach(({ page }) => { pageErrors.length = 0; page.on("pageerror", error => pageErrors.push(error.message)); });
test.afterEach(() => expect(pageErrors).toEqual([]));

function boardValue(entry: { value: unknown }) {
  const value = entry.value as { encrypted_payload: string };
  return typeof value.encrypted_payload === "string" ? JSON.parse(Buffer.from(value.encrypted_payload.slice(3), "base64").toString("utf8")) : entry.value;
}

async function createRoom(page: Page, name = "human-host", purpose?: string) {
  // Wrangler's local host reports http://j01n.me; the browser fixture uses its own localhost origin.
  await page.route("**/rooms", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const invite = await response.json() as { access: string; invite_link: string };
    const local = new URL(page.url()).origin;
    await route.fulfill({ response, json: { ...invite,
      access: invite.access.replace(new URL(invite.access).origin, local),
      invite_link: invite.invite_link.replace(new URL(invite.invite_link).origin, local),
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create room", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create room", exact: true });
  await dialog.getByLabel("Your name", { exact: true }).fill(name);
  await dialog.getByLabel("Room name", { exact: true }).fill("Planning room");
  if (purpose) await dialog.getByLabel("Public purpose").fill(purpose);
  await dialog.getByLabel("Kickoff").fill("Start by planning the parser work.");
  await dialog.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy invitation URL" })).toBeVisible();
  return (await page.getByRole("button", { name: "Copy invitation URL" }).getAttribute("data-copy-invitation"))!;
}

test("create opens the room as host with Kanban and a shareable private link", async ({ page }) => {
  await createRoom(page);
  await expect(page).toHaveURL(/\/room\/[^?#]+$/);
  await expect(page.getByText("Start by planning the parser work.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Planning room" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "To Do", exact: true })).toBeVisible();
  const link = page.getByRole("button", { name: "Copy invitation URL" });
  await expect(link).toHaveAttribute("data-copy-invitation", /\/room\/[^#]+#[A-Za-z0-9_-]+$/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("j01n.rooms") || "{}"));
  expect(Object.values(saved)).toEqual([expect.objectContaining({ participant_id: "human-host", participant_token: expect.any(String) })]);
});

test("navigation aligns and the overview abbreviates expiry and duplicate purpose", async ({ page }, testInfo) => {
  await createRoom(page, "human-host", "Sprint Planning room");
  await page.setViewportSize({ width: 1280, height: 900 });
  const nav = page.locator(".room-navigation");
  const live = nav.getByRole("link", { name: "Live view" });
  const arcade = nav.getByRole("button", { name: "ARCADE" });
  await expect(arcade).toBeVisible();
  const styles = await page.evaluate(() => {
    const live = document.querySelector("[data-room-view-link]")!;
    const arcade = document.querySelector("[data-arcade-open]")!;
    const a = live.getBoundingClientRect();
    const b = arcade.getBoundingClientRect();
    return {
      liveHeight: a.height, arcadeHeight: b.height, liveCenter: a.y + a.height / 2, arcadeCenter: b.y + b.height / 2,
      liveBackground: getComputedStyle(live).backgroundColor, arcadeBackground: getComputedStyle(arcade).backgroundColor,
      liveAlign: getComputedStyle(live).alignItems, arcadeAlign: getComputedStyle(arcade).alignItems,
    };
  });
  expect(styles.liveHeight).toBeGreaterThanOrEqual(44);
  expect(styles.liveHeight).toBe(styles.arcadeHeight);
  expect(styles.liveCenter).toBe(styles.arcadeCenter);
  expect(styles.liveAlign).toBe("center");
  expect(styles.arcadeAlign).toBe("center");
  expect(styles.liveBackground).not.toBe(styles.arcadeBackground);
  await expect(page.locator(".room-summary dt", { hasText: "purpose" })).toHaveCount(0);
  const expiry = page.locator(".room-summary time");
  await expect(expiry).toHaveText(/^expires in \d+ (min|h)$/);
  const exact = await expiry.getAttribute("title");
  expect(exact).toBeTruthy();
  expect(exact).toBe(new Date((await expiry.getAttribute("datetime"))!).toLocaleString());
  await expect(page.getByRole("button", { name: "Extend 30 min" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("header-1280.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(live).toBeVisible();
  expect(await live.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("header-390.png"), fullPage: true });
});

test("room console and live view follow the homepage palette and responsive border hierarchy", async ({ page }) => {
  await createRoom(page);
  // Open without a mouse click so the later keyboard-focus outline check still applies.
  await page.locator(".task-editor-toggle").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  const theme = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const overview = getComputedStyle(document.querySelector(".room-overview")!);
    const board = getComputedStyle(document.querySelector(".room-board")!);
    const reservations = getComputedStyle(document.querySelector(".room-reservations")!);
    return {
      cream: body.getPropertyValue("--console-cream").trim(),
      text: body.color,
      overviewBorder: overview.borderTopWidth,
      boardBorder: board.borderTopWidth,
      secondaryBorder: reservations.borderTopStyle,
      boardBackground: board.backgroundColor,
      taskColumns: getComputedStyle(document.querySelector(".task-editor")!).gridTemplateColumns.split(" ").length,
    };
  });
  expect(theme).toMatchObject({ cream: "#fdedcc", text: "rgb(217, 211, 199)", overviewBorder: "2px", boardBorder: "2px", secondaryBorder: "dashed", boardBackground: "rgb(29, 28, 26)", taskColumns: 2 });
  await page.getByRole("button", { name: "Add board key" }).focus();
  expect(await page.getByRole("button", { name: "Add board key" }).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("dashed");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Task title", { exact: true }).fill("Unbroken".repeat(16));
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Edit Unbroken/ })).toBeVisible();
  const mobile = await page.evaluate(() => ({
    columns: getComputedStyle(document.querySelector(".kanban-board")!).gridTemplateColumns.split(" ").length,
    taskColumns: getComputedStyle(document.querySelector(".task-editor")!).gridTemplateColumns.split(" ").length,
    fits: document.querySelector(".room-overview")!.getBoundingClientRect().right <= innerWidth,
    noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
  }));
  expect(mobile).toEqual({ columns: 1, taskColumns: 1, fits: true, noHorizontalOverflow: true });
  await page.getByRole("link", { name: "Live view" }).click();
  await expect(page.locator("body")).toHaveClass(/live-room-page/);
  expect(await page.locator(".live-grid > .live-panel").first().evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("2px");
  expect(await page.locator(".live-panel h2").first().evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");
});

test("a private link asks for your own name and saved room access survives a new tab", async ({ page, browser }) => {
  const invitation = await createRoom(page);
  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(invitation);
  await guest.getByLabel("Your name", { exact: true }).fill("human-guest");
  await guest.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(guest.getByRole("button", { name: "Copy invitation URL" })).toBeVisible();
  const roomUrl = guest.url();
  expect(new URL(roomUrl).hash).toBe("");
  const key = await guest.evaluate(() => localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith("j01n.hostKey.")) || ""));
  expect(key).not.toBeNull();
  const profile = await guest.evaluate(() => Object.values(JSON.parse(localStorage.getItem("j01n.rooms") || "{}"))[0]);
  expect(profile).toMatchObject({ participant_id: "human-guest", participant_token: expect.any(String) });
  await guest.close();
  const resumed = await context.newPage();
  await resumed.goto(roomUrl);
  await expect(resumed.getByRole("button", { name: "Copy invitation URL" })).toBeVisible();
  expect(await resumed.evaluate(() => localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith("j01n.hostKey.")) || ""))).toBe(key);
  await context.close();
});

test("humans create, assign and move tasks that an SDK agent can read", async ({ page }) => {
  const invitation = await createRoom(page);
  const agent = await joinRoom(parseInviteLink(invitation)!, "worker-agent");
  await page.getByText("New task", { exact: true }).click();
  await page.getByRole("combobox", { name: "Owner", exact: true }).selectOption("worker-agent");
  await page.getByLabel("Task title", { exact: true }).fill("Fix parser");
  await page.getByLabel("Description and acceptance criteria").fill("Handle empty input; parser tests pass.");
  await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("high");
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit Fix parser", exact: true })).toBeVisible();
  const first = await agent.board();
  const tasks = boardValue(first.board.tasks);
  const id = Object.keys(tasks)[0];
  expect(tasks[id]).toMatchObject({ title: "Fix parser", owner: "worker-agent", state: "todo", priority: "high", description: "Handle empty input; parser tests pass." });
  expect(boardValue(first.board.columns).todo).toEqual([id]);
  await page.getByRole("button", { name: "Edit Fix parser", exact: true }).click();
  await page.getByRole("combobox", { name: "Column", exact: true }).selectOption("review");
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.locator("[data-task-status]")).toHaveText("Task saved.");
  const second = await agent.board();
  expect(boardValue(second.board.tasks)[id].state).toBe("review");
  expect(boardValue(second.board.columns).review).toEqual([id]);
  expect(boardValue(second.board.columns).todo).toEqual([]);
});

test("an SDK agent's encrypted question can be answered with a linked reply", async ({ page }) => {
  const agent = await joinRoom(parseInviteLink(await createRoom(page))!, "worker-agent");
  const question = await agent.send("human-host", { text: "Approve this result?" }, { expectsReply: true });
  await expect(page.getByText("Approve this result?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reply to worker-agent", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill("Approved. Tests pass.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  const messages = await agent.read({ all: true });
  expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ from: "human-host", reply_to: question.id, body: expect.objectContaining({ text: "Approved. Tests pass." }) })]));
  expect((await agent.status()).open_asks).toEqual([]);
  await page.getByRole("combobox", { name: "Recipient", exact: true }).selectOption("worker-agent");
  await page.getByLabel("Message", { exact: true }).fill("Run parser tests?");
  await page.getByLabel("Request a reply").check();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  const request = (await agent.read({ all: true })).find(m => (m.body as { text?: string })?.text === "Run parser tests?");
  expect(request).toMatchObject({ from: "human-host", expects_reply: { due_at: expect.any(String) } });
  expect((await agent.status()).open_asks).toHaveLength(1);
});

test("live updates keep drafts and conflicting board writes require an explicit retry", async ({ page }) => {
  const agent = await joinRoom(parseInviteLink(await createRoom(page))!, "worker-agent");
  await page.getByText("New task", { exact: true }).click();
  const title = page.getByLabel("Task title", { exact: true });
  await title.fill("Human task");
  await title.focus();
  const initial = await agent.board();
  await agent.patchBoard({ tasks: { "agent-task": { title: "Agent task", state: "todo", owner: "worker-agent" } }, columns: { todo: ["agent-task"], doing: [], review: [], done: [] } }, { ifVersions: { tasks: initial.board.tasks.version!, columns: initial.board.columns.version! } });
  await expect(page.getByRole("button", { name: "Edit Agent task", exact: true })).toBeVisible();
  await expect(title).toHaveValue("Human task");
  await expect(title).toBeFocused();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.locator("[data-task-status]")).toContainText("Board changed while you were editing");
  expect(Object.keys(boardValue((await agent.board()).board.tasks))).toEqual(["agent-task"]);
  await expect(title).toHaveValue("Human task");
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit Human task", exact: true })).toBeVisible();
  expect(Object.values(boardValue((await agent.board()).board.tasks))).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Agent task" }), expect.objectContaining({ title: "Human task" })]));
  const message = page.getByLabel("Message", { exact: true });
  await message.fill("Still writing this message");
  await agent.send("all", { text: "New update while you type" });
  await expect(page.getByText("New update while you type", { exact: true })).toBeVisible();
  await expect(message).toHaveValue("Still writing this message");
  await expect(message).toBeFocused();
});

test("a new message updates only the message list, not the board or the composer", async ({ page }) => {
  const agent = await joinRoom(parseInviteLink(await createRoom(page))!, "worker-agent");
  await page.getByText("New task", { exact: true }).click();
  await page.getByLabel("Task title", { exact: true }).fill("Draft task");
  await page.getByLabel("Message", { exact: true }).fill("Draft message");
  // Mark the live DOM nodes; a section that is rebuilt loses its marker.
  await page.evaluate(() => {
    document.querySelector(".room-board")!.setAttribute("data-marker", "kept");
    document.querySelector(".room-participants")!.setAttribute("data-marker", "kept");
    document.querySelector("[data-message-form]")!.setAttribute("data-marker", "kept");
  });
  await agent.send("all", { text: "Only the list changes" });
  await expect(page.getByText("Only the list changes", { exact: true })).toBeVisible();
  expect(await page.locator('.room-board[data-marker="kept"]').count()).toBe(1);
  expect(await page.locator('[data-message-form][data-marker="kept"]').count()).toBe(1);
  await expect(page.getByLabel("Task title", { exact: true })).toHaveValue("Draft task");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Draft message");
  await page.getByRole("button", { name: "Reply to worker-agent" }).click();
  await expect(page.getByRole("combobox", { name: "Recipient", exact: true })).toHaveValue("worker-agent");
  await expect(page.locator("[data-reply-status]")).toHaveText("Replying to worker-agent");
});

test("JSON invitations cannot import another participant's token or identity", async ({ page, browser }) => {
  const invitation = await createRoom(page, "Human Host");
  await expect(page.getByRole("button", { name: "Extend 30 min" })).toBeVisible();
  const saved = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("j01n.rooms") || "{}"))[0]) as { participant_token: string };
  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto("/");
  await guest.getByRole("button", { name: "Join room", exact: true }).click();
  const dialog = guest.getByRole("dialog", { name: "Join room", exact: true });
  await dialog.getByLabel("Your name", { exact: true }).fill("New Guest");
  await dialog.getByLabel("Invitation", { exact: true }).fill(JSON.stringify({ ...parseInviteLink(invitation), participant_id: "Human-Host", participant_token: saved.participant_token }));
  await dialog.getByRole("button", { name: "Join", exact: true }).click();
  await expect(guest.getByRole("button", { name: "Copy invitation URL" })).toBeVisible();
  const profile = await guest.evaluate(() => Object.values(JSON.parse(localStorage.getItem("j01n.rooms") || "{}"))[0]) as { participant_id: string; participant_token: string };
  expect(profile.participant_id).toBe("New-Guest");
  expect(profile.participant_token).not.toBe(saved.participant_token);
  await expect(guest.getByRole("button", { name: "Extend 30 min" })).toHaveCount(0);
  await context.close();
});

test("missing saved keys cannot silently replace an existing identity", async ({ page }) => {
  const agent = await joinRoom(parseInviteLink(await createRoom(page))!, "worker-agent");
  const before = (await agent.participants()).participants.find(p => p.id === "human-host")?.public_key;
  expect(before).toBeTruthy();
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("j01n.hostKey.")) localStorage.removeItem(key); sessionStorage.clear(); });
  await page.reload();
  await expect(page.getByText(/Saved encryption key unavailable/)).toBeVisible();
  expect((await agent.participants()).participants.find(p => p.id === "human-host")?.public_key).toBe(before);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("j01n.hostKey.")))).toEqual([]);
});

test("other board keys remain visible beside Kanban and reject stale edits", async ({ page }) => {
  const agent = await joinRoom(parseInviteLink(await createRoom(page))!, "worker-agent");
  await agent.setBoardKey("decision", "Initial decision", { ifVersion: 0 });
  await expect(page.getByRole("button", { name: "Edit board key decision", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit board key decision", exact: true }).click();
  await page.getByLabel("value", { exact: true }).fill("Human decision");
  await agent.setBoardKey("decision", "Agent decision", { ifVersion: 1 });
  await expect(page.getByText("Agent decision", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-board-status]")).toContainText("Board changed");
  expect((await agent.board()).board.decision.value).toBe("Agent decision");
  await expect(page.getByLabel("value", { exact: true })).toHaveValue("Human decision");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Human decision", { exact: true })).toBeVisible();
});

test("board rows preview values, keep edits secondary and show the warning only in the form", async ({ page }, testInfo) => {
  const agent = await joinRoom(parseInviteLink(await createRoom(page))!, "worker-agent");
  await agent.setBoardKey("task.T2", { title: "Polish board rows", status: "claimed", brief: "Not shown in preview" }, { ifVersion: 0 });
  const longText = "First line\n" + "x".repeat(170);
  await agent.setBoardKey("notes", longText, { ifVersion: 0 });
  const objectRow = page.locator('[data-collapse="key:task.T2"]');
  const textRow = page.locator('[data-collapse="key:notes"]');
  await expect(objectRow.locator(".board-preview")).toHaveText("Polish board rows");
  await expect(objectRow.locator(".board-preview-state")).toHaveText("claimed");
  await expect(textRow.locator(".board-preview")).toHaveText("First line " + "x".repeat(49) + "…");
  await expect(objectRow.locator(".board-meta")).toContainText("v1 · worker-agent");
  await expect(objectRow).not.toHaveAttribute("open", "");
  await expect(page.locator(".room-board > .fineprint")).toHaveCount(0);
  const edit = page.getByRole("button", { name: "Edit board key task.T2" });
  await expect(edit).toHaveClass(/button-small/);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(edit).toBeVisible();
    const layout = await page.evaluate(() => {
      const button = document.querySelector('[data-edit-board-key="task.T2"]')!;
      const state = document.querySelector('[data-collapse="key:task.T2"] .board-preview-state')!;
      const style = getComputedStyle(button);
      return { noOverflow: document.documentElement.scrollWidth <= innerWidth, stateVisible: state.getBoundingClientRect().right <= button.getBoundingClientRect().left, height: button.getBoundingClientRect().height, background: style.backgroundColor, color: style.color };
    });
    expect(layout.noOverflow).toBe(true);
    expect(layout.stateVisible).toBe(true);
    expect(layout.height).toBeGreaterThanOrEqual(44);
    expect(layout.background).not.toBe("rgb(253, 237, 204)");
    expect(layout.color).toBe("rgb(253, 237, 204)");
    await page.screenshot({ path: testInfo.outputPath(`board-${width}.png`), fullPage: true });
  }
  await edit.click();
  await expect(page.locator("[data-board-form] .fineprint")).toHaveText("Shared with room participants, not encrypted. Do not put secrets on the board.");
  await expect(page.getByLabel("key", { exact: true })).toHaveValue("task.T2");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await objectRow.locator("summary").click();
  await expect(objectRow).toHaveAttribute("open", "");
  await expect(objectRow.locator(".board-value")).toContainText("Not shown in preview");
});

test("re-entering a saved room preserves its token, keys and identity", async ({ page }) => {
  await page.addInitScript(() => {
    const tools = new Map<string, { execute: (args: object) => Promise<string> }>();
    Object.defineProperty(document, "modelContext", { value: { registerTool(tool: { name: string; execute: (args: object) => Promise<string> }) { tools.set(tool.name, tool); } } });
    Object.defineProperty(window, "runRoomJoin", { value: (args: object) => tools.get("join_room")!.execute(args) });
  });
  const invitation = await createRoom(page);
  const before = await page.evaluate(() => ({ rooms: localStorage.getItem("j01n.rooms"), key: localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith("j01n.hostKey."))!) }));
  let rejoins = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/participants/')) rejoins++; });
  await page.goto("/");
  await page.getByRole("button", { name: "Join room", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Join room", exact: true });
  await dialog.getByLabel("Your name", { exact: true }).fill("human-host");
  await dialog.getByLabel("Invitation", { exact: true }).fill(invitation);
  await dialog.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy invitation URL" })).toBeVisible();
  await page.goto("/");
  await page.evaluate(invite => (window as unknown as { runRoomJoin: (args: object) => Promise<string> }).runRoomJoin({ invite_json: invite }), invitation);
  await expect(page.getByRole("button", { name: "Copy invitation URL" })).toBeVisible();
  const after = await page.evaluate(() => ({ rooms: localStorage.getItem("j01n.rooms"), key: localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith("j01n.hostKey."))!) }));
  expect(after.rooms === before.rooms).toBe(true);
  expect(after.key === before.key).toBe(true);
  expect(rejoins).toBe(0);
  await expect(page.getByRole("button", { name: "Extend 30 min", exact: true })).toBeVisible();
});

test("storage failure keeps a created invitation recoverable without creating twice", async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === "j01n.rooms") throw new DOMException("Storage unavailable", "QuotaExceededError"); return setItem.call(this, key, value); };
  });
  let creations = 0;
  await page.route("**/rooms", async route => { if (route.request().method() === "POST") creations++; await route.continue(); });
  await page.goto("/");
  await page.getByRole("button", { name: "Create room", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create room", exact: true });
  await dialog.getByLabel("Your name", { exact: true }).fill("human-host");
  await dialog.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:4179/");
  await expect(dialog.getByLabel("Private invitation JSON", { exact: true })).toBeVisible();
  const recovered = JSON.parse(await dialog.getByLabel("Private invitation JSON", { exact: true }).inputValue());
  expect(typeof recovered.join_secret === "string" && recovered.join_secret.length > 0).toBe(true);
  expect(recovered.participant_token).toBeUndefined();
  await dialog.getByRole("button", { name: "Open created room", exact: true }).click();
  expect(creations).toBe(1);
});

test("a private join link is not discarded when browser storage fails", async ({ page, browser }) => {
  const invitation = await createRoom(page);
  const context = await browser.newContext();
  await context.addInitScript(() => { const setItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'j01n.rooms') throw new DOMException('Storage unavailable', 'QuotaExceededError'); return setItem.call(this, key, value); }; });
  const guest = await context.newPage();
  await guest.goto(invitation);
  await expect(guest.locator('[data-room-error]')).toContainText('This browser cannot save room access');
  expect(new URL(guest.url()).hash === new URL(invitation).hash).toBe(true);
  await expect(guest.getByRole('button', { name: 'Join room', exact: true })).toHaveCount(0);
  await context.close();
});

test("editing a departed participant's task preserves its owner through live updates", async ({ page }) => {
  const invitation = await createRoom(page);
  const agent = await joinRoom(parseInviteLink(invitation)!, "worker-agent");
  const reader = await joinRoom(parseInviteLink(invitation)!, "reader-agent");
  await agent.patchBoard({ tasks: { existing: { title: "Existing task", owner: "worker-agent", state: "todo", release_ref: "keep" } }, columns: { todo: ["existing"], doing: [], review: [], done: [] } });
  await expect(page.getByRole("button", { name: "Edit Existing task", exact: true })).toBeVisible();
  await agent.leave();
  const owner = page.getByRole("combobox", { name: "Owner", exact: true });
  await expect(owner.locator('option[value="worker-agent"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Edit Existing task", exact: true }).click();
  await expect(owner).toHaveValue("worker-agent");
  await reader.send("all", { text: "Update while editing the departed owner's task" });
  await expect(page.getByText("Update while editing the departed owner's task", { exact: true })).toBeVisible();
  await expect(owner).toHaveValue("worker-agent");
  await page.getByRole("combobox", { name: "Column", exact: true }).selectOption("review");
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.locator("[data-task-status]")).toHaveText("Task saved.");
  expect(boardValue((await reader.board()).board.tasks).existing).toMatchObject({ owner: "worker-agent", state: "review", release_ref: "keep" });
});

test("editing an existing board key cannot silently rename it", async ({ page }) => {
  const agent = await joinRoom(parseInviteLink(await createRoom(page))!, "worker-agent");
  await agent.setBoardKey("decision", "Original", { ifVersion: 0 });
  await page.getByRole("button", { name: "Edit board key decision", exact: true }).click();
  await expect(page.getByLabel("key", { exact: true })).toHaveJSProperty("readOnly", true);
  await agent.send("all", { text: "Refresh the immutable key editor" });
  await expect(page.getByText("Refresh the immutable key editor", { exact: true })).toBeVisible();
  await expect(page.getByLabel("key", { exact: true })).toHaveJSProperty("readOnly", true);
  await page.getByLabel("value", { exact: true }).fill("Edited");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Edited", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add board key", exact: true }).click();
  await expect(page.getByLabel("key", { exact: true })).toHaveJSProperty("readOnly", false);
});

test("a committed message with a lost receipt is checked instead of immediately resent", async ({ page }) => {
  const agent = await joinRoom(parseInviteLink(await createRoom(page))!, "worker-agent");
  let posts = 0;
  await page.route("**/r/*", async route => {
    if (route.request().method() !== "POST" || route.request().postDataJSON()?.intent === "key.exchange") return route.continue();
    posts++;
    const committed = await route.fetch();
    expect(committed.ok()).toBe(true);
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Receipt lost after commit" }) });
  });
  await page.getByRole("combobox", { name: "Recipient", exact: true }).selectOption("worker-agent");
  await page.getByLabel("Message", { exact: true }).fill("Please review once");
  await page.getByLabel("Request a reply").check();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("[data-message-status]")).toContainText("Delivery unknown");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Check delivery", exact: true }).click();
  await expect(page.locator("[data-message-status]")).toContainText("Delivered as message #");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  expect(posts).toBe(1);
  expect((await agent.status()).open_asks).toHaveLength(1);
});

test("console and Live view fit mobile screens and pass accessibility checks", async ({ page }, testInfo) => {
  await createRoom(page);
  await page.getByText("New task", { exact: true }).click();
  await page.getByLabel("Task title", { exact: true }).fill("Review the parser changes");
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit Review the parser changes", exact: true })).toBeVisible();
  await page.locator(".message-new").last().evaluate((el) => {
    for (const animation of el.getAnimations()) { animation.pause(); animation.currentTime = 0; }
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("room-console-" + width + ".png"), fullPage: true });
  }
  await page.getByRole("link", { name: "Live view", exact: true }).click();
  await expect(page.getByRole("link", { name: "Room console", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save task", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect((await new AxeBuilder({ page }).analyze()).violations.map(v => v.id)).toEqual([]);
  await page.getByRole("link", { name: "Room console", exact: true }).click();
  await expect(page.getByText("New task", { exact: true })).toBeVisible();
});
