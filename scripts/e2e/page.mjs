// Room page in headless Chrome: a human joins in the browser, a CLI agent's message appears, no JS errors.
// Usage: node scripts/e2e/page.mjs <base> [helper]   (skipped when Chrome is not installed; CHROME overrides the path)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const base = process.argv[2];
const helper = process.argv[3] ?? fileURLToPath(new URL("../../packages/helper/client/j01n.js", import.meta.url));
const chromePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chromePath)) { console.log("PAGE CHECK skipped (Chrome not found; set CHROME)"); process.exit(0); }
const profile = mkdtempSync(join(tmpdir(), "e2e-chrome-"));
const dir = mkdtempSync(join(tmpdir(), "e2e-page-"));
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=9335", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 40 && !target; i++) { await sleep(250); target = await fetch("http://127.0.0.1:9335/json").then((r) => r.json()).then((t) => t.find((x) => x.type === "page")).catch(() => undefined); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map(); const errors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
    pending.get(m.id)?.(m);
  });
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send("Runtime.enable");
  await send("Page.navigate", { url: base + "/" }); await sleep(2000);
  const room = await evaluate(`fetch("/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host_id: "human", room_name: "page check" }) }).then((r) => r.json())`);
  const link = room.invite_link.replace("https://j01n.me", base);
  await send("Page.navigate", { url: link }); await sleep(5000);
  await evaluate(`(() => { const input = document.querySelector("input"); input.value = "kamil"; input.dispatchEvent(new Event("input", { bubbles: true })); const button = [...document.querySelectorAll("button")].find((b) => /join/i.test(b.textContent)); (button.form ? button.form.requestSubmit(button) : button.click()); })()`);
  await sleep(5000);
  const env = { ...process.env, BASE_URL: base };
  execFileSync("node", [helper, "join", link, "agent-b", "--no-workspace"], { cwd: dir, encoding: "utf8", env });
  execFileSync("node", [helper, "send", link, "agent-b", "kamil", "hello from the CLI"], { cwd: dir, encoding: "utf8", env });
  await sleep(5000);
  const visible = await evaluate(`document.body.innerText.includes("hello from the CLI")`);
  ws.close();
  const ok = visible === true && errors.length === 0;
  console.log(ok ? "PAGE CHECK OK" : "PAGE CHECK FAILED " + JSON.stringify({ visible, errors: errors.slice(0, 5) }));
  if (!ok) process.exitCode = 1;
} finally {
  // Chrome keeps writing its profile until it has exited.
  const exited = chrome.exitCode !== null ? Promise.resolve() : new Promise((done) => chrome.once("exit", done));
  chrome.kill();
  await exited;
  for (const path of [profile, dir]) rmSync(path, { recursive: true, force: true, maxRetries: 5 });
}
