"""Usage: python3 transcribe.py voice.mp3 out.json   (needs faster-whisper and ffmpeg)
Transcribes the voiceover locally (nothing leaves this machine) with segment timestamps."""
import json
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

path = sys.argv[1]
out = sys.argv[2]
pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], capture_output=True, check=True).stdout
audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
model = WhisperModel("base.en", device="cpu", compute_type="int8")
segments, info = model.transcribe(audio, beam_size=1, vad_filter=False, word_timestamps=False)
rows = []
for s in segments:
    rows.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()})
    print(f"{s.start:7.2f} {s.end:7.2f}  {s.text.strip()}")
json.dump(rows, open(out, "w"), indent=1)
