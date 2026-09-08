"""Project repeated read-only results without changing the durable transcript."""

import json
from collections.abc import Sequence

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

READ_ONLY_TOOLS = frozenset({"read", "grep", "glob"})


def project_tool_results(
    messages: Sequence[BaseMessage],
    *,
    read_only_tools: frozenset[str] = READ_ONLY_TOOLS,
    min_chars: int = 512,
) -> list[BaseMessage]:
    """Keep a full reference in this request for every shortened duplicate."""
    calls: dict[str, tuple[str, str]] = {}
    originals: dict[tuple[str, str, str], str] = {}
    projected: list[BaseMessage] = []
    for message in messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls:
                name, call_id = call.get("name"), call.get("id")
                if name not in read_only_tools or not call_id:
                    continue
                try:
                    args = json.dumps(call.get("args", {}), sort_keys=True, ensure_ascii=False)
                except (TypeError, ValueError):
                    continue
                calls[call_id] = (name, args)
        elif isinstance(message, ToolMessage):
            signature = calls.get(message.tool_call_id)
            content = message.content
            if (
                signature is not None
                and (not message.name or message.name == signature[0])
                and message.status == "success"
                and isinstance(content, str)
                and len(content) >= min_chars
                and not content.lstrip().upper().startswith(("ERROR", "INVALID PATH"))
            ):
                key = (*signature, content)
                original_id = originals.get(key)
                if original_id is None:
                    originals[key] = message.tool_call_id
                else:
                    reference = (
                        f"نتیجه عیناً با پاسخ ابزار {original_id} در همین پیام‌ها یکسان است؛ "
                        "متن کامل همان پاسخ را استفاده کن."
                    )
                    if len(reference) < len(content):
                        message = message.model_copy(update={"content": reference})
        projected.append(message)
    return projected
