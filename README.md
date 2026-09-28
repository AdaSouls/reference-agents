# reference-agents

Working example agents built on [AdaSouls](https://github.com/AdaSouls)
using nothing but the public [`@adasouls/sdk`](https://github.com/AdaSouls/adasouls-sdk-typescript)
— no internal shortcuts. If an agent here needs something the SDK doesn't
offer, that's a gap in the SDK, not a reason to special-case this repo.
Identities, delegations and policies follow the
[ALMA](https://github.com/AdaSouls/alma) protocol. MIT licensed.

## Treasury Agent

> "Put 500 USDC of idle treasury to work."

An agent that pays a vendor under its organization's self and counterparty
policies: the payment is authorized only within its limits, and only to a
vendor with real, verifiable history. Its setup is declared in an ALMA
Agent Manifest (`treasury-agent/treasury-agent.yaml`).

See [`treasury-agent/README.md`](treasury-agent/README.md) for setup and
testing.

> **No hosted API yet.** Point the agent at your own `adasouls-api` with
> `ADASOULS_API_URL`.

## Coming later

Procurement, billing and marketplace agents.

Code comments cite AdaSouls design documents (`REPOSITORY.md`, `ADR-NNN`)
that are not published yet.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
