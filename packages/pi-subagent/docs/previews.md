# Preview notes

[Back to the README](../README.md)

The README images are native screenshots of Pi 1.3.0 running in Ghostty with Lune Core, Core
Theme, Dock and Subagent. The coordinator starts two real subagent sessions. The sessions read
sample files with Pi's tools, record a report and appear in the production Dock and `/agents`
inspector. The settings image is the production Auto tiers menu.

Only the model endpoint is scripted. A temporary HTTP server on the loopback interface returns
predefined responses without calling a model service. The explorer's final response waits while
the screenshots are taken, leaving a running agent beside a completed reviewer. These are
illustrative tasks, not model-quality or timing benchmarks. The tier models shown are local
preview models, not recommendations; the capture does not exercise automatic classification.

The capture uses separate temporary settings, definitions, sessions and a sample Git repository.
It does not load personal extensions or credentials. PNGs come from macOS `screencapture` of the
native terminal window. The capture scripts and working logs are local release-preparation
artifacts under the repository's ignored `.scratch/` directory.

`capture.json` records the terminal dimensions, package versions and extension entry hashes for
`subagent-overview.png`, `subagent-inspector.png` and `subagent-auto-tiers.png`.
