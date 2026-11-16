# Music for the demo video

The film is the cinematic intro (`?intro`, 17 s) followed by the story (`?story`), voiced by the 3:21 ElevenLabs take in `docs/story-voiceover.md`.

## Intro: "Bass First"

Measured from the file: about 99 BPM (one beat is 0.604 s), key of C♯, 70 s long. A quiet build runs to 7.4 s; after that, almost all the energy is sub-bass (below 120 Hz). The intro is cut to it:

| Time | Music | Picture |
| --- | --- | --- |
| 0.0–7.4 s | Quiet build | The urgent list settles onto the tilted brief, row by row |
| 7.4 s | The drop | The camera swings to the $58 decision |
| 10.45 s | A hit | The cursor clicks Keep $62 |
| 13.5–14.1 s | Near silence | The camera has pulled back and the whole app is sharp |
| 14.12 s | A hit | The title "Timmy" racks into focus |
| 16.5–17.0 s | A gap | Fade to black; cut the music at 16.9 s with a 0.4 s fade |

## Outro: the end of "Bass First"

The outro (`?outro`, 15 s) uses the track from its hit at 57.10 s to the end (70.0 s). The film opens on that hit. The line "Never drop a ball." lands on the final hit (68.75 s in the track, 11.65 s into the outro). The last 2 s are silence over the title, then it fades to black.

## The story: a prompt for the bed under the voice

Generate this one track to run under the whole story, from its first frame (the voice's 0:00) to the end card. It matches "Bass First" in tempo and key, so the cut from the intro feels like one score. The times come from the voiceover.

> Instrumental, no vocals. 99 BPM, key of C-sharp. A bass-led modern electronic score for a calm, confident product story, built to sit under a narrator: a deep, round sub bass carries the groove, with a soft kick, a light shaker and closed hi-hats, a warm analog pad, and an occasional muted pluck. Keep the midrange (300 Hz to 4 kHz) sparse, with no lead melody while the voice is talking. No vocal chops, no stutter stops, no long risers or big drops. Length 3:30.
>
> 0:00–0:27, the problem: C-sharp minor. A low-pass-filtered pad, one sustained sub note, and a muted heartbeat pulse each bar. No drums. Quiet, slightly restless.
>
> 0:27, the turn: exactly on the downbeat at 0:27, open the filter and move to C-sharp major. The kick, a soft clap on 2 and 4, and the sub-bass groove come in. Optimistic and steady, not euphoric.
>
> 0:41–2:23, the walkthrough: a steady, unobtrusive groove; the same four-bar loop, changing a little every eight bars. Small one-bar swells that land at 1:22, 1:36, 1:57 and 2:05.
>
> 2:23–2:39, everything sorted: add a higher pad layer and brighter hi-hats for a gentle lift.
>
> 2:39–3:00, the plan: the warmest, fullest section. Wide pads and a simple three-note motif. Confident.
>
> 3:00–3:12, without it: the drums and groove drop out. Back to C-sharp minor: a low, filtered drone and a slow pulse only.
>
> 3:12–3:21, nothing slipped: the groove returns in C-sharp major and builds gently to one resolved chord that lands at 3:21.
>
> 3:21–3:30: let the final chord ring under the end card and fade to silence by 3:30.

If the tool asks for section lengths, use 27.5 s, 14 s, 102 s, 15.3 s, 21.5 s, 11.4 s, 9.1 s and 9.2 s, in that order.

**Fallback:** the steady part of "Bass First" (0:29–1:08) can loop under the walkthrough at a low level, since its energy sits below the voice. Its stops would land on random words, though, so a dedicated bed is better.

## Mix

- **Voice:** the take measures −23 LUFS. Raise it to about −16 LUFS, a typical level for online video.
- **Music under the voice:** keep it 15–18 dB below the voice, and duck it 3–6 dB more while the voice is speaking. Let it come up in the gaps, in the plan, and on the "Without it" drop.
- **Intro:** music only. Bring the hits up to about −14 LUFS short-term.
- **Final master:** −14 LUFS integrated (YouTube's reference) with peaks no higher than −1 dBTP.
