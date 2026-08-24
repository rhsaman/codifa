import asyncio
import os

import pytest

from agents import _load_images, _maybe_downscale_image, _MAX_VISION_DIM, _MAX_VISION_BYTES
import graph


def _q():
    class Q:
        def put_nowait(self, x):
            pass

    return Q()


def test_load_images_prefers_dataurl():
    items = [{"path": "/tmp/does-not-exist.png", "dataUrl": "data:image/png;base64,AAAA"}]
    assert _load_images(items) == ["data:image/png;base64,AAAA"]


def test_load_images_falls_back_to_path(tmp_path):
    p = tmp_path / "a.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    out = _load_images([str(p)])
    assert len(out) == 1 and out[0].startswith("data:image/png;base64,")


def test_load_images_skips_unreadable():
    assert _load_images(["/no/such/file.png"]) == []
    assert _load_images([{"path": "/no/such/file.png"}]) == []


def test_load_images_handles_string_and_dict_mixed(tmp_path):
    p = tmp_path / "b.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    items = [str(p), {"dataUrl": "data:image/png;base64,CCCC"}]
    out = _load_images(items)
    assert out == [
        "data:image/png;base64," + __import__("base64").b64encode(b"\x89PNG\r\n\x1a\n").decode(),
        "data:image/png;base64,CCCC",
    ]


def _make_png_data_url(width: int, height: int) -> str:
    from io import BytesIO

    import numpy as np
    from PIL import Image

    # Noisy image (like a real screenshot) so PNG does not compress to nothing.
    arr = np.random.randint(0, 256, (height, width, 3), dtype="uint8")
    img = Image.fromarray(arr, "RGB")
    buf = BytesIO()
    img.save(buf, format="PNG")
    b64 = __import__("base64").b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def test_downscale_shrinks_oversized_image():
    # A screenshot-sized image well above the vision limits must be shrunk.
    big = _make_png_data_url(4000, 3000)
    assert len(__import__("base64").b64decode(big.split(",", 1)[1])) > _MAX_VISION_BYTES
    out = _maybe_downscale_image(big)
    assert out.startswith("data:image/")
    raw = __import__("base64").b64decode(out.split(",", 1)[1])
    assert len(raw) <= _MAX_VISION_BYTES
    from io import BytesIO

    from PIL import Image

    with Image.open(BytesIO(raw)) as img:
        assert max(img.size) <= _MAX_VISION_DIM


def test_downscale_keeps_small_image_untouched():
    small = _make_png_data_url(800, 600)
    assert _maybe_downscale_image(small) == small


def test_downscale_ignores_non_image_data_url():
    assert _maybe_downscale_image("data:text/plain;base64,QUJD") == "data:text/plain;base64,QUJD"


def test_expand_imports_pulls_relative(tmp_path):
    (tmp_path / "main.py").write_text("from . import helper\n")
    (tmp_path / "helper.py").write_text("z = 1\n")
    out = graph._expand_imports(str(tmp_path), ["main.py"])
    assert "helper.py" in out


def test_expand_imports_skips_bare_modules(tmp_path):
    (tmp_path / "m.py").write_text("import os\nimport sys\n")
    out = graph._expand_imports(str(tmp_path), ["m.py"])
    assert out == ["m.py"]  # no local files added


def test_rank_files_by_prompt_orders_by_token():
    files = ["lib/util.py", "src/auth/login.py", "readme.md"]
    ranked = graph._rank_files_by_prompt(files, "auth login")
    assert ranked[0] == "src/auth/login.py"
