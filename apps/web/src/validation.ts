import { sanitizeId } from "./constants";
import { json } from "./format";
import { randomBase64Url } from "@j01n/sdk/crypto";

const MAX_PARTICIPANT_ID_LENGTH = 64;
export const MAX_BOARD_KEY_LENGTH = 80;
const MAX_STATUS_LENGTH = 240;
const MAX_MODEL_LENGTH = 120;
const MAX_SKILL_LENGTH = 80;
const MAX_SKILLS_COUNT = 32;
const MAX_ROOM_NAME_LENGTH = 80;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function sanitizeRoomId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
}

export function isValidRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}

/** Normalize a participant ID — must be a non-empty string after sanitization. */
export function normalizeParticipantId(value: unknown): string | Response {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return json({ error: "participant_id is required" }, 400);
  return sanitizeId(id, MAX_PARTICIPANT_ID_LENGTH);
}

/** Normalize a board key — must be a non-empty sanitized string. */
export function normalizeBoardKey(value: unknown): string | Response {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) return json({ error: "board key is required" }, 400);
  const normalized = sanitizeId(key, MAX_BOARD_KEY_LENGTH);
  if (!normalized) return json({ error: "invalid board key" }, 400);
  return normalized;
}

/** Normalize a room ID — generates a random one if the proposed value is empty. */
export function normalizeRoomId(value: string | undefined): string {
  if (!value || typeof value !== "string") return randomBase64Url(16);
  const sanitized = sanitizeRoomId(value.trim());
  return sanitized || randomBase64Url(16);
}

/** Normalize a host ID. */
export function normalizeHostId(value: string | undefined): string {
  const sanitized = sanitizeId((value ?? "host").trim());
  return sanitized || "host";
}

/** Normalize a room name — defaults to "j01n rendezvous" if empty. */
export function normalizeRoomName(value: string | undefined): string {
  const name = typeof value === "string" ? value.trim() : "";
  return name ? name.slice(0, MAX_ROOM_NAME_LENGTH) : "j01n rendezvous";
}

/** Normalize max participants — clamps between 2 and 64. */
export function normalizeMaxParticipants(value: number | undefined, defaultMax = 16): number {
  return Math.min(Math.max(Math.trunc(value ?? defaultMax), 2), 64);
}

/** Normalize a participant state value. */
export function normalizeState(value: unknown): "free" | "busy" | undefined | Response {
  if (value === undefined) return undefined;
  if (value === "free" || value === "busy") return value;
  return json({ error: "state must be 'free' or 'busy'" }, 400);
}

/** Normalize a participant status text. */
export function normalizeStatus(value: unknown): string | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return json({ error: "status must be a string" }, 400);
  return value.trim().slice(0, MAX_STATUS_LENGTH);
}

/** Normalize a participant model name. */
export function normalizeModel(value: unknown): string | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return json({ error: "model must be a string" }, 400);
  const model = value.trim().slice(0, MAX_MODEL_LENGTH);
  return model || undefined;
}

/** Normalize a participant model provider (same rules as the model name). */
export function normalizeProvider(value: unknown): string | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return json({ error: "provider must be a string" }, 400);
  const provider = value.trim().slice(0, MAX_MODEL_LENGTH);
  return provider || undefined;
}

/** Normalize a participant capabilities list (same limits as skills). */
export function normalizeCapabilities(value: unknown): string[] | undefined | Response {
  const capabilities = normalizeSkills(value);
  return capabilities instanceof Response ? json({ error: "capabilities must be an array of strings" }, 400) : capabilities;
}

/** Normalize a participant skills list. */
export function normalizeSkills(value: unknown): string[] | undefined | Response {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return json({ error: "skills must be an array of strings" }, 400);
  const skills = value
    .filter((skill): skill is string => typeof skill === "string")
    .map((skill) => skill.trim().slice(0, MAX_SKILL_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_SKILLS_COUNT);
  return [...new Set(skills)];
}
