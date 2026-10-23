"""Read initializers and node attributes out of an .onnx file with no dependencies.

Just enough of the protobuf wire format to compare our rebuilt wake-word front end
with openWakeWord's published `melspectrogram.onnx` (see frontend_mel.py), so the
check runs on a machine without the `onnx` package. Only FLOAT tensors stored as
raw_data are decoded, which is how PyTorch and tf2onnx write weights.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = buf[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return result, i


def _fields(buf: bytes) -> list[tuple[int, int, object]]:
    out: list[tuple[int, int, object]] = []
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        num, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 1:
            value, i = buf[i : i + 8], i + 8
        elif wire == 5:
            value, i = buf[i : i + 4], i + 4
        elif wire == 2:
            length, i = _varint(buf, i)
            value, i = buf[i : i + length], i + length
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")
        out.append((num, wire, value))
    return out


@dataclass
class Node:
    op_type: str
    inputs: list[str]
    ints: dict[str, list[int]] = field(default_factory=dict)


@dataclass
class OnnxSummary:
    producer: str
    initializers: dict[str, tuple[list[int], list[float] | None]]
    nodes: list[Node]
    constants: dict[str, list[float]]


def _floats(raw: bytes) -> list[float]:
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def _tensor(buf: bytes) -> tuple[str, list[int], list[float] | None]:
    f = _fields(buf)
    dims = [v for n, w, v in f if n == 1 and w == 0]
    dtype = next((v for n, _, v in f if n == 2), 1)
    name = next((v.decode() for n, _, v in f if n == 8), "")
    raw = next((v for n, _, v in f if n == 9), None)
    values = _floats(raw) if raw is not None and dtype == 1 else None
    return name, dims, values


def read(path: str) -> OnnxSummary:
    with open(path, "rb") as fh:
        model = _fields(fh.read())
    producer = next((v.decode() for n, _, v in model if n == 2), "")
    graph = next(v for n, _, v in model if n == 7)
    inits: dict[str, tuple[list[int], list[float] | None]] = {}
    nodes: list[Node] = []
    constants: dict[str, list[float]] = {}
    for num, _, value in _fields(graph):
        if num == 5:
            name, dims, values = _tensor(value)
            inits[name] = (dims, values)
        elif num == 1:
            nf = _fields(value)
            op = next(v.decode() for n, _, v in nf if n == 4)
            node = Node(op, [v.decode() for n, _, v in nf if n == 1])
            outputs = [v.decode() for n, _, v in nf if n == 2]
            for attr in (v for n, _, v in nf if n == 5):
                af = _fields(attr)
                aname = next(v.decode() for n, _, v in af if n == 1)
                ints = [v for n, w, v in af if n == 8 and w == 0]
                ints += [v for n, w, v in af if n == 3 and w == 0]
                if ints:
                    node.ints[aname] = ints
                tensor = next((v for n, _, v in af if n == 5), None)
                if op == "Constant" and tensor is not None and outputs:
                    _, _, values = _tensor(tensor)
                    if values is not None:
                        constants[outputs[0]] = values
            nodes.append(node)
    return OnnxSummary(producer, inits, nodes, constants)
