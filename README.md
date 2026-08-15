# alphavector-core

AV Dev domain-agnostic agent OS. Package `alphavector-core`. Bundle `llc.alphavector.dev`.

Not Mission Control. Not the Real Estate app (`alphavector-re`).

This repository is the core: pack-agnostic host, unbounded agent runtime, Linux computer images (Grok Bot-shaped), pack-load fail-closed.

This is a development scaffold, not a consumer brand.

| Use | Value |
| --- | --- |
| App display | AV Dev |
| Package | alphavector-core |
| Bundle | llc.alphavector.dev |
| First domain pack | alphavector-re (separate repository) |

## What this is

The core (DEC-001-A) hosts a signed domain pack. It supplies:

- A Linux computer per tenant (real container or namespace, not an in-process fake). Agents share the machine and the disk. Desktops are per-agent. Image update keeps files and logins. Reset-from-snapshot is last resort.
- An unbounded agent runtime (DEC-027). No product-constant N. Named agents, personas, skills, memory, inter-agent mail. The pack authors the org chart. The field user does not spawn agents, write personas, or add skills.
- Pack load (DEC-019). Signed binding. Unsigned, incomplete, or unsigned-owner packs fail closed. One active pack per tenant.
- A policy gateway at every external effect. Rule bodies are pack. Graduation does not strip policy.
- Authorization cards. Authorization is the default (DEC-010). Deny is terminal. Architect cards do not appear on the field surface.
- A pack-agnostic data plane (DEC-026): generic party, record, journey, assertion, memory tiers, retrieval, graph. PostgreSQL is the only business truth. Memory cannot become facts.
- Three surfaces (DEC-024): required field path, optional Ask, Architect off the field home screen.

## What this is not

- Not a CRM, chatbot, copilot, or single-domain operator.
- Not alphavector-re. Domain types are pack bindings, not core tables.
- Not a robot pack. A later Physical AI pack must be hostable; it is not built here.
- Not a consumer house name.

## Locks

Authorization is the default. This repository does not invent numbered trust tiers (DEC-017 is not accepted).

Field users do not configure models, prompts, Temporal, tools, hypervisors, images, or networking (DEC-020).

Assumed autonomy for routine communications or recovery is excluded (EXC-008). Surprise graduation is a product failure (DEC-023).

## Computer

One persistent Linux computer per tenant. Agents share the disk. Desktops are per-agent X sessions (viewable, Architect can attach, PNG screenshot). Image update keeps files. Pack registry and running-state are durable.

## Development

Run install, then test, then build. Node 20. Vitest. Actions workflow under .github/workflows.
