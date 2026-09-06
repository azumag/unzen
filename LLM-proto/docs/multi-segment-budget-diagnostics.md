# Multi-segment browser budget diagnostics

Before generating multi-gigabyte shards, inspect whether the current graph contract can satisfy the browser artifact tiers:

```bash
python tools/diagnose_multi_segment_budget.py \
  /absolute/path/to/model_q4.onnx \
  --hidden-size 2048
```

The diagnostic loads only the ONNX graph metadata and external-data ranges. It does not run ONNX Runtime, generate shards, or claim numerical/browser evidence.

It reports:

- feasibility under preferred (256 MiB), normal (512 MiB), and absolute (1 GiB) ceilings;
- the planner's exact minimum achievable maximum and machine-readable oversized singleton spans when a tier is infeasible;
- every single-layer span estimate;
- the worst single-layer spans and their largest retained external initializers.

Use this report to distinguish "add more decoder cuts" from a graph-decomposition blocker where even the smallest legal span is too large.

## Real Llama-3.2-1B q4 observation

Issue #223 records the first real #167 run against `onnx-community/Llama-3.2-1B-Instruct` revision `14007543b6dc92de88daf96a9aa85d2f95ace6ef`.

The current decoder-layer-only graph contract is infeasible even at the 1 GiB hard ceiling:

- layer 0 alone: about 1070.28 MiB;
- layers 1 through 14 alone: about 68.28 MiB each;
- layer 15 alone: about 1070.29 MiB.

Both edge spans retain the tied `model.embed_tokens.weight` initializer, which is 1002 MiB by itself. Adding rotary caches and one decoder layer pushes the edge artifacts above 1 GiB.

This is not a reason to relax the hard browser policy. It is evidence that the graph needs a different decomposition (for example prefix/postfix edge stages or vocabulary-axis chunking). That runtime/manifest design is tracked separately in #223.

When a tier is infeasible, `multi_segment_onnx.py` preserves the human-readable fail-close error while also exposing the same budget floor and oversized singleton spans through `BrowserArtifactBudgetError.as_dict()`. The diagnostic command emits those fields directly as JSON, so automation does not need to parse error text.

For the pinned real 1B artifact, the command currently reports `minimumAchievableMaximumBytes=1122275890` for all three policy tiers, with `[0,1)=1122266530` and `[15,16)=1122275890` as the oversized singleton spans. The largest retained initializer on both spans is `model.embed_tokens.weight` at `1050673152` bytes.

## CI regression probe

`LLM Proto` CI downloads only the pinned 149 KiB ONNX graph (not the 1.7 GB external weight file) and runs `probe_llama_1b_budget_blocker.py`. Because the graph contains the external-data ranges, the probe can reproduce the exact layer-span estimates and reject drift in the source graph digest, 16-layer contract, hard-policy infeasibility, endpoint singleton sizes, or tied-embedding byte count without paying the bandwidth/storage cost of the full weights.
