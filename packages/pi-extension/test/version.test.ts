import { describe, expect, it } from "vitest";
import { assessInstallation } from "../version";

describe("Pi extension installation diagnostics", () => {
  it("identifies a stale loaded checkout and duplicate GitHub/GitLab installs", () => {
    const result = assessInstallation("gitlab", "a".repeat(40), "b".repeat(40), [
      "https://github.com/k1000/j01n.me", "https://gitlab.com/k1000/j01n.me",
    ]);

    expect(result).toMatchObject({ source: "gitlab", loaded_commit: "a".repeat(40), installed_commit: "b".repeat(40),
      reload_required: true, duplicate_install: true });
    expect(result.warnings.join(" ")).toContain("pi remove https://github.com/k1000/j01n.me");
    expect(result.warnings.join(" ")).toContain("/reload");
  });

  it("does not warn for a current GitLab-only installation", () => {
    const result = assessInstallation("gitlab", "a".repeat(40), "a".repeat(40), ["https://gitlab.com/k1000/j01n.me"]);
    expect(result.warnings).toEqual([]);
    expect(result).toMatchObject({ reload_required: false, duplicate_install: false });
  });

  it("warns when the GitHub package is the loaded extension", () => {
    const result = assessInstallation("github", "a".repeat(40), "a".repeat(40), ["https://github.com/k1000/j01n.me"]);
    expect(result.warnings.join(" ")).toContain("pi install https://gitlab.com/k1000/j01n.me");
  });
});
