"""Rebuild the wake-word mel-spectrogram front end from permissively licensed parts.

openWakeWord ships `melspectrogram.onnx` alongside its CC BY-NC-SA 4.0 models
without a separate licence (plans/LICENCES.md, B4). Reading the file shows it is
an export of torchlibrosa's `Spectrogram` + `LogmelFilterBank` (MIT), using
librosa's Slaney mel filters (ISC), PyTorch 1.11 as the exporter:

    STFT as two Conv1d (n_fft 512, hop 160, periodic Hann of 400 centred, no padding)
    power = real^2 + imag^2
    mel   = power @ melW            melW = librosa mel(sr 16000, n_fft 512,
                                           n_mels 32, fmin 60, fmax 3800, slaney)
    db    = 10 * log10(max(mel, 1e-10)) - 10 * log10(1.0)
    out   = max(db, max(db) - 80)   top_db 80 over the whole input

so we can regenerate every number in it from those formulas (written out below,
no librosa or torch needed) and export our own copy under our licence.

    python frontend_mel.py check  [path]   compare our weights with the published file
    python frontend_mel.py export OUT.onnx build our own file (needs `pip install onnx`)

`check` runs with numpy only and is what scripts/wake/test_frontend.py runs.
`export` writes the same graph (input "input" [batch, samples] float32 at int16
scale; output "output" [batch, 1, frames, 32]), and the recipe's parity step
(README step 2) runs both files on the same audio with onnxruntime before training.
"""

from __future__ import annotations

import math
import os
import sys

import numpy as np

SAMPLE_RATE = 16000
N_FFT = 512
HOP = 160
WIN_LENGTH = 400
N_MELS = 32
FMIN = 60.0
FMAX = 3800.0
AMIN = 1e-10
REF = 1.0
TOP_DB = 80.0

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLISHED = os.path.join(HERE, "..", "..", "public", "models", "wake", "melspectrogram.onnx")


# --- librosa's Slaney mel scale (librosa.core.convert, htk=False) -------------------

def hz_to_mel(f: np.ndarray) -> np.ndarray:
    f = np.asanyarray(f, dtype=np.float64)
    f_sp = 200.0 / 3
    mels = f / f_sp
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = math.log(6.4) / 27.0
    return np.where(f >= min_log_hz, min_log_mel + np.log(np.maximum(f, 1e-12) / min_log_hz) / logstep, mels)


def mel_to_hz(m: np.ndarray) -> np.ndarray:
    m = np.asanyarray(m, dtype=np.float64)
    f_sp = 200.0 / 3
    freqs = f_sp * m
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = math.log(6.4) / 27.0
    return np.where(m >= min_log_mel, min_log_hz * np.exp(logstep * (m - min_log_mel)), freqs)


def mel_filterbank() -> np.ndarray:
    """librosa.filters.mel(..., htk=False, norm='slaney').T  → shape (257, 32)."""
    fftfreqs = np.linspace(0, SAMPLE_RATE / 2, 1 + N_FFT // 2)
    mel_f = mel_to_hz(np.linspace(hz_to_mel(FMIN), hz_to_mel(FMAX), N_MELS + 2))
    fdiff = np.diff(mel_f)
    ramps = mel_f[:, None] - fftfreqs[None, :]
    weights = np.zeros((N_MELS, 1 + N_FFT // 2))
    for i in range(N_MELS):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))
    enorm = 2.0 / (mel_f[2 : N_MELS + 2] - mel_f[:N_MELS])
    weights *= enorm[:, None]
    return weights.T.astype(np.float32)


# --- torchlibrosa's STFT-as-convolution kernels --------------------------------------

def window() -> np.ndarray:
    """Periodic Hann of WIN_LENGTH, zero-padded to N_FFT in the centre."""
    n = np.arange(WIN_LENGTH)
    hann = 0.5 - 0.5 * np.cos(2 * np.pi * n / WIN_LENGTH)
    pad = (N_FFT - WIN_LENGTH) // 2
    return np.concatenate([np.zeros(pad), hann, np.zeros(N_FFT - WIN_LENGTH - pad)])


def stft_kernels() -> tuple[np.ndarray, np.ndarray]:
    """Conv1d weights (257, 1, 512) for the real and imaginary parts."""
    bins = 1 + N_FFT // 2
    k = np.arange(bins)[:, None]
    n = np.arange(N_FFT)[None, :]
    angle = 2 * np.pi * k * n / N_FFT
    w = window()[None, :]
    real = (np.cos(angle) * w)[:, None, :].astype(np.float32)
    imag = (-np.sin(angle) * w)[:, None, :].astype(np.float32)
    return real, imag


def logmel(audio: np.ndarray) -> np.ndarray:
    """Reference forward pass: audio [batch, samples] → [batch, 1, frames, 32]."""
    real_k, imag_k = stft_kernels()
    audio = np.atleast_2d(audio).astype(np.float64)
    frames = 1 + (audio.shape[1] - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(frames)[:, None]
    seg = audio[:, idx]  # [batch, frames, 512]
    real = seg @ real_k[:, 0, :].T
    imag = seg @ imag_k[:, 0, :].T
    mel = (real**2 + imag**2) @ mel_filterbank()
    db = 10 * np.log10(np.maximum(mel, AMIN)) - 10 * np.log10(max(AMIN, REF))
    db = np.maximum(db, db.max() - TOP_DB)
    return db[:, None, :, :].astype(np.float32)


# --- compare with the published file ----------------------------------------------

def check(path: str = PUBLISHED, tol: float = 1e-6) -> dict[str, float]:
    """Max absolute difference between our weights and the published file's."""
    sys.path.insert(0, HERE)
    import onnx_weights

    pub = onnx_weights.read(path)
    real, imag = stft_kernels()
    ours = {
        "0.stft.conv_real.weight": real,
        "0.stft.conv_imag.weight": imag,
        "1.melW": mel_filterbank(),
    }
    diffs: dict[str, float] = {}
    for name, arr in ours.items():
        dims, values = pub.initializers[name]
        if list(arr.shape) != dims or values is None:
            raise AssertionError(f"{name}: shape {list(arr.shape)} vs published {dims}")
        diffs[name] = float(np.max(np.abs(arr.ravel() - np.asarray(values, dtype=np.float32))))
    convs = [n for n in pub.nodes if n.op_type == "Conv"]
    if any(n.ints.get("strides") != [HOP] or n.ints.get("pads") != [0, 0] for n in convs):
        raise AssertionError("published Conv stride/padding differ from HOP/no padding")
    consts = sorted(v[0] for v in pub.constants.values() if len(v) == 1)
    for want in (2.0, 10.0, math.log(10), TOP_DB):
        if not any(abs(c - want) < 1e-5 for c in consts):
            raise AssertionError(f"published graph has no constant {want}")
    bad = {k: v for k, v in diffs.items() if v > tol}
    if bad:
        raise AssertionError(f"weights differ from the published file: {bad}")
    return diffs


# --- export our own copy -----------------------------------------------------------

def export(out_path: str) -> None:
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    real, imag = stft_kernels()
    inits = [
        numpy_helper.from_array(real, "stft_real"),
        numpy_helper.from_array(imag, "stft_imag"),
        numpy_helper.from_array(mel_filterbank(), "mel_w"),
        numpy_helper.from_array(np.array([1], dtype=np.int64), "axis1"),
        numpy_helper.from_array(np.array(2.0, dtype=np.float32), "two"),
        numpy_helper.from_array(np.array(AMIN, dtype=np.float32), "amin"),
        numpy_helper.from_array(np.array(10.0, dtype=np.float32), "ten"),
        numpy_helper.from_array(np.array(math.log(10), dtype=np.float32), "ln10"),
        numpy_helper.from_array(np.array(10 * math.log10(max(AMIN, REF)), dtype=np.float32), "ref_db"),
        numpy_helper.from_array(np.array(TOP_DB, dtype=np.float32), "top_db"),
    ]
    conv = dict(kernel_shape=[N_FFT], strides=[HOP], pads=[0, 0], dilations=[1], group=1)
    nodes = [
        helper.make_node("Unsqueeze", ["input", "axis1"], ["x"]),  # [B, 1, S]
        helper.make_node("Conv", ["x", "stft_real"], ["re"], **conv),  # [B, 257, T]
        helper.make_node("Conv", ["x", "stft_imag"], ["im"], **conv),
        helper.make_node("Pow", ["re", "two"], ["re2"]),
        helper.make_node("Pow", ["im", "two"], ["im2"]),
        helper.make_node("Add", ["re2", "im2"], ["power"]),
        helper.make_node("Unsqueeze", ["power", "axis1"], ["power4"]),  # [B, 1, 257, T]
        helper.make_node("Transpose", ["power4"], ["power_t"], perm=[0, 1, 3, 2]),
        helper.make_node("MatMul", ["power_t", "mel_w"], ["mel"]),  # [B, 1, T, 32]
        helper.make_node("Max", ["mel", "amin"], ["mel_c"]),
        helper.make_node("Log", ["mel_c"], ["ln"]),
        helper.make_node("Mul", ["ln", "ten"], ["ln10x"]),
        helper.make_node("Div", ["ln10x", "ln10"], ["db0"]),
        helper.make_node("Sub", ["db0", "ref_db"], ["db"]),
        helper.make_node("ReduceMax", ["db"], ["peak"], keepdims=0),
        helper.make_node("Sub", ["peak", "top_db"], ["floor"]),
        helper.make_node("Max", ["db", "floor"], ["output"]),
    ]
    graph = helper.make_graph(
        nodes,
        "wake_melspectrogram",
        [helper.make_tensor_value_info("input", TensorProto.FLOAT, ["batch_size", "samples"])],
        [helper.make_tensor_value_info("output", TensorProto.FLOAT, ["batch_size", 1, "frames", N_MELS])],
        inits,
    )
    model = helper.make_model(graph, producer_name="tamelo-wake-recipe", opset_imports=[helper.make_opsetid("", 13)])
    model.doc_string = (
        "Log-mel front end for openWakeWord-style wake models, rebuilt from torchlibrosa (MIT) "
        "and librosa (ISC) formulas by scripts/wake/frontend_mel.py. Licence: same as the project."
    )
    onnx.checker.check_model(model)
    onnx.save(model, out_path)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "check":
        result = check(sys.argv[2] if len(sys.argv) > 2 else PUBLISHED)
        for name, diff in result.items():
            print(f"{name}: max |ours - published| = {diff:.3g}")
        print("OK: our mel front end matches the published weights")
    elif cmd == "export":
        export(sys.argv[2])
        print(f"wrote {sys.argv[2]}")
    else:
        sys.exit(__doc__)
