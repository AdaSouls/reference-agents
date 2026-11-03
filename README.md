# reference-agents

Working example agents built on [AdaSouls](https://github.com/AdaSouls)
using nothing but the public [`@adasouls/sdk`](https://github.com/AdaSouls/adasouls-sdk-typescript)
— no internal shortcuts. If an agent here needs something the SDK doesn't
offer, that's a gap in the SDK, not a reason to special-case this repo.
Identities, delegations and policies follow the
[ALMA](https://github.com/AdaSouls/alma) protocol. Every agent here has the
same shape and follows the same rules: [`STANDARD.md`](STANDARD.md). MIT
licensed.

## Treasury Agent

> "Put 500 USDC of idle treasury to work."

An agent that pays a vendor under its organization's self and counterparty
policies: the payment is authorized only within its limits, and only to a
vendor with real, verifiable history. Its setup is declared in an ALMA
Agent Manifest (`treasury-agent/treasury-agent.yaml`). It can also pay
from its own wallet through the SDK's guarded wallet, with its payment
records on disk so a restart never pays twice.

See [`treasury-agent/README.md`](treasury-agent/README.md) for setup and
testing.

> **No hosted API yet.** Point the agent at your own `adasouls-api` with
> `ADASOULS_API_URL`.

## Governance Analyst

> "Read every open governance action and tell me what it does, what the
> Constitution says, and what you'd vote — then I decide."

An agent for Cardano governance that ingests every open action from Koios,
verifies each anchor against its on-chain hash, and (in the phases that
follow) writes a sourced analysis and a draft rationale for a human to
decide on. It never votes and never touches a key. Its outputs land in
[`cardano-governance`](https://github.com/AdaSouls/cardano-governance)'s
`votes/`. See [`governance-analyst/README.md`](governance-analyst/README.md).

## Coming later

The rest of the Cardano governance set (`spo-votes`, `drep-mandate`,
`delegation-concierge`, `treasury-verifier`), the SPO Sentinel, and
procurement, billing and marketplace agents.

Code comments cite AdaSouls design documents (`REPOSITORY.md`, `ADR-NNN`)
that are not published yet.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
