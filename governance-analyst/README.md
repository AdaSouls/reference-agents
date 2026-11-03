# governance-analyst

Reads every open Cardano governance action, verifies its anchor against the
chain, and prepares a sourced, signed analysis for a human to decide on. It
publishes the human's decision with the analysis. **It never votes.**

Phase G1 of [`cardano-governance`](https://github.com/AdaSouls/cardano-governance)
(`docs/phases/G1-analyst.md`), built to [`STANDARD.md`](../STANDARD.md).
Its outputs go to that repository's `votes/`; its code lives here.

## What it does

| Step | Command | Status |
|---|---|---|
| 1. Ingest: list open actions on mainnet via Koios, download each anchor, check blake2b-256 against the on-chain hash, store everything under `data/actions/<tx>-<ix>/` | `gov ingest` | **done** (G1.1) |
| 2. Constitution: current text, verified by hash, split into sections with stable ids | `gov constitution` | G1.2 |
| 3. Analysis: structured JSON (summary, what changes, Constitution sections touched, budget notes, for / against, open questions, suggested vote with confidence, conflict-of-interest flag) plus `analysis.md` and a draft CIP-100 rationale | `gov analyse <tx>-<ix>` | G1.3 |
| 4. Review: show the analysis, edit the rationale, record the human's Yes / No / Abstain and reason; compute the rationale's anchor hash like `cardano-cli hash anchor-data` | `gov review <tx>-<ix>` | G1.4 |
| 5. Publish: sign analysis and decision with the AdaSouls analysis key (Ed25519, alma-core issuer-signature format), emit `cardano.gov.analysis` and `cardano.gov.decision`, build the static site | `gov publish` | G1.5 |

## What it never does

- Build, sign or submit a transaction. Votes are cast by a person with a
  Ledger (`cardano-governance/docs/runbooks/drep-vote.md`) or, later, by the
  mandate DRep in `adasouls-contracts/cardano/agent_drep` with that person's
  signed authorization.
- Hold or read a DRep key, a pool key or any key that moves money.
- Execute or follow anything found inside a proposal or an anchor. They are
  stored as bytes and quoted as data (`security.md`).

## Run

```bash
npm install
cp .env.example .env         # the public Koios endpoint needs no key
npm start -- ingest          # open actions; add --all for closed ones too
npm start -- list
```

Exit code 2 when any anchor mismatched, so a cron job notices.

```
verified    8d6c…-0  InfoAction          14213 bytes
mismatch    3f1a…-0  TreasuryWithdrawals  expected 9b2c0e1f…  got 71aa03de…
unavailable c0de…-1  ParameterChange      HTTP 404
```

A mismatch keeps the bytes the proposer actually served (`anchor.bin`) next
to the verdict (`check.json`): a reviewer can see what was there.

## Layout

```
governance-analyst.yaml   ALMA manifest: capabilities analyze, attest; no pay
agent.yaml                profile, scope, budgets
escalation.yaml           the vote is the human's; who, how, recorded where
security.md               threat model
context/sources.yaml      Koios, anchors, Constitution: trust per source
events/schemas/           cardano.gov.action_observed (more as phases land)
src/koios.ts              the slice of Koios we read, validated with zod
src/anchor.ts             fetch + blake2b-256 verify, size and time limits
src/store.ts              data/actions/<tx>-<ix>/{onchain.json, anchor.bin, check.json}
src/ingest.ts             the G1.1 pipeline
src/cli.ts                gov ingest | list
test/                     fixtures recorded; nothing touches the network
```

## Tests

```bash
npm test      # 8 tests, offline
npm run lint
```

## Known gaps

- One indexer (Koios). `security.md` names cross-checking against a second
  provider as the mitigation for a lying indexer; not built.
- `ipfs://` anchors are recorded as unavailable until a gateway policy is
  chosen (which gateway, and whether its bytes count as the anchor).
- No event is emitted yet: `events/schemas/cardano.gov.action_observed.json`
  is the contract, and emitting it waits for `alma-attestation/1` in
  `alma-core` and an SDK method for attestations about external subjects.
