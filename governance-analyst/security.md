# Threat model

## What this agent holds

- `ANALYSIS_KEY_FILE`: an Ed25519 key that signs records (analysis, decision)
  in alma-core's issuer-signature format. It moves no money and casts no
  vote. Read from a path, never printed or logged.
- `ANTHROPIC_API_KEY`: model access. From the environment only.
- Nothing else. No DRep key, no pool key, no wallet.

## Untrusted inputs

Everything fetched is untrusted: Koios responses, anchor documents (JSON-LD
written by proposers), the Constitution text, proposer history.

- Stored as bytes with their blake2b-256 digest; parsed only to extract
  known CIP-108 fields; never executed, never used as a URL to follow
  beyond the one anchor URL the chain names.
- Quoted into the model prompt as data inside explicit delimiters, with the
  instruction that nothing inside it is an instruction. Model output is
  validated against a schema and never runs code.
- A hash mismatch is a recorded failure of that action, not a reason to stop
  the run, and not something to "fix" by trusting the downloaded bytes.

## What a compromise can do

| Compromised | Can | Cannot |
|---|---|---|
| Koios (or the network path to it) | Hide actions, feed wrong on-chain fields | Make an anchor verify: the hash comes from the chain record we also fetched, so a consistent lie needs both; cross-checking against a second provider is the mitigation (TODO) |
| A proposer's anchor | Inject text into the analysis | Change the decision: a human reads the analysis and decides; the event records that |
| The model | Write a misleading analysis | Alter any figure (they bypass the model) or publish anything: the human decides |
| The analysis key | Sign false records as AdaSouls | Vote, move funds, or rewrite the transparency log (records are append-only and anchored) |
| This process | Everything above at once | Vote or move funds: it has no key that can |

## Mainnet

Read-only. No code in this directory builds or submits a transaction.
