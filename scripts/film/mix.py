"""Mixes the product film's soundtrack (Sizzle audio method).

  python3 scripts/film/mix.py --voice VO.mp3 --bed BED.mp3 --bass BASS.mp3 --out film.wav \
      [--words src/film/vo_words.json] [--open 13.6] [--walk 201.62] [--close 16.2]

The film is three parts, back to back:
  open   "Bass First" from 9.03 s, so frame 0 hits with energy and the title lands on its bar at 19.48 s;
         faded out through its quiet gap as the picture fades.
  walk   the narration (high-passed at 70 Hz, normalized to -16 LUFS) over "Calm Confidence" from 0 s.
         The bed is ducked from the word timings: -11 dB under speech (120 ms attack, 400 ms release),
         -5 dB in pauses longer than 0.6 s, -2 dB after the last word. It is low-passed (650 Hz) under the
         problem section and the "Without it" section, with 0.35 s crossfades.
  close  "Bass First" from 54.63 s, so its final hit (68.75 s) lands on the lockup at 14.12 s, then rings out.
The whole thing is then normalized to -14 LUFS integrated with a true peak at or below -1 dBTP.
Audio is decoded and processed locally with ffmpeg and numpy.
"""
import argparse
import json
import subprocess
import tempfile

import numpy as np

SR = 48000


def decode(path, start=0.0, dur=None, af=None, channels=2):
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-i", path]
    if dur is not None:
        cmd += ["-t", str(dur)]
    if af:
        cmd += ["-af", af]
    cmd += ["-f", "f32le", "-ac", str(channels), "-ar", str(SR), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, channels).copy()


def fit(x, n):
    """Pad with silence or trim to n samples."""
    if len(x) >= n:
        return x[:n]
    return np.vstack([x, np.zeros((n - len(x), x.shape[1]), np.float32)])


def ramp(n, t0, t1, a, b):
    """A per-sample curve from a (before t0) to b (after t1), linear between."""
    t = np.arange(n) / SR
    return np.clip((t - t0) / max(1e-6, t1 - t0), 0, 1) * (b - a) + a


def smooth(curve, ms):
    k = max(1, int(SR * ms / 1000))
    return np.convolve(curve, np.ones(k) / k, mode="same")


def duck_envelope(words, n, lead=0.0):
    """Gain in dB for the bed, from the narration's word timings."""
    t = np.arange(n) / SR
    phrases = []
    for w in words:
        s, e = w["s"] + lead, w["e"] + lead
        if phrases and s - phrases[-1][1] <= 0.6:
            phrases[-1][1] = e
        else:
            phrases.append([s, e])
    db = np.full(n, -5.0)
    for s, e in phrases:
        db[(t >= s - 0.12) & (t <= e + 0.4)] = -11.0
    db[t > phrases[-1][1] + 0.4] = -2.0
    db[t < phrases[0][0] - 0.12] = -5.0
    return smooth(db, 120)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", required=True)
    ap.add_argument("--bed", required=True)
    ap.add_argument("--bass", required=True)
    ap.add_argument("--words", default="src/film/vo_words.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--open", type=float, default=13.6)
    ap.add_argument("--walk", type=float, default=201.62)
    ap.add_argument("--close", type=float, default=16.2)
    a = ap.parse_args()
    words = json.load(open(a.words))

    # Open: "Bass First" from 9.03 s, faded with the picture.
    n_open = int(a.open * SR)
    opener = fit(decode(a.bass, 9.03, a.open, "loudnorm=I=-14:TP=-1.5:LRA=11"), n_open)
    opener *= ramp(n_open, a.open - 1.4, a.open, 1.0, 0.0)[:, None]

    # Walk: narration over the ducked, shaped bed.
    n_walk = int(a.walk * SR)
    voice = fit(decode(a.voice, af="highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=7", channels=1), n_walk)
    voice = np.repeat(voice, 2, axis=1)
    dry = fit(decode(a.bed, 0, a.walk, "loudnorm=I=-16:TP=-1.5:LRA=11"), n_walk)
    low = fit(decode(a.bed, 0, a.walk, "loudnorm=I=-16:TP=-1.5:LRA=11,lowpass=f=650"), n_walk)
    without = next(w["s"] for w in words if w["w"].lower().startswith("without"))
    five = next(w["s"] for i, w in enumerate(words) if w["w"].lower() == "at" and i + 1 < len(words) and words[i + 1]["w"].lower().startswith("five"))
    turn = next(w["s"] for i, w in enumerate(words) if w["w"].lower() == "this" and i + 1 < len(words) and words[i + 1]["w"].lower().startswith("monday"))
    lp = np.maximum(ramp(n_walk, turn - 0.35, turn, 1.0, 0.0), ramp(n_walk, without - 0.35, without, 0.0, 1.0) * ramp(n_walk, five - 0.35, five, 1.0, 0.0))
    extra = 1.0 - 0.3 * ramp(n_walk, without - 0.35, without, 0.0, 1.0) * ramp(n_walk, five - 0.35, five, 1.0, 0.0)
    gain = 10 ** (duck_envelope(words, n_walk) / 20) * extra * ramp(n_walk, a.walk - 0.9, a.walk, 1.0, 0.0)
    bed = (dry * (1 - lp)[:, None] + low * lp[:, None]) * gain[:, None]
    walk = voice + bed

    # Close: "Bass First" from 54.63 s; the final hit lands on the lockup and rings out.
    n_close = int(a.close * SR)
    closer = fit(decode(a.bass, 54.63, None, "loudnorm=I=-14:TP=-1.5:LRA=11"), n_close)
    closer *= ramp(n_close, 0, 0.04, 0.0, 1.0)[:, None]

    film = np.vstack([opener, walk, closer]).astype(np.float32)
    with tempfile.NamedTemporaryFile(suffix=".f32") as tmp:
        film.tofile(tmp.name)
        common = ["ffmpeg", "-v", "error", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", tmp.name]
        probe = ["ffmpeg", "-hide_banner", "-nostats", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", tmp.name]
        stats = subprocess.run(probe + ["-af", "loudnorm=I=-14:TP=-1.2:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
        m = json.loads(stats[stats.rindex("{"):])
        af = (f"loudnorm=I=-14:TP=-1.2:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
              f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,alimiter=limit=0.87:level=false")
        subprocess.run(common + ["-af", af, "-ar", str(SR), "-y", a.out], check=True)
    print(f"{a.out}: {len(film) / SR:.2f} s (open {a.open}, walk {a.walk}, close {a.close})")


if __name__ == "__main__":
    main()
