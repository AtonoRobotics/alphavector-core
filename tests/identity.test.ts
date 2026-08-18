import { describe, expect, it } from "vitest";
import { FORBIDDEN_PRODUCT_NAMES, GLASS, GLASS_HUES, PRODUCT, isForbiddenProductName } from "../src/identity.js";

describe("product identity", () => {
  it("is Pyrallon / alphavector-core / llc.alphavector.dev", () => {
    expect(PRODUCT.appDisplay).toBe("Pyrallon");
    expect(PRODUCT.appDisplay).not.toMatch(/AV Dev|Alpha Vector LLC|VEYRA/);
    expect(PRODUCT.package).toBe("alphavector-core");
    expect(PRODUCT.bundleId).toBe("llc.alphavector.dev");
    expect(PRODUCT.firstPackPackage).toBe("alphavector-re");
    expect(GLASS).toEqual({
      bone: "#F4F1EA",
      nearBlack: "#0B0B0C",
      hairline: "#2A2A2D",
      holdAmber: "#C4A574",
    });
    expect(GLASS_HUES).toEqual(["#F4F1EA", "#0B0B0C", "#2A2A2D", "#C4A574"]);
  });

  it("does not revive forbidden names", () => {
    for (const name of ["Desk", "Shape", "Director", "Play", "Plant", "HIL", "Thor", "Mission Control", "VEYRA", "Agent OS"]) {
      expect(isForbiddenProductName(name)).toBe(true);
      expect(FORBIDDEN_PRODUCT_NAMES).toContain(name);
    }
  });
});
