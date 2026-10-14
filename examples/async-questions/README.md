# Async Questions for DSH — experimental 0.1.0

A standalone plugin intended to keep DSH's ordinary message composer visible
while a normal `ask_user_question` card is pending. It reuses DSH's existing
question card, answer handling, and retained composer. OpenCodex is not required
to run this package. The plugin does not call a model or add a model provider.

The contribution selects only the current session's pending `question` kind.
Plan review and other pending interactions do not receive its marker. A scoped
stylesheet reveals the retained composer and places the existing question card
above it. Unloading the plugin disposes its contribution and stylesheet.

## Compatibility and installation

Built against the public DSH `0.2.1-alpha.2` packages and Cordis
`4.0.5-alpha.1`. The CSS relies on DSH's current DOM attributes and `:has()`;
those DOM attributes are not a stable layout API. Test again before using a
different DSH version. Node 22.19 or newer is required to build; Node 24 LTS is
recommended.

Install the release archive into a disposable DSH environment first:

```sh
export DSH_HOME="$PWD/.dsh-async-questions-qa"
dsh --profile async-questions-qa --from-default-profile web --dump-config
dsh plugin --profile async-questions-qa add ./dsh-opencodex-async-questions-0.1.0.tgz
dsh --profile async-questions-qa
```

Use that same `DSH_HOME` and profile when launching DSH. A separate profile alone
does not isolate all DSH data. To remove the feature, disable or remove
`dsh-opencodex-async-questions` using DSH's plugin management and reload the UI.

From source:

```sh
npm ci
npm test
npm run package
```

The archive is written to `release/`. Tests run against the compiled client
loader, so a stale build cannot silently satisfy them.

## Provenance

This source was produced in an actual OpenCodex research session running inside
DSH with DeepSeek V4 Pro. It started from OpenCodex's generic eight-file plugin
scaffold, which contained no question feature. The operator supplied the goal,
guided the model after research loops, and resumed bounded runs. This is a
human-guided generated example, not proof that arbitrary features are recreated
without intervention.

After copying the generated source into this example, the maintainer changed
the no-DOM branch of the stylesheet effect to return an empty disposer so that
it satisfies Cordis's type contract. The maintainer also added this README and
the focused tests. The generated marker and stylesheet behavior was retained.

No proprietary Codex code or UI assets are included. This implements the desired
interaction using DSH's own UI; native Codex visual equivalence was not verified.

## Validation and remaining work

Type checking, compilation, compiled-loader registration, exact-session marker
selection, question/plan/idle transitions, and lifecycle cleanup are covered by
the included Node tests. Their slot and document objects are explicit contract
doubles; they do not render a browser or execute CSS.

**Full interactive acceptance is still outstanding.** In particular, this
package has not yet passed a complete installed-browser check for computed
layout, simultaneous ordinary send, attachments, draft preservation, timed
questions and late answers, refresh, or real plugin unload. Passing the Node
tests or installing the archive is not evidence that those behaviors passed.

The acceptance sequence is: open an ordinary question with a saved draft; edit
and send independently of the answer; submit the answer; repeat with an
attachment, a timed question and late answer, session switches and refresh;
confirm plan review retains its original behavior; unload and confirm DSH's
original question takeover returns. Record separate behavior, visual, and
lifecycle results before marking the artifact ready for daily use.
