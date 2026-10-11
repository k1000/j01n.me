import { describe, expect, it } from "vitest";
import { assertSafePeerPromptText } from "../spawn-herdr";

const invite = { join_secret: "fixture-room-key", participant_token: "fixture-participant-token" };
const senderToken = "fixture-sender-token";

describe("Herdr peer prompt guard", () => {
  it("rejects each known current-room credential in either prompt field", () => {
    for (const credential of [invite.join_secret, invite.participant_token, senderToken]) {
      expect(() => assertSafePeerPromptText(invite, senderToken, `Review ${credential}`, "builder")).toThrow("room credentials");
      expect(() => assertSafePeerPromptText(invite, senderToken, "Review docs", `builder ${credential}`)).toThrow("room credentials");
    }
  });

  it("rejects canonical room invitation links even for a different room", () => {
    for (const path of ["room", "r"]) {
      const link = `https://j01n.me/${path}/other#fixture-other-key`;
      expect(() => assertSafePeerPromptText(invite, senderToken, `Review ${link}`, "builder")).toThrow("invitation links");
      expect(() => assertSafePeerPromptText(invite, senderToken, "Review docs", `builder ${link}`)).toThrow("invitation links");
    }
  });

  it("permits benign Pi task and role text without changing the prompt", () => {
    expect(() => assertSafePeerPromptText(invite, senderToken, "Review docs", "builder")).not.toThrow();
    expect(() => assertSafePeerPromptText(invite, senderToken, "Review https://example.org/docs#intro", "reviewer")).not.toThrow();
  });
});
