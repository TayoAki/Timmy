"""Prints tempo, beats, key, a loudness map and the strongest hits of a music file (local only).
Usage: python3 analyze_music.py track.mp3   (needs librosa and ffmpeg)
"""
import subprocess
import sys

import librosa
import numpy as np

path = sys.argv[1]
pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "22050", "-"], capture_output=True, check=True).stdout
y = np.frombuffer(pcm, np.float32)
sr = 22050
print(f"duration {len(y) / sr:.2f}s")

tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
tempo = float(np.atleast_1d(tempo)[0])
print(f"tempo ~{tempo:.1f} BPM, {len(beats)} beats, first beats: {', '.join(f'{b:.2f}' for b in beats[:8])}")
if len(beats) > 4:
    print(f"median beat gap {np.median(np.diff(beats)):.3f}s")

# Key: average chroma against Krumhansl-Schmuckler profiles.
chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
scores = []
for i in range(12):
    scores.append((np.corrcoef(np.roll(major, i), chroma)[0, 1], f"{names[i]} major"))
    scores.append((np.corrcoef(np.roll(minor, i), chroma)[0, 1], f"{names[i]} minor"))
scores.sort(reverse=True)
print("key guesses:", ", ".join(f"{k} ({s:.2f})" for s, k in scores[:3]))

# Loudness shape in half-second steps, and the biggest jumps (hits, drops).
rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=512)
db = 20 * np.log10(np.maximum(rms, 1e-6))
step = 0.5
print("level (dBFS rms) every 0.5s:")
row = []
for t0 in np.arange(0, times[-1], step):
    m = (times >= t0) & (times < t0 + step)
    row.append(f"{t0:4.1f}:{db[m].mean():5.1f}")
for i in range(0, len(row), 8):
    print("  " + "  ".join(row[i:i + 8]))
onset = librosa.onset.onset_strength(y=y, sr=sr)
otimes = librosa.times_like(onset, sr=sr)
peaks = librosa.util.peak_pick(onset, pre_max=10, post_max=10, pre_avg=20, post_avg=20, delta=np.percentile(onset, 97) * 0.5, wait=20)
strong = sorted(peaks, key=lambda i: -onset[i])[:14]
print("strongest hits:", ", ".join(f"{otimes[i]:.2f}" for i in sorted(strong)))
