"""Re-export Google's speech_embedding (TFHub, Apache-2.0) as the wake front end's embedding model.

Task Q53, step 3 of "Closing B4" in README.md.

    python export_embedding.py MODULE_DIR --inspect
    python export_embedding.py MODULE_DIR [--out PATH] [--input-tensor NAME] [--output-tensor NAME]

MODULE_DIR is Google's module, unpacked: download
https://tfhub.dev/google/speech_embedding/1?tf-hub-format=compressed (it redirects to
Kaggle, https://www.kaggle.com/models/google/speech-embedding) and `tar -xzf` it into
an empty folder. It takes 16 kHz audio and computes its own log-mel inside.

openWakeWord's `embedding_model.onnx` skips that mel step: it takes 76-frame mel windows
[batch, 76, 32, 1] and returns [batch, 1, 1, 96]. So we cut Google's graph at the input of
its first convolution (where the mel windows enter the conv tower), feed a placeholder of
that shape there, keep everything up to the module's embedding output, and convert that
subgraph with tf2onnx. --inspect lists the convolutions and the cut it would make, so
the tensors can be set by hand if the automatic choice is wrong.

The file is written to $WAKE_WORK/frontend/speech_embedding.onnx by default. Then run
`python embedding_parity.py <that file>` (or prepare_frontend.py --embedding <that file>,
which runs it too) to compare it with openWakeWord's published file.

Needs (build time only, nothing is shipped): tensorflow, tensorflow-hub, tf2onnx
(all Apache-2.0); see requirements-embedding.txt.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

WINDOW = 76
N_MELS = 32
EMBED = 96
OPSET = 13


@dataclass(frozen=True)
class GraphNode:
    """The parts of a TF NodeDef the cut logic needs (kept TF-free so it can be tested)."""

    name: str
    op: str
    inputs: tuple[str, ...]


def tensor_name(ref: str) -> str:
    """'^ctrl' and 'node' and 'node:1' → 'node:0' / 'node:1' (control inputs dropped by callers)."""
    return ref if ":" in ref else ref + ":0"


def topo_order(nodes: list[GraphNode]) -> list[GraphNode]:
    by_name = {n.name: n for n in nodes}
    seen: set[str] = set()
    order: list[GraphNode] = []

    def visit(name: str) -> None:
        stack = [(name, False)]
        while stack:
            current, done = stack.pop()
            if done:
                order.append(by_name[current])
                continue
            if current in seen or current not in by_name:
                continue
            seen.add(current)
            stack.append((current, True))
            for ref in by_name[current].inputs:
                parent = ref.lstrip("^").split(":")[0]
                if parent not in seen:
                    stack.append((parent, False))

    for n in nodes:
        visit(n.name)
    return order


def convolutions(nodes: list[GraphNode]) -> list[GraphNode]:
    return [n for n in topo_order(nodes) if n.op in ("Conv2D", "DepthwiseConv2dNative")]


def choose_cut(nodes: list[GraphNode], output: str) -> tuple[str, str]:
    """(input tensor, output tensor): the data input of the first convolution that the
    output depends on, and the output itself."""
    by_name = {n.name: n for n in nodes}
    needed: set[str] = set()
    stack = [output.split(":")[0]]
    while stack:
        name = stack.pop()
        if name in needed or name not in by_name:
            continue
        needed.add(name)
        stack.extend(ref.lstrip("^").split(":")[0] for ref in by_name[name].inputs if not ref.startswith("^"))
    convs = [n for n in convolutions(nodes) if n.name in needed]
    if not convs:
        raise ValueError(f"no convolution feeds {output}; pass --input-tensor")
    return tensor_name(convs[0].inputs[0]), tensor_name(output)


# --- TensorFlow parts (build time) -----------------------------------------------------

def load_frozen(module_dir: Path):
    """Frozen GraphDef and output tensor name of the module's default signature."""
    import tensorflow as tf
    import tensorflow_hub as hub
    from tensorflow.python.framework.convert_to_constants import convert_variables_to_constants_v2

    loaded = hub.load(str(module_dir))
    fn = loaded.signatures["default"]
    frozen = convert_variables_to_constants_v2(fn)
    graph_def = frozen.graph.as_graph_def()
    output = frozen.outputs[0].name
    print(f"module input {[t.name for t in frozen.inputs]} → output {output} {frozen.outputs[0].shape}")
    del tf
    return graph_def, output


def graph_nodes(graph_def) -> list[GraphNode]:
    return [GraphNode(n.name, n.op, tuple(n.input)) for n in graph_def.node]


def cut(graph_def, input_tensor: str, output_tensor: str):
    """New GraphDef: placeholder 'mel' [None, 76, 32, 1] feeding input_tensor, up to output_tensor."""
    import tensorflow as tf

    with tf.Graph().as_default() as g:
        mel = tf.compat.v1.placeholder(tf.float32, [None, WINDOW, N_MELS, 1], name="mel")
        (out,) = tf.compat.v1.import_graph_def(
            graph_def, input_map={input_tensor: mel}, return_elements=[output_tensor], name="g"
        )
        tf.identity(out, name="embedding")
        full = g.as_graph_def()
    return tf.compat.v1.graph_util.extract_sub_graph(full, ["embedding"])


def check_shape(graph_def) -> None:
    import numpy as np
    import tensorflow as tf

    with tf.Graph().as_default() as g:
        tf.compat.v1.import_graph_def(graph_def, name="")
        with tf.compat.v1.Session(graph=g) as sess:
            y = sess.run("embedding:0", {"mel:0": np.zeros((2, WINDOW, N_MELS, 1), np.float32)})
    if y.shape != (2, 1, 1, EMBED):
        sys.exit(
            f"the cut gives output shape {y.shape}, expected (2, 1, 1, {EMBED}). "
            "Run --inspect and pass --input-tensor / --output-tensor."
        )


def to_onnx(graph_def, out_path: Path) -> None:
    import tf2onnx

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tf2onnx.convert.from_graph_def(
        graph_def,
        input_names=["mel:0"],
        output_names=["embedding:0"],
        opset=OPSET,
        output_path=str(out_path),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("module_dir", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--inspect", action="store_true", help="list convolutions and the proposed cut, write nothing")
    parser.add_argument("--input-tensor", help="tensor where mel windows enter (default: first conv's input)")
    parser.add_argument("--output-tensor", help="embedding tensor (default: the module's default output)")
    args = parser.parse_args()

    if not (args.module_dir / "saved_model.pb").exists():
        sys.exit(f"{args.module_dir} has no saved_model.pb; unpack the TFHub tarball there first")

    graph_def, default_output = load_frozen(args.module_dir)
    nodes = graph_nodes(graph_def)
    output = args.output_tensor or default_output
    auto_in, _ = choose_cut(nodes, output)
    input_tensor = args.input_tensor or auto_in

    if args.inspect:
        for n in convolutions(nodes):
            print(f"  {n.op:22} {n.name}  ← {n.inputs[0]}")
        print(f"cut: mel windows enter at {input_tensor}; embedding is {output}")
        return

    sub = cut(graph_def, input_tensor, output)
    check_shape(sub)
    if args.out:
        out = args.out
    else:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from common import work_dir

        out = work_dir() / "frontend" / "speech_embedding.onnx"
    to_onnx(sub, out)
    print(f"wrote {out}\nnext: python embedding_parity.py {out}")


if __name__ == "__main__":
    main()
