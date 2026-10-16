#!/usr/bin/env python3
"""One-time export of the Laya decision router to ONNX.

Laya (`convaiinnovations/laya`) is a ModernBERT encoder plus a from-scratch
decision head, shipped as a torch checkpoint whose architecture lives in the
`rl_common.py` that travels with the snapshot. The app used to run it through
the Python sidecar, which meant `torch` + `transformers` stayed in the runtime
dependency set and cost ~1.5 GB of RAM per load.

This script converts the checkpoint to ONNX once, offline. After that the
native Rust agent runs it in-process through `ort` (the same runtime the e5
embedding model already uses), so the sidecar no longer needs torch at all.

Run it with the backend venv (the only place torch is installed):

    backend/.venv/bin/python scripts/export-laya-onnx.py --preflight-only
    backend/.venv/bin/python scripts/export-laya-onnx.py

The exported graph takes the same tensors the torch model's forward pass does
and returns the per-option logits:

    input_ids      int64 [batch, seq]
    attention_mask int64 [batch, seq]
    marker_pos     int64 [batch, n_markers]
    marker_mask    bool  [batch, n_markers]
    qtype          int64 [batch]
    -> logits      float32 [batch, n_markers]

`act_head` is deliberately not exported: skill routing only reads the option
logits, and dropping the head keeps the graph (and the file) smaller.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time

#: Sub-builds of the snapshot, in the order the router probes them. The base
#: build handles Latin requests; `multilingual` is preferred for non-Latin
#: (e.g. Persian) ones, mirroring `laya_router._resolve_model_dir`.
SUBDIRS = ("", "multilingual")

#: Default snapshot location (the app's data root, see `model_download.py`).
DEFAULT_MODEL_DIR = os.path.join(
    os.environ.get("CODER_DATA_DIR") or os.path.expanduser("~/.codifa"),
    "models",
    "laya--convaiinnovations--laya",
)


def preflight(model_dir: str) -> bool:
    """Report what the export needs before loading anything heavy."""
    print(f"model dir: {model_dir}")
    if not os.path.isdir(model_dir):
        print("  MISSING — download the decision model from Settings -> Models")
        return False

    ok = True
    for mod in ("torch", "transformers", "safetensors", "onnx", "onnxruntime"):
        try:
            m = __import__(mod)
            print(f"  {mod:14} {getattr(m, '__version__', '?')}")
        except Exception as exc:  # noqa: BLE001 — report and keep checking
            print(f"  {mod:14} MISSING ({exc})")
            ok = False

    for sub in SUBDIRS:
        d = os.path.join(model_dir, sub) if sub else model_dir
        label = sub or "(base)"
        weights = os.path.join(d, "model.safetensors")
        if not os.path.isfile(weights):
            print(f"  {label:14} no model.safetensors — skipped")
            continue
        size_mb = os.path.getsize(weights) / 1048576
        print(f"  {label:14} {size_mb:.0f} MB weights, encoder={os.path.isdir(os.path.join(d, 'encoder'))}")
    return ok


def load_rl_common(model_dir: str):
    """Import the `rl_common.py` that ships with the snapshot."""
    path = os.path.join(model_dir, "rl_common.py")
    if not os.path.isfile(path):
        raise SystemExit(f"rl_common.py not found in {model_dir}")
    spec = importlib.util.spec_from_file_location("laya_rl_common", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_logits_only(torch):
    """Build the wrapper class: an `nn.Module` returning just the option logits.

    `torch.onnx.export` walks `model.modules()`, so the wrapper must be a real
    module rather than a plain callable.
    """

    class LogitsOnly(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model

        def forward(self, input_ids, attention_mask, marker_pos, marker_mask, qtype):
            logits, _act = self.model(input_ids, attention_mask, marker_pos, marker_mask, qtype)
            return logits

    return LogitsOnly


def unroll_transformer_encoder(model) -> int:
    """Replace the head container's fused forward with a plain layer loop.

    `nn.TransformerEncoder.forward` lowers to `aten::_transformer_encoder_layer_fwd`
    when the sparsity fast path is on, and ONNX has no symbolic for that operator.
    The container's forward is exactly "run each layer in order" (no norm is
    configured here), so looping the layers is equivalent and exports cleanly.
    Returns the number of layers unrolled.
    """
    head = getattr(model, "head", None)
    if head is None:
        return 0
    layers = list(head.layers)

    def forward(src, mask=None, src_key_padding_mask=None, is_causal=False):
        out = src
        for layer in layers:
            out = layer(
                out,
                src_mask=mask,
                src_key_padding_mask=src_key_padding_mask,
                is_causal=is_causal,
            )
        return out

    head.forward = forward
    return len(layers)


def export_one(model_dir: str, sub: str, rl_common, torch) -> str:
    """Export one sub-build; returns the written path."""
    src = os.path.join(model_dir, sub) if sub else model_dir
    label = sub or "base"
    weights = os.path.join(src, "model.safetensors")
    if not os.path.isfile(weights):
        print(f"[{label}] no weights — skipped")
        return ""

    cfg = rl_common.load_cfg(os.path.join(src, "rl_agent_config.json"))
    print(f"[{label}] encoder={cfg['encoder']} head_layers={cfg['head_layers']} "
          f"max_len={cfg['max_len']} head_max_len={cfg['head_max_len']}")

    # Architecture from the shipped config, weights from the checkpoint: the
    # encoder is built offline (no network) and the state dict fills it in.
    model = rl_common.build_model(cfg, encoder_dir=os.path.join(src, "encoder"))
    from safetensors.torch import load_file

    state = load_file(weights)
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing:
        print(f"[{label}] WARNING missing keys: {list(missing)[:5]}")
    if unexpected:
        print(f"[{label}] WARNING unexpected keys: {list(unexpected)[:5]}")
    model.eval()
    unrolled = unroll_transformer_encoder(model)
    print(f"[{label}] head layers unrolled for export: {unrolled}")

    wrapper = make_logits_only(torch)(model)
    batch, seq, n_markers = 2, 64, 2
    input_ids = torch.ones((batch, seq), dtype=torch.long)
    attention_mask = torch.ones((batch, seq), dtype=torch.long)
    marker_pos = torch.tensor([[5, 9], [6, 11]], dtype=torch.long)
    marker_mask = torch.ones((batch, n_markers), dtype=torch.bool)
    qtype = torch.zeros((batch,), dtype=torch.long)

    out_dir = os.path.join(src, "onnx")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "model.onnx")

    with torch.no_grad():
        reference = wrapper(input_ids, attention_mask, marker_pos, marker_mask, qtype)

    # The legacy (TorchScript) exporter bakes the traced sequence length into
    # the attention reshapes, so any other length fails at runtime with
    # "input_shape_size == requested_shape_size was false". The dynamo exporter
    # propagates the symbolic shapes through those reshapes, which is what a
    # router needs: every request has a different length.
    torch.onnx.export(
        wrapper,
        (input_ids, attention_mask, marker_pos, marker_mask, qtype),
        out_path,
        input_names=["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"],
        output_names=["logits"],
        dynamic_shapes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "marker_pos": {0: "batch", 1: "n_markers"},
            "marker_mask": {0: "batch", 1: "n_markers"},
            "qtype": {0: "batch"},
        },
        opset_version=18,
        do_constant_folding=True,
        dynamo=True,
    )

    # Verify the exported graph against torch on the same inputs — an export
    # that silently diverges would route skills wrongly with no error. The
    # second run uses a DIFFERENT sequence length on purpose: a graph that only
    # works at the traced length would pass the first check and fail in the app.
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
    feeds = {
        "input_ids": input_ids.numpy(),
        "attention_mask": attention_mask.numpy(),
        "marker_pos": marker_pos.numpy(),
        "marker_mask": marker_mask.numpy(),
        "qtype": qtype.numpy(),
    }
    got = sess.run(["logits"], feeds)[0]
    diff = float(np.abs(got - reference.numpy()).max())
    size_mb = os.path.getsize(out_path) / 1048576
    print(f"[{label}] wrote {out_path} ({size_mb:.0f} MB) max|onnx-torch|={diff:.2e}")
    if diff > 1e-3:
        raise SystemExit(f"[{label}] export diverged from torch (diff={diff})")

    alt_seq, alt_markers = 89, 3
    alt_ids = torch.ones((1, alt_seq), dtype=torch.long)
    alt_mask = torch.ones((1, alt_seq), dtype=torch.long)
    alt_pos = torch.tensor([[5, 20, 40]], dtype=torch.long)
    alt_mmask = torch.ones((1, alt_markers), dtype=torch.bool)
    alt_qtype = torch.zeros((1,), dtype=torch.long)
    with torch.no_grad():
        alt_ref = wrapper(alt_ids, alt_mask, alt_pos, alt_mmask, alt_qtype)
    alt_got = sess.run(
        ["logits"],
        {
            "input_ids": alt_ids.numpy(),
            "attention_mask": alt_mask.numpy(),
            "marker_pos": alt_pos.numpy(),
            "marker_mask": alt_mmask.numpy(),
            "qtype": alt_qtype.numpy(),
        },
    )[0]
    alt_diff = float(np.abs(alt_got - alt_ref.numpy()).max())
    print(f"[{label}] dynamic-shape check (seq={alt_seq}, markers={alt_markers}) "
          f"max|onnx-torch|={alt_diff:.2e}")
    if alt_diff > 1e-3:
        raise SystemExit(f"[{label}] graph is not dynamic (diff={alt_diff})")

    # Dynamic int8 quantization: the fp32 graph is ~1.6 GB, which is more RAM
    # than the torch model it replaces. Quantizing the MatMuls cuts it to a
    # fraction while keeping the ranking intact — verified below, because a
    # silently degraded graph would route skills wrongly with no error.
    quant_path = os.path.join(out_dir, "model.int8.onnx")
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(out_path, quant_path, weight_type=QuantType.QInt8)
    qsess = ort.InferenceSession(quant_path, providers=["CPUExecutionProvider"])
    qgot = qsess.run(["logits"], feeds)[0]
    qdiff = float(np.abs(qgot - reference.numpy()).max())
    qsize_mb = os.path.getsize(quant_path) / 1048576
    print(f"[{label}] wrote {quant_path} ({qsize_mb:.0f} MB) max|int8-torch|={qdiff:.2e}")
    if qdiff > 0.5:
        raise SystemExit(f"[{label}] int8 graph diverged too far (diff={qdiff})")

    # The fp32 graph is only an intermediate — the router loads the int8 one.
    # Leaving it behind costs ~3 GB across the two builds, because the dynamo
    # exporter writes the weights to a sidecar `.data` file next to the graph.
    # That is more disk than the torch checkpoint this export replaces.
    for stale in (out_path, out_path + ".data"):
        if os.path.isfile(stale):
            os.remove(stale)
    return quant_path


def clean_export_inputs(model_dir: str) -> int:
    """Delete everything the export consumed or left behind; returns bytes freed.

    Two kinds of dead weight accumulate in a snapshot:

    * the torch checkpoints (``*.safetensors``) — only an input to this script,
      ~2 GB across the shipped sub-builds;
    * the fp32 ONNX graph and its ``.data`` weight sidecar — the dynamo
      exporter writes the weights next to the graph, so a run that predates the
      cleanup in :func:`export_one` (or one interrupted mid-export) leaves
      ~1.6 GB per sub-build that the router never loads, because it prefers
      ``model.int8.onnx``.

    Re-exporting needs the checkpoints again, which means re-downloading; that
    is the trade this makes.
    """
    freed = 0
    for root, _dirs, files in os.walk(model_dir):
        for name in files:
            if not (
                name.endswith(".safetensors")
                or name == "model.onnx"
                or name == "model.onnx.data"
            ):
                continue
            path = os.path.join(root, name)
            try:
                freed += os.path.getsize(path)
                os.remove(path)
            except OSError:  # noqa: BLE001, S110 — a locked file must not abort the sweep
                continue
    return freed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    ap.add_argument("--preflight-only", action="store_true")
    ap.add_argument(
        "--prune-weights",
        action="store_true",
        help="delete the torch checkpoints after a successful export",
    )
    ap.add_argument(
        "--clean-only",
        action="store_true",
        help="only delete export inputs and orphaned fp32 graphs (no export)",
    )
    args = ap.parse_args()

    if args.clean_only:
        freed = clean_export_inputs(args.model_dir)
        print(f"freed {freed / 1048576:.0f} MB")
        return 0

    if not preflight(args.model_dir):
        return 1
    if args.preflight_only:
        return 0

    import torch

    # Keep the export light: this runs on the user's machine, and the encoder
    # is large enough that extra threads only add peak memory.
    torch.set_num_threads(2)
    torch.set_grad_enabled(False)
    # The decision head is an `nn.TransformerEncoder`, whose fused fast path
    # lowers to `aten::_transformer_encoder_layer_fwd` — an operator ONNX has
    # no symbolic for. Disabling it decomposes the layer into standard ops
    # (matmul/softmax/layernorm) that export cleanly.
    torch.backends.mha.set_fastpath_enabled(False)

    rl_common = load_rl_common(args.model_dir)
    started = time.time()
    written = []
    for sub in SUBDIRS:
        path = export_one(args.model_dir, sub, rl_common, torch)
        if path:
            written.append(path)
    print(f"done in {time.time() - started:.0f}s: {len(written)} graph(s)")
    if args.prune_weights and written:
        freed = clean_export_inputs(args.model_dir)
        print(f"freed {freed / 1048576:.0f} MB of export inputs")
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())
