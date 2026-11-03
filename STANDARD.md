# The AdaSouls agent standard

Every agent in this repository, and every agent AdaSouls publishes, has the
same shape. The shape exists so that three things hold for all of them:
anyone can tell **who** the agent is, **what it may do**, and **what it
did** — and the last one is evidence other people can verify, not a claim.

This file is the standard. Each agent's directory is an instance of it.
`treasury-agent` predates it and is being brought in line; new agents start
from it.

## The rule

> An ALMA agent observes, analyses and attests. Decisions that commit
> money, votes or keys are made by a human, and the event the agent
> publishes records who decided.

An agent that must act on-chain does so only within limits the chain or a
custody service enforces (`alma-verifier` tells you which), or by submitting
exactly what a human already signed (the DRep with a mandate in
`adasouls-contracts/cardano/agent_drep`). An agent never holds, asks for,
logs or prints a key that moves money or votes.

## Layout

```
<agent>/
  README.md             what it does, what it never does, how to run it
  <agent>.yaml          ALMA Agent Manifest: identity, capabilities, authority
  agent.yaml            profile: goal, scope, orchestration pattern, budgets
  escalation.yaml       which decisions need a human, who, with what expiry
  security.md           threat model: untrusted inputs, keys, what a compromise can do
  context/sources.yaml  every external source it reads, and how far it trusts each
  events/schemas/       JSON Schema per event type it emits (alma-attestation/1)
  src/                  the agent; talks to AdaSouls only through @adasouls/sdk
  test/                 vitest; fixtures recorded, never the network
  test/fixtures/
  .env.example          every variable, with what it is for; secrets never have defaults
  package.json          scripts: start, lint, build, test (and eval when it has evals)
```

Files that only make sense once the agent has them: `evals/` (cases and
expected events), `memory/policy.yaml` (working / episodic / semantic,
retention), `tools/mcp.json` (MCP servers with a permission per tool:
`read`, `write`, `moves-money`), `learning.md` (what may change without a
new version: nothing, by default), `CHANGELOG.md`.

## Rules every agent follows

1. **Only the public SDK.** If the agent needs something `@adasouls/sdk`
   doesn't offer, that is an SDK gap to fix, not something to special-case
   here. Admin bootstrap (`setup.ts`) may use REST with a human's token; the
   agent's runtime may not.
2. **Untrusted input stays data.** Governance actions, anchors, pool
   metadata, web pages and anything fetched are stored as files with their
   digest, quoted into prompts as data, never executed, and never allowed to
   steer what the agent does next. A hash mismatch or a failed download is
   recorded, never skipped.
3. **No key that moves money or votes.** Not in `.env`, not in memory, not
   in logs. Signing keys for *records* (Ed25519, alma-core issuer-signature
   format) are allowed; they come from a path in the environment and are
   never printed.
4. **Every output is an event.** What the agent produces goes out as a
   signed envelope (`alma-attestation/1` with a `type` from the catalogue,
   or a receipt / report / delivery where those fit), with the version of
   the agent that produced it (`almaVersion`), the sources it used (with
   digests) and, when a human decided, `decidedBy`. Local files are a
   convenience; the event is the record.
5. **Deterministic where it can be.** Anything computed from chain data
   must be recomputable by someone else from `observed` + `sources`. Model
   output is marked declared, and the figures it talks about never pass
   through the model.
6. **Tests against fixtures.** `npm test` runs offline. Integration runs are
   explicit and env-gated. Mainnet is read-only for code in this repository.
7. **Nothing changes in silence.** A behaviour change is a new version of
   the agent's `alma.yaml` / manifest and a `CHANGELOG.md` line. Prompts are
   versioned files, not strings in code.
8. **Escalation is written down.** `escalation.yaml` names the decisions a
   human takes, who that is, and how long an approval is good for. The
   `decidedBy` block in an event must match it.

## Event catalogue

The envelope and the first types (`cardano.gov.*`, `cardano.pool.*`,
`cardano.treasury.*`, `agent.*`) are specified in the ALMA workspace
document *SPO Sentinel y catálogo de eventos* and will move to
`alma/spec/` once `alma-core` ships `alma-attestation/1`. Until then each
agent keeps the JSON Schemas it emits under `events/schemas/`, and they are
the contract.

## Where things live

| What | Repo |
|---|---|
| Agent code (all of them) | this repository, one directory each |
| On-chain code they rely on (Safe modules, Aiken validators) | `adasouls-contracts` |
| The AdaSouls governance *operation*: policies, runbooks, DRep metadata, `votes/` with analyses, decisions and rationales | `cardano-governance` — agents write their outputs there, they don't live there |
| Protocol, envelopes, verification | `alma` (`alma-core`, `spec/`) |

## Checklist for a new agent

- [ ] Directory with the layout above; `README.md` has a "What it never does" section.
- [ ] Manifest validates with `@adasouls/alma-manifest`.
- [ ] `escalation.yaml` and `security.md` written before the first line of `src/`.
- [ ] Every event type has a schema under `events/schemas/` and a fixture that validates against it.
- [ ] `npm test` passes offline; CI job added to `.github/workflows/ci.yml`.
- [ ] No secret has a default in `.env.example`; `npm run lint` passes.
