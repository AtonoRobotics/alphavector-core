import { describe, expect, it } from "vitest";
import { FORBIDDEN_PRODUCT_NAMES, PRODUCT, isForbiddenProductName } from "../src/identity.js";

describe("product identity", () => {
  it("is AV Dev / alphavector-core / llc.alphavector.dev", () => {
    expect(PRODUCT.appDisplay).toBe("AV Dev");
    expect(PRODUCT.package).toBe("alphavector-core");
    expect(PRODUCT.bundleId).toBe("llc.alphavector.dev");
    expect(PRODUCT.firstPackPackage).toBe("alphavector-re");
  });

  it("does not revive forbidden names", () => {
    for (const name of ["Desk", "Shape", "Director", "Play", "Plant", "HIL", "Thor", "Mission Control"]) {
      expect(isForbiddenProductName(name)).toBe(true);
      expect(FORBIDDEN_PRODUCT_NAMES).toContain(name);
    }
  });
});
