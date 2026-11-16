#!/bin/bash
# Frames (+ music) to a 30 fps H.264 MP4.
#   encode.sh <frames dir> <out.mp4> [music file] [music start, s] [length, s]
# The music is trimmed from its start for the film's length, faded out over the last
# 0.45 s, and loudness-normalised to -14 LUFS with peaks at or below -1 dBTP.
set -e
FRAMES="$1"; OUT="$2"; MUSIC="$3"; START="${4:-0}"
COUNT=$(ls "$FRAMES"/f*.png | wc -l)
LEN="${5:-$(python3 -c "print(round(($COUNT - 1) / 30, 3))")}"
FADE=$(python3 -c "print(max(0, $LEN - 0.45))")
if [ -n "$MUSIC" ]; then
  ffmpeg -y -v error -framerate 30 -i "$FRAMES/f%05d.png" -ss "$START" -i "$MUSIC" \
    -filter_complex "[0:v]trim=0:$LEN,setpts=PTS-STARTPTS,format=yuv420p[v];[1:a]atrim=0:$LEN,asetpts=PTS-STARTPTS,afade=t=out:st=$FADE:d=0.45,aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-14:TP=-1:LRA=11,apad,atrim=0:$LEN[a]" \
    -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 18 -r 30 -c:a aac -b:a 192k "$OUT"
else
  ffmpeg -y -v error -framerate 30 -i "$FRAMES/f%05d.png" -vf "trim=0:$LEN,format=yuv420p" -c:v libx264 -preset slow -crf 18 -r 30 "$OUT"
fi
ffprobe -v error -show_entries format=duration -of default=nw=1 "$OUT"
