# Integration validation — 2026-10-26

Platform: macOS ARM64; Node 24.22.0; CPython 3.12.13; Rust 1.99.1. Dependencies and native artifacts were installed/built independently in this checkout. No virtualenv, compiled library, model or user memory was imported from either original repository.

## Scope and source provenance

The original 5041-file OpenViking snapshot is recorded in SOURCE_MANIFEST.json with original paths and hashes. User-approved omissions now exclude upstream examples, docs, Web Studio, benchmarks, plugin/distribution metadata, CI and standalone deployment assets. Available license notices from those directories are retained under engine/licenses/omitted-components/. The full config example moved to engine/openviking/ov.conf.example, and config help/packaging use that retained location.

Runtime code preserves the existing memory, migration, retrieval and graph behavior, with the approved field-language rendering fix and independently pinned engine version. VIOLOOP_ENGINE_VERSION remains 0.4.24.dev70. The manifest records every omission, relocated file and integration edit separately. The JavaScript adapter, model gateway, durable tasks, migration reader and graph projection remain in service/.

## Passed checks

- `npm test`: 249 tests passed: 114 JavaScript service tests, 121 extraction/migration tests, 4 native graph completion tests, 4 migration timing tests and 6 repository/packaging invariants. No failing case was skipped or marked expected-failure.
- Language coverage: Chinese/English descriptions and conditional branches render correctly; Python/JSON use the same target language. Original YAML content, Python SDK edit instructions and V2 object/no-change rules remain intact.
- `npm run test:integration`: real Python/C++/Rust engine with deterministic local model/embedding substitutes. Automatic legacy migration, persisted links, graph projection, manual CRUD, native retrieval and restart without replay passed. Old graph.db remained byte-identical; temporary data and child processes were cleaned up.
- `npm run test:package`: the same end-to-end contract against flattened package paths and assembled runtime. Python runs with -S, so editable installs and external site-packages cannot mask missing dependencies. Installed package main/bin/start paths match the existing server.js entry point.
- `npm run build`: C++ vector engine, Rust RAGFS and Rust CLI compiled; wheel and complete source archive generated. Archive contains every retained source-manifest file and preserved notice/template, without node_modules, virtualenvs or build caches.
- Runtime assembly: built wheel plus dependencies from engine/uv.lock installed into build/openviking-python; native server imports succeed with -S. Rebuilds replace only validated build artifacts and never silently package an older runtime directory.
- Native local embedding dependency loaded successfully using Metal; actual model quality/performance was not measured.
- Source ignore audit preserves retained source files and excludes generated artifacts/data.
- Shell syntax checks passed for device build and removal scripts; device packaging enforces Node 24 and Python 3.11 ABI requirements.

## Language-rendering decision

Local source commit ae52cf00c restored V2 raw field descriptions, while two existing extraction-loop tests still required rendered language, producing conflicting expectations. After review, the user explicitly requested the new repository to render those descriptions and update the corresponding tests. The implementation now uses the existing restricted render_description_template helper for YAML field prose, including language conditionals. No final-prompt-wide replacement is performed. URI generation, stored memories, models and migration policies are unchanged.

## Repository state and boundaries

Git is initialized on main with origin git@github.com:BvioTech/violoop-mem-ov.git. No commit, push, release or deployment was performed, following the explicit no-commit instruction in goal item 10 over the stale commit/push completion wording.

Original repositories and live services were not changed or restarted. The original violoop-mem still has only its pre-existing untracked .DS_Store; original OpenViking remains clean. No simulator/user/device memory was modified. Tests used no actual cloud model or remote embedding service. Old memory data is read-only during migration, and the new package's purge script also retains memory state.

## Practical limits

The macOS build/runtime were verified. Linux ARM64 Debian package creation and Device/PC deployment were not performed. Native integration used local deterministic model substitutes; it establishes functional wiring and persistence, not real-model extraction quality. LDAP and optional upstream applications are not required for this service and were not exercised. Full upstream OpenViking integration suites requiring external services were not run.

## Artifacts and logs

The native OpenViking wheel and complete service source archive are in dist/. Their SHA-256 values are in dist/SHA256SUMS. Import hashes in SOURCE_MANIFEST.json describe the original snapshots separately from integration edits. Detailed local logs are kept under ignored build/validation/.

## Documentation asset trim

After the integration validation, the user requested removal of documentation website images, GIFs, fonts and theme code. The trim removed 485 files (48,842,712 logical bytes), preserving all prose and license text, including guides stored under docs/images. Remaining documentation image references point to the upstream snapshot. Documentation-only package commands no longer depend on VitePress or the removed theme. The import manifest retains omitted files and hashes as provenance.

Post-trim checks: 9 repository/README tests passed; bilingual documentation consistency and API reference checks passed. These checks do not replace the earlier runtime integration tests, whose source code was not changed by the trim.

## First-batch peripheral cleanup

Deleted 1880 additional peripheral files (19,411,878 logical bytes) from the approved directories and root deployment/review files. This follows the earlier 485-file documentation-asset trim. Twelve license/notice files and the upstream configuration sample were relocated rather than discarded. bot/, context_gateway/, sdk/, tests/, native sources and active runtime templates remain present. Root VioLoop docs/deploy scripts remain present. Git-visible working files are approximately 37.2 MB; large ignored compiler/dependency caches were not part of this cleanup.

After this cleanup, the 249-test main suite and native source-layout integration passed; the shorter engine README also passed its four packaging-description tests. The rebuilt wheel/runtime and package-layout integration are checked by the normal build/test commands, with logs under build/validation/. No original repository, live service or user memory was changed.

## VikingBot removal

Removed VikingBot sources, chat CLI, Bot proxy routes, feedback collector, package entry points, and the Bot optional dependency group. uv removed 36 exclusively required packages from the lockfile without changing retained versions. The previous first-batch inventory above is historical; the current source manifest records these additional omissions.
