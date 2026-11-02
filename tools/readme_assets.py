"""Render the README images: banner, social preview, app icon and screenshots of the live page.

    python tools/serve.py 8080          # in another terminal
    python tools/readme_assets.py [http://127.0.0.1:8080/]

Writes docs/readme/banner.png, docs/og.png and docs/readme/{hero,market,mine,explorer,mobile}.png.
The mark itself (docs/logo.png, icons, favicons) comes from tools/logo_assets.py, which runs first.
    python tools/readme_assets.py --quick   # banner + social preview only (no mining)
Uses Playwright with the installed Chrome. The screenshots show whatever the testnet branch holds at that moment.
"""
import subprocess, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
QUICK = "--quick" in sys.argv; args = [a for a in sys.argv[1:] if a != "--quick"]
URL = (args[0] if args else "http://127.0.0.1:8080/").rstrip("/") + "/"
subprocess.run([sys.executable, str(ROOT / "tools" / "logo_assets.py")], check=True)
OUT = ROOT / "docs" / "readme"; OUT.mkdir(parents=True, exist_ok=True)

def ready(page):
    page.wait_for_function("document.fonts.status === 'loaded'"); page.wait_for_timeout(700)

with sync_playwright() as p:
    try: browser = p.chromium.launch(channel="chrome")
    except Exception: browser = p.chromium.launch()

    pg = browser.new_page(viewport={"width": 1280, "height": 640})
    pg.goto(URL + "readme/banner.html", wait_until="networkidle"); ready(pg)
    pg.screenshot(path=str(OUT / "banner.png")); pg.screenshot(path=str(ROOT / "docs" / "og.png"))
    pg.close()
    if QUICK: browser.close(); print("banner + og written to", OUT); sys.exit(0)

    pg = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    pg.goto(URL, wait_until="networkidle"); ready(pg)
    pg.wait_for_selector("#strip .cube[data-h]")
    pg.screenshot(path=str(OUT / "hero.png"))
    pg.add_style_tag(content=".top, .wallets { position: relative; top: 0; }")   # nothing sticky inside element shots
    pg.locator("#market").screenshot(path=str(OUT / "market.png"))
    pg.click("#blocks tbody tr:nth-child(3)"); pg.wait_for_selector("#block-detail .match")
    pg.locator("#explorer").screenshot(path=str(OUT / "explorer.png"))

    pg.click("#b-wallets"); pg.click("#b-mine"); pg.wait_for_selector("#o2 .ticket", timeout=180000)
    pg.check("input[name=img][value='img/doge.jpg']"); pg.fill("#caption", "such chain. very block. wow")
    pg.click("#b-inscribe"); pg.wait_for_selector("#o3 .ticket", timeout=180000)
    pg.fill("#price", "40"); pg.click("#b-sell"); pg.wait_for_selector("#o4 .txcard", timeout=180000)
    pg.click("#b-buy"); pg.wait_for_selector("#o5 .txcard", timeout=240000)
    for i in (2, 3, 4): pg.evaluate(f"document.querySelector('#o{i}').innerHTML = ''")   # keep the shot compact
    pg.locator("#mine").screenshot(path=str(OUT / "mine.png"))
    pg.close()

    m = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    m.goto(URL, wait_until="networkidle"); ready(m); m.wait_for_selector("#strip .cube[data-h]")
    m.screenshot(path=str(OUT / "mobile.png"))
    browser.close()
print("written to", OUT)
