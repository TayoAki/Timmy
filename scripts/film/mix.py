"""Mixes the product film's soundtrack (Sizzle audio method), v2.

  python3 scripts/film/mix.py --voice VO.mp3 --bed CALM.mp3 --bass BASS.mp3 --out film.wav \
      [--words src/film/vo_words.json] [--walk 113.9] [--close 7.35]

The film is the walkthrough (?film, `walk` seconds) and then the 3D close (?intro&close&from=11.05,
`close` seconds). The narration runs across both, from 0.

  open    "Bass First" from 0 s under the problem cards, low-passed (650 Hz) so it sits under the
          voice, opening up into its section at 14.745 s as the app swings in ("This is Timmy").
  bed     "Calm Confidence" from 53.87 s, crossfaded in after the reveal, so its beats sit on Bass
          First's and its section at 160.148 s lands on "so your inbox stops deciding your day".
  close   "Bass First" from 65.68 s (11.05 s into the close, which starts at 54.63 s), so its final hit
          (68.75 s) lands on the lockup and on "Timmy," then rings out.
Every music part is normalized to -16 LUFS and ducked from the word timings: -11 dB under speech
(120 ms attack, 400 ms release), -5 dB in pauses longer than 0.6 s, -2 dB after the last word.
The narration is high-passed at 70 Hz and normalized to -16 LUFS. The whole thing is then normalized
to -14 LUFS integrated with a true peak at or below -1 dBTP. Everything runs locally (ffmpeg, numpy).
"""
import argparse
import json
import subprocess
import tempfile

import numpy as np

SR = 48000
BED_AT = 53.87  # Calm Confidence position at film time 0
OPEN_SECTION = 14.745  # Bass First section start, where the low-pass opens
CLOSE_FROM = 54.63 + 11.05  # Bass First position where the 3D close joins


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


def place(x, at, n):
    """x starting at `at` seconds in an n-sample timeline."""
    out = np.zeros((n, x.shape[1]), np.float32)
    i = int(at * SR)
    m = max(0, min(len(x), n - i))
    out[i : i + m] = x[:m]
    return out


def ramp(n, t0, t1, a, b):
    """A per-sample curve from a (before t0) to b (after t1), linear between."""
    t = np.arange(n) / SR
    return np.clip((t - t0) / max(1e-6, t1 - t0), 0, 1) * (b - a) + a


def smooth(curve, ms):
    k = max(1, int(SR * ms / 1000))
    return np.convolve(curve, np.ones(k) / k, mode="same")


def duck_envelope(words, n):
    """Gain in dB for the music, from the narration's word timings."""
    t = np.arange(n) / SR
    phrases = []
    for w in words:
        if phrases and w["s"] - phrases[-1][1] <= 0.6:
            phrases[-1][1] = w["e"]
        else:
            phrases.append([w["s"], w["e"]])
    db = np.full(n, -5.0)
    for s, e in phrases:
        db[(t >= s - 0.12) & (t <= e + 0.4)] = -11.0
    db[t > phrases[-1][1] + 0.4] = -2.0
    return smooth(db, 120)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", required=True)
    ap.add_argument("--bed", required=True)
    ap.add_argument("--bass", required=True)
    ap.add_argument("--words", default="src/film/vo_words.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--walk", type=float, default=113.9)
    ap.add_argument("--close", type=float, default=7.35)
    a = ap.parse_args()
    words = json.load(open(a.words))
    total = a.walk + a.close
    n = int(total * SR)
    norm = "loudnorm=I=-16:TP=-1.5:LRA=11"

    voice = fit(decode(a.voice, af="highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=7", channels=1), n)
    voice = np.repeat(voice, 2, axis=1)

    # Open: Bass First, muffled under the problem, opening on its section as the app swings in.
    head = OPEN_SECTION + 3.0
    dry = fit(decode(a.bass, 0, head, norm), int(head * SR))
    low = fit(decode(a.bass, 0, head, norm + ",lowpass=f=650"), int(head * SR))
    m = len(dry)
    lp = ramp(m, OPEN_SECTION - 0.45, OPEN_SECTION, 1.0, 0.0)
    opener = (dry * (1 - lp)[:, None] + low * lp[:, None]) * ramp(m, head - 1.6, head, 1.0, 0.0)[:, None]
    opener = place(opener, 0, n)

    # Bed: Calm Confidence, beat-matched, in as Bass First goes out; out as the close comes in.
    bed = place(fit(decode(a.bed, BED_AT, total - BED_AT, norm), int((total - BED_AT) * SR)), 0, n)
    bed *= (ramp(n, head - 1.9, head - 0.2, 0.0, 1.0) * ramp(n, a.walk - 0.35, a.walk + 0.25, 1.0, 0.0))[:, None]

    # Close: Bass First from where the 3D close joins it; the final hit lands on "Timmy,".
    closer = place(decode(a.bass, CLOSE_FROM, None, norm), a.walk - 0.3, n)
    closer *= ramp(n, a.walk - 0.3, a.walk + 0.1, 0.0, 1.0)[:, None]

    gain = 10 ** (duck_envelope(words, n) / 20)
    film = (voice + (opener + bed + closer) * gain[:, None]).astype(np.float32)

    with tempfile.NamedTemporaryFile(suffix=".f32") as tmp:
        film.tofile(tmp.name)
        common = ["ffmpeg", "-v", "error", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", tmp.name]
        probe = ["ffmpeg", "-hide_banner", "-nostats", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", tmp.name]
        stats = subprocess.run(probe + ["-af", "loudnorm=I=-14:TP=-1.2:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
        mj = json.loads(stats[stats.rindex("{"):])
        af = (f"loudnorm=I=-14:TP=-1.2:LRA=11:measured_I={mj['input_i']}:measured_TP={mj['input_tp']}:measured_LRA={mj['input_lra']}"
              f":measured_thresh={mj['input_thresh']}:offset={mj['target_offset']}:linear=true,alimiter=limit=0.87:level=false")
        subprocess.run(common + ["-af", af, "-ar", str(SR), "-y", a.out], check=True)
    print(f"{a.out}: {total:.2f} s (walk {a.walk}, close {a.close})")


if __name__ == "__main__":
    main()
