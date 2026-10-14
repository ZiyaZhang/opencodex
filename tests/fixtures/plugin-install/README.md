# Native plugin installation integration

Run from a checkout with `npm ci` completed and an actual generated feature tarball available (the async-questions archive is also attached to the GitHub prerelease):

```sh
node tests/fixtures/plugin-install/run.mjs /absolute/path/to/dsh-opencodex-async-questions-0.1.0.tgz
```

The default input is the real `dsh-opencodex-async-questions-0.1.0.tgz` output package. An optional argument can select another independent tarball whose Host entry has the same name as its package. The runner creates a fresh DSH_HOME under `.local/native-install-*` and starts public DSH on port 53753 without opening a browser. It does not load OpenCodex, copy credentials, create sessions, or call a model. Existing profiles and running previews are unchanged.

The first phase invokes OpenCodex's installation controller with **synthetic acceptance records**, exercising its boundary against the real native `pluginManager.installBundle`. Subsequent DSH restarts check installed/enabled persistence and active Host registration, then native disable, re-enable, remove, and absence after another restart. Every phase uses the native manager, retains a JSON result and process log, and shuts down its process. No package operation can target a home other than the newly marked fixture home.

This proves installation orchestration and Host lifecycle for this package/version. Synthetic acceptance is only test input; it does not establish the feature's interaction correctness, visual similarity, or ordinary-use readiness. The separate output QA driver and actual user checks cover feature interactions.
