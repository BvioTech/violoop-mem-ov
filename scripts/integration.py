#!/usr/bin/env python3
from common import ROOT, PYTHON, run, require_node, test_environment
require_node()
if not PYTHON.exists(): raise SystemExit('Run npm run setup first.')
run('node', '--test', '--test-timeout=240000', ROOT / 'service/test/native_integration.js', env=test_environment())
