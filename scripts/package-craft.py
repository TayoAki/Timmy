"""Copies the Craft apps' web builds into public/craft/<app>/ for Timmy to host.

Input: a wasm-bindgen output folder per app (<out>/<app>/<app>-web.js,
<app>-web_bg.wasm, snippets/) and the app's checkout (for its index.html and
licence files). The .wasm is stored gzipped as <app>-web_bg.wasmz and the page
decompresses it in the browser, so it ships small whatever the web server
compresses. Set CRAFT_WASM_OPT=1 to run wasm-opt -Oz first.

Usage: python3 scripts/package-craft.py <out-dir> <checkouts-dir> [app ...]
"""
import gzip
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "public" / "craft"
APPS = ["wordcraft", "gridcraft", "deckcraft", "pdfcraft"]
# Inside Timmy the editors go by what they do; the projects' names stay in SOURCE.txt and the licences.
LABEL = {"wordcraft": "Document editor", "gridcraft": "Spreadsheet editor", "deckcraft": "Presentation editor", "pdfcraft": "PDF editor"}

LOADER = """<script type="module">
  // Timmy hosts this page: the .wasm ships gzipped and is decompressed here. If it can't
  // start, the page says so and tells a hosting page (?host=parent) at once.
  import init, * as bindings from './{app}-web.js';
  async function wasm() {{
    const res = await fetch('./{app}-web_bg.wasmz');
    if (!res.ok) throw new Error('could not download it (HTTP ' + res.status + ')');
    return new Response(res.body.pipeThrough(new DecompressionStream('gzip')), {{ headers: {{ 'Content-Type': 'application/wasm' }} }});
  }}
  try {{
    const instance = await init({{ module_or_path: wasm() }});
    window.wasmBindings = bindings;
    dispatchEvent(new CustomEvent('TrunkApplicationStarted', {{ detail: {{ wasm: instance }} }}));
  }} catch (err) {{
    const message = 'The {label} couldn’t start: ' + (err && err.message ? err.message : err);
    const note = document.getElementById('{app}_loading');
    if (note) note.textContent = message;
    if (new URLSearchParams(location.search).get('host') === 'parent' && window.parent !== window) {{
      window.parent.postMessage({{ type: '{app}:failed', version: '1', error: message }}, location.origin);
    }}
  }}
</script>"""


def package(app: str, out: Path, checkouts: Path) -> None:
    src = out / app
    repo = checkouts / app
    shell = (repo / "apps" / f"{app}-web" / "index.html").read_text()
    title = re.search(r"<title>(.*?)</title>", shell).group(1)
    wasm = src / f"{app}-web_bg.wasm"
    if not wasm.exists():
        print(f"{app}: no build in {src}, skipped")
        return

    dest = DEST / app
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    shutil.copy2(src / f"{app}-web.js", dest / f"{app}-web.js")
    if (src / "snippets").exists():
        shutil.copytree(src / "snippets", dest / "snippets")

    opt = src / f"{app}-web_bg.opt.wasm"
    # wasm-opt -Oz trims the decompressed size by about a third but saves only a few percent
    # gzipped, and takes minutes per app: opt in with CRAFT_WASM_OPT=1.
    if not opt.exists() and os.environ.get("CRAFT_WASM_OPT") and shutil.which("wasm-opt"):
        print(f"{app}: wasm-opt -Oz …")
        r = subprocess.run(["wasm-opt", "-Oz", "-all", "--strip-debug", "--strip-producers", str(wasm), "-o", str(opt)], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"{app}: wasm-opt failed, shipping the unoptimised build\n{r.stderr[-400:]}")
            opt.unlink(missing_ok=True)
    data = (opt if opt.exists() else wasm).read_bytes()
    # mtime=0 keeps the output identical for an identical build, so git doesn't store a new copy.
    with open(dest / f"{app}-web_bg.wasmz", "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as f:
        f.write(data)

    # The app's own page, with Trunk's build links swapped for the loader.
    page = re.sub(r"\s*<link data-trunk[^>]*/>", "", shell)
    page = page.replace(f"<title>{title}</title>", f'<meta name="craft-app" content="{app}">\n  <title>{LABEL[app]}</title>', 1)
    page = re.sub(r"Loading [A-Za-z]+&hellip;", "Opening&hellip;", page)
    page = page.replace("</body>", LOADER.format(app=app, label=LABEL[app].lower()) + "\n</body>", 1)
    (dest / "index.html").write_text(page)

    for name in ("LICENSE-MIT", "LICENSE-APACHE", "NOTICE"):
        if (repo / name).exists():
            shutil.copy2(repo / name, dest / name)
    rev = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    (dest / "SOURCE.txt").write_text(f"{title}: https://github.com/storytold/{app} at {rev}\nBuilt for Timmy with cargo build --release --target wasm32-unknown-unknown -p {app}-web and wasm-bindgen --target web --weak-refs.\nLicensed MIT OR Apache-2.0; see LICENSE-MIT, LICENSE-APACHE and NOTICE.\n")
    size = (dest / f"{app}-web_bg.wasmz").stat().st_size
    print(f"{app}: {len(data) / 1e6:.1f} MB wasm → {size / 1e6:.1f} MB gzipped in public/craft/{app}")


if __name__ == "__main__":
    out, checkouts = Path(sys.argv[1]), Path(sys.argv[2])
    for app in sys.argv[3:] or APPS:
        package(app, out, checkouts)
