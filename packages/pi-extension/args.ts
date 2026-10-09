export interface ParsedArgs {
  cmd: string;
  roomUrlOrInvite?: string;
  joinSecret?: string;
  me?: string;
  rest: string[];
}

const ENV_COMMANDS = new Set(["join", "read", "inbox", "doctor"]);

type EnvVars = Record<string, string | undefined>;

export function parseArgs(args: string[], env: EnvVars = process.env): ParsedArgs {
  const cmd = args[0];
  if (!cmd) return { cmd: "", rest: args };
  const parser = argParsers.find((candidate) => candidate.matches(cmd, args, env)) ?? restParser;
  return parser.parse(cmd, args, env);
}

interface ArgParser {
  matches(cmd: string, args: string[], env: EnvVars): boolean;
  parse(cmd: string, args: string[], env: EnvVars): ParsedArgs;
}

const envParser: ArgParser = { matches: isEnvInvocation, parse: envParsedArgs };
const createParser: ArgParser = { matches: (cmd) => cmd === "create", parse: createParsedArgs };
// A room link (https://j01n.me/room/<id>#<secret>) carries its own secret, so it parses like an invite file.
const urlParser: ArgParser = { matches: (_cmd, args) => isUrlArg(args[1]) && !args[1].includes("#"), parse: urlParsedArgs };
const inviteParser: ArgParser = { matches: (_cmd, args) => !!args[1], parse: inviteParsedArgs };
const restParser: ArgParser = { matches: () => true, parse: (cmd, args) => ({ cmd, rest: args.slice(1) }) };
const argParsers = [envParser, createParser, urlParser, inviteParser];

function envParsedArgs(cmd: string, args: string[], env: EnvVars): ParsedArgs {
  return { cmd, roomUrlOrInvite: env.ROOM_URL, joinSecret: env.JOIN_SECRET, me: env.ME, rest: args.slice(1) };
}

function urlParsedArgs(cmd: string, args: string[]): ParsedArgs {
  return { cmd, roomUrlOrInvite: args[1], joinSecret: args[2], me: args[3], rest: args.slice(4) };
}

function createParsedArgs(cmd: string, args: string[]): ParsedArgs {
  if (isUrlArg(args[1])) return { cmd, roomUrlOrInvite: args[1], rest: args.slice(2) };
  return { cmd, rest: args.slice(1) };
}

function inviteParsedArgs(cmd: string, args: string[]): ParsedArgs {
  return { cmd, roomUrlOrInvite: args[1], me: args[2], rest: args.slice(3) };
}

function isUrlArg(value: string | undefined): boolean {
  return !!value && /^https?:/.test(value);
}

function isEnvInvocation(cmd: string, args: string[], env: EnvVars): boolean {
  if (!hasEnvRoom(env)) return false;
  if (cmd === "send") return args.length <= 3;
  return args.length === 1 && ENV_COMMANDS.has(cmd);
}

function hasEnvRoom(env: EnvVars): boolean {
  return !!(env.ROOM_URL && env.JOIN_SECRET && env.ME);
}

export function splitArgs(input: string): string[] {
  const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
  return [...input.matchAll(pattern)].map((match) => unescapeArg(match[1] ?? match[2] ?? match[3] ?? ""));
}

function unescapeArg(value: string): string {
  return value.replace(/\\([\\"'])/g, "$1");
}
