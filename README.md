# reference-agents

Production-grade demos proving the AdaSouls public SDK/API actually
works, end to end, with no internal shortcuts. If a reference agent
needs something the public SDK doesn't offer, that's a bug in the SDK,
not a reason to special-case this repo. See
`docs/repositories/reference-agents/REPOSITORY.md` in `alma` for the
full design.

## Treasury Agent

> "Put 500 USDC of idle treasury to work."

See [`treasury-agent/README.md`](treasury-agent/README.md) for setup and
testing.

## Coming later

Procurement Agent, Billing Agent, Marketplace Agent (Phase 13+) — see
`docs/repositories/reference-agents/REPOSITORY.md`'s "Responsibilities".

## Status

Treasury Agent (Phase 7), built alongside `adasouls-sdk-typescript`.
