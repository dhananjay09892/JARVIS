"""Step 3: synthesise positive and negative clips for one wake model.

    python generate_clips.py hey_tamelo [--scale 0.01]

Writes 16 kHz WAVs to $WAKE_WORK/models/<model>/{positive,negative}_{train,test}/,
the folders openWakeWord's --augment_clips step reads. Voices come only from the
commercially usable TTS inputs in sources.json:

  - Piper en_US-libritts_r-medium (904 LibriTTS-R speakers) via piper-sample-generator
  - Kokoro-82M: 28 English voices, and the 4 Hindi voices for an Indian accent and
    for the Hindi/Gujarati negatives (Gujarati written in Devanagari, phrases.json)

The share of each comes from the config's recipe.voice_mix. --scale shrinks every
count (0.01 = a 1 % smoke run to check the pipeline before the long run).
"""

from __future__ import annotations

import argparse
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from common import load_config, read_audio, require_commercial, resample, work_dir, write_wav

KOKORO_ENGLISH = {
    "a": ["af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova",
          "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
          "am_michael", "am_onyx", "am_puck", "am_santa"],
    "b": ["bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis"],
}
KOKORO_HINDI = ["hf_alpha", "hf_beta", "hm_omega", "hm_psi"]
KOKORO_RATE = 24000


class Kokoro:
    def __init__(self) -> None:
        require_commercial("kokoro-82m")
        from kokoro import KPipeline

        self.pipes = {code: KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M") for code in ("a", "b", "h")}

    def say(self, text: str, voice: str, speed: float):
        lang = "h" if voice.startswith("h") else voice[0]
        chunks = [r.audio.cpu().numpy() for r in self.pipes[lang](text, voice=voice, speed=speed) if r.audio is not None]
        if not chunks:
            return None
        import numpy as np

        return resample(np.concatenate(chunks), KOKORO_RATE)


def piper(texts: list[str], count: int, out_dir: Path, tools: Path, voice: Path) -> int:
    """Spread `count` clips over `texts` with piper-sample-generator, then convert to 16 kHz."""
    require_commercial("piper-libritts-r")
    if count <= 0:
        return 0
    generator = tools / "piper-sample-generator" / "generate_samples.py"
    if not generator.exists():
        sys.exit(f"missing {generator}; see README step 0")
    per_text = max(1, count // len(texts))
    made = 0
    for text in texts:
        with tempfile.TemporaryDirectory() as tmp:
            cmd = [sys.executable, str(generator), text, "--model", str(voice),
                   "--max-samples", str(per_text), "--output-dir", tmp]
            subprocess.run(cmd, check=True)
            for wav in sorted(Path(tmp).glob("*.wav")):
                write_wav(out_dir / f"piper_{made:06d}.wav", read_audio(wav))
                made += 1
        if made >= count:
            break
    return made


def kokoro(engine: Kokoro, texts: list[str], voices: list[str], count: int, out_dir: Path, prefix: str,
           rng: random.Random) -> int:
    made = 0
    attempts = 0
    while made < count and attempts < count * 3:
        attempts += 1
        audio = engine.say(rng.choice(texts), rng.choice(voices), rng.uniform(0.8, 1.25))
        if audio is None or len(audio) < 4000:
            continue
        write_wav(out_dir / f"{prefix}_{made:06d}.wav", audio)
        made += 1
    return made


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model")
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=47)
    args = parser.parse_args()

    config = load_config(args.model)
    recipe = config["recipe"]
    mix = recipe["voice_mix"]
    root = work_dir()
    model_dir = root / "models" / config["model_name"]
    voice = root / "data" / "piper-libritts-r" / "en_US-libritts_r-medium.onnx"
    engine = Kokoro()
    english_voices = KOKORO_ENGLISH["a"] + KOKORO_ENGLISH["b"]
    rng = random.Random(args.seed)

    plan = {
        "positive": (config["target_phrase"], config["target_phrase"] + recipe["say_hindi"]),
        "negative": (config["custom_negative_phrases"], config["custom_negative_phrases"] + recipe["negatives_hindi"]),
    }
    for split, total in (("train", config["n_samples"]), ("test", config["n_samples_val"])):
        total = max(3, int(total * args.scale))
        for kind, (english_texts, hindi_voice_texts) in plan.items():
            out = model_dir / f"{kind}_{split}"
            if out.exists():
                shutil.rmtree(out)
            n_piper = int(total * mix["piper"])
            n_en = int(total * mix["kokoroEnglish"])
            n_hi = total - n_piper - n_en
            made = piper(english_texts, n_piper, out, root / "tools", voice)
            made += kokoro(engine, english_texts, english_voices, n_en, out, "kokoro_en", rng)
            made += kokoro(engine, hindi_voice_texts, KOKORO_HINDI, n_hi, out, "kokoro_hi", rng)
            print(f"{config['model_name']} {kind}_{split}: {made} clips")


if __name__ == "__main__":
    main()
