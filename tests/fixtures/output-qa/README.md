# Real DSH output acceptance driver

This fixture supplies deterministic **test stimuli**, not a replacement feature. Public DSH `0.2.1-alpha.2` supplies the real SessionController, agent loop, Tools service, UserQuestions service, persisted projection, and UI renderer. The fixture does not change the DOM, render a question, or replace the composer. Install the actual generated plugin separately.

Its local model adapter emits real tool calls and short receipts without making model API requests. Usage is zero for this deterministic adapter. A global `llm/stream` guard rejects every other provider; the overlay also disables the standard external providers and automatic model-generated titles. Ordinary and timed cases call the actual `ask_user_question` tool. The synthetic plan tool calls the real `userQuestions.ask()` with a `plan-review` intent.

## Create a separate instance

Use a repository checkout with `npm ci` completed. Run these commands from the repository root. No model credentials are needed. Choose an empty directory dedicated to this test, outside daily DSH storage:

```sh
export OPENCODEX_QA_HOME="$(mktemp -d "${TMPDIR:-/tmp}/opencodex-output-qa.XXXXXX")"
export DSH_HOME="$OPENCODEX_QA_HOME"
export OPENCODEX_QA_CONTROL_PORT=53752
node tests/fixtures/output-qa/init.mjs
node node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile output-qa --from-default-profile web \
  --patch "$OPENCODEX_QA_HOME/output-qa.patch.yml" \
  --host 127.0.0.1 --port 53751 --no-open
```

The initializer writes a dedicated marker and generates the overlay with this checkout's absolute module path. It refuses the daily `~/.dsh` directory and its descendants, filesystem/home roots, symlinks, and populated directories without a valid fixture marker. The running plugin and control CLI require both `OPENCODEX_QA_HOME` and `DSH_HOME` to resolve to that marked directory. A separate profile alone is insufficient because profiles can share storage and dependencies.

Open the authenticated local URL printed by DSH. Keep its token private. Stop the instance with Ctrl-C before installing the generated artifact:

```sh
export FEATURE_TGZ="/absolute/path/to/the-actual-generated-plugin.tgz"
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin \
  --profile output-qa add "$FEATURE_TGZ"
node node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile output-qa \
  --patch "$OPENCODEX_QA_HOME/output-qa.patch.yml" \
  --host 127.0.0.1 --port 53751 --no-open
```

Subsequent launches omit `--from-default-profile web`. Keep the fixture overlay last if adding other overlays. If the checkout moves, stop DSH and rerun `init.mjs` in the new location. This fixture is distributed as test source in Git, not installed in everyday profiles or included in the main plugin package.

The control endpoint binds only to `127.0.0.1`. It requires a custom header and rejects every request carrying an `Origin` header. Use the supplied CLI from another terminal with the same environment variables. If a port is already occupied, choose another web port and set `OPENCODEX_QA_CONTROL_PORT` consistently for DSH and the control CLI. The commands above do not assume an existing local DSH instance can be reused.

## Exercise the actual interface

```sh
node tests/fixtures/output-qa/control.mjs create ordinary
node tests/fixtures/output-qa/control.mjs trigger SESSION_ID
node tests/fixtures/output-qa/control.mjs status
node tests/fixtures/output-qa/control.mjs cancel SESSION_ID
```

`create` returns a real session ID and makes a sidebar session named `Output QA · ordinary · …`. A harmless local initialization turn makes the session visible. Open it in the real DSH UI **before** triggering the question. Enter a unique draft such as `QA-DRAFT-ordinary-01` and attach a small synthetic text or image file through the ordinary UI.

After `trigger`, the local adapter emits the actual tool invocation. Verify the generated feature in the browser: the ordinary composer remains editable, the draft and attachment survive, and answering the question does not send the draft. Separately test ordinary send while a question is pending; it may queue behind the pending tool. Use the actual question UI to answer. `status` shows projection state, inbox counts, and recent real `user/message`, `tool/call`, `tool/result`, and `turn/end` receipts so the ordinary message and question answer can be correlated independently.

| Create command | Actual service path | Checks |
| --- | --- | --- |
| `create ordinary` | Legacy `ask_user_question` → `userQuestions.ask` | Pending question and composer coexist; draft, attachments, ordinary send/queue, and answer ID stay correct |
| `create timed` | Timed `ask_user_question(timeout:5)` → `askTimed` | Open the session before triggering; let five seconds pass; observe `continued`; answer late and confirm the original `user-question-reply` is admitted |
| `create plan` | `output_qa_plan_review` → `ask(intent:{kind:"plan-review"})` | Plan rendering and approval/rejection remain unchanged by an ordinary-question-only plugin; draft returns after review |

Also exercise refresh and switching sessions while a question is pending. For timed cases, the late answer is settled when the real agent admits its `user-question-reply`; the local adapter completes that turn immediately. After process restart, inspect the existing session using the normal DSH UI. The fixture's stimulus registry is intentionally process-local, so create fresh fixture sessions for new control commands.

For unload coverage, stop DSH, remove only the generated feature plugin from this isolated profile using normal DSH plugin management, relaunch, and repeat the ordinary scenario. Confirm the original question/composer behavior returns and no style or listener remains. Keep the test driver present until acceptance is complete. Delete only the dedicated test directory when finished.

## Evidence and limits

Record the actual feature tarball hash, pinned DSH version, before/after screenshots, observed draft and attachment behavior, and event identities. A deterministic fixture proves behavior of this installed DSH service/UI path for the exercised cases. It does not establish real-model quality, general task success, or visual equivalence to an inaccessible Codex interface. A screenshot match alone is insufficient for state behavior, and a passing tool response is insufficient for UI acceptance.

This portable driver is adapted from the private local acceptance stimulus. Its guard tests and syntax checks can be run without starting a server or loading account configuration:

```sh
node --test tests/fixtures/output-qa/home.test.mjs
node --check tests/fixtures/output-qa/index.mjs
node --check tests/fixtures/output-qa/control.mjs
node --check tests/fixtures/output-qa/init.mjs
```

These checks do not count as a completed browser acceptance run. Keep all test content synthetic: the status response deliberately includes recent test message and tool receipts.
