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
| 2. Constitution: the one in force (latest enacted `NewConstitution` action), bytes verified against its on-chain anchor hash, split into sections and guardrails with stable ids (`art-2-sec-7`, `app-1-s2-1`, `PARAM-03a`) | `gov constitution` | **done** (G1.2) |
| 3. Analysis: one model call over verified facts, the Constitution in force and the proposer's document quoted as data; structured JSON checked before anything is written (every figure cites a `FACTS` path and matches it; every Constitution id exists), then `analysis.md` and a draft CIP-100 rationale | `gov analyse <tx>-<ix>` | **done** (G1.3) |
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
                             # honours HTTPS_PROXY; set NODE_EXTRA_CA_CERTS behind a TLS-inspecting proxy
npm start -- constitution   # the Constitution in force; IPFS_GATEWAY and CONSTITUTION_MIRRORS in .env
npm start -- analyse <tx>-<ix>   # needs ANTHROPIC_API_KEY; exit 3 = the model's answer failed a check, nothing written
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
                          data/constitution/<hash>/{constitution.md, sections.json, source.json}
src/ingest.ts             the G1.1 pipeline
src/constitution.ts       which Constitution is in force; the splitter (sections + guardrails)
src/constitution-sync.ts  gov constitution: fetch via anchor or mirrors, verify, store
src/facts.ts              the verified facts the model may cite; lovelace -> ADA exactly; CIP-108 fields
src/analysis.ts           schema, prompt assembly, the checks (figures, citations), markdown + rationale draft
src/analyse.ts            gov analyse: store -> prompt -> model -> checks -> files
src/model.ts              the one place the model is called (Anthropic SDK; injectable)
prompts/analyse.v1.md     the system prompt, versioned
src/cli.ts                gov ingest | list
test/                     fixtures recorded; nothing touches the network
```

## Tests

```bash
npm test      # 23 tests, offline (the model is simulated)
CONSTITUTION_FILE=path/to/cardano-constitution-2.txt npm test   # also gate 2: full text hashes to the on-chain anchor
npm run lint
```

## What an analysis looks like

`data/actions/<tx>-<ix>/analysis.md`: a header with the on-chain facts
and the anchor verdict; summary; what changes if it passes; the
Constitution sections it touches, each with *governs / supports /
tension*; tensions; budget notes; arguments for; arguments against; open
questions (including any instruction-like text found in the proposal);
the suggested vote with a confidence, marked *declared, not decided*;
conflict of interest; and a table of every figure used with the `FACTS`
path it came from. `analysis.json` holds the same plus the digests of the
inputs, the prompt version and the model. `rationale.draft.jsonld` is the
CIP-100 draft the human edits in review.

Gates from the test plan covered in code: 3 (no invented figures), 4
(prompt injection quoted as data, delimiter escapes neutralised), 5
(citations resolve). Gate 6 (two humans read the first five analyses cold)
is a process, not code.

## Known gaps

- One indexer (Koios). `security.md` names cross-checking against a second
  provider as the mitigation for a lying indexer; not built.
- `ipfs://` anchors go through `IPFS_GATEWAY` (default in `.env.example`:
  `https://ipfs.io/ipfs/`). The gateway is untrusted like any host: the bytes
  still have to hash to the on-chain anchor hash, so a lying gateway yields
  a mismatch, never a false "verified". `check.json` records `fetchedFrom`.
  Unset, `ipfs://` anchors are recorded as unavailable.
- No event is emitted yet: `events/schemas/cardano.gov.action_observed.json`
  is the contract, and emitting it waits for `alma-attestation/1` in
  `alma-core` and an SDK method for attestations about external subjects.
