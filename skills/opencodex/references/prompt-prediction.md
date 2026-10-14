# Prompt prediction: ghost text and Tab acceptance

Use for “猜你想问”, suggested next prompts, and inline draft completion. A screenshot
can establish appearance, while its caption may describe Tab acceptance. It cannot
establish trigger timing, cancellation, model input, or the target's private prompt.
Record those as assumptions until exercised. Ask only the consequential distinction:
suggest the next whole message when the composer is empty, complete a draft, or both.

Inspect the actual image using the installed image-reading capability. Record its
observed region and state as visual evidence; record a caption's claimed interaction
as a user requirement or unverified report until tested. Do not infer the model,
prompt, latency, history window, or automatic-send behavior from gray text alone.
If the user's request already fixes empty-composer versus draft-completion behavior,
follow it without asking again. Otherwise state a bounded first-version assumption
or clarify only when the choice changes the requested result.

## Small implementation contract

Keep the suggestion separate from the actual draft until accepted. Tab inserts it;
it never sends a message. Esc dismisses it until the context or draft changes. Normal
typing, session switches, submission, a newer prediction, and plugin unload invalidate
older results. Typing must remain immediately responsive while prediction runs.

For an empty-composer first version, trigger once after an assistant turn completes
and the session becomes idle. Use a bounded excerpt of that session's recent visible
conversation. Do not read other sessions or attachments merely to predict a prompt.
For draft completion, debounce edits, require a stable revision, and limit suggestions
to the current insertion point. Do not imply the screenshot proves either policy.

Show a subtle gray suggestion with a discoverable “Tab” hint and an equivalent click
action. Retain an ordinary accessible label. Tab must keep its usual focus/menu role
when no applicable suggestion exists, a slash/reference menu owns the keyboard,
Shift/Alt/Ctrl/Meta is held, or IME composition is active. Never swallow every Tab on
the page. Enter retains the resident composer's normal behavior.

## Verified public DSH seams (0.2.1-alpha.2)

These were read in the published package declarations; they are implementation leads,
not proof that a generated plugin has passed browser acceptance:

- `@deepseek-ai/dsh-client-ui-conversation/client` declares the session-scoped list
  slot `conversation.input.overlay`, rendered inside the resident composer card.
  Use `conversation.input.dock` only when the requested appearance allows a row above
  the card. Do not replace the entire composer for a small suggestion.
- Session standard props include `useInput` and `inputActions`. `InputState` exposes
  `draft`, `draftRev`, `phase`, `attachmentIds`, and reference `occurrences`.
- `inputActions.captureInsertion()` returns a `TokenSpan` with start, end, draftRev.
  `insertText(text, span)` returns false when the draft changed or submission locked
  the editor, and applies the edit as one undo step. Capture before an async request,
  recheck applicability on arrival and on acceptance, and respect a false return.
- Avoid `setDraft` for completion: it replaces the whole document and removes inline
  reference chips. `ComposerKeyboard` and its Lexical editor are package-internal;
  do not import them as a plugin API. If a keyboard hook is absent, a narrowly scoped
  DOM listener must be lifecycle-owned, check the exact editor/session target, and
  fail inert if the expected DOM anchors change.

Declarations are under `lib/types/client/contract/{slots,input,draft-editor}.d.ts`.
Read only the relevant sections, then use the generic scaffold and implement.

Use [dsh-adaptation.md](dsh-adaptation.md) for `scaffold`, build and tarball delivery.
The empty starter's composer dock must be changed to the selected overlay or other
verified surface; retaining its `return null` contribution does not implement ghost
text. Do not rebuild the resident editor or rediscover the whole DSH package graph.

## Model and consumption contract

The generated feature's runtime predictions need their own small, visible budget;
OpenCodex's construction-job budget does not automatically meter a separately installed
plugin. Reuse the user's configured DSH provider. Bound context and output, allow only
one in-flight request per session, abort superseded work, debounce, cache identical
context/revision keys, and enforce a cooldown and per-day cap. A canceled request may
still incur usage. Prediction failure, no credential, exhausted quota, or an empty
response should hide the suggestion without breaking typing. Never add a hidden
external model process or hard-coded API key.

Document how the independent plugin accounts requests and usage, its initial limits,
and how a user disables prediction. Compiling a provider adapter or exercising a fixed
response fixture does not establish that a real model was called or produced useful
suggestions. Keep those results separate and retain failed or irrelevant examples.

## Acceptance scenes

1. Real model produces a relevant next prompt for a synthetic completed conversation.
   Tab inserts it, does not submit, and one Undo restores the previous draft.
2. A delayed response cannot overwrite intervening typing or appear in another session.
3. Esc, IME, slash menu, reference chip, attachments, selection and Shift-Tab preserve
   ordinary behavior. Test at least one Chinese composition sequence.
4. Refresh and plugin unload remove stale ghost text and keyboard listeners; the
   default composer remains usable. Re-enable without duplicate requests/listeners.
5. Observe request count, latency, confirmed usage and cap behavior. Deterministic
   provider fixtures verify routing; they cannot establish real suggestion quality.
6. Compare typography, first-line alignment, wrapping and hint placement at a fixed
   viewport/theme. Report unavailable target states and visual differences explicitly.
