# Runtime features: asynchronous compaction

Use this route for context management, background model work and other features whose main contract is execution state. A screenshot can explain the feature; it cannot prove that no conversation content was lost.

## Establish the target contract

Separate the announcement, the implementation and the installed target. The public Codex `async_compaction.rs` reviewed on 2026-10-15 tracks a background candidate, history/model identity and cancellation. Its enablement checks an experimental feature plus a provider with Remote Compaction V2 support. That does not establish availability for every account, desktop version or model. The supplied social screenshot's 65% default remains unverified here.

Source: [Codex async compaction](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/async_compaction.rs). Pin the commit/version when beginning an actual reproduction.

The DSH implementation must use its own supported model route and public session/compaction contracts. An OpenAI-specific remote compaction protocol is not an available DeepSeek implementation merely because its client code is public.

## Resolve feasibility before implementing

Inspect only the installed `@deepseek-ai/dsh-compaction`, `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session` and token-meter declarations needed for the next decision. Record exact versions and declarations. Do not read the whole framework.

Answer these questions with an API path or a precise missing extension point:

- Can the plugin capture a balanced immutable history prefix and its revision while the foreground continues?
- Can it adopt the result at a request boundary, preserving every subsequent user/tool/assistant event exactly once and in order?
- How does it coexist with the current compaction owner and foreground overflow fallback?
- Can it cancel its worker and discard stale results on reset, model change, unload and shutdown without changing the raw event log?
- Are summary requests routed through the same metering and cancellation seams as ordinary model calls?

If the SDK offers only an awaited whole compaction operation, do not label an unawaited call equivalent. A background promise alone does not establish safe concurrent mutation. Record any required host API as a blocker; do not patch private methods in the user's host.

## Independent acceptance obligations

Use a deterministic summarizer with a controllable barrier before a paid quality test. Capture the selected event IDs and revision, hold its result, append new user input and a tool call/result, then release it. Compare the adopted model-visible history with the expected prefix summary plus exact untouched suffix.

Test concurrent triggers, stale candidates, cancellation, a foreground context overflow, a failed summary, reload, fork and plugin unload. Assert original log preservation, balanced tool IDs, at most one worker per session, no lost or duplicate messages, and bounded fallback/retry. Add a metered real-model run only after these mechanics pass.

Measure foreground blocked time, compression time, token usage and retained constraints. Report behavioral correctness separately from perceived latency. A faster run with lost user instructions is a failure.

OpenCodex currently requires a visual scope for every accepted package. That UI-specific schema must be made explicit about runtime-only applicability before this use case can claim automatic acceptance. Do not manufacture screenshots or a passed visual row to satisfy it. Runtime compaction is a pending capability, not a shipped OpenCodex output.
