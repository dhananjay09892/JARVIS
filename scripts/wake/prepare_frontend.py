"""Step 2: build the shared front end the classifiers are trained on and shipped with.

    python prepare_frontend.py --embedding PATH

Writes $WAKE_WORK/frontend/melspectrogram.onnx (our own export, frontend_mel.py)
and copies the embedding model given by --embedding next to it, then checks with
onnxruntime that our mel model gives the same output as openWakeWord's published
one, and as the numpy reference, on speech-like noise and a tone.

--embedding is where licence risk B4 is closed for the embedding model
(plans/LICENCES.md). Pass either:
  - a model re-exported from Google's speech_embedding (Apache-2.0) — task Q53, or
  - public/models/wake/embedding_model.onnx, only once its licence is confirmed as
    Apache-2.0 (Q53 records how), with --published-embedding-confirmed.
Classifiers must be trained and shipped on the same two files.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import numpy as np

import frontend_mel
from common import work_dir


def run(path: Path, audio: np.ndarray) -> np.ndarray:
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return session.run(None, {session.get_inputs()[0].name: audio.astype(np.float32)})[0]


def parity(ours: Path, tol: float = 1e-3) -> None:
    rng = np.random.default_rng(2)
    t = np.arange(32000) / 16000
    cases = {
        "noise": rng.normal(0, 3000, (1, 32000)),
        "tone": 8000 * np.sin(2 * np.pi * 440 * t)[None, :],
        "frame": rng.normal(0, 1000, (1, 1760)),
    }
    for name, audio in cases.items():
        a = run(ours, audio)
        b = run(Path(frontend_mel.PUBLISHED), audio)
        ref = frontend_mel.logmel(audio)
        d_pub = float(np.max(np.abs(a - b)))
        d_ref = float(np.max(np.abs(a - ref)))
        print(f"  {name}: shape {a.shape}, |ours - published| {d_pub:.2e}, |ours - numpy| {d_ref:.2e}")
        if a.shape != b.shape or d_pub > tol or d_ref > tol:
            sys.exit(f"mel parity failed on '{name}'; do not train on this front end")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--embedding", required=True, type=Path)
    parser.add_argument("--published-embedding-confirmed", action="store_true")
    args = parser.parse_args()

    published = (Path(frontend_mel.PUBLISHED).parent / "embedding_model.onnx").resolve()
    if args.embedding.resolve() == published and not args.published_embedding_confirmed:
        sys.exit("openWakeWord's embedding_model.onnx is still 'treated as CC BY-NC-SA' (LICENCES.md B4). "
                 "Use a re-export (Q53) or confirm its licence and pass --published-embedding-confirmed.")
    if not args.embedding.exists():
        sys.exit(f"no embedding model at {args.embedding}")

    out = work_dir() / "frontend"
    out.mkdir(parents=True, exist_ok=True)
    mel = out / "melspectrogram.onnx"
    frontend_mel.check()  # weights still match the published file
    frontend_mel.export(str(mel))
    shutil.copyfile(args.embedding, out / "embedding_model.onnx")
    print(f"front end in {out}")
    parity(mel)
    print("OK")


if __name__ == "__main__":
    main()
