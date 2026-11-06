# Windows simulator development

This checkout supports a Windows x64 Python running under emulation on Windows
on Arm. Native modules must match the Python ABI (`win-amd64`), not the host CPU
reported by `platform.machine()`.

The local simulator uses Node 24, Python 3.12, the existing OpenViking C++ vector
engine, Rust RAGFS, and the `bge-m3-q8_0.gguf` embedding model. The sibling
simulator launcher enables GPU auto-selection for BGE by default (verified as
Vulkan with the x64 Node runtime); the separate Gemma service continues to use
the GPU. Use the launcher's `-MemoryCpuOnly` switch for CPU mode and
`-RestartMemory` to apply a backend change to an existing Memory process.
Check `/runtimez` for the actual `embedding.backend` after startup.

## Native build

Install Node dependencies with Node 24 and `npm ci`. Install Python dependencies
from `engine/uv.lock` into `.venv`, including the build dependencies from the
engine's `pyproject.toml`.

The C++ build needs x64 MinGW-w64 and CMake on PATH. The SSE3 variant works with
x64 emulation; avoid compiling host-specific AVX variants for this deployment.
With the virtual environment active:

```powershell
$env:OV_X86_BUILD_VARIANTS = 'sse3'
$env:OV_SKIP_RAGFS_BUILD = '1'
$env:OV_SKIP_OV_BUILD = '1'
$env:OV_SKIP_STUDIO_BUILD = '1'
Set-Location engine
python setup.py build_ext --inplace
```

Build RAGFS with MSVC Build Tools, Rust and the `x86_64-pc-windows-msvc` target.
An Arm64 Rust host can cross-compile this extension:

```powershell
$env:PYO3_PYTHON = (Resolve-Path ../.venv/Scripts/python.exe).Path
$pythonBase = python -c "import sys; print(sys.base_prefix)"
$env:LIB = "$pythonBase\libs;$env:LIB"
$env:CARGO_BUILD_JOBS = '4'
python -m maturin build --release --manifest-path crates/ragfs-python/Cargo.toml --target x86_64-pc-windows-msvc --out ../build/ragfs-wheel
```

Install the resulting wheel in `.venv`. Install the engine editable with
`OV_SKIP_CPP_BUILD=1`, `OV_SKIP_RAGFS_BUILD=1`, `OV_REQUIRE_RAGFS_BUILD=0`,
`OV_SKIP_OV_BUILD=1` and `OV_SKIP_STUDIO_BUILD=1` to reuse these builds. Set
`OPENVIKING_VERSION` and `SETUPTOOLS_SCM_PRETEND_VERSION_FOR_OPENVIKING` to the
contents of `engine/VIOLOOP_ENGINE_VERSION`.

## Validation

Run the service tests with Node 24. The real native integration test uses a
temporary directory and deterministic model responses, so it does not touch
simulator data or call cloud services:

```powershell
$env:VIOLOOP_TEST_PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
$env:VIOLOOP_TEST_PYTHONPATH = (Resolve-Path engine).Path
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'
node --test --test-timeout=600000 service/test/native_integration.js
```

Windows uses named pipes instead of Unix socket paths. POSIX signal, inode and
permission-bit assertions are skipped on Windows; the functional migration,
CRUD, retrieval, persistence and source-preservation checks remain enabled.
Each restart on this x64 Python deployment can spend about a minute importing
the engine. Shutdown terminates the managed Python process tree so the Windows
virtual-environment launcher cannot leave a child holding the listening port.

The sibling model checkout's `scripts/start-local-simulator.ps1` starts this
service and the Device against the same simulator data directory and named
pipe. Set `-SkipMemory` to run the UI without Memory, or `-RestartEdge` when
changing that setting on an already-running Device. Existing `graph.db` is kept
as the read-only migration source; new native data is stored separately.
