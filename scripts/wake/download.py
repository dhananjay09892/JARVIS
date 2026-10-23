"""Step 1: fetch the training inputs listed in sources.json, and nothing else.

    python download.py            all required inputs
    python download.py kathbath   one input (Kathbath also needs HF_TOKEN, see sources.json)

Downloads land in $WAKE_WORK/data/<id>/ and are unpacked there. Any id whose
commercialUse is not true is refused (common.require_commercial). Audio corpora
are then converted to 16 kHz mono WAV under $WAKE_WORK/data16k/<id>/ for the
augmentation step, which expects that rate.
"""

from __future__ import annotations

import os
import shutil
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

from common import load_sources, read_audio, require_commercial, work_dir, write_wav

CONVERT_16K = {"musan", "rirs-noises"}  # used as background/noise folders during augmentation


def fetch(url: str, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / url.rsplit("/", 1)[-1]
    if target.exists() and target.stat().st_size > 0:
        print(f"  have {target.name}")
        return target
    print(f"  get  {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "tamelo-wake-recipe"})
    token = os.environ.get("HF_TOKEN")
    if token and "huggingface.co" in url:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request) as response, open(f"{target}.part", "wb") as out:
            shutil.copyfileobj(response, out, length=1 << 20)
    except Exception as err:  # noqa: BLE001 - report which URL failed and stop
        sys.exit(f"download failed for {url}: {err}\nCheck the URL on the source's page and update sources.json.")
    os.replace(f"{target}.part", target)
    return target


def unpack(archive: Path, dest: Path) -> None:
    marker = dest / f".unpacked-{archive.name}"
    if marker.exists():
        return
    print(f"  unpack {archive.name}")
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest)
    elif archive.name.endswith((".tar.gz", ".tgz", ".tar")):
        with tarfile.open(archive) as t:
            t.extractall(dest, filter="data")
    else:
        return
    marker.touch()


def snapshot(source_id: str, dest: Path) -> None:
    """Gated Hugging Face datasets without fixed file URLs (Kathbath)."""
    from huggingface_hub import snapshot_download

    if not os.environ.get("HF_TOKEN"):
        sys.exit(f"{source_id} is gated: accept its conditions on Hugging Face and set HF_TOKEN")
    path = snapshot_download(
        repo_id="ai4bharat/Kathbath",
        repo_type="dataset",
        allow_patterns=["*hindi*", "*gujarati*", "*Hindi*", "*Gujarati*", "README*"],
        local_dir=dest,
        token=os.environ["HF_TOKEN"],
    )
    if not any(Path(path).rglob("*.*")):
        sys.exit("Kathbath: no Hindi or Gujarati files matched; check the dataset's file layout")


def rir_files(src: Path) -> list[Path]:
    """Impulse responses named in OpenSLR 28's rir_list files (the real_rirs folder also
    holds isotropic *noise* recordings, which must not be used as RIRs)."""
    lists = list(src.rglob("rir_list"))
    if os.environ.get("WAKE_RIRS") == "simulated":
        lists = [p for p in lists if "simulated_rirs" in p.parts]
    found: list[Path] = []
    for rir_list in lists:
        for token in rir_list.read_text().split():
            if token.endswith(".wav"):
                found.append(src / token)
    return found


def flat_groups(source_id: str, src: Path) -> dict[str, list[Path]]:
    """openWakeWord globs each background/RIR folder without recursing, so each group is
    written as one flat folder: data16k/musan/{noise,music,speech}, data16k/rirs-noises/{rirs,pointsource_noises}."""
    if source_id == "musan":
        root = src / "musan"
        return {g: sorted((root / g).rglob("*.wav")) for g in ("noise", "music", "speech")}
    if source_id == "rirs-noises":
        root = src / "RIRS_NOISES"
        return {"rirs": rir_files(src), "pointsource_noises": sorted((root / "pointsource_noises").rglob("*.wav"))}
    return {}


def convert_16k(source_id: str, src: Path, dest_root: Path) -> None:
    for group, files in flat_groups(source_id, src).items():
        dest = dest_root / source_id / group
        if not files:
            sys.exit(f"{source_id}: no files for '{group}' under {src}; has the archive layout changed?")
        print(f"  16 kHz copies of {len(files)} files → {dest}")
        for path in files:
            rel = path.relative_to(src).with_suffix(".wav")
            out = dest / "__".join(rel.parts)
            if not out.exists():
                write_wav(out, read_audio(path))


def main(ids: list[str]) -> None:
    sources = load_sources()
    if not ids:
        ids = [s["id"] for s in sources.values() if s.get("required") and (s.get("download") or s["id"] == "kathbath")]
    root = work_dir()
    for source_id in ids:
        source = require_commercial(source_id)
        dest = root / "data" / source_id
        print(f"{source_id}: {source['name']} ({source['licence']})")
        if source_id == "kathbath":
            snapshot(source_id, dest)
            continue
        for url in source.get("download", []):
            unpack(fetch(url, dest), dest)
        if source_id in CONVERT_16K:
            convert_16k(source_id, dest, root / "data16k")
    print("done")


if __name__ == "__main__":
    main(sys.argv[1:])
