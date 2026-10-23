"""numpy-only checks for the rebuilt mel front end: `python -m unittest test_frontend` here."""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import frontend_mel  # noqa: E402


class FrontEndTest(unittest.TestCase):
    def test_weights_match_published_file(self):
        diffs = frontend_mel.check()
        self.assertEqual(set(diffs), {"0.stft.conv_real.weight", "0.stft.conv_imag.weight", "1.melW"})
        for diff in diffs.values():
            self.assertLess(diff, 1e-6)

    def test_mel_bands_cover_60_to_3800_hz(self):
        w = frontend_mel.mel_filterbank()
        rows = np.nonzero(w.sum(axis=1))[0]
        hz_per_bin = frontend_mel.SAMPLE_RATE / frontend_mel.N_FFT
        self.assertGreaterEqual(rows[0] * hz_per_bin, frontend_mel.FMIN)
        self.assertLessEqual(rows[-1] * hz_per_bin, frontend_mel.FMAX)

    def test_logmel_shape_matches_streaming_use(self):
        # The engine feeds 1280 new samples plus 480 of history and expects 8 mel rows.
        out = frontend_mel.logmel(np.random.default_rng(0).normal(0, 3000, (1, 1760)))
        self.assertEqual(out.shape, (1, 1, 8, 32))

    def test_tone_peaks_in_the_right_band(self):
        t = np.arange(16000) / 16000
        out = frontend_mel.logmel(10000 * np.sin(2 * np.pi * 1000 * t)[None, :])[0, 0]
        peak_band = int(out.mean(axis=0).argmax())
        centre_bins = frontend_mel.mel_filterbank().argmax(axis=0)
        expected = int(np.abs(centre_bins - 1000 / (16000 / 512)).argmin())
        self.assertLessEqual(abs(peak_band - expected), 1)


if __name__ == "__main__":
    unittest.main()
