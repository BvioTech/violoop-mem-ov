#!/usr/bin/env python3
from common import ROOT, ENGINE, PYTHON, run
if not PYTHON.exists(): raise SystemExit('Run npm run setup first.')
run(PYTHON, '-m', 'unittest', 'tests.session.test_graph_completion', cwd=ENGINE)
run(PYTHON, '-m', 'pytest', '-o', 'addopts=',
    'tests/session/memory/test_legacy_migration_sources.py',
    'tests/session/memory/test_extraction_output_protocol.py',
    'tests/session/memory/test_legacy_migration_embedding.py',
    'tests/session/memory/test_legacy_migration_routing.py',
    'tests/session/memory/test_legacy_migration_query.py', cwd=ENGINE)
run(PYTHON, ROOT / 'service/test/migration_timing_native.py')
run(PYTHON, '-m', 'pytest', '-o', 'addopts=', 'tests/test_violoop_repository.py', 'tests/test_bot_removed.py', cwd=ROOT)
