#!/usr/bin/env python3
"""Build a native engine wheel and complete service source archive, without publishing."""
import json
import hashlib
import tarfile
import shutil
from common import ROOT, ENGINE, PYTHON, VERSION, run, require_node
require_node()
if not PYTHON.exists(): raise SystemExit('Run npm run setup first.')
dist = ROOT / 'dist'; dist.mkdir(exist_ok=True)
# setuptools copies into an existing build tree and otherwise retains deleted modules.
for build_lib in (ENGINE / 'build').glob('lib.*'):
    if build_lib.is_dir() and not build_lib.is_symlink():
        shutil.rmtree(build_lib)
run(PYTHON, '-m', 'build', '--wheel', '--no-isolation', '--outdir', dist, ENGINE)
package = json.loads((ROOT / 'package.json').read_text())
version = package['version']
# The source tree uses service/, while the installed service retains its public
# /opt/violoop-mem/server.js entry point. Keep package metadata consistent, too.
installed = {**package, 'main': 'server.js', 'bin': {'violoop-mem': './server.js'},
             'scripts': {'start': 'node server.js'}}
(ROOT / 'build').mkdir(exist_ok=True)
(ROOT / 'build/package.json').write_text(json.dumps(installed, indent=2) + '\n')
lock = json.loads((ROOT / 'package-lock.json').read_text())
lock['packages']['']['bin'] = installed['bin']
(ROOT / 'build/package-lock.json').write_text(json.dumps(lock, indent=2) + '\n')
# Manifest entries preserve even originally tracked paths matching ignore rules.
manifest = json.loads((ROOT / 'SOURCE_MANIFEST.json').read_text())
files = {item['destination'] for source in manifest['sources'] for item in source['files'] if item.get('disposition') != 'omitted'}
files.add('engine/VIOLOOP_ENGINE_VERSION')
files.update(item['path'] for item in manifest.get('retained_files', []))
for name in ('service', 'scripts', 'deploy', 'docs', 'tests'):
    for p in (ROOT / name).rglob('*'):
        if p.is_file() and not any(part in {'__pycache__', 'node_modules', '.venv', '.local', 'build', 'dist', 'target'} or part.endswith('.egg-info') for part in p.relative_to(ROOT).parts) and p.suffix in {'.py', '.js', '.cjs', '.sh', '.sql', '.md', '.json', '.yaml', '.yml'} and not p.name.startswith('.env'):
            files.add(str(p.relative_to(ROOT)))
files.update(['.gitignore', '.dockerignore', 'package.json', 'package-lock.json', 'README.md', 'SOURCE_MANIFEST.json', 'NOTICE.md'])
with tarfile.open(dist / f'violoop-mem-{version}-source.tar.gz', 'w:gz') as archive:
    for name in sorted(files):
        archive.add(ROOT / name, arcname=f'violoop-mem/{name}', recursive=False)
print(f'Built source archive ({len(files)} files) and OpenViking {VERSION} wheel in {dist}')

checksums = []
for artifact in sorted(dist.iterdir()):
    if artifact.is_file() and (artifact.suffix == '.whl' or artifact.name.endswith('-source.tar.gz')):
        checksums.append(f"{hashlib.sha256(artifact.read_bytes()).hexdigest()}  {artifact.name}")
(dist / 'SHA256SUMS').write_text('\n'.join(checksums) + '\n')
