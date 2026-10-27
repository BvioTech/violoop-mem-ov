from pathlib import Path
import importlib.util
import json
import subprocess
import sys
import zipfile
ROOT = Path(__file__).resolve().parents[1]
def test_engine_version_is_independent_of_root_git_tags():
    spec = importlib.util.spec_from_file_location('ov_version', ROOT / 'engine/scripts/build_support/versioning.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    module._get_scm_version = lambda *_: (_ for _ in ()).throw(AssertionError('must not inspect root Git tags'))
    expected = (ROOT / 'engine/VIOLOOP_ENGINE_VERSION').read_text().strip()
    assert module.resolve_openviking_version(env={'UNRELATED': '1'}) == expected
    assert module.resolve_openviking_version(env={'OPENVIKING_VERSION': '1.2.3'}) == '1.2.3'
def test_retained_engine_files_match_manifest_and_documented_omissions_are_absent():
    manifest = json.loads((ROOT / 'SOURCE_MANIFEST.json').read_text())
    import hashlib
    edited = {'engine/pyproject.toml', 'engine/scripts/build_support/versioning.py',
              'engine/openviking/session/memory/extraction_output_protocol/python_protocol.py',
              'engine/tests/session/memory/test_extraction_output_protocol.py'}
    for source in manifest['sources']:
        for entry in source['files']:
            p = ROOT / entry['destination']
            if entry.get('disposition') == 'omitted':
                relative = entry['destination']
                removable_roots = ('engine/examples/', 'engine/docs/', 'engine/web-studio/',
                    'engine/benchmark/', 'engine/agent-plugins/', 'engine/npm/', 'engine/.agents/',
                    'engine/.claude-plugin/', 'engine/.github/', 'engine/deploy/', 'engine/bot/')
                assert relative.startswith(removable_roots) or relative in {
                    'engine/.pr_agent.toml', 'engine/Dockerfile', 'engine/docker-compose.yml', 'engine/Caddyfile',
                    *manifest.get('bot_removal', {}).get('deleted_files', []),
                    *manifest.get('test_cleanup', {}).get('deleted_files', []),
                    *manifest.get('service_scope_removal', {}).get('deleted_files', [])}
                assert not p.exists() and not p.is_symlink(), relative
                if entry.get('preserved_at'):
                    preserved = ROOT / entry['preserved_at']
                    assert hashlib.sha256(preserved.read_bytes()).hexdigest() == entry.get('integration_sha256', entry['sha256'])
                continue
            assert p.exists(), entry['destination']
            if entry['destination'].startswith('engine/') and entry['destination'] not in edited:
                data = str(p.readlink()).encode() if p.is_symlink() else p.read_bytes()
                assert hashlib.sha256(data).hexdigest() == entry.get('integration_sha256', entry['sha256']), str(p)
def test_service_is_self_contained_and_packaging_has_no_retired_sources():
    import re
    for f in (ROOT / 'service').glob('*.js'):
        for dep in re.findall(r"require\(['\"](\.[^'\"]+)['\"]\)", f.read_text()):
            assert (f.parent / (dep + '.js')).exists(), (f.name, dep)
    nfpm = (ROOT / 'scripts/nfpm.yaml').read_text()
    for deleted in ['legacy_server.js', 'graph_store_sqlite.js', 'graph_page.js', 'backup.js', 'scripts/graphify.js']:
        assert not (ROOT / 'service' / deleted).exists()
        assert deleted not in nfpm
    for src in re.findall(r'^  - src: \./(.+)$', nfpm, re.M):
        if src not in ['node_modules', 'build/openviking-python', 'build/package.json', 'build/package-lock.json']:
            assert (ROOT / src).exists(), src
def test_source_startup_resolves_own_engine_and_python():
    result = subprocess.run(['node','-e','console.log(JSON.stringify(require("./service/config").loadConfig([], {})))'], cwd=ROOT, check=True, capture_output=True, text=True)
    config = json.loads(result.stdout)
    assert Path(config['openviking']['pythonPath']).resolve() == ROOT / 'engine'
    assert Path(config['openviking']['python']).parent.parent == ROOT / '.venv'

def test_package_removal_never_deletes_memory_state():
    postrm = (ROOT / 'scripts/deb/postrm.sh').read_text()
    assert 'rm -rf /var/lib' not in postrm
    assert 'rm -r /var/lib' not in postrm

def test_peripheral_trim_keeps_required_runtime_and_recorded_notices():
    import hashlib
    manifest = json.loads((ROOT / 'SOURCE_MANIFEST.json').read_text())
    for item in manifest.get('retained_files', []):
        assert hashlib.sha256((ROOT / item['path']).read_bytes()).hexdigest() == item['sha256']
    for directory in ('openviking', 'openviking_cli', 'src', 'crates', 'third_party', 'context_gateway', 'sdk', 'tests'):
        assert (ROOT / 'engine' / directory).is_dir()
    assert (ROOT / 'engine/LICENSE').is_file()
    assert (ROOT / 'engine/openviking/ov.conf.example').is_file()


def test_retained_tests_do_not_import_retired_applications():
    import ast
    retired = {"benchmark", "examples", "vikingbot"}
    for path in (ROOT / "engine/tests").rglob("*.py"):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            modules = ([alias.name for alias in node.names] if isinstance(node, ast.Import)
                       else [node.module or ""] if isinstance(node, ast.ImportFrom) else [])
            assert not any(module.split(".")[0] in retired for module in modules), (path, node.lineno)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_read_text" and node.args:
                arg = node.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    assert arg.value.split("/")[0] not in {".github", "Dockerfile", "docker-compose.yml"}, (path, node.lineno)
