# Changelog

Versions follow package.json. A new prompt version, a new FACTS field or a
new event type is a new minor; a changed check that can reject an answer it
accepted before is noted as such.

## 0.1.0

The analyst as it runs on mainnet today.

- `gov ingest`: every open action, anchor fetched and hashed like
  `cardano-cli hash anchor-data`, mismatches kept as evidence; the whole
  proposal list stored.
- `gov constitution`: the Constitution in force from the latest enacted
  NewConstitution, split into sections and guardrails (splitter v2).
- `gov analyse` (prompt `analyse.v3`): FACTS + Constitution + the proposer's
  document → model → gates (schema, figures sourced to FACTS or quoted from
  the document, citations exist) with up to three attempts; FACTS carry
  voting state against thresholds, the Net Change Limit remaining
  (`context/treasury.yaml`) and the proposer's history.
- `gov review`: records the person's decision, writes the CIP-100
  rationale, signs analysis and decision with the agent's ALMA key.
- `gov publish`, `gov anchor`: into AdaSouls/cardano-governance.
- Runs under its own ALMA: `alma.yaml` + `.alma/` from `alma connect`, a
  guard before every command (`gov whoami` shows what it runs as).
- `npm run check`: the standard, checked by a machine. `npm run eval`: three
  cases that pin the judgement.
- Dependencies: zod 4 (GHSA-mrhx-c7xc-m3w5 in zod 3); `overrides` forces it
  into `@adasouls/alma-core` and `@adasouls/alma-manifest` until `alma`
  moves to zod 4 itself. `@anthropic-ai/sdk` 0.80 has two moderate
  advisories in its memory tool, which this agent does not use; the 1.x
  upgrade is a separate change.
