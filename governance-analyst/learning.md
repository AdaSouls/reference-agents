# What may change without a new version

Nothing, by default. The analyst has no memory between runs and no
parameter that moves on its own. Concretely:

| Thing | Changes how |
| --- | --- |
| Prompt | A new `prompts/analyse.vN.md` file and `PROMPT_VERSION`; every eval recording becomes stale and is re-recorded on purpose. |
| Gates (figures, citations, schema) | Code, with a test for the answer they newly reject. |
| Net Change Limit recognised | A PR to `context/treasury.yaml` citing the Info action. |
| Constitution in force | Re-derived from the chain by `gov constitution`; the stored split is rebuilt when the splitter version changes. |
| Model | `ANALYSIS_MODEL`; the record names the model that ran. |
| Weights, thresholds, heuristics | There are none to tune. |

What the agent learned, as a team, is in this repository's history and in
the eval cases: each case is a mistake we do not want to make twice.

## Mistakes already turned into cases or gates

- Figures the model computed itself (a sum of withdrawals, a percentage of
  the treasury) were wrong often enough that every figure now needs a
  `FACTS` path or a field of the proposer's document.
- Citations to Constitution section ids that do not exist in the version
  in force: now rejected.
- Public IPFS gateways rate-limit; one gateway meant "unavailable" for real
  anchors. Several are tried; the hash still decides.
- The Constitution split kept an old version's sections after a splitter
  fix; the stored split is re-made when the splitter version changes.
- An analysis that did not know the vote was failing, or that the treasury
  had 42M ADA left of its limit, argued in a vacuum: both are FACTS now.
