# AV Dev (`alphavector-core`)

Domain-agnostic autonomous agent operating system.

| | |
| --- | --- |
| Display name | **AV Dev** |
| Package | `alphavector-core` |
| Bundle | `llc.alphavector.dev` |

This repository is the OS. It hosts a signed pack. It does not become the pack.

## What this is

- A pack-agnostic host: signed binding, one active pack per tenant, fail closed.
- An unbounded agent runtime: named agents, personas, skills, memory, inter-agent mail. Count is instance data on the pack org chart.
- A Linux computer primitive: one persistent machine per tenant, per-agent desktops, shared disk and logins.
- A policy gateway: authorization is the default. External effects need an authorization card or independent outcome evidence. Graduation does not strip policy.
- Three surfaces that stay apart: required field path, optional Ask, Architect off the home screen.

## What this is not

- **Not Mission Control.** This repo does not import Desk, Shape, Director, Play, Plant, HIL, Thor, Pad, Nexus, GUIDO, FIDO, Uplink, or cinema-robot types.
- **Not the Real Estate app.** The first vertical pack lives in a separate repository (`AtonoRobotics/alphavector-re`). Real Estate kinds do not belong in this tree.
- **Not a consumer house name.** The product on the glass is AV Dev.

## Locks this core implements

- **DEC-012 / DEC-022** — Policy gateway is core; rule bodies are pack. Graduation does not strip policy.
- **DEC-019** — Signed pack load. Unsigned, incomplete, or unsigned-owner fails closed. Field users cannot load or edit a pack.
- **DEC-020** — If a field user must configure models, prompts, Temporal, or tools, the product failed. Binders fail closed when missing.
- **DEC-021** — Two principals: Architect / broker-admin vs licensed field user. Surfaces are not smashed together.
- **DEC-023** — Surprise graduation is a product failure.
- **DEC-024** — Field home, optional Ask, Architect off the home screen. Architect cards do not appear on the field surface.
- **DEC-026** — Generic party / record / journey. Postgres is the only business truth. Memory cannot become facts. Packs bind kinds.
- **DEC-027** — No product-constant agent count.
- **EXC-008** — Assumed autonomy for routine comms / CRM / scheduling / recovery is excluded.
- **DEC-017** is not accepted. This core does not invent T0–T3 numeric thresholds.

A production policy instance is tenant-specific and counsel-signed. The typed binder is `CounselPolicyBinder`. Without a bound instance the gateway fails closed.

## Computer primitive

One persistent Linux computer per tenant. Agents share the machine, not the screen.

| Capability | Who |
| --- | --- |
| Shared filesystem, installed tools, browser profiles | Tenant machine |
| Desktop / VNC | Per agent |
| Shell, structured file read, screenshot of *their* desktop | Agent |
| Drive desktop / browser | Computer-use worker (not the agent) |
| Open desktop, watch, take over for login / 2FA / captcha / payment | Architect |
| See passwords | Nobody except the architect at the keyboard |

Image update is a data-preserving refresh: new image, same volume. Reset-from-snapshot is last resort and may lose unsynced work. Field users do not configure the hypervisor, images, or networking. Packs may bind egress. Packs do not own the computer.

Image: `llc.alphavector.dev/computer`.

```bash
npm run computer:build
```

## Run

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

- Field home: `http://127.0.0.1:8787/`
- Ask: `http://127.0.0.1:8787/ask`
- Architect: `http://127.0.0.1:8787/architect` (not linked from the field home)

Postgres is the business store. Operator-set `DATABASE_URL` and `npm run migrate`. Field users never see that.

## Tests

- Pack-load fail-closed (unsigned / incomplete / unsigned-owner / signed generic fixture)
- Agent spawn envelope (N from the pack, field user cannot spawn)
- Policy gateway (authorization default, cards, mail is not authority, EXC-008, no surprise graduation)
- Computer start / shared disk / separate desktops / update keeps disk

CI runs on the default branch.

## Pack contract

Required sections: identity, roles, journey kinds, action-class verbs, policy, connectors, record / party / knowledge bindings, evidence / eval fixtures, Ask ceilings, field language map.

The in-repo fixture pack is generic operations. It contains no Real Estate types and no Mission Control types.
