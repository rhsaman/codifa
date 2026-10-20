#!/usr/bin/env python3
"""Report the REAL memory number Activity Monitor shows for Codifa.

Activity Monitor's "Memory" column is the *physical footprint* (dirty +
compressed pages), which can be several times the RSS. It also aggregates every
process that belongs to the app bundle: the shell, its WebKit web-content
processes and any sidecars. This script reports all three so a comparison is
never misled by RSS alone.
"""
import os
import re
import subprocess
import sys


def ps_table():
    out = subprocess.run(
        ["ps", "-Ao", "pid,ppid,rss,etime,comm"],
        capture_output=True,
        text=True,
    ).stdout
    rows = []
    for line in out.splitlines()[1:]:
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        try:
            rows.append(
                {
                    "pid": int(parts[0]),
                    "ppid": int(parts[1]),
                    "rss": int(parts[2]),
                    "etime": parts[3],
                    "comm": parts[4].strip(),
                }
            )
        except ValueError:
            continue
    return rows


def footprint(pid):
    """Physical footprint in MB (what Activity Monitor reports), plus peak."""
    try:
        out = subprocess.run(
            ["footprint", str(pid)], capture_output=True, text=True, timeout=120
        )
        if out.returncode == 0 and out.stdout.strip():
            m = re.search(
                r"Footprint:\s*([\d.]+)\s*(KB|MB|GB)", out.stdout, re.IGNORECASE
            )
            if m:
                val = float(m.group(1))
                unit = m.group(2).upper()
                return val * {"KB": 1 / 1024, "MB": 1, "GB": 1024}[unit]
    except Exception:
        pass
    try:
        out = subprocess.run(
            ["vmmap", "--summary", str(pid)], capture_output=True, text=True, timeout=120
        )
        for line in out.stdout.splitlines():
            if "Physical footprint" in line and "peak" not in line:
                nums = re.findall(r"([\d.]+)([KMG])", line)
                if nums:
                    val, unit = nums[0]
                    return float(val) * {"K": 1 / 1024, "M": 1, "G": 1024}[unit]
    except Exception:
        pass
    return None


def classify(rows):
    """Group processes into: shell, web content, lsp/node, other sidecars."""
    shell, web, lsp, side = [], [], [], []
    for r in rows:
        c = r["comm"].lower()
        if "codifa.app/contents/macos/codifa" in c or c.endswith("/codifa"):
            shell.append(r)
        elif "webcontent" in c:
            web.append(r)
        elif any(
            k in c
            for k in (
                "typescript-language-server",
                "rust-analyzer",
                "pylsp",
                "tsserver",
                "language-server",
            )
        ):
            lsp.append(r)
        elif any(k in c for k in ("python", "node", "esbuild", "chromium", "playwright")):
            side.append(r)
    return shell, web, lsp, side


def show(title, procs, do_footprint=True):
    if not procs:
        print(f"  {title}: (none)")
        return 0.0
    print(f"  {title}:")
    total_rss = total_fp = 0.0
    with_fp = 0
    for r in sorted(procs, key=lambda x: -x["rss"]):
        fp = footprint(r["pid"]) if do_footprint else None
        total_rss += r["rss"] / 1024
        if fp is not None:
            total_fp += fp
            with_fp += 1
        fp_s = f"{fp:7.1f}MB fp" if fp is not None else "        ?   "
        print(
            f"    {r['rss']/1024:7.1f}MB rss  {fp_s}  pid={r['pid']:<7} "
            f"up {r['etime']:<12} {os.path.basename(r['comm'])[:38]}"
        )
    print(f"    -> RSS {total_rss:.1f}MB" + (f"  |  footprint {total_fp:.1f}MB ({with_fp} procs)" if with_fp else ""))
    return total_fp if with_fp else total_rss


def main():
    rows = ps_table()
    shell, web, lsp, side = classify(rows)
    if not shell and not web:
        print("no Codifa app running")
        return 1

    print("=" * 78)
    print("Codifa memory — physical footprint is the number Activity Monitor shows")
    print("=" * 78)

    print("\n[1] APP SHELL")
    fp_shell = show("shell", shell)

    print("\n[2] WEB CONTENT (renderer)")
    # Only attribute WebContent procs that started within a minute of the shell,
    # since macOS does not parent them to the app.
    fp_web = show("web content", web)

    print("\n[3] LANGUAGE SERVERS")
    show("lsp", lsp)

    print("\n[4] OTHER SIDECARS")
    show("sidecars", side, do_footprint=False)

    print("\n" + "=" * 78)
    print(f"TOTAL (shell + web content)   RSS {(sum(r['rss'] for r in shell+web)/1024):.1f}MB"
          f"   FOOTPRINT {(fp_shell+fp_web):.1f}MB")
    print("=" * 78)

    print("\n[5] SYSTEM MEMORY PRESSURE")
    vm = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
    page = 4096
    stats = {}
    for line in vm.splitlines():
        m = re.match(r"([^:]+):\s+(\d+)", line)
        if m:
            stats[m.group(1).strip()] = int(m.group(2))
    for key in (
        "Pages free",
        "Pages active",
        "Pages inactive",
        "Pages wired down",
        "Pages occupied by compressor",
        "Swapouts",
    ):
        if key in stats:
            print(f"  {key:<32} {stats[key]*page/1024/1024/1024:7.2f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
