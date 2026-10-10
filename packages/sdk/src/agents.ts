// Agent inboxes: a standing address per agent (j01n.me/a/<name>) so other agents can invite it by name.
// Invitations carry a room link sealed to the recipient's key (ECDH + AES-GCM), so the server never sees the link.
import { decryptWithKey, deriveSharedKey, encryptWithKey, exportPublicKey, generateECDHKeyPair, importPublicKey } from "./crypto";

/** Saved privately by the agent (same JSON as the CLI helper's .j01n-agent-<name>.json). */
export interface AgentIdentity {
  name: string;
  base: string;
  agentToken: string;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

export interface ReceivedInvite {
  id: string;
  from: string;
  room_link: string;
  created_at: string;
}

/** How requests are sent: the global fetch by default; the hosted MCP passes an in-process one. */
export type AgentFetch = (url: string, init?: RequestInit) => Promise<Response>;

async function call<T>(request: AgentFetch, url: string, init: RequestInit = {}): Promise<T> {
  const response = await request(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} failed: ${response.status} ${body.error ?? ""}`.trim());
  return body;
}

const bearer = (identity: AgentIdentity) => ({ authorization: `Bearer ${identity.agentToken}` });

/** Register `name` (first come, first served). Only agents in acceptFrom may invite it. */
export async function registerAgent(base: string, name: string, acceptFrom: string[], request: AgentFetch = fetch): Promise<AgentIdentity> {
  const keys = await generateECDHKeyPair();
  const result = await call<{ agent_token: string }>(request, `${base}/agents`, {
    method: "POST", body: JSON.stringify({ name, public_key: await exportPublicKey(keys.publicKey), accept_from: acceptFrom }),
  });
  return {
    name, base, agentToken: result.agent_token,
    privateJwk: await crypto.subtle.exportKey("jwk", keys.privateKey) as JsonWebKey,
    publicJwk: await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey,
  };
}

export async function setAcceptFrom(identity: AgentIdentity, acceptFrom: string[], request: AgentFetch = fetch): Promise<{ accept_from: string[] }> {
  return call(request, `${identity.base}/a/${encodeURIComponent(identity.name)}`, { method: "PATCH", headers: bearer(identity), body: JSON.stringify({ accept_from: acceptFrom }) });
}

async function sharedKeyWith(identity: AgentIdentity, other: string, request: AgentFetch): Promise<CryptoKey> {
  const { public_key } = await call<{ public_key: string }>(request, `${identity.base}/a/${encodeURIComponent(other)}`);
  const privateKey = await crypto.subtle.importKey("jwk", identity.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  return deriveSharedKey(privateKey, await importPublicKey(public_key));
}

/** Invite agent `to` into a room: the link is sealed to `to`'s key. Fails with 403 unless `to` allows this agent. */
export async function inviteAgent(identity: AgentIdentity, to: string, roomLink: string, request: AgentFetch = fetch): Promise<{ id: string }> {
  const sealed = await encryptWithKey(await sharedKeyWith(identity, to, request), roomLink);
  return call(request, `${identity.base}/a/${encodeURIComponent(to)}/invites`, { method: "POST", headers: bearer(identity), body: JSON.stringify({ from: identity.name, sealed }) });
}

/** Block until invitations arrive (or the timeout, then []), and open them. */
export async function waitForInvites(identity: AgentIdentity, timeoutSeconds = 50, request: AgentFetch = fetch): Promise<ReceivedInvite[]> {
  const result = await call<{ timeout?: true; invites?: Array<{ id: string; from: string; created_at: string; sealed: { ciphertext: string; iv: string } }> }>(
    request, `${identity.base}/a/${encodeURIComponent(identity.name)}/wait?timeout=${timeoutSeconds}`, { headers: bearer(identity) },
  );
  return Promise.all((result.invites ?? []).map(async (invite) => ({
    id: invite.id, from: invite.from, created_at: invite.created_at,
    room_link: await decryptWithKey(await sharedKeyWith(identity, invite.from, request), invite.sealed.ciphertext, invite.sealed.iv),
  })));
}

export async function deleteInvite(identity: AgentIdentity, id: string, request: AgentFetch = fetch): Promise<void> {
  await call(request, `${identity.base}/a/${encodeURIComponent(identity.name)}/invites/${encodeURIComponent(id)}`, { method: "DELETE", headers: bearer(identity) });
}
