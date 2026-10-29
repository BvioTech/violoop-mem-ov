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


def test_ci_build_uses_device_runtime_and_release_is_tag_only():
    import yaml
    workflow = yaml.safe_load((ROOT / '.github/workflows/build-release.yml').read_text())
    assert workflow['on']['push'] == {'branches': ['main'], 'tags': ['v*']}
    assert workflow['on']['pull_request']['branches'] == ['main']
    assert workflow['permissions'] == {'contents': 'read'}
    jobs = workflow['jobs']
    assert jobs['build']['needs'] == 'service'
    assert jobs['build']['runs-on'] == 'ubuntu-24.04-arm'
    assert jobs['build']['container'] == 'node:24-bookworm'
    assert jobs['build']['env']['UV_PYTHON_DOWNLOADS'] == 'never'
    assert jobs['build']['env']['OV_REQUIRE_RAGFS_BUILD'] == '1'
    commands = [step.get('run') for step in jobs['build']['steps']]
    assert 'npm run setup -- --python /usr/bin/python3 --bootstrap-rust' in commands
    assert 'npm test' in commands
    assert 'npm run test:integration' in commands
    assert 'npm run build:deb' in commands
    release = jobs['release']
    assert release['needs'] == 'build'
    assert release['permissions'] == {'contents': 'write'}
    assert release['if'] == "github.repository == 'BvioTech/violoop-mem-ov' && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"
    assert jobs['notify-apt']['needs'] == 'release'
    assert jobs['notify-apt']['if'] == release['if']
    assert jobs['notify-apt'].get('permissions', workflow['permissions']) == {'contents': 'read'}
    upload = next(step for step in jobs['build']['steps'] if step.get('uses', '').startswith('actions/upload-artifact@'))
    download = next(step for step in release['steps'] if step.get('uses', '').startswith('actions/download-artifact@'))
    assert upload['with']['name'] == download['with']['name']
    assert upload['with']['if-no-files-found'] == 'error'
    publish = next(step for step in release['steps'] if 'gh release create' in step.get('run', ''))
    assert '--verify-tag --draft' in publish['run']
    assert 'dist/*.deb dist/*.deb.sha256' in publish['run']
    assert '--prerelease="$PRERELEASE"' in publish['run']
    assert publish['run'].index('gh release create') < publish['run'].index('--draft=false')
    import ast
    tree = ast.parse((ROOT / 'scripts/build.py').read_text())
    loop = next(node for node in tree.body if isinstance(node, ast.For) and isinstance(node.target, ast.Name) and node.target.id == 'name')
    files = set()
    exec(compile(ast.Module(body=[loop], type_ignores=[]), 'source-file-selection', 'exec'), {'ROOT': ROOT, 'files': files})
    assert '.github/workflows/build-release.yml' in files
    assert 'tests/test_violoop_repository.py' in files


def test_ci_version_check_rejects_wrong_tag_platform_arch_and_node():
    import yaml
    workflow = yaml.safe_load((ROOT / '.github/workflows/build-release.yml').read_text())
    step = next(step for step in workflow['jobs']['build']['steps'] if step['name'] == 'Check device platform and release version')
    code = step['run'].partition("node <<'JS'\n")[2].rpartition('\nJS')[0]
    assert code
    harness = r"""
const assert = require('node:assert/strict');
const vm = require('node:vm');
const pkg = require('./package.json');
const base = {
  platform: 'linux', arch: 'arm64', versions: { node: '24.18.0' },
  env: { NODE_VERSION: '24', GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${pkg.version}` },
};
for (const [changes, shouldFail] of [
  [{}, false],
  [{ env: { ...base.env, GITHUB_REF_NAME: 'v0.0.0' } }, true],
  [{ env: { ...base.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'feature' } }, false],
  [{ platform: 'darwin' }, true],
  [{ arch: 'x64' }, true],
  [{ versions: { node: '22.0.0' } }, true],
]) {
  let failed = false;
  try { vm.runInNewContext(CODE, { require: () => pkg, process: { ...base, ...changes } }); }
  catch { failed = true; }
  assert.equal(failed, shouldFail, JSON.stringify(changes));
}
"""
    subprocess.run(['node', '-e', 'const CODE = ' + json.dumps(code) + ';\n' + harness], cwd=ROOT, check=True)


def test_ci_apt_notification_signs_exact_body_and_fails_closed():
    import os
    import yaml
    workflow = yaml.safe_load((ROOT / '.github/workflows/build-release.yml').read_text())
    step = next(step for step in workflow['jobs']['notify-apt']['steps'] if step['name'] == 'Notify APT repository')
    code = step['run'].partition("node <<'JS'\n")[2].rpartition('\nJS')[0]
    assert code
    mock = r"""
const assert = require('node:assert/strict');
global.fetch = async (url, options) => {
  const body = JSON.stringify({ repo: process.env.GITHUB_REPOSITORY, tag: process.env.GITHUB_REF_NAME });
  const expected = 'sha256=' + require('node:crypto').createHmac('sha256', process.env.APT_WEBHOOK_SECRET).update(body).digest('hex');
  assert.equal(url, process.env.HOOK_URL);
  assert.equal(options.method, 'POST');
  assert.equal(options.body, body);
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers['X-Hub-Signature-256'], expected);
  assert.ok(options.signal instanceof AbortSignal);
  return { status: Number(process.env.TEST_HTTP_STATUS), text: async () => 'fixture failure' };
};
"""
    for secret, status, expected_exit in [('fixture-secret', '202', 0), ('fixture-secret', '401', 1), ('', '202', 1)]:
        env = dict(os.environ, APT_WEBHOOK_SECRET=secret, TEST_HTTP_STATUS=status,
                   HOOK_URL=step['env']['HOOK_URL'], GITHUB_REPOSITORY='BvioTech/violoop-mem-ov', GITHUB_REF_NAME='v0.11.5')
        result = subprocess.run(['node', '-e', mock + '\n' + code], cwd=ROOT, env=env, capture_output=True, text=True)
        assert result.returncode == expected_exit, result.stderr
        if expected_exit == 0:
            assert 'APT sync accepted' in result.stdout
        else:
            assert ('APT webhook returned 401' if secret else 'Configure the APT_WEBHOOK_SECRET') in result.stderr
