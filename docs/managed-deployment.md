# Managed runtime and device packaging

`npm start` launches the Node adapter and the in-repository OpenViking child. Source development resolves `.venv/bin/python` and `engine/`; installation keeps `/opt/violoop-mem/server.js` and `/opt/violoop-mem/openviking-python`, together with the existing systemd identity, Unix socket and state paths.

For Debian 12 ARM64: install Node 24, Python 3.11, uv, native build prerequisites and nFPM; run `npm run setup -- --python 3.11 --bootstrap-rust`, `npm test`, `npm run test:integration`, then `npm run build:deb`. The latter builds the in-repository engine wheel, assembles its locked Python runtime, and builds the Debian package. It does not install, publish or contact the apt webhook. Use only the package built for the target Python/Node ABI.

Models remain in the separate `violoop-mem-model` package. Optional remote migration embedding settings and Device model routing retain their existing protocol. Secret files are provisioned outside Git. The source archive and provenance manifest accompany the runtime; no second OpenViking checkout is required.

Migration reads old graph.db without using the retired GraphStore. Old database/files are never automatically deleted. New data is stored under openviking/, legacy-migration/ and openviking-graph.db. Back up a stopped service's complete state before a separately authorized deployment. This repository consolidation does not perform deployment, stop services or modify live state.
