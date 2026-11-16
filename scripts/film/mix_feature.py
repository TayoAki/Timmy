"""Mixes a 30-second feature film's soundtrack (Sizzle audio method).

  python3 scripts/film/mix_feature.py --voice VO.wav --bed CALM.mp3 --words src/film/features/words/<id>.json \
      --show 6.4 --section 42.562 --out film.wav [--length 30]

The narration starts at 0. The bed ("Calm Confidence", supplied by the owner) is placed so that its section
start `--section` (from music_beats.json) lands on `--show`, where the app swings in, and fades out over the
last 1.4 s. The bed is normalized to -16 LUFS and ducked from the word timings like the product film's mix
(-11 dB under speech, -5 dB in pauses, -2 dB after the last word); the voice is high-passed at 70 Hz and
normalized to -16 LUFS; the whole is normalized to -14 LUFS with a true peak at or below -1 dBTP.
Everything runs locally (ffmpeg, numpy).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
from mix import SR, decode, duck_envelope, fit, ramp  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", required=True)
    ap.add_argument("--bed", required=True)
    ap.add_argument("--words", required=True)
    ap.add_argument("--show", type=float, required=True)
    ap.add_argument("--section", type=float, required=True)
    ap.add_argument("--length", type=float, default=30.0)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    words = json.load(open(a.words))
    n = int(a.length * SR)
    voice = fit(decode(a.voice, af="highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=7", channels=1), n)
    voice = voice.repeat(2, axis=1)
    start = max(0.0, a.section - a.show)
    bed = fit(decode(a.bed, start, a.length, "loudnorm=I=-16:TP=-1.5:LRA=11"), n)
    bed *= (ramp(n, 0, 0.25, 0.0, 1.0) * ramp(n, a.length - 1.4, a.length, 1.0, 0.0))[:, None]
    gain = 10 ** (duck_envelope(words, n) / 20)
    film = (voice + bed * gain[:, None]).astype("float32")
    with tempfile.NamedTemporaryFile(suffix=".f32") as tmp:
        film.tofile(tmp.name)
        src = ["-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", tmp.name]
        stats = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", *src, "-af", "loudnorm=I=-14:TP=-1.2:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
        mj = json.loads(stats[stats.rindex("{"):])
        af = (f"loudnorm=I=-14:TP=-1.2:LRA=11:measured_I={mj['input_i']}:measured_TP={mj['input_tp']}:measured_LRA={mj['input_lra']}"
              f":measured_thresh={mj['input_thresh']}:offset={mj['target_offset']}:linear=true,alimiter=limit=0.87:level=false")
        subprocess.run(["ffmpeg", "-v", "error", *src, "-af", af, "-ar", str(SR), "-y", a.out], check=True)
    print(f"{a.out}: {a.length:.1f} s, bed from {start:.2f} s")


if __name__ == "__main__":
    main()
