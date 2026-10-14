# Behavior and visual acceptance

Use a finite acceptance contract written before implementation. Each assertion has a fixture, action, expected result, evidence path, target version, candidate build digest, and one of pass/fail/not-run/blocked. Keep the evidence that contradicts a proposed implementation.

For every UI feature, the acceptance handoff begins with a short explanation of the feature, user benefit, and states tested. Include a real Codex reference image and a real DSH image of each required comparison state, with registered screenshot artifact IDs and captions. Use user-supplied references, authorized DSH CUA captures, or attributed official-source images; record unknown versions and scope limits. Never replace missing Codex evidence with a DSH image, a mockup, or a generated demonstration.

Run four layers as applicable:

1. Pure behavior checks: state transitions, correlation IDs, idempotency, budget accounting, persistence migrations and cancellation.
2. Package checks: clean install/build, declared exports, runtime load/unload, and no bundled research data.
3. Real isolated DSH: actual registration, working interactions, reload/restart, two-session isolation, errors, uninstall and restoration.
4. Target comparison: same scenario and visual state in the real reference and candidate.

A mock can prove handling of a specific adapter response. It cannot prove provider connectivity, target behavior, a real DSH session, visual parity or complete feature reproduction. A preview page or HTTP 200 is not host acceptance.

Persist command output and screenshots under the job workspace. Report generated-code self-tests with the job's verification action. That report never grants install permission or substitutes for host-controlled validation. If a required check cannot run, preserve the artifact and exact blocker with a reproducible next step.

Register actual PNG/JPEG/WebP screenshots of at most 2 MiB with workspace-relative paths and `screenshot: {subject, caption, provenance, sourceUrl?, version?}`. View the images using the available image tool; file-signature checks alone are not visual inspection. For a user-recorded visual `passed` result, `verification.screenshotIds` must select at least one registered `subject: "codex"` and one `subject: "dsh"` image. Use matching states and the current candidate digest; a technically accepted pair does not by itself prove visual equivalence. The agent action remains a report and cannot certify this result.

If the Codex reference, DSH capture, image-reading capability or permitted UI access is missing, report the outcome as partial, with visual `not-run` or `blocked`. Preserve any independently passed behavior/package checks. Do not grant readiness or describe the feature as fully reproduced. Public-source images show the publisher's scenario; they do not prove that the same feature is available on the user's account.

Before the user chooses installation, provide the behavior implemented, visual differences, versions tested, limits, required permissions/dependencies, package digest and rollback procedure. After changes, rerun the affected assertions against the new digest; prior screenshots do not verify new code.

The repository's use-case document provides starter scenarios. They remain planned or not-run until real evidence is recorded. Sources: `playwright-visual`, `aria-combobox`, `dsh-plugin-manager`.
