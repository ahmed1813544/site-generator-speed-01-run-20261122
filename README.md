# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ahmed1813544/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ahmed1813544/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

SwiftSite is a faster drop-in for makefun-site 1.0.0: it builds the same static sites byte for byte, about 3× faster on the solve work (fused single-pass Markdown rendering, hand-scanned front matter, compiled templates, per-case slug caches).

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` and writes `/output/answers.json` (`MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for those paths outside a container). `solve.js` is a dependency-free ES module whose `run(input)` returns the output tree makefun-site returns for one case's site, byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?ref=b3qn12jq&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
