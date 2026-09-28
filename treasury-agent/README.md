# treasury-agent

Reference implementation of AdaSouls's headline scenario: **"put 500
USDC of idle treasury to work."** Demonstrates ALMA identity, delegation,
self/counterparty policy, `EconomicAction` execution, and audit history
— built entirely against `@adasouls/sdk`, no internal shortcuts (see
`reference-agents/REPOSITORY.md` in `alma`). If this agent needed
something the SDK doesn't expose, that would be an SDK gap to fix, not
something special-cased here.

`src/treasury-agent.ts` is the actual agent — every line in it talks to
AdaSouls through nothing but the public SDK. `src/setup.ts` is the
one-time admin bootstrap (create an org, agent, policies, a delegation,
an API key) that a human does once, over real REST with a real Auth0
token — not part of the agent's own runtime, and not something the SDK
covers yet (there's no console either, Phase 10).

Since Phase 9, `setup.ts` reads [`treasury-agent.yaml`](treasury-agent.yaml)
(an Agent Manifest, `@adasouls/alma-manifest`) instead of hardcoding the
policy/delegation shape inline — proving that package's exit criterion
for real ("the Treasury Agent's configuration can be expressed as, and
reproduced from, a manifest file") by actually driving this repo's own
setup from it.

## Setup

```bash
npm install
cp .env.example .env
```

1. Get a real Auth0 access token the same way `adasouls-api`'s own docs
   describe (client_credentials grant against your Auth0 tenant) and set
   it as `AUTH0_TOKEN` in `.env`.
2. Point `ADASOULS_API_URL` at a running `adasouls-api` (e.g.
   `http://localhost:3000/v1` for local dev).
3. `npm run setup` — creates the organization/agent/policies/delegation/
   API key, and prints the `ADASOULS_API_KEY`/`AGENT_ID` to put in `.env`.
4. `npm start` — runs the actual demo: puts 500 USDC to work, then
   prints the agent's identity/authority/reputation/recent history.

## Testing

```bash
# in adasouls-api: podman-compose up -d, npm run dev, then:
cd adasouls-api && npm run create-treasury-agent-test-fixture
# copy the printed export lines, then in this repo:
ADASOULS_API_URL="http://localhost:<port>/v1" \
ADASOULS_TEST_API_KEY="ak_..." \
ADASOULS_TEST_AGENT_ID="alma:main:agent:..." \
npm test
```

`create-treasury-agent-test-fixture` reads the exact same
`treasury-agent.yaml` `src/setup.ts` does (via `@adasouls/alma-manifest`)
but calls `adasouls-api`'s service layer directly instead of REST, so
the test suite doesn't need a live Auth0 token — the two can't silently
drift since there's only one manifest, not two hand-written copies of
its values.

## Known gaps

- `src/setup.ts` hasn't been verified end to end against a real Auth0
  token. The test suite verifies the actual agent runtime
  (`src/treasury-agent.ts`) via the service-layer fixture instead, which
  is the part that matters for "zero internal shortcuts."
- No CI integration run yet — same reasoning as `adasouls-sdk-typescript`'s
  README (no deployed `dev` environment to point at).
