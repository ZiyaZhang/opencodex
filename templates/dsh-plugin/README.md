# __PLUGIN_NAME__

Generic OpenCodex starter for DSH `0.2.1-alpha.2`, Cordis `4.0.5-alpha.1`, and Node.js `>=22.19.0`. The Host is empty; the Client registers a typed contribution that returns `null`. It has no feature behavior and is not a completed reconstruction.

## Develop and package

```sh
npm ci
npm run build
npm test
npm run package
```

`npm test` currently checks compilation and package entry wiring only. Add meaningful behavior tests for the implemented feature. `npm run package` writes a self-contained tarball to `release/`; that directory is excluded from package contents, so repeated packing cannot include prior tarballs. The distributed package already contains compiled JavaScript and declarations and has no install script.

Edit `src/client/index.tsx` to implement the selected feature using a verified public Slot. JSX is already enabled; keep the existing build entry. Keep the package name, patch name and module loader ID aligned. The build reads the loader ID from `package.json`. Add only required Host services, runtime dependencies and Client loading dependencies. Do not copy local monorepo paths or a private React instance into the package.

The template demonstrates `conversation.composer.dock` with `PropsRuntime` and its type augmentations. It does not imply that this slot is appropriate for every feature. `dsh.client.inject` lists package loading dependencies; `export const inject` lists Context service names. Keep effects and registrations owned by the plugin Context, with cleanup on unload.

If adding styles, ensure the emitted styles are loaded and disposed; an unreferenced CSS file will not apply itself. If adding runtime imports from DSH, keep shared packages external in the Client build and declare their loading requirements.

Install the tarball in a separate DSH_HOME without OpenCodex for real interaction, visual, refresh, disable/re-enable and uninstall checks. After independent acceptance, the OpenCodex Host installs and enables the package automatically through native DSH plugin management. Compilation does not prove that an interaction or visual comparison passed. Replace this starter description with the actual feature, supported states, known gaps, validation evidence, and uninstall steps before delivery.

Original starter code is available under the MIT license. Retain applicable notices when adding other code or assets.
