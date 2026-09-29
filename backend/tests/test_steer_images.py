"""تست helper پیام steer گراف: متن + فایل + عکس به پیام چندبخشی تبدیل می‌شود."""

from graph import _steer_to_human_message


def test_steer_text_only_is_single_text():
    msg = _steer_to_human_message([{"id": "m1", "prompt": "p1"}])
    assert isinstance(msg.content, str)
    assert "p1" in msg.content
    assert "INTERRUPTION" in msg.content


def test_steer_attachments_appended_to_text():
    msg = _steer_to_human_message(
        [{"id": "m1", "prompt": "p1", "attachments": ["a.txt"]}]
    )
    assert isinstance(msg.content, str)
    assert "`a.txt`" in msg.content


def test_steer_images_build_multipart_blocks():
    msg = _steer_to_human_message(
        [
            {
                "id": "m1",
                "prompt": "p1",
                "images": [
                    {
                        "path": "/tmp/x.png",
                        "name": "x.png",
                        "dataUrl": "data:image/png;base64,AAA",
                    }
                ],
            }
        ]
    )
    assert isinstance(msg.content, list)
    kinds = [b.get("type") for b in msg.content]
    assert kinds[0] == "text"
    assert "image_url" in kinds
    img_block = next(b for b in msg.content if b.get("type") == "image_url")
    assert img_block["image_url"]["url"].startswith("data:image/png;base64,")


def test_steer_skills_and_mcp_servers_injected_in_text():
    msg = _steer_to_human_message(
        [
            {
                "id": "m1",
                "prompt": "p1",
                "skills": ["alpha"],
                "mcp_servers": {"docker": {"command": "docker"}},
            }
        ]
    )
    text = msg.content if isinstance(msg.content, str) else msg.content[0]["text"]
    assert "`alpha`" in text
    assert "`docker`" in text


def test_steer_multiple_merges_text_and_images():
    msg = _steer_to_human_message(
        [
            {"id": "m1", "prompt": "p1", "attachments": ["a.txt"]},
            {
                "id": "m2",
                "prompt": "p2",
                "images": [
                    {
                        "path": "/tmp/y.png",
                        "name": "y.png",
                        "dataUrl": "data:image/png;base64,BBB",
                    }
                ],
            },
        ]
    )
    assert isinstance(msg.content, list)
    text = msg.content[0]["text"]
    assert "- p1" in text and "- p2" in text
    assert "`a.txt`" in text
    assert len([b for b in msg.content if b.get("type") == "image_url"]) == 1
