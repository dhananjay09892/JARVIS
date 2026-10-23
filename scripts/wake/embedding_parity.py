"""Embedding parity check for the wake front end (task Q53, licence risk B4).

    python embedding_parity.py CANDIDATE.onnx [PUBLISHED.onnx]

Runs a candidate embedding model (normally our re-export of Google's Apache-2.0
`speech_embedding`, made by export_embedding.py) and openWakeWord's published
`embedding_model.onnx` on the same mel windows, and compares their weights.

The inputs are real mel windows from our own mel front end (frontend_mel.py), with
openWakeWord's `x / 10 + 2` transform, cut into the 76-frame windows the engine in
src/lib/wake/ feeds the embedding model: [batch, 76, 32, 1] → [batch, 1, 1, 96].

Verdicts:
  match      outputs agree within tolerance: the published file computes Google's
             model, so it can be recorded as Apache-2.0 in plans/LICENCES.md.
  differ     both files run but disagree: the recipe trains on the re-export.
  unusable   the candidate has the wrong shape or gives non-finite output: fix the
             export before training on it.

Needs numpy and onnxruntime only.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import frontend_mel  # noqa: E402
import onnx_weights  # noqa: E402

PUBLISHED = (HERE / ".." / ".." / "public" / "models" / "wake" / "embedding_model.onnx").resolve()
WINDOW = 76  # mel frames per embedding (775 ms)
STEP = 8  # one embedding every 8 mel frames (80 ms), as the engine does
N_MELS = 32
EMBED = 96


def mel_transform(x: np.ndarray) -> np.ndarray:
    """openWakeWord's melspec_transform, same as melTransform in src/lib/wake/openwakeword.ts."""
    return x / 10 + 2


def windows_from_audio(audio: np.ndarray) -> np.ndarray:
    """Audio [samples] at int16 scale → mel windows [n, 76, 32, 1] float32."""
    mel = mel_transform(frontend_mel.logmel(audio[None, :])[0, 0])  # [frames, 32]
    starts = range(0, mel.shape[0] - WINDOW + 1, STEP)
    return np.stack([mel[s : s + WINDOW] for s in starts])[..., None].astype(np.float32)


def test_windows(seed: int = 7) -> dict[str, np.ndarray]:
    """Mel windows from speech-like noise, a tone, a chirp, near-silence and random values."""
    rng = np.random.default_rng(seed)
    sr = frontend_mel.SAMPLE_RATE
    t = np.arange(int(1.6 * sr)) / sr
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 3 * t)  # syllable-rate amplitude
    return {
        "noise": windows_from_audio(rng.normal(0, 3000, t.size) * envelope),
        "tone": windows_from_audio(8000 * np.sin(2 * np.pi * 440 * t)),
        "chirp": windows_from_audio(6000 * np.sin(2 * np.pi * (200 + 1200 * t) * t)),
        "quiet": windows_from_audio(rng.normal(0, 30, t.size)),
        "random": rng.uniform(-6, 4, (4, WINDOW, N_MELS, 1)).astype(np.float32),
    }


def run(path: Path | str, windows: np.ndarray) -> np.ndarray:
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return session.run(None, {session.get_inputs()[0].name: windows.astype(np.float32)})[0]


def input_shape(path: Path | str) -> list:
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return list(session.get_inputs()[0].shape)


def conv_weights(path: Path | str) -> list[np.ndarray]:
    """4-D float initializers (Conv kernels, OIHW) in file order."""
    out = []
    for dims, values in onnx_weights.read(str(path)).initializers.values():
        if len(dims) == 4 and values is not None and int(np.prod(dims)) > 1:
            out.append(np.asarray(values, dtype=np.float32).reshape(dims))
    return out


def weight_report(candidate: Path | str, published: Path | str, tol: float = 1e-4) -> tuple[int, int]:
    """How many of the published conv kernels appear (same shape, values within tol) in the candidate.

    Batch-norm folding can rescale kernels, so this is supporting evidence only; the
    output comparison decides the verdict.
    """
    ours = conv_weights(candidate)
    theirs = conv_weights(published)
    matched = 0
    used: set[int] = set()
    for w in theirs:
        for i, c in enumerate(ours):
            if i in used or c.shape != w.shape:
                continue
            if float(np.max(np.abs(c - w))) <= tol * max(1.0, float(np.max(np.abs(w)))):
                matched += 1
                used.add(i)
                break
    return matched, len(theirs)


@dataclass
class Result:
    verdict: str  # "match", "differ" or "unusable"
    max_diff: dict[str, float] = field(default_factory=dict)
    weights: tuple[int, int] = (0, 0)
    reason: str = ""

    def lines(self) -> list[str]:
        out = [f"  {name}: max |candidate - published| {d:.2e}" for name, d in self.max_diff.items()]
        out.append(f"  conv kernels found unchanged in the candidate: {self.weights[0]} of {self.weights[1]}")
        out.append(f"  verdict: {self.verdict}" + (f" ({self.reason})" if self.reason else ""))
        return out


def compare(candidate: Path | str, published: Path | str = PUBLISHED, tol: float = 1e-3) -> Result:
    """Run both models on the same mel windows. Tolerance is relative to the output scale."""
    shape = input_shape(candidate)
    if len(shape) != 4 or shape[1:] != [WINDOW, N_MELS, 1]:
        return Result("unusable", reason=f"candidate input shape {shape}, expected [batch, {WINDOW}, {N_MELS}, 1]")
    result = Result("match", weights=weight_report(candidate, published))
    for name, windows in test_windows().items():
        a = run(candidate, windows)
        b = run(published, windows)
        if a.shape != (windows.shape[0], 1, 1, EMBED):
            return Result("unusable", reason=f"candidate output shape {a.shape} on '{name}', expected [n, 1, 1, {EMBED}]")
        if not np.all(np.isfinite(a)):
            return Result("unusable", reason=f"candidate gives non-finite output on '{name}'")
        diff = float(np.max(np.abs(a - b)))
        result.max_diff[name] = diff
        if diff > tol * max(1.0, float(np.max(np.abs(b)))):
            result.verdict = "differ"
            result.reason = f"outputs disagree on '{name}'"
    return result


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    candidate = Path(argv[0])
    published = Path(argv[1]) if len(argv) > 1 else PUBLISHED
    for p in (candidate, published):
        if not p.exists():
            print(f"no model at {p}", file=sys.stderr)
            return 2
    result = compare(candidate, published)
    print(f"embedding parity: {candidate} vs {published}")
    print("\n".join(result.lines()))
    if result.verdict == "match":
        print("The published embedding_model.onnx computes Google's speech_embedding: record it as Apache-2.0 "
              "in plans/LICENCES.md (B4 step 3) and either file may be used.")
    elif result.verdict == "differ":
        print("The files disagree: train and ship on the re-export, not the published file.")
    return 0 if result.verdict != "unusable" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
