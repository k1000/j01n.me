import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { peerConfigPath, resolvePeerRole, resolvePeerSelection } from "../peer-roles";
import { writePeerConfig } from "./peer-config-fixture";

describe("user-scoped peer spawn policy", () => {
  afterEach(() => vi.unstubAllEnvs());
  const setup = () => {
    const path = writePeerConfig(mkdtempSync(join(tmpdir(), "j01n-role-config-")));
    vi.stubEnv("J01N_PEER_CONFIG", path);
    return path;
  };

  it("requires a personal config and offers a setup path rather than using built-in models", () => {
    vi.stubEnv("J01N_PEER_CONFIG", join(tmpdir(), "does-not-exist-peer-spawn.json"));
    expect(() => resolvePeerSelection()).toThrow(/peer-spawn\.json.*copy|copy.*peer-spawn\.json/i);
  });

  it("uses personal defaults, each harness's own configured model and actual skill names", () => {
    setup();
    expect(resolvePeerSelection()).toMatchObject({ role: "builder", harness: "pi", startup: { model: undefined, skillNames: ["j01n-builder"], tools: ["read", "bash", "edit", "write", "j01n"] } });
    expect(resolvePeerSelection("reviewer", "claude")).toMatchObject({ role: "reviewer", harness: "claude", startup: { model: "user-claude-review-model", skillNames: ["j01n-reviewer"], tools: ["Read", "Bash"] } });
    expect(resolvePeerSelection("builder", "claude").startup.model).toBeUndefined();
    expect(resolvePeerRole("planner").model).toBe("user/pi-plan-model");
    vi.stubEnv("J01N_REVIEWER_MODEL", "not-used");
    expect(resolvePeerRole("reviewer").model).toBe("user/pi-review-model");
    expect(() => resolvePeerSelection("planner", "claude")).toThrow(/not configured/);
    expect(() => resolvePeerSelection("owner", "pi")).toThrow(/reserved|unknown/);
  });

  it("accepts a user-defined role and custom skill file, but refuses unsafe models, tools and paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "j01n-role-config-"));
    const path = writePeerConfig(dir);
    const skill = join(dir, "review.md");
    writeFileSync(skill, "---\nname: my-tester\ndescription: Checks code\n---\n# Test\n");
    const roles = { tester: { pi: { model: "custom/test-model", skills: ["./review.md"], tools: ["read", "bash", "j01n"] } } };
    writeFileSync(path, JSON.stringify({ defaultRole: "tester", defaultHarness: "pi", roles }));
    vi.stubEnv("J01N_PEER_CONFIG", path);
    expect(resolvePeerSelection()).toMatchObject({ role: "tester", startup: { model: "custom/test-model", skills: [realpathSync(skill)], skillNames: ["my-tester"] } });
    writeFileSync(path, JSON.stringify({ defaultRole: "tester", defaultHarness: "pi", roles: { tester: { pi: { ...roles.tester.pi, model: "--dangerously-skip-permissions" } } } }));
    expect(() => resolvePeerSelection()).toThrow(/model/);
    writeFileSync(path, JSON.stringify({ defaultRole: "tester", defaultHarness: "pi", roles: { tester: { pi: { ...roles.tester.pi, tools: ["read,--dangerously-skip-permissions"] } } } }));
    expect(() => resolvePeerSelection()).toThrow(/tools/);
    writeFileSync(path, JSON.stringify({ defaultRole: "tester", defaultHarness: "pi", roles: { tester: { pi: { ...roles.tester.pi, tools: ["read", "bash"] } } } }));
    expect(() => resolvePeerSelection()).toThrow(/must include j01n/);
    writeFileSync(path, JSON.stringify({ defaultRole: "tester", defaultHarness: "pi", roles: { tester: { pi: { ...roles.tester.pi, skills: ["./missing.md"] } } } }));
    expect(() => resolvePeerSelection()).toThrow(/skill is unavailable/);
  });

  it("uses XDG user config, rejects relative overrides and malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "j01n-role-config-"));
    expect(peerConfigPath({ XDG_CONFIG_HOME: dir })).toBe(join(dir, "j01n", "peer-spawn.json"));
    expect(() => peerConfigPath({ J01N_PEER_CONFIG: "./peer-spawn.json" })).toThrow(/absolute/);
    const path = writePeerConfig(dir);
    vi.stubEnv("J01N_PEER_CONFIG", path);
    writeFileSync(path, "not JSON");
    expect(() => resolvePeerSelection()).toThrow(/invalid peer spawn JSON/);
  });
});
