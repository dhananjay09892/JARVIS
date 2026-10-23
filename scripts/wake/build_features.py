"""Step 4: turn the commercially licensed speech, music and noise into negative features.

    python build_features.py [--max-hours 1200] [--val-hours 11]

Shared by all three models, so it runs once. Writes to $WAKE_WORK/features/:
  negatives_train.npy    float16 [N, 16, 96]  2-second windows (our replacement for
                         openWakeWord's usual negative feature file)
  validation_stream.npy  float16 [T, 96]      a continuous held-out stream used to
                         measure false wakes per hour during training

Training audio: LibriTTS-R train-clean-100, FLEURS train (en, hi, gu), Kathbath
(hi, gu, if downloaded), MUSAN speech and music. Held out for validation: LibriTTS-R
test-clean, FLEURS test, and every 10th MUSAN file. Features are computed with the
front end from step 2, so they match what the shipped models see.
"""

from __future__ import annotations

import argparse
import zlib
from pathlib import Path

import numpy as np

from common import SAMPLE_RATE, read_audio, require_commercial, work_dir

CLIP = 2 * SAMPLE_RATE  # 2 s → exactly 16 embeddings
CHUNK = 60 * SAMPLE_RATE  # validation stream is embedded a minute at a time
AUDIO = {".wav", ".flac", ".mp3"}


def held_out(path: Path) -> bool:
    return zlib.crc32(str(path.name).encode()) % 10 == 0


def corpora(root: Path) -> tuple[list[Path], list[Path]]:
    data = root / "data"
    train: list[Path] = []
    val: list[Path] = []

    def files(*parts: str) -> list[Path]:
        base = data.joinpath(*parts)
        return sorted(p for p in base.rglob("*") if p.suffix.lower() in AUDIO) if base.exists() else []

    for source_id in ("libritts-r", "fleurs", "musan"):
        require_commercial(source_id)
    for path in files("libritts-r"):
        (val if "test_clean" in path.parts else train).append(path)
    for path in files("fleurs"):
        (val if "test" in path.parts else train).append(path)
    for group in ("speech", "music", "noise"):
        for path in files("musan", "musan", group):
            if held_out(path):
                val.append(path)
            elif group != "noise":  # noise is mixed in as background during augmentation instead
                train.append(path)
    if (data / "kathbath").exists():
        require_commercial("kathbath")
        train += files("kathbath")
    return train, val


def features(root: Path):
    from openwakeword.utils import AudioFeatures

    front = root / "frontend"
    return AudioFeatures(
        melspec_model_path=str(front / "melspectrogram.onnx"),
        embedding_model_path=str(front / "embedding_model.onnx"),
    )


def to_int16(audio: np.ndarray) -> np.ndarray:
    return (np.clip(audio, -1, 1) * 32767).astype(np.int16)


def build_train(paths: list[Path], max_hours: float, out: Path, extractor) -> int:
    budget = int(max_hours * 3600 * SAMPLE_RATE)
    shards: list[np.ndarray] = []
    batch: list[np.ndarray] = []
    used = 0
    rng = np.random.default_rng(47)
    for path in rng.permutation(np.array(paths, dtype=object)):
        audio = read_audio(Path(path))
        for start in range(0, len(audio) - CLIP + 1, CLIP):
            batch.append(to_int16(audio[start : start + CLIP]))
            used += CLIP
        if len(batch) >= 4096:
            shards.append(extractor.embed_clips(np.stack(batch), batch_size=256).astype(np.float16))
            batch = []
            print(f"  {used / SAMPLE_RATE / 3600:.1f} h")
        if used >= budget:
            break
    if batch:
        shards.append(extractor.embed_clips(np.stack(batch), batch_size=256).astype(np.float16))
    result = np.concatenate(shards)[:, -16:, :]
    np.save(out, result)
    return result.shape[0]


def build_val(paths: list[Path], hours: float, out: Path, extractor) -> int:
    budget = int(hours * 3600 * SAMPLE_RATE)
    stream: list[np.ndarray] = []
    pending = np.zeros(0, dtype=np.float32)
    used = 0
    for path in paths:
        pending = np.concatenate([pending, read_audio(path)])
        while len(pending) >= CHUNK:
            stream.append(extractor.embed_clips(to_int16(pending[:CHUNK])[None, :], batch_size=1)[0].astype(np.float16))
            pending = pending[CHUNK:]
            used += CHUNK
        if used >= budget:
            break
    result = np.concatenate(stream)
    np.save(out, result)
    return result.shape[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-hours", type=float, default=1200)
    parser.add_argument("--val-hours", type=float, default=11)
    args = parser.parse_args()

    root = work_dir()
    out = root / "features"
    out.mkdir(parents=True, exist_ok=True)
    train, val = corpora(root)
    print(f"{len(train)} training files, {len(val)} held-out files")
    extractor = features(root)
    n = build_train(train, args.max_hours, out / "negatives_train.npy", extractor)
    print(f"negatives_train.npy: {n} windows")
    t = build_val(val, args.val_hours, out / "validation_stream.npy", extractor)
    print(f"validation_stream.npy: {t} frames ({t * 0.08 / 3600:.1f} h)")


if __name__ == "__main__":
    main()
