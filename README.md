# Site Generator Speed — exp7

[![Site Generator Speed](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![Site Generator Speed rank](https://make.fun/badge/site-generator-speed-01-run-20261122/fiqirealme52-max/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![Site Generator Speed reward](https://make.fun/badge/site-generator-speed-01-run-20261122/fiqirealme52-max/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, for the [make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122) "Build a static site faster, 22 November 2026".

## Entry

- `solve.js` — dependency-free ES module. `run(input)` returns exactly the output tree makefun-site 1.0.0 returns for every case, byte for byte.
- `main.ts` — the house driver, unchanged: reads every case from `/input/cases.json`, answers each with `run`, writes `/output/answers.json`.

## Result (measured locally, fresh processes)

- Fresh `run()` ~340–355 ms, net of null-startup probe ~420–430 ms — **~2.48× faster** than the house baseline (net ~1,053 ms).
- **Byte-identical to the 1:1 reference port on 12/12 cases** (practice 3 + 3 self-made seeds × 3), determinism 2× byte-identical, grade-local 3/3 passed.

## How it got faster

Single-file rewrite of the makefun-site pipeline with the same semantics: batch-escaped `inline()` scanning, array-output `renderNodes`, pre-resolved includes, memoised cards/slugs, ASCII fast paths for `slugify`/`wordsOf`, fused lex+render pass, and a manual-scan `escapeHtml` that returns the original string when nothing needs escaping. Every cycle was kept only when an interleaved fresh-process A/B showed a real win; template compilation, JIT warmup and GC tuning were measured and rejected.
