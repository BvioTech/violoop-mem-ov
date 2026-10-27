# OpenViking engine for VioLoop Memory

This directory contains the retained OpenViking runtime and build sources used by the VioLoop Memory service. See the repository root README.md for installation, startup, migration and packaging instructions.

The JavaScript adapter supervises this engine; it preserves the Device/PC HTTP and Unix-socket contracts. Python handles memory extraction and retrieval, Rust provides RAGFS and the CLI, and C++ provides the local vector engine.

Unused upstream examples, documentation site, Web Studio frontend, benchmarks, plugin marketplace metadata, CI and deployment files have been omitted. VikingBot and its CLI/server/metrics integration are omitted. context_gateway, SDKs and required tests remain available.

The complete upstream configuration template is retained at `openviking/ov.conf.example`. VioLoop generates its actual runtime configuration automatically. Licenses for omitted components that were present in the imported snapshot are retained under `licenses/omitted-components/`; active dependency licenses remain in place.

Source provenance, original hashes and explicit omissions are recorded in `../SOURCE_MANIFEST.json`. Upstream project: https://github.com/volcengine/OpenViking . Main project license: [AGPL-3.0](LICENSE).
