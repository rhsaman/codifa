"""detect_test_commands: maps a project's markers to the correct test command
per language, and never fabricates a passing test for C/C++ without a runner.
"""

import os

from graph import (
    detect_frontend_stack,
    detect_test_commands,
    scoped_test_command,
)


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
    # falsely report a passing test (exit 0). It should leave cmds empty so the
    # Coder is told there are no project tests to run.
    _mk(str(tmp_path), "main.c", "int main(){return 0;}\n")
    assert detect_test_commands(str(tmp_path)) == []


def test_python_uses_uv_run_pytest(tmp_path):
    _mk(str(tmp_path), "pyproject.toml", "[project]\nname = 'demo'\n")
    assert detect_test_commands(str(tmp_path)) == ["uv run pytest"]


def test_scoped_pytest_file_and_single_test(tmp_path):
    _mk(str(tmp_path), "pyproject.toml", "[project]\nname = 'demo'\n")
    root = str(tmp_path)
    # File scope: the project's own runner with the file appended.
    assert scoped_test_command(root, "backend/tests/test_x.py") == (
        "uv run pytest backend/tests/test_x.py"
    )
    # Single-test scope: pytest's native file::test form.
    assert scoped_test_command(root, "backend/tests/test_x.py", test="test_ok") == (
        "uv run pytest backend/tests/test_x.py::test_ok"
    )


def test_scoped_vitest_uses_related(tmp_path):
    _mk(
        str(tmp_path),
        "package.json",
        '{"scripts": {"test": "vitest"}, "devDependencies": {"vitest": "^3"}}',
    )
    root = str(tmp_path)
    assert scoped_test_command(root, "src/app.test.ts") == (
        "npx vitest run src/app.test.ts"
    )
    # related=True: vitest's related mode (tests touching the changed files);
    # --run keeps it out of watch mode.
    assert scoped_test_command(root, "src/app.ts", related=True) == (
        "npx vitest related src/app.ts --run"
    )


def test_scoped_jest_uses_dash_t(tmp_path):
    _mk(
        str(tmp_path),
        "package.json",
        '{"scripts": {"test": "jest"}, "devDependencies": {"jest": "^29"}}',
    )
    assert scoped_test_command(
        str(tmp_path), "src/app.test.js", test="renders the button"
    ) == 'npx jest src/app.test.js -t "renders the button"'


def test_scoped_go_uses_run_flag(tmp_path):
    _mk(str(tmp_path), "go.mod", "module demo\n")
    root = str(tmp_path)
    assert scoped_test_command(root, "pkg/thing_test.go") == (
        "go test ./pkg"
    )
    assert scoped_test_command(root, "pkg/thing_test.go", test="TestThing") == (
        'go test ./pkg -run "TestThing"'
    )


def test_scoped_cargo_uses_test_filter(tmp_path):
    _mk(str(tmp_path), "Cargo.toml", "[package]\nname = 'demo'\n")
    assert scoped_test_command(
        str(tmp_path), "src/lib.rs", test="adds_numbers"
    ) == "cargo test adds_numbers"


def test_scoped_without_runner_returns_none(tmp_path):
    # No manifest -> no fabricated command; the caller falls back to guidance.
    _mk(str(tmp_path), "main.c", "int main(){return 0;}\n")
    assert not scoped_test_command(str(tmp_path), "main.c")


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
