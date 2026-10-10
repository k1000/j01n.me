import { createServer } from "node:http";
import app from "../apps/web/src/index";
import { RendezvousSession } from "../apps/web/src/rendezvous";
import { RoomRegistry } from "../apps/web/src/room/registry";
import type { Env } from "../apps/web/src/types";

// Run the real room handlers with isolated, disposable storage; no Cloudflare credentials or live rooms.
function memoryState(): DurableObjectState {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key),
      deleteAll: async () => values.clear(),
      list: async (options?: { prefix?: string }) => new Map([...values].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))),
      setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
      transaction: async <T>(fn: () => Promise<T>) => fn(),
    },
    id: { toString: () => "browser-fixture" }, waitUntil: () => {}, blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
  } as unknown as DurableObjectState;
}

function namespace(factory: () => { fetch: (request: Request) => Promise<Response> }): DurableObjectNamespace {
  const objects = new Map<string, { object: ReturnType<typeof factory>; pending: Promise<unknown> }>();
  return {
    idFromName: (name: string) => name,
    get: (name: string) => {
      let entry = objects.get(name);
      if (!entry) { entry = { object: factory(), pending: Promise.resolve() }; objects.set(name, entry); }
      const current = entry;
      return { fetch: (input: string | Request, init?: RequestInit) => {
        // Serialize fixture handlers, not stream bodies; this is not a Worker concurrency emulator.
        const result = current.pending.then(() => current.object.fetch(typeof input === "string" ? new Request(input, init) : input));
        current.pending = result.then(() => {}, () => {});
        return result;
      } };
    },
  } as unknown as DurableObjectNamespace;
}

const env = {} as Env;
env.RENDEZVOUS = namespace(() => new RendezvousSession(memoryState(), env));
env.ROOM_REGISTRY = namespace(() => new RoomRegistry(memoryState(), env));

createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const request = new Request("http://127.0.0.1:4179" + incoming.url, {
      method: incoming.method, headers,
      ...(["GET", "HEAD"].includes(incoming.method || "GET") ? {} : { body: Buffer.concat(chunks) }),
    });
    const response = await app.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    const reader = response.body?.getReader();
    if (reader) {
      outgoing.on("close", () => { reader.cancel().catch(() => {}); });
      while (!outgoing.destroyed) {
        const { done, value } = await reader.read();
        if (done) break;
        outgoing.write(value);
      }
    }
    outgoing.end();
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end(String(error));
  }
}).listen(4179, "127.0.0.1");
