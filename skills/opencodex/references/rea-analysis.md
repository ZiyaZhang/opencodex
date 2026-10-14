# REA and packaged JavaScript analysis

Use static package analysis to explain an observed feature or answer a specific missing link. Prefer public source when it already answers the question. Record the exact REA version and current advertised schemas; repository main and the installed release can differ.

For an explicitly selected local ASAR or extracted JavaScript application, inventory format, size and digest before analysis. Use the installed JavaScript analysis tool and request a summary only if that schema supports it. Save the returned evidence identity and graph; inspect relevant modules or paths rather than regenerating the entire analysis. Native disassemblers are unnecessary for a purely JavaScript question.

Follow a concrete seed such as the visible label, route, event, component, or tool name. Trace the renderer handler, state store, IPC/preload boundary, main-process service, persistence, and cloud call only as far as evidence supports. Module proximity, bundled names, feature flags and dead code are candidates, not proof of execution. A source map may be absent or refer to source that was not shipped.

When comparing releases, use immutable input copies and matching analysis settings. Preserve target and evidence digests. Compare changed regions with the existing graph; correlate them with the same runtime scenario. Do not rewrite the installed app or its updater configuration as part of inspection.

Keep extraction in the research workspace. Do not execute extracted application code just to inventory it. Prevent archive traversal and symlink escape when choosing extraction tools. No credentials, private prompt text, bundled application source, or user data belongs in the generated public package; implement the observed behavior with original code.

Sources: `rea-entry`, `rea-javascript`, `rea-evidence`, `rea-contracts`, `electron-asar`. These guides explain concepts; actual tool names/arguments come from the running provider.
