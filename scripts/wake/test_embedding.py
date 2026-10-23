"""Checks for the embedding parity step (Q53) that run without TensorFlow or a GPU:
`python -m unittest test_embedding` here. Needs numpy and onnxruntime; the fixtures are
openWakeWord's published file, a copy with one kernel changed, and the mel model."""

import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import embedding_parity as ep  # noqa: E402
import onnx_weights  # noqa: E402
from export_embedding import GraphNode, choose_cut, convolutions, tensor_name  # noqa: E402

try:
    import onnxruntime  # noqa: F401

    HAVE_ORT = True
except ImportError:
    HAVE_ORT = False

MEL = ep.PUBLISHED.parent / "melspectrogram.onnx"


def perturbed_copy(directory: str, scale: float = 1.05) -> Path:
    """The published file with the last conv kernel scaled, same size and structure."""
    data = ep.PUBLISHED.read_bytes()
    dims, values = onnx_weights.read(str(ep.PUBLISHED)).initializers["model/conv2d_19/Conv2D/ReadVariableOp:0"]
    raw = struct.pack(f"<{len(values)}f", *values)
    assert data.count(raw) == 1, "kernel bytes should appear once"
    changed = struct.pack(f"<{len(values)}f", *(v * scale for v in values))
    out = Path(directory) / "perturbed.onnx"
    out.write_bytes(data.replace(raw, changed))
    return out


class WindowsTest(unittest.TestCase):
    def test_windows_have_the_engine_shape(self):
        for name, w in ep.test_windows().items():
            self.assertEqual(w.shape[1:], (76, 32, 1), name)
            self.assertEqual(w.dtype, np.float32, name)
            self.assertTrue(np.all(np.isfinite(w)), name)

    def test_transform_matches_the_engine(self):
        # src/lib/wake/openwakeword.ts: melTransform = x / 10 + 2
        self.assertEqual(ep.mel_transform(np.array([-20.0, 0.0, 30.0])).tolist(), [0.0, 2.0, 5.0])

    def test_one_window_per_80_ms(self):
        audio = np.zeros(16000 * 2)
        frames = 1 + (audio.size - 512) // 160
        self.assertEqual(ep.windows_from_audio(audio).shape[0], 1 + (frames - 76) // 8)


@unittest.skipUnless(HAVE_ORT, "onnxruntime not installed")
class ParityTest(unittest.TestCase):
    def test_same_file_matches(self):
        result = ep.compare(ep.PUBLISHED, ep.PUBLISHED)
        self.assertEqual(result.verdict, "match")
        self.assertEqual(result.weights, (20, 20))
        self.assertEqual(max(result.max_diff.values()), 0.0)

    def test_changed_kernel_differs(self):
        with tempfile.TemporaryDirectory() as d:
            result = ep.compare(perturbed_copy(d), ep.PUBLISHED)
        self.assertEqual(result.verdict, "differ")
        self.assertEqual(result.weights, (19, 20))

    def test_tiny_change_within_tolerance_matches(self):
        with tempfile.TemporaryDirectory() as d:
            result = ep.compare(perturbed_copy(d, scale=1 + 1e-7), ep.PUBLISHED)
        self.assertEqual(result.verdict, "match")

    def test_wrong_model_is_unusable(self):
        result = ep.compare(MEL, ep.PUBLISHED)
        self.assertEqual(result.verdict, "unusable")
        self.assertIn("input shape", result.reason)

    def test_cli_exit_codes(self):
        self.assertEqual(ep.main([str(ep.PUBLISHED)]), 0)
        self.assertEqual(ep.main([str(MEL)]), 1)
        self.assertEqual(ep.main(["/no/such/file.onnx"]), 2)


class CutTest(unittest.TestCase):
    """The graph-cut logic of export_embedding.py on a hand-made graph shaped like the module:
    audio → log-mel → normalise → conv tower → embedding, plus a side branch."""

    GRAPH = [
        GraphNode("embedding", "Identity", ("tower/conv_2/Conv2D",)),
        GraphNode("tower/conv_2/Conv2D", "Conv2D", ("tower/conv_1/relu", "tower/conv_2/kernel")),
        GraphNode("tower/conv_1/relu", "Relu", ("tower/conv_1/Conv2D",)),
        GraphNode("tower/conv_1/Conv2D", "Conv2D", ("frontend/normalised", "tower/conv_1/kernel")),
        GraphNode("frontend/normalised", "AddV2", ("frontend/scaled", "frontend/two")),
        GraphNode("frontend/scaled", "Mul", ("frontend/logmel:0", "frontend/tenth")),
        GraphNode("frontend/logmel", "Log", ("frontend/mel",)),
        GraphNode("frontend/mel", "MatMul", ("samples", "frontend/melW")),
        GraphNode("side/Conv2D", "Conv2D", ("samples", "side/kernel")),
        GraphNode("samples", "Placeholder", ()),
        GraphNode("tower/conv_1/kernel", "Const", ()),
        GraphNode("tower/conv_2/kernel", "Const", ()),
        GraphNode("frontend/melW", "Const", ()),
        GraphNode("frontend/two", "Const", ()),
        GraphNode("frontend/tenth", "Const", ("^samples",)),
        GraphNode("side/kernel", "Const", ()),
    ]

    def test_cuts_at_the_first_conv_the_output_needs(self):
        self.assertEqual(choose_cut(self.GRAPH, "embedding:0"), ("frontend/normalised:0", "embedding:0"))

    def test_convolutions_in_data_order(self):
        names = [n.name for n in convolutions(self.GRAPH)]
        self.assertLess(names.index("tower/conv_1/Conv2D"), names.index("tower/conv_2/Conv2D"))

    def test_no_conv_is_an_error(self):
        with self.assertRaises(ValueError):
            choose_cut(self.GRAPH, "frontend/logmel:0")

    def test_tensor_names(self):
        self.assertEqual(tensor_name("a/b"), "a/b:0")
        self.assertEqual(tensor_name("a/b:1"), "a/b:1")


if __name__ == "__main__":
    unittest.main()
