import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CardBook } from "../src/auth/cards.js";
import { computerRoot } from "../src/computer/paths.js";
import { AvError } from "../src/errors.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import { FieldClient, FieldHttpError } from "../src/http/field-client.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { MemoryPackRegistry, PackLoader } from "../src/packs/loader.js";
import { ALPHAVECTOR_RE_PIN_SHA, createOpenStart, signedRePack } from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const servers: FieldHttpServer[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.close();
  }
});

async function rePack(tenantId = "t1") {
  const { anchors, binding } = await signedRePack();
  const loader = new PackLoader(new MemoryPackRegistry(), anchors);
  const loaded = loader.load({ tenantId, binding, actor: "architect" });
  if (!loaded.ok) throw new Error(loaded.message);
  return loaded.loaded;
}

async function liveDurable(
  tenantId: string,
  computerBaseDir: string,
  issued?: { field: string },
) {
  const { core, pack } = await bootFieldCore(tenantId, {
    computerBaseDir,
    adapter: new DryStemAdapter(),
  });
  let fieldToken = issued?.field;
  if (!fieldToken) {
    const architect = core.fieldTokens.issue({ tenantId, principal: "architect" });
    fieldToken = core.fieldTokens.issue({
      tenantId,
      principal: "field",
      presented: architect.token,
    }).token;
  }
  const server = new FieldHttpServer({ core, pack, tenantId });
  servers.push(server);
  const { url } = await server.listen(0, "127.0.0.1");
  return {
    server,
    url,
    fieldToken,
    field: new FieldClient(url, fieldToken),
    core,
    pack,
  };
}

async function issueFollowUpCard(field: FieldClient): Promise<{ journeyId: string; cardId: string }> {
  const { journey } = await createOpenStart(field, "buyer", "Work this buyer journey");
  const inbox = await field.cards();
  const cardId = inbox[0]?.cardId;
  if (!cardId) {
    throw new Error("field start must require a card for the one external effect");
  }
  return { journeyId: journey.id, cardId };
}

describe("durable pending cards on tenant computer disk", () => {
  it("keeps the RE fixture pin at 5091328", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
  });

  it("reloads the same pending owner_instance card from the tenant disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-cards-"));
    const pack = await rePack("t1");
    const first = new CardBook(dir);
    const issued = first.issue({
      tenantId: "t1",
      kind: "owner_instance",
      actionClass: "communicate",
      agentId: "agent_follow",
      purpose: "follow-up",
      subject: "buyer",
      channel: "email",
      pack,
    });

    const paths = computerRoot(dir, "t1");
    expect(existsSync(paths.cardsFile)).toBe(true);
    expect(paths.cardsFile).toBe(path.join(dir, "tenants", "t1", "cards.json"));
    expect(existsSync(path.join(paths.disk, "cards.json"))).toBe(false);

    const second = new CardBook(dir);
    const inbox = second.fieldInbox("t1");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.cardId).toBe(issued.cardId);
    expect(second.get(issued.cardId)?.kind).toBe("owner_instance");
    expect(second.get(issued.cardId)?.status).toBe("pending");
  });

  it("lists the same card and approve-then-executes after process restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-cards-http-"));
    const first = await liveDurable("restart", dir);
    const { cardId } = await issueFollowUpCard(first.field);
    const inbox = await first.field.cards();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.cardId).toBe(cardId);
    await first.server.close();

    const second = await liveDurable("restart", dir, { field: first.fieldToken });
    const again = await second.field.cards();
    expect(again).toHaveLength(1);
    expect(again[0]!.cardId).toBe(cardId);
    const home = await second.field.home();
    expect(home.inbox.map((c) => c.cardId)).toEqual([cardId]);

    const approved = await second.field.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.effect?.executed).toBe(true);
    expect(await second.field.cards()).toHaveLength(0);
  });

  it("approves a fact card after restart and only then writes facts.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-card-"));
    const first = await liveDurable("fact-restart", dir);
    const rec = await first.field.createApprovedRecord(
      (await first.field.home()).recordKinds[0]?.id ?? "record",
      "Subject",
    );
    let cardId = "";
    try {
      await first.field.record("condition.required", rec.id);
      throw new Error("expected authorization card before fact write");
    } catch (err) {
      if (!(err instanceof FieldHttpError) || err.code !== "AUTHORIZATION_REQUIRED" || !err.cardId) {
        throw err;
      }
      cardId = err.cardId;
    }
    const paths = computerRoot(dir, "fact-restart");
    expect(existsSync(paths.cardsFile)).toBe(true);
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    await first.server.close();

    const second = await liveDurable("fact-restart", dir, { field: first.fieldToken });
    const again = await second.field.cards();
    expect(again).toHaveLength(1);
    expect(again[0]!.cardId).toBe(cardId);
    const approved = await second.field.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.fact).toEqual({ id: "condition.required", present: true, recordId: rec.id });
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(await second.field.cards()).toHaveLength(0);
  });

  it("missing store is an empty inbox and does not invent a card", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-cards-miss-"));
    const book = new CardBook(dir);
    expect(book.fieldInbox("t1")).toEqual([]);
    expect(book.get("card_invented")).toBeUndefined();

    const live = await liveDurable("missing", dir);
    expect(await live.field.cards()).toEqual([]);
    const home = await live.field.home();
    expect(home.inbox).toEqual([]);
  });

  it("corrupt store refuses to serve cards and does not invent one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-cards-bad-"));
    const paths = computerRoot(dir, "t1");
    await mkdir(path.dirname(paths.cardsFile), { recursive: true });
    await writeFile(paths.cardsFile, "{not-json", "utf8");

    const book = new CardBook(dir);
    expect(() => book.fieldInbox("t1")).toThrow(AvError);
    expect(() => book.fieldInbox("t1")).toThrow(/corrupt/i);
    expect(book.get("card_invented")).toBeUndefined();

    const guessed = await mkdtemp(path.join(os.tmpdir(), "av-cards-guess-"));
    const guessPath = computerRoot(guessed, "corrupt");
    await mkdir(path.dirname(guessPath.cardsFile), { recursive: true });
    await writeFile(
      guessPath.cardsFile,
      JSON.stringify({ cards: [{ purpose: "guessed-follow-up", subject: "buyer" }] }),
      "utf8",
    );
    const guessedBook = new CardBook(guessed);
    expect(() => guessedBook.fieldInbox("corrupt")).toThrow(/corrupt/i);
    expect(guessedBook.get("card_invented")).toBeUndefined();

    const live = await liveDurable("corrupt", guessed);
    await expect(live.field.cards()).rejects.toMatchObject({
      status: 500,
      code: "CARD_STORE_CORRUPT",
    });
  });
});
