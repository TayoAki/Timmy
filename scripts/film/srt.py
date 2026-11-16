"""Captions (SRT) for the product film, from the narration's word timings.

  python3 scripts/film/srt.py src/film/vo_words.json OUT.srt [--offset 13.6]

Cues keep every spoken word, break at punctuation or pauses, and fit two lines of at most
32 characters. The offset is where the narration starts in the film (0 for v2: the voice opens the film).
Spelling follows the product: "9:15", "proposal v4", "Send & track", the folder names.
"""
import json
import re
import sys

FIX = [
    (r"\btype form\b", "Typeform"),
    (r"\bhub spot\b", "HubSpot"),
    (r"\bFacebook lead ads\b", "Facebook Lead Ads"),
    (r"owes what\?", "owes what."),
    (r"files buried, three", "files buried three"),
    (r"\bmorning runs\b", "morning run"),
    (r"\b8 o'clock\b", "8:00"),
    (r"\bone o'clock to 2:30\b", "1:00 to 2:30"),
    (r"\bProposal V(\d)", r"proposal v\1"),
    (r"\bV(\d)\b", r"v\1"),
    (r"\bapprovals,", "Approvals,"),
    (r"\bsend and track\b", "Send & track"),
    (r"\bto waiting\b", "to Waiting"),
    (r"\bnine o'clock\b", "9:00"),
    (r"Follow up, waiting, or read through", "Follow Up, Waiting or Read Through"),
    (r"\bdrive\b", "Drive"),
    (r"\bfive thirty\b", "5:30"),
    (r"Monday morning works\. 9:15 is great\.", "“Monday morning works! 9:15 is great.”"),
    (r"Write a campaign for my best leads\.", "“Write a campaign for my best leads.”"),
]


def tokens(words):
    """Join the transcriber's split tokens ("8 o 'clock", "2 .30", "$83 ,520") back together."""
    out = []
    for w in words:
        t = w["w"]
        if out and (t.startswith("'") or re.match(r"^[.,]\d", t)):
            out[-1] = {**out[-1], "w": out[-1]["w"] + (":" + t[1:] if t.startswith(".") else t), "e": w["e"]}
        elif out and out[-1]["w"] in ("o",) and t.startswith("'"):
            out[-1] = {**out[-1], "w": "o" + t, "e": w["e"]}
        else:
            out.append(dict(w))
    # "8 o'clock" arrives as "8", "o'clock" after the join above.
    return out


def stamp(s):
    s = max(0.0, s)
    h, m = int(s // 3600), int(s % 3600 // 60)
    return f"{h:02d}:{m:02d}:{int(s % 60):02d},{int(round(s % 1 * 1000)) % 1000:03d}"


def wrap(text, width=32):
    words, lines, line = text.split(), [], ""
    for w in words:
        if line and len(line) + 1 + len(w) > width:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    lines.append(line)
    return lines


def main():
    src, out = sys.argv[1], sys.argv[2]
    offset = float(sys.argv[sys.argv.index("--offset") + 1]) if "--offset" in sys.argv else 0.0
    ws = tokens(json.load(open(src)))
    cues, cur = [], []
    for i, w in enumerate(ws):
        cur.append(w)
        text = " ".join(x["w"] for x in cur)
        nxt = ws[i + 1] if i + 1 < len(ws) else None
        pause = nxt is not None and nxt["s"] - w["e"] > 0.45
        punct = re.search(r"[.?!]$", w["w"]) or (re.search(r"[,:]$", w["w"]) and len(text) > 34)
        too_long = nxt is not None and len(wrap(text + " " + nxt["w"])) > 2
        if nxt is None or pause or punct or too_long:
            cues.append(cur)
            cur = []
    # A lone word doesn't get a cue of its own: it joins the next cue ("Timmy," + "never drop a ball.")
    # when that one follows closely, or else the cue before it ("…using your own files and" + "numbers.").
    def fits(ws):
        return len(wrap(" ".join(x["w"] for x in ws), 34)) <= 2

    merged = []
    i = 0
    while i < len(cues):
        c = cues[i]
        ends = re.search(r"[.?!]$", c[0]["w"])
        if len(c) == 1 and not ends and i + 1 < len(cues) and cues[i + 1][0]["s"] - c[0]["e"] < 1.0 and fits(c + cues[i + 1]):
            merged.append(c + cues[i + 1])
            i += 2
            continue
        if len(c) == 1 and merged and c[0]["s"] - merged[-1][-1]["e"] < 0.45 and fits(merged[-1] + c):
            merged[-1] = merged[-1] + c
        else:
            merged.append(c)
        i += 1
    cues = merged
    with open(out, "w") as f:
        for n, c in enumerate(cues, 1):
            text = " ".join(x["w"] for x in c)
            for a, b in FIX:
                text = re.sub(a, b, text)
            start = c[0]["s"] + offset
            end = c[-1]["e"] + offset + 0.25
            if n < len(cues):
                end = min(end, cues[n][0]["s"] + offset - 0.05)
            lines = wrap(text) if len(wrap(text)) <= 2 else wrap(text, 34)
            f.write(f"{n}\n{stamp(start)} --> {stamp(end)}\n" + "\n".join(lines) + "\n\n")
    print(f"{out}: {len(cues)} cues")


if __name__ == "__main__":
    main()
