"""detect_test_commands: maps a project's markers to the correct test command
per language, and never fabricates a passing test for C/C++ without a runner.
"""

import os

from graph import detect_frontend_stack, detect_test_commands


def _mk(root, name, body=""):
    path = os.path.join(root, name)
    with open(path, "w", encoding="utf-8") as _f:
        _f.write(body)
    return path


def test_dart_pure_uses_dart_test(tmp_path):
    _mk(str(tmp_path), "pubspec.yaml", "name: demo\n")
    assert detect_test_commands(str(tmp_path)) == ["dart test"]


def test_flutter_uses_flutter_test(tmp_path):
    _mk(str(tmp_path), "pubspec.yaml", "dependencies:\n  flutter:\n")
    assert detect_test_commands(str(tmp_path)) == ["flutter test"]


def test_c_cpp_with_cmake_uses_ctest(tmp_path):
    _mk(str(tmp_path), "CMakeLists.txt", "cmake_minimum_required(VERSION 3.10)\n")
    assert detect_test_commands(str(tmp_path)) == ["ctest --output-on-failure"]


def test_c_cpp_with_makefile_uses_make_test(tmp_path):
    _mk(str(tmp_path), "Makefile", "test:\n\t@echo ok\n")
    assert detect_test_commands(str(tmp_path)) == ["make test"]


def test_c_cpp_without_runner_returns_no_commands(tmp_path):
    # A C/C++ project with no CMake/Make must NOT emit a no-op echo that would
    # falsely report a passing test (exit 0). It should leave cmds empty so
    # test_node reports "no tests configured".
    _mk(str(tmp_path), "main.c", "int main(){return 0;}\n")
    assert detect_test_commands(str(tmp_path)) == []


def test_python_uses_uv_run_pytest(tmp_path):
    _mk(str(tmp_path), "pyproject.toml", "[project]\nname = 'demo'\n")
    assert detect_test_commands(str(tmp_path)) == ["uv run pytest"]


def test_javascript_uses_npx_test_runner(tmp_path):
    _mk(str(tmp_path), "package.json", '{"scripts":{"test":"jest"}}')
    # The explicit `test` script is run as-is; the runner-specific command is
    # only inferred when no `test` script exists.
    assert detect_test_commands(str(tmp_path)) == ["npm run test"]


def test_react_vite_without_test_script_uses_vitest(tmp_path):
    _mk(
        str(tmp_path),
        "package.json",
        '{"dependencies":{"react":"^18"},"devDependencies":{"vite":"^5","vitest":"^1"}}',
    )
    assert detect_test_commands(str(tmp_path)) == ["npx vitest run"]


def test_vue_with_jest_uses_npx_jest(tmp_path):
    _mk(
        str(tmp_path),
        "package.json",
        '{"dependencies":{"vue":"^3"},"devDependencies":{"jest":"^29"}}',
    )
    assert detect_test_commands(str(tmp_path)) == ["npx jest"]


def test_svelte_with_vitest_uses_npx_vitest(tmp_path):
    _mk(
        str(tmp_path),
        "package.json",
        '{"devDependencies":{"svelte":"^4","vitest":"^1"}}',
    )
    assert detect_test_commands(str(tmp_path)) == ["npx vitest run"]


def test_test_frontend_script_is_included(tmp_path):
    _mk(
        str(tmp_path),
        "package.json",
        '{"scripts":{"test:frontend":"bash test/run-frontend.sh"}}',
    )
    assert detect_test_commands(str(tmp_path)) == ["npm run test:frontend"]


def test_python_plus_frontend_backend_dedup(tmp_path):
    # A combined workspace: Python backend + a node `test:frontend` script and a
    # node `test:backend` script that merely delegates to pytest. The pytest
    # delegation must be skipped so the suite is not run twice.
    _mk(str(tmp_path), "pyproject.toml", "[project]\nname = 'demo'\n")
    _mk(
        str(tmp_path),
        "package.json",
        '{"scripts":{"test:frontend":"bash test/run-frontend.sh",'
        '"test:backend":"uv run pytest"}}',
    )
    assert detect_test_commands(str(tmp_path)) == [
        "uv run pytest",
        "npm run test:frontend",
    ]


def test_detect_frontend_stack_react_vite():
    import json
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "package.json"), "w", encoding="utf-8") as _f:
            _f.write(
                json.dumps(
                    {
                        "dependencies": {"react": "^18"},
                        "devDependencies": {"vite": "^5", "vitest": "^1"},
                    }
                )
            )
        assert detect_frontend_stack(d) == "React (vitest)"


def test_detect_frontend_stack_none_without_frontend():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        assert detect_frontend_stack(d) == ""
