/**
 * No test reaches the network (STANDARD.md rule 6). Anything that calls the
 * real fetch fails loudly with the URL, so a test that forgot to pass its
 * recorded fetch is found at once, not when CI's runner happens to be
 * offline. LIVE_TESTS=1 turns the guard off for the env-gated live suites.
 */
if (process.env.LIVE_TESTS !== "1") {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    throw new Error(`test tried to reach the network: ${url} (STANDARD.md rule 6; set LIVE_TESTS=1 for live suites)`);
  }) as typeof fetch;
}
