import { describe, expect, it } from "vitest";
import { DataPlane, MemoryDataPlaneStore } from "../src/data/plane.js";
import { loadSignedFixture } from "./helpers.js";

describe("data plane", () => {
  it("binds generic kinds from the pack and refuses unbound kinds", async () => {
    const ctx = await loadSignedFixture(2);
    const plane = new DataPlane(new MemoryDataPlaneStore());
    const party = await plane.createParty(ctx.loaded, "requester", { label: "Ada" });
    const record = await plane.createRecord(ctx.loaded, "case-file", { title: "Packet 1" });
    const journey = await plane.createJourney(ctx.loaded, "case", "opened", { ref: record.id });
    expect(party.kind).toBe("requester");
    expect(record.kind).toBe("case-file");
    expect(journey.kind).toBe("case");
    await expect(plane.createRecord(ctx.loaded, "listing", { no: true })).rejects.toMatchObject({
      code: "KIND_UNBOUND",
    });
    await expect(plane.createParty(ctx.loaded, "household", { no: true })).rejects.toMatchObject({
      code: "KIND_UNBOUND",
    });
  });
});
