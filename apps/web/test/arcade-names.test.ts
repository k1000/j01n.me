import { describe, expect, it } from "vitest";
import { roomArcadeScript } from "../src/room-arcade";

const script = roomArcadeScript();
const start = script.indexOf("  function clean(");
const end = script.indexOf("  function text(", start);
if (start < 0 || end <= start) throw new Error("Arcade label functions not found");
const seatLabels = new Function(script.slice(start, end) + "return seatLabels;")() as (ids: string[]) => string[];

describe("arcade seat labels", () => {
  it("keeps existing labels when they are distinct", () => {
    expect(seatLabels(["Alice", "worker-1", "visitor"])).toEqual(["ALICE", "WORKER.", "VISITOR"]);
  });

  it("pairs a readable prefix with distinguishing numbered ends", () => {
    const labels = seatLabels(["worker-1", "worker-2", "worker-3", "worker-4", "worker-5", "polish-1", "polish-2"]);
    expect(labels).toEqual(["WOR-1", "WOR-2", "WOR-3", "WOR-4", "WOR-5", "POL-1", "POL-2"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("reserves untouched labels and disambiguates repeated suffixes", () => {
    const labels = seatLabels(["worker-1", "xworker-1", "RKER-1", "worker-11", "xworker-11"]);
    expect(labels[2]).toBe("RKER-1");
    expect(labels.every((label) => label.length <= 7)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
