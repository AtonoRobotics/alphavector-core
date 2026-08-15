import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { fieldHomeHtml } from "../src/surfaces/html.js";

describe("surfaces", () => {
  it("does not put architect or admin cards on the field home screen", () => {
    const html = fieldHomeHtml();
    expect(html).not.toContain("/architect");
    expect(html).not.toContain("admin");
    expect(html).toContain("Work");
    expect(html).toContain("/ask");
  });

  it("keeps architect off the field API", async () => {
    const { app } = await buildApp();
    const field = await app.inject({ method: "GET", url: "/api/field/state" });
    expect(field.statusCode).toBe(200);
    const body = field.json();
    expect(body.surface).toBe("field");
    expect(body.architectCards).toEqual([]);
    const architect = await app.inject({ method: "GET", url: "/architect" });
    expect(architect.statusCode).toBe(403);
    const architectOk = await app.inject({
      method: "GET",
      url: "/architect",
      headers: { "x-av-principal": "architect" },
    });
    expect(architectOk.statusCode).toBe(200);
    await app.close();
  });
});
