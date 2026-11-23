// exp11 entry: Sparkplug-only V8 flags (measured fastest in the Stage 4
// ablation: 320 CPU / 257 wall vs 353/262 for Kestrel's full flag set), then
// the streaming byte CLI. --no-turbofan is LAST so that an unrecognized
// flag earlier in the string cannot swallow it.
require("node:v8").setFlagsFromString("--no-incremental-marking --semi-space-growth-factor=8 --no-parallel-scavenge --no-minor-gc-task --always-sparkplug --no-concurrent-sparkplug --no-turbofan");
require("./engine.cjs").runCli();
