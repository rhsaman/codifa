"""Debug: why does model_max_output return 4000 for tokenrouter deepseek-v4-pro-0813-free?"""
import asyncio
import sys

sys.path.insert(0, "backend")

import providers


async def main():
    provider = "tokenrouter"
    model = "deepseek/deepseek-v4-pro-0813-free"
    base_url = "https://api.tokenrouter.com/v1"

    # 1. Catalog lookup path
    catalog = await providers._models_dev_catalog()
    dev_id = providers._models_dev_id(provider, model, base_url)
    keys = providers._models_dev_keys(provider, base_url, dev_id)
    print("dev_id:", dev_id)
    print("keys:", keys)
    print("normalized:", providers._normalize_catalog_id(dev_id))
    entry = providers._models_dev_entry(catalog, keys, dev_id)
    print("entry keys:", list(entry.keys())[:10] if entry else None)
    print("entry limit:", (entry.get("limit") if entry else None))
    out = providers._models_dev_max_output(catalog, keys, dev_id)
    print("catalog max_output:", out)

    # 2. Full model_max_output
    mo = await providers.model_max_output(provider, model, base_url)
    print("model_max_output:", mo)

    # 3. is_opencode check
    print("is_opencode:", providers.is_opencode(provider, base_url))

    # 4. What does the gateway /models payload advertise?
    try:
        enlisted = await providers.list_models(provider, base_url)
        for e in enlisted:
            if e.get("id") == model:
                print("gateway entry:", {k: e.get(k) for k in ("id", "context", "max_output", "reasoning")})
                break
    except Exception as exc:  # noqa: BLE001
        print("list_models error:", exc)


asyncio.run(main())