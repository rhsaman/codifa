"""detect_test_commands: maps a project's markers to the correct test command
per language, and never fabricates a passing test for C/C++ without a runner.
"""

import os

from graph import detect_test_commands


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
    assert detect_test_commands(str(tmp_path)) == ["npx jest"]
