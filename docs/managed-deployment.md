# Managed runtime and device packaging

`npm start` launches the Node adapter and the in-repository OpenViking child. Source development resolves `.venv/bin/python` and `engine/`; installation keeps `/opt/violoop-mem-ov/server.js` and `/opt/violoop-mem-ov/openviking-python`, together with the existing systemd identity, Unix socket and state paths.

For Debian 12 ARM64: install Node 24, Python 3.11, uv, native build prerequisites and nFPM; run `npm run setup -- --python 3.11 --bootstrap-rust`, `npm test`, `npm run test:integration`, then `npm run build:deb`. The latter builds the in-repository engine wheel, assembles its locked Python runtime, and builds the Debian package. It does not install or publish. Use only the package built for the target Python/Node ABI.

Models remain in the separate `violoop-mem-model` package. Optional remote migration embedding settings and Device model routing retain their existing protocol. Secret files are provisioned outside Git. The source archive and provenance manifest accompany the runtime; no second OpenViking checkout is required.

## Memory output language

Managed Memory reads the paired user's language from Device's loopback
`GET /settings/language` endpoint on the same origin as
`OPENVIKING_DEVICE_MODEL_URL`. An explicit selection wins; `system`/`auto`
uses the resolved PC OS language. Tags are normalized (`zh` becomes `zh-CN`),
and unresolved `system` is never sent to the model as a language name.

The service subscribes to Device's `settings:language` SSE events and refreshes
the snapshot every five seconds, including after reconnecting. It pauses new
memory submissions and migration scheduling, drains accepted work, then updates
OpenViking's `output_language_override` through the authenticated native runtime
configuration API. No process restart is needed. This applies to subsequent
extraction, summaries/overviews and consolidation; it does not translate existing
memory files. Standby remains paused after a language update.

The last confirmed language is stored in `<dataDir>/language-state.json` and
included in the generated `ov.conf` on restart. If Device is temporarily
unavailable, that confirmed value remains usable. With no confirmed value,
Memory stays unready and retries synchronization rather than guessing from the
Memory host's locale or timezone. A failed native configuration update also
keeps new work gated until it succeeds. `/runtimez` exposes `language.ready`,
`language.language`, `language.desired`, and any synchronization error.

This uses an instance-wide OpenViking override, matching the current managed
service's fixed account/user. External OpenViking mode remains externally
configured. Deploy the Python engine and Node adapter from the same revision;
older engines do not expose this parameter through the runtime PATCH API.

## Portable simulator

The Device simulator packager uses `mem/service/server.js`, `mem/openviking-python/`, and `runtime/python/` beside `runtime/node`. The service resolves that bundled interpreter and package directory before source checkout or system defaults. `OPENVIKING_PYTHON` and `OPENVIKING_PYTHONPATH` remain explicit overrides. Source Windows checkouts use `.venv/Scripts/python.exe`.

Build on each target OS/architecture with Node 24. In this repository run `npm run setup`, `npm run build`, and `python3 scripts/build-openviking-runtime.py --replace`. Then run Device's `scripts/build-sim-bundle.sh` with `MEM_REPO` pointing here, `MEM_PYTHON_HOME` pointing to a relocatable standalone Python distribution matching the engine's Python ABI, and `MODEL_CACHE` containing `bge-m3-q8_0.gguf`. `MEM_RUNTIME_SRC` can override the staged `build/openviking-python` directory. A virtualenv is not a redistributable interpreter. The packager imports the staged engine with the copied interpreter and checks its prefix before producing the archive; perform the native startup smoke test on each target before release.

The PC sidecar and source simulator put the model gateway key under the writable simulator memory directory's `runtime/model-gateway.key`. Device resolves the same path in simulator mode; hardware retains `/run/violoop-mem/model-gateway.key`. Standalone launchers set `VIOLOOP_MEMORY_MODEL_KEY_FILE` explicitly. The memory HTTP debug listener stays disabled; Device model calls use loopback port 9090 (or the configured API port in the source simulator).

Migration reads old graph.db without using the retired GraphStore. Old database/files are never automatically deleted. New data is stored under openviking/, legacy-migration/ and openviking-graph.db. Back up a stopped service's complete state before a separately authorized deployment. This repository consolidation does not perform deployment, stop services or modify live state.
