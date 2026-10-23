"""Steps 5–6: augment the clips, train the classifier and write its model card.

    python train.py hey_tamelo

Runs openWakeWord's own trainer (code only, Apache-2.0) with our config, but with
its feature extractor pointed at our front end from step 2 instead of the files
bundled in the openwakeword package. Then copies the exported classifier to
$WAKE_WORK/release/<model>.onnx with a MODEL_CARD.md listing every input and its
licence, ready for Q48 to test and commit to public/models/wake/.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import runpy
import shutil
import sys
from pathlib import Path

from common import HERE, load_config, load_sources, work_dir


def use_our_frontend(root: Path) -> None:
    import openwakeword.utils as owu

    front = root / "frontend"
    for name in ("melspectrogram.onnx", "embedding_model.onnx"):
        if not (front / name).exists():
            sys.exit(f"missing {front / name}; run prepare_frontend.py first")
    original = owu.AudioFeatures.__init__

    def init(self, melspec_model_path="", embedding_model_path="", *args, **kwargs):
        original(
            self,
            melspec_model_path or str(front / "melspectrogram.onnx"),
            embedding_model_path or str(front / "embedding_model.onnx"),
            *args,
            **kwargs,
        )

    owu.AudioFeatures.__init__ = init


def run_trainer(config_path: Path, step: str) -> None:
    argv = sys.argv
    sys.argv = ["openwakeword.train", "--training_config", str(config_path), step]
    try:
        runpy.run_module("openwakeword.train", run_name="__main__")
    finally:
        sys.argv = argv


def model_card(config: dict, onnx_path: Path) -> str:
    sources = load_sources()
    used = sorted({i for ids in config["recipe"]["sources"].values() for i in ids})
    digest = hashlib.sha256(onnx_path.read_bytes()).hexdigest()
    rows = "\n".join(f"| {sources[i]['name']} | {sources[i]['licence']} | {sources[i].get('attribution', '')} |" for i in used)
    return f"""# {config['recipe']['phrase']} wake model

- File: `{onnx_path.name}` (SHA-256 `{digest}`)
- Trained: {dt.date.today().isoformat()} with scripts/wake (plan 02, Q47 recipe)
- Phrase: "{config['recipe']['phrase']}" ({config['recipe']['pronunciation']})
- Front end: the melspectrogram.onnx and embedding_model.onnx from prepare_frontend.py
- Licence: same as the project. No openWakeWord pre-trained model or non-commercial data was used.

## Training inputs

| Input | Licence | Attribution |
|---|---|---|
{rows}
"""


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = work_dir()
    config = load_config(sys.argv[1])
    # openWakeWord resolves the config's relative paths from the current directory.
    import os

    os.chdir(root)
    run_config = root / "configs" / f"{config['model_name']}.json"
    run_config.parent.mkdir(parents=True, exist_ok=True)
    run_config.write_text(json.dumps(config, indent=2), encoding="utf8")

    use_our_frontend(root)
    run_trainer(run_config, "--augment_clips")
    run_trainer(run_config, "--train_model")

    exported = root / "models" / f"{config['model_name']}.onnx"
    if not exported.exists():
        sys.exit(f"trainer did not write {exported}")
    release = root / "release"
    release.mkdir(exist_ok=True)
    target = release / exported.name
    shutil.copyfile(exported, target)
    (release / f"{config['model_name']}.MODEL_CARD.md").write_text(model_card(config, target), encoding="utf8")
    print(f"release: {target}")


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    main()
