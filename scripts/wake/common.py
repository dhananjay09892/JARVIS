"""Shared helpers for the wake-model recipe (scripts/wake/README.md)."""

from __future__ import annotations

import json
import os
import sys
import wave
from math import gcd
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SAMPLE_RATE = 16000


def work_dir() -> Path:
    """Everything big goes here, never into the repo. Override with WAKE_WORK."""
    path = Path(os.environ.get("WAKE_WORK", HERE / "work")).resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_sources() -> dict[str, dict]:
    data = json.loads((HERE / "sources.json").read_text(encoding="utf8"))
    return {s["id"]: s for s in data["inputs"]}


def require_commercial(source_id: str) -> dict:
    """Stop the run if anything tries to use an input without a commercial-use licence."""
    sources = load_sources()
    if source_id not in sources:
        sys.exit(f"'{source_id}' is not in scripts/wake/sources.json; add it with its licence first")
    source = sources[source_id]
    if source.get("commercialUse") is not True:
        sys.exit(f"'{source_id}' ({source.get('licence')}) is not cleared for commercial use; the recipe refuses it")
    return source


def load_config(model: str) -> dict:
    path = HERE / "configs" / f"{model}.json"
    if not path.exists():
        sys.exit(f"no config {path}; models: {', '.join(p.stem for p in (HERE / 'configs').glob('*.json'))}")
    config = json.loads(path.read_text(encoding="utf8"))
    for ids in config["recipe"]["sources"].values():
        for source_id in ids:
            require_commercial(source_id)
    return config


def resample(audio: np.ndarray, rate: int, target: int = SAMPLE_RATE) -> np.ndarray:
    if rate == target:
        return audio.astype(np.float32)
    from scipy.signal import resample_poly

    g = gcd(rate, target)
    return resample_poly(audio, target // g, rate // g).astype(np.float32)


def to_mono(audio: np.ndarray) -> np.ndarray:
    return audio.mean(axis=1) if audio.ndim == 2 else audio


def write_wav(path: Path, audio: np.ndarray, rate: int = SAMPLE_RATE) -> None:
    """Float audio in [-1, 1] → 16-bit mono WAV."""
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())


def read_audio(path: Path) -> np.ndarray:
    """Any file soundfile can read → float32 mono at 16 kHz."""
    import soundfile as sf

    audio, rate = sf.read(str(path), dtype="float32", always_2d=False)
    return resample(to_mono(audio), rate)
