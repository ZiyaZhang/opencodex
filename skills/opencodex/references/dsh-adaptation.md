# DSH capability mapping and plugin development

Identify the actual DSH version and relevant public SDK packages before designing the plugin. Inspect only the services, tools, slots/factories, package exports, and lifecycle needed for the selected behavior; use saved evidence when the version is unchanged. Avoid importing private source files from a local monorepo: a user-installed plugin must work from published dependencies.

For every requirement, record: current DSH capability; public integration point; necessary plugin state; a real acceptance check; compatibility gap. Existing behavior is reused and tested. Missing host support is a reported requirement, not simulated by editing the DOM outside its owning extension.

Keep business state owned by the appropriate host/session service. Use UI extension registrations for presentation; dispose every registration, listener, timer and resource when unloading. A replaceable single slot is not a callable factory: confirm the extension's semantics and avoid recursively selecting an override from itself. Test two sessions and two component instances to catch shared-state leaks.

Persist stable IDs and schema versions, not labels or in-memory handles. Make migration and downgrade behavior explicit. Generated packages need a declared host compatibility range, dependencies, entry points, build instructions, a license for original code, and an uninstall/rollback path. Keep REA and CUA optional capabilities for research unless the generated feature actually requires them at runtime.

Build and test inside the research workspace. Submit the produced package path through the job's artifact action. Do not install into the everyday profile from a research tool or package script. The host's isolated validation and the user's installation choice follow separately.

Sources: `dsh-repository`, `dsh-slots`, `dsh-plugin-manager`, `rea-dsh-adapter`. Reconfirm exports and installed interfaces before using names from these moving branches.

## Start from the shipped scaffold

After recording the relevant evidence and specification, use the job tool once for a new reconstruction:

```json
{"action":"scaffold","payload":{"packageName":"dsh-your-feature"}}
```

This copies eight bundled files into the job workspace's `plugin/` directory and returns its path, file hashes, exact initial Client source, template SDK targets and build/package commands. Use this quickstart to edit the feature; do not reread all eight files just to reconstruct the already supplied boilerplate. The name must be unscoped lowercase letters/digits separated by single hyphens, at most 80 characters. The directory must be absent or empty; the tool refuses overwrites and symlinks, and does not install packages or run builds. On resume, inspect existing files and continue them rather than deleting the project to rerun scaffolding.

The starter fixes DSH SDK versions at `0.2.1-alpha.2`, supplies a lockfile, a no-op Host, a typed empty Client contribution, a bundle patch, and a working browser-loader build. Its `conversation.composer.dock` contribution uses `PropsRuntime` and returns `null`: this is a generic extension example, not any requested feature. Select the feature's appropriate slot and implement real behavior. Do not repeatedly research package manifests, the loader wrapper, or the demonstrated registration signature unless the installed host differs or a concrete failure requires it.

Run inside `plugin/`:

```sh
npm ci
npm run build
npm test
npm run package
```

The initial `npm test` checks compilation and package entry wiring only; add meaningful feature checks as implementation proceeds. Packaging writes `release/<packageName>-0.1.0.tgz` and excludes `release/` from the distribution. From the job workspace, register that exact file, for example `plugin/release/dsh-your-feature-0.1.0.tgz`, through artifact kind `plugin`. A tarball of the untouched empty starter is not an implemented feature and must not be presented as one.

The starter's Client is `src/client/index.tsx`; JSX and the build entry are already configured. Add only the dependencies and services needed for the selected behavior; preserve the shared host identities and Context-owned cleanup described below. Rewrite the starter README with actual feature behavior and verification before delivery.

## A distributable plugin, not a workspace patch

The first supported public runtime is DSH `0.2.1-alpha.2` with Cordis `4.0.5-alpha.1`. Inspect installed package `package.json` files and their exported declaration files before coding. Declare compatible public dependencies in the generated package; never publish absolute imports, `file:` dependencies into the developer's checkout, or symlinks to OpenCodex's `node_modules`.

For a presentation-only feature, the smallest package has a no-op Host `apply` export, a real Client `apply` export, compiled artifacts, a manifest and a bundle patch. The Host half activates the package so DSH discovers its Client half; it does not need to invent a server or another agent service.

The scaffold already provides this packaging shape. The following is a reference for adapting it, not a reason to create a second project:

```json
{
  "name": "dsh-your-feature",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/host.js",
  "exports": {
    ".": "./dist/host.js",
    "./client": "./dist/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-client-ui-conversation"
      ]
    }
  },
  "files": ["dist", "cordis.patch.yml", "README.md", "LICENSE"]
}
```

This is a shape, not a complete manifest: add the actual engine range, peer/development dependencies and build commands. Add `@deepseek-ai/dsh-client-ui-user-questions` to Client loading dependencies only for a feature that requires that native question owner. Package loading IDs in `dsh.client.inject` are different from runtime Context service names.

```yaml
- insert:
    - id: your-feature
      name: dsh-your-feature
```

The patch's `name`, npm package name and Client module loader ID must agree. Avoid install/postinstall scripts. Ship compiled files in the tarball so users do not need a compiler or allow an install script to build the plugin. `npm pack --dry-run` must show the Host entry, Client entry and patch. Inspect the actual `npm pack` tarball too, not only the source tree.

## Public Client API and service names

Import `Context` from `@deepseek-ai/cordis`; do not invent a `ClientContext` runtime class. Client declarations augment that same Context. For example, a slot-only plugin can declare `export const inject = ['slots']`; if it reads `ctx.uiSession`, include `'uiSession'`. The conversation package publishes `ctx.conversation` and `ctx.uiConversation`; do not guess generic service names such as `'session'` or `'ui'`. Declaring nonexistent required services leaves the plugin waiting instead of rendering.

Prefer standard slot props for read-only UI observations: `PropsRuntime<'conversation.composer.dock'>` includes session identity plus hooks registered by loaded domain packages. Use type-only imports from the appropriate `/client` exports to load TypeScript augmentations. Do not bundle a second copy of an entire DSH feature just to get its types. `PendingQuestion` from the question package's public Client export is a **type export**; runtime `instanceof PendingQuestion` in a third-party package is not a supported import strategy. Its public `kind` discriminator is sufficient for observing the question state.

Slot declarations and their entries have separate lifetimes. Register an entry inside `ctx.slots.inject(slotName, () => ctx.slots.register(options, Component))`, returning the disposer. A list slot needs a unique `id`; a keyed slot needs its declared `key`; a chain slot requires a `select` returning a match or `null`. Do not install a chain entry returning `null` as a way to suppress another owner's question; it merely declines selection. Avoid recursive rendering of the slot that the component itself replaced.

Create styles/listeners in `ctx.effect` and return their cleanup. Observe state with provided selector hooks rather than global DOM polling. For an inspected DOM compatibility seam, scope selectors to the contributed component's current session and named `data-*` anchors, and leave the native UI intact when those anchors are missing. Never target hashed CSS classes or change unrelated disabled controls.

## Build the browser loader correctly

The Client entry is not a normal script imported by a page. DSH expects a module registered with its browser loader:

```js
window.__ModuleLoader__.load({
  id: 'dsh-your-feature',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // Insert the bundled CommonJS Client output here.
    return module.exports;
  }
});
```

A small reproducible build can use esbuild: bundle the Host entry as Node ESM with packages external; bundle Client as browser CommonJS with automatic JSX; wrap that CJS text in the loader above. Set `process.env.NODE_ENV` to a string literal in the browser bundle. If importing CSS as text, insert it through a context-owned style effect; otherwise ensure every emitted CSS file is actually loaded and disposed. A successful JavaScript build with an unreferenced CSS asset produces an installed but visually unchanged plugin.

Keep host-shared modules external in the Client bundle: at least `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, and any runtime imports from DSH's shared UI packages such as `@deepseek-ai/dsh-client-ui-slots`. Use the host's shared identity for stores, hooks and registries. A private bundled React copy can compile and still fail with invalid hooks at runtime. A pure type import disappears and does not need a runtime loader import.

Typecheck against the exact installed public declarations. Build both halves, pack, install the tarball into an isolated profile, and wait for DSH's Client plugin loading to finish. Check for unresolved services, module IDs, missing exports and slot-error anchors before testing the feature. HTTP 200 from the Web server does not prove that the plugin loaded.

## If the feature genuinely needs a Host tool

Use the published `defineTool` author schema, not a copied OpenAI JSON Schema envelope. In this DSH version, `parameters` is a **property map** with per-property `required: true`; it is not `{type:'object',properties:...,required:[...]}`. Every successful tool result must match `output.schema`, and `output.render` turns the canonical value into model content. Object value schemas explicitly choose `additionalProperties`.

```ts
parameters: {
  featureId: { type: 'string', required: true },
  includeDetails: { type: 'boolean' }
},
output: {
  schema: {
    type: 'object',
    properties: { summary: { type: 'string', required: true } },
    additionalProperties: false
  },
  render: (_args, value) => [{ type: 'text', text: value.summary }]
}
```

Read `exec.agent` for the actual calling session and `exec.signal` for cancellation. Register tools on the plugin Context so unload removes them. Use DSH's authenticated Remote carrier for UI commands that need Host operations; do not open an unauthenticated localhost API merely to make a demo work. For the composer-preservation case, no new tool, Remote endpoint or duplicate question service is required.

## Minimum delivery record

Record the generated package name/version/hash, exact DSH version, installed tarball path, isolated profile, build/typecheck result, real interaction result and unload restoration. Include the commands another user can run from a clean checkout. Separate source-grounded assumptions, synthetic tests and real UI evidence. Submit an actual compiled tarball through `opencodex_job` artifact registration; a plan, screenshot or README alone is not the requested usable plugin.
