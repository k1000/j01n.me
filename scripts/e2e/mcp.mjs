// MCP flow over HTTP: two MCP sessions (host + agent) in one room. Usage: node scripts/e2e/mcp.mjs <base>
const base = process.argv[2] ?? "https://j01n.me";
const H = { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "curl/8.7.1" };
async function session() {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const sid = r.headers.get("mcp-session-id");
  return async (name, args) => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...H, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) });
    const body = await res.json();
    if (body.error || body.result?.isError) throw new Error(`${name}: ${JSON.stringify(body.error ?? body.result).slice(0, 300)}`);
    return JSON.parse(body.result.content[0].text);
  };
}
const results = [];
const check = (label, ok) => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${label}`); };
const host = await session();
const agent = await session();
const room = await host("create_room", { hostId: "mcp-host", firstMessage: "Goal: MCP flow check" });
const link = room.invite_link.replace("https://j01n.me", base);
const joined = await agent("join_room", { inviteJson: link, participantId: "mcp-agent", capabilities: "code,shell", workspace: { path: "/work/x", repo: "https://u:t@example.com/r.git", branch: "main" } });
check("join_room returns the sealed kickoff and team", joined.kickoff?.text === "Goal: MCP flow check" && Array.isArray(joined.team));
await agent("send_message", { inviteJson: link, participantId: "mcp-agent", to: "mcp-host", body: "hello host" });
const hostRead = await host("read_messages", { inviteJson: link, participantId: "mcp-host" });
check("host reads the agent's encrypted message", hostRead.messages.some((m) => m.from === "mcp-agent" && m.body?.text === "hello host" && m.reply));
await host("send_message", { inviteJson: link, participantId: "mcp-host", to: "mcp-agent", body: "hello agent" });
const woke = await agent("wait_for_event", { inviteJson: link, participantId: "mcp-agent", timeoutSeconds: 10 });
check("agent's wait_for_event returns the host's message", woke.messages?.some((m) => m.from === "mcp-host" && m.body?.text === "hello agent"));
await host("set_board_key", { inviteJson: link, participantId: "mcp-host", key: "status", value: JSON.stringify({ state: "ok" }) });
const board = await agent("read_board", { inviteJson: link, participantId: "mcp-agent" });
check("board write and read", board.board?.status?.value?.state === "ok");
await agent("reserve_paths", { inviteJson: link, participantId: "mcp-agent", repo: "example.com/r", paths: "src/a.ts", reason: "flow" });
const res = await host("list_reservations", { inviteJson: link, participantId: "mcp-host" });
check("reservations: a hosted MCP agent shares no checkout, so none is stored", Array.isArray(res.reservations) && res.reservations.length === 0);
const team = await host("list_participants", { inviteJson: link, participantId: "mcp-host" });
const me = team.participants?.find((p) => p.id === "mcp-agent");
check("list_participants opens the workspace (credentials stripped)", me?.workspace?.repo === "https://example.com/r.git" && me?.capabilities?.join() === "code,shell");
await host("close_room", { inviteJson: link, participantId: "mcp-host" });
console.log(results.every(Boolean) ? "MCP FLOW OK" : "MCP FLOW FAILED");
if (!results.every(Boolean)) process.exitCode = 1;
