# Source provenance and notices

This repository combines VioLoop's JavaScript memory service and a source snapshot of OpenViking. See SOURCE_MANIFEST.json for original repositories, commits, and SHA-256 hashes of imported files before local integration edits.

OpenViking and its original license/notice files are retained under engine/. OpenViking declares AGPL-3.0 in engine/pyproject.toml; see engine/LICENSE. Third-party notices and licenses remain with their components.

This repository, including the VioLoop `service/` sources, is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0); see the root LICENSE file. Any devices or packages built from this repository and conveyed to third parties must be accompanied by, or offer, the complete corresponding source for the exact version conveyed (git tag matching the package version, plus the release's source archive), per AGPL-3.0 sections 6 and 13. The running service exposes a `GET /license` endpoint that points to this repository and its license for anyone interacting with it over a network.

OpenViking source snapshot: 8e3383878fb0bb6f8d977178141d2c49339b0fe8. The integration pins its Python/CLI version to 0.4.24.dev70 independently of root service tags. The preserved legacy graph.db schema is test data only; the old graph engine is excluded.

Integration changes additionally render field-description language templates before sending them to the model. This user-approved patch and its tests do not change URI generation or historical memory data.

Documentation-only media, font programs and theme sources were subsequently omitted at the user's request. Original file hashes and omission reasons remain in SOURCE_MANIFEST.json; prose and license texts are retained.

A subsequent user-approved trim omits upstream examples, docs, Web Studio, benchmarks, plugin/distribution metadata, CI and standalone deployment files. Available license notices for those omitted components are preserved under engine/licenses/omitted-components/. The full configuration template is relocated to engine/openviking/ov.conf.example; original provenance remains recorded.
