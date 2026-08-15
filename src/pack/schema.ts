import { z } from "zod";
import { REQUIRED_PACK_SECTIONS } from "./types.js";

const ed25519Signature = z.object({
  alg: z.literal("Ed25519"),
  publicKey: z.string().min(1),
  signature: z.string().min(1),
});

const kindBinding = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const packDocumentSchema = z
  .object({
    identity: z.object({
      packId: z.string().min(1),
      name: z.string().min(1),
      version: z.string().min(1),
      owner: z.string().min(1),
      domain: z.string().min(1),
    }),
    roles: z
      .array(
        z.object({
          id: z.string().min(1),
          title: z.string().min(1),
          persona: z.string().min(1),
          skills: z.array(z.string().min(1)).min(1),
          specialties: z.array(z.string().min(1)).min(1),
          memoryScope: z.string().min(1),
        }),
      )
      .min(1),
    orgChart: z.object({
      seats: z
        .array(
          z.object({
            seatId: z.string().min(1),
            roleId: z.string().min(1),
            agentName: z.string().min(1),
          }),
        )
        .min(1),
    }),
    journeyKinds: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          stages: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
    actionClassVerbs: z
      .array(
        z.object({
          verb: z.string().min(1),
          class: z.string().min(1),
          externalEffect: z.boolean(),
        }),
      )
      .min(1),
    policy: z.object({
      ruleRefs: z.array(z.string().min(1)).min(1),
      rules: z
        .array(
          z.object({
            id: z.string().min(1),
            whenVerb: z.string().min(1),
            whenClass: z.string().min(1).optional(),
            effect: z.enum(["deny", "require_authorization", "allow_if_authorized"]),
            reason: z.string().min(1),
          }),
        )
        .min(1),
      defaultStance: z.literal("authorization"),
      graduation: z.object({
        requiresIndependentOutcomeEvidence: z.literal(true),
        surpriseGraduationIsFailure: z.literal(true),
      }),
    }),
    connectors: z.array(
      z.object({
        id: z.string().min(1),
        kind: z.string().min(1),
        egressHosts: z.array(z.string().min(1)),
      }),
    ),
    bindings: z.object({
      recordKinds: z.array(kindBinding).min(1),
      partyKinds: z.array(kindBinding).min(1),
      knowledgeKinds: z.array(kindBinding).min(1),
    }),
    evidence: z.object({
      fixtures: z.array(
        z.object({
          id: z.string().min(1),
          summary: z.string().min(1),
          independent: z.literal(true),
        }),
      ),
    }),
    eval: z.object({
      fixtures: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            mustPass: z.literal(true),
            prompt: z.string().min(1),
            expectedStance: z.enum(["refuse_unauthorized", "follow_policy", "no_assumed_autonomy"]),
          }),
        )
        .min(1),
    }),
    askCeilings: z.object({
      maxTurns: z.number().int().positive(),
      maxExternalEffects: z.number().int().nonnegative(),
      forbiddenVerbs: z.array(z.string()),
    }),
    fieldLanguageMap: z.record(z.string().min(1), z.string().min(1)),
    signatures: z.object({
      pack: ed25519Signature,
      owner: ed25519Signature,
    }),
  })
  .superRefine((doc, ctx) => {
    const roleIds = new Set(doc.roles.map((role) => role.id));
    for (const seat of doc.orgChart.seats) {
      if (!roleIds.has(seat.roleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `orgChart seat ${seat.seatId} references unknown role ${seat.roleId}`,
          path: ["orgChart", "seats"],
        });
      }
    }
    const names = doc.orgChart.seats.map((seat) => seat.agentName);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "orgChart agent names must be unique",
        path: ["orgChart", "seats"],
      });
    }
  });

export function missingRequiredSections(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [...REQUIRED_PACK_SECTIONS];
  }
  const record = value as Record<string, unknown>;
  return REQUIRED_PACK_SECTIONS.filter((section) => record[section] === undefined);
}
