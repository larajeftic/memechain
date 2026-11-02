"""Render the memechain mark from docs/logo.html into every icon size the site and README use.

    python tools/logo_assets.py            # no server needed, loads docs/logo.html from disk

Writes docs/logo.png (1024, transparent), docs/logo-160.png (header), docs/icon-512.png + docs/icon-192.png (night background, rounded),
docs/icons/favicon-64.png, docs/icons/favicon-32.png, docs/icons/apple-touch-icon.png (180, night background)
and _backups/logo-preview.png (the mark on the page background, for checking; not committed).
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"; ICONS = DOCS / "icons"; ICONS.mkdir(exist_ok=True)
PREVIEW = ROOT / "_backups" / "logo-preview.png"; PREVIEW.parent.mkdir(exist_ok=True)
SRC = (DOCS / "logo.html").as_uri()

def rounded(img, radius):
    m = Image.new("L", img.size, 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius, fill=255)
    out = img.copy(); out.putalpha(m); return out

with sync_playwright() as p:
    try: browser = p.chromium.launch(channel="chrome")
    except Exception: browser = p.chromium.launch()
    pg = browser.new_page(viewport={"width": 1024, "height": 1024})
    pg.goto(SRC, wait_until="networkidle"); pg.wait_for_timeout(300)
    pg.screenshot(path=str(DOCS / "logo.png"), omit_background=True)
    pg.evaluate("document.body.classList.add('bg')"); pg.wait_for_timeout(100)
    pg.screenshot(path=str(PREVIEW))
    browser.close()

mark = Image.open(DOCS / "logo.png").convert("RGBA")

def fit(src, size, pad):   # scale the 1024 canvas into size, with pad px of air on each side
    inner = size - 2 * pad; im = src.resize((inner, inner), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0)); out.paste(im, (pad, pad), im); return out

for size in (512, 192):
    canvas = Image.new("RGBA", (size, size), (10, 10, 12, 255)); art = fit(mark, size, round(size * 0.04))
    canvas.alpha_composite(art); rounded(canvas, round(size * 0.22)).save(DOCS / f"icon-{size}.png")
apple = Image.new("RGBA", (180, 180), (10, 10, 12, 255)); apple.alpha_composite(fit(mark, 180, 6)); apple.save(ICONS / "apple-touch-icon.png")
for size in (64, 32):
    fit(mark, size, 0).save(ICONS / f"favicon-{size}.png")
fit(mark, 160, 0).save(DOCS / "logo-160.png")   # transparent, for the page header
print("logo assets written to", DOCS)
