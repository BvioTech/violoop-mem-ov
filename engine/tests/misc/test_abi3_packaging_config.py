import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def test_packaging_only_includes_abi3_engine_extensions():
    setup_py = _read_text("setup.py")
    pyproject = _read_text("pyproject.toml")

    assert "storage/vectordb/engine/*.abi3.so" in setup_py
    assert "storage/vectordb/engine/*.abi3.so" in pyproject
    assert "storage/vectordb/engine/*.dll" not in setup_py
    assert "storage/vectordb/engine/*.dll" not in pyproject
    assert "storage/vectordb/engine/*.so" not in setup_py
    assert "storage/vectordb/engine/*.so" not in pyproject


def test_windows_engine_loader_registers_dll_search_paths():
    engine_init = _read_text("openviking/storage/vectordb/engine/__init__.py")

    assert "add_dll_directory" in engine_init
    assert "module_path" in engine_init
    assert 'package_root / "lib"' in engine_init
    assert 'package_root / "bin"' in engine_init


def test_setup_no_longer_bundles_mingw_runtime_dlls_for_engine():
    setup_py = _read_text("setup.py")

    assert "WINDOWS_ENGINE_RUNTIME_DLL_PATTERNS" not in setup_py
    assert "_stage_windows_engine_runtime_dlls" not in setup_py


def test_setup_extracts_windows_ragfs_python_pyd_from_maturin_wheel():
    setup_py = _read_text("setup.py")

    assert 'basename == "ragfs_python.pyd"' in setup_py
    assert 'basename.startswith("ragfs_python.abi3.")' in setup_py
    assert "stable-ABI native extension" in setup_py


def test_windows_abi3_backend_uses_stable_python_linkage():
    setup_py = _read_text("setup.py")
    src_cmake = _read_text("src/CMakeLists.txt")

    assert "OV_PYTHON_SABI_LIBRARY" in setup_py
    assert "python3.dll" in setup_py
    assert "OV_PYTHON_SABI_LIBRARY" in src_cmake
    assert "Python3::Python" not in src_cmake


def test_abi3_backend_releases_gil_and_rejects_invalid_storage_op_type():
    backend_source = _read_text("src/abi3_engine_backend.cpp")

    assert "PyEval_SaveThread" in backend_source
    assert "PyEval_RestoreThread" in backend_source
    assert "Invalid storage op type" in backend_source


def test_repo_no_longer_contains_pybind11_engine_bindings():
    assert not (REPO_ROOT / "src" / "pybind11_interface.cpp").exists()
    assert not (REPO_ROOT / "src" / "cpu_feature_probe.cpp").exists()
    assert not (REPO_ROOT / "src" / "py_accessors.h").exists()


def test_python_engine_exports_only_live_abi3_api():
    import openviking.storage.vectordb.engine as engine

    assert not hasattr(engine, "FetchDataResult")


def _extract_rust_version(pattern: str, text: str) -> str:
    match = re.search(pattern, text, re.MULTILINE)
    assert match, f"Pattern not found: {pattern}"
    return match.group("version")


def test_ragfs_python_uses_pyo3_version_with_python_314_support():
    cargo_toml = _read_text("crates/ragfs-python/Cargo.toml")

    assert 'pyo3 = { version = "0.27"' in cargo_toml


def test_root_build_system_includes_maturin_for_isolated_builds():
    pyproject = _read_text("pyproject.toml")
    setup_py = _read_text("setup.py")

    assert '"maturin>=1.0,<2.0",' in pyproject
    assert "sys.executable," in setup_py
    assert '"maturin",' in setup_py
    assert '"build",' in setup_py
    assert '"--release",' in setup_py
    cargo_toml = _read_text("crates/ragfs-python/Cargo.toml")
    assert 'default = ["extension-module", "s3"]' in cargo_toml
    assert '"--out",' in setup_py
    assert "tmpdir," in setup_py
    assert 'shutil.which("maturin")' not in setup_py


def test_build_system_honors_compiler_overrides_and_requires_ragfs_for_wheels():
    setup_py = _read_text("setup.py")

    assert 'os.environ.get("CC")' in setup_py
    assert 'os.environ.get("CXX")' in setup_py
    assert "OV_REQUIRE_RAGFS_BUILD" in setup_py


def test_root_build_system_can_skip_cli_and_cpp_without_skipping_ragfs():
    setup_py = _read_text("setup.py")

    assert 'os.environ.get("OV_SKIP_OV_BUILD") == "1"' in setup_py
    assert 'os.environ.get("OV_SKIP_CPP_BUILD") == "1"' in setup_py
    assert "if SKIP_CPP_BUILD" in setup_py
    assert "class OpenVikingDistribution(Distribution)" in setup_py
    assert "self.build_ov_cli_artifact()" in setup_py
    assert "self.build_ragfs_python_artifact()" in setup_py


def test_rust_crates_declare_the_repo_minimum_rust_version():
    makefile = _read_text("Makefile")
    min_rust_version = _extract_rust_version(
        r"^MIN_RUST_VERSION := (?P<version>[0-9.]+)$",
        makefile,
    )

    for relative_path in (
        "crates/ov_cli/Cargo.toml",
        "crates/ragfs/Cargo.toml",
        "crates/ragfs-python/Cargo.toml",
    ):
        cargo_toml = _read_text(relative_path)
        assert f'rust-version = "{min_rust_version}"' in cargo_toml


