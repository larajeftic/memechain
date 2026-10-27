"""End-to-end test of the browser demo with Playwright (uses the installed Google Chrome).

    python tools/serve.py 8080                       # in another terminal
    python tests/e2e_browser.py [http://127.0.0.1:8080/] [screenshot_dir]

Walks the seven steps (wallets, mine, inscribe, list, buy, cold vault, verify), checks balances and ownership,
exports the chain and validates the export with node.py. Writes desktop + mobile screenshots.
"""
import json, subprocess, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080/"
SHOTS = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(tempfile.mkdtemp(prefix="memechain_shots_"))
SHOTS.mkdir(parents=True, exist_ok=True)
errors = []
num = lambda page, sel: int(page.text_content(sel).replace(",", ""))

with sync_playwright() as p:
    try: browser = p.chromium.launch(channel="chrome")
    except Exception: browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL, wait_until="networkidle")
    page.wait_for_function("document.fonts.status === 'loaded'")
    page.screenshot(path=str(SHOTS / "01_top.png"))

    page.click("#b-wallets")
    hot = page.text_content("#a-hot").strip(); assert hot.startswith("meme1") and len(hot) == 45, hot
    assert page.text_content("#a-cold").strip() != hot
    print("wallets", hot)

    page.click("#b-mine"); page.wait_for_selector("#o2 .ticket", timeout=180000)
    assert num(page, "#w-hot") == 250, page.text_content("#w-hot"); assert num(page, "#cb-height") == 5
    print("mined 5 blocks:", page.text_content("#m2"))
    page.locator("#steps").screenshot(path=str(SHOTS / "02_steps.png"))

    page.check("input[name=img][value='img/doge.jpg']"); page.fill("#caption", "such chain. very block. wow")
    page.click("#b-inscribe"); page.wait_for_selector("#o3 .ticket", timeout=180000)
    assert num(page, "#w-hot") == 300 and num(page, "#cb-height") == 6          # +51 coinbase -1 fee
    assert "such chain" in page.text_content("#market-grid") and "you" in page.text_content("#market-grid")
    print("inscribed:", page.text_content("#m3"))

    page.fill("#price", "40"); page.click("#b-sell"); page.wait_for_selector("#o4 .txcard", timeout=180000)
    assert "40" in page.locator("#market-grid .price").first.text_content()
    print("listed")

    page.click("#b-buy"); page.wait_for_selector("#o5 .txcard", timeout=240000)
    assert "test buyer" in page.locator("#market-grid .own").first.text_content(), page.locator("#market-grid .own").first.text_content()
    # listing block (+50), buyer mined one block for itself, buy block mined by you (+50), +40 sale
    assert num(page, "#w-hot") == 300 + 50 + 50 + 40, page.text_content("#w-hot")
    assert num(page, "#w-buyer") == 50 - 40, page.text_content("#w-buyer")
    print("bought: hot", page.text_content("#w-hot"), "buyer", page.text_content("#w-buyer"))
    page.locator("#s5").screenshot(path=str(SHOTS / "03_buy.png"))

    hot_before = num(page, "#w-hot")
    page.click("#b-cold"); page.wait_for_selector("#o6 .txcard", timeout=180000)
    cold = num(page, "#w-cold"); assert cold == int(hot_before * 0.75), (cold, hot_before)
    assert num(page, "#w-hot") == hot_before - cold + 50
    print("cold vault", cold)
    page.click("#b-topup")
    page.wait_for_function(f"parseInt(document.querySelector('#w-cold').textContent.replace(/,/g,'')) === {cold - 50}", timeout=180000)
    page.locator("#wallets").screenshot(path=str(SHOTS / "04_wallets.png"))

    page.click("#b-verify"); page.wait_for_selector("#o7 .check")
    assert page.locator("#o7 .check li.fail").count() == 0, page.text_content("#o7")
    print("verify:", " | ".join(t.strip() for t in page.locator("#o7 .check li").all_text_contents()))
    page.locator("#s7").screenshot(path=str(SHOTS / "05_verify.png"))

    with page.expect_download() as dl: page.click("#b-export")
    export = SHOTS / "exported_chain.json"; dl.value.save_as(str(export))
    chain = json.loads(export.read_text(encoding="utf-8"))
    types = [t["type"] for b in chain for t in b["txs"]]
    assert types.count("meme") == 1 and types.count("sell") == 1 and types.count("buy") == 1 and types.count("transfer") == 2, types
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "validate_export.py"), str(export)], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0 and "VALID" in r.stdout, r.stdout + r.stderr
    print("python validator:", [l for l in r.stdout.splitlines() if l.startswith("VALID") or l.startswith("memes")])

    page.click("#blocks tbody tr[data-h='6']"); assert "Block 6 as stored" in page.text_content("#block-detail")
    page.locator("#market").screenshot(path=str(SHOTS / "06_market.png"))
    page.locator("#explorer").screenshot(path=str(SHOTS / "07_explorer.png"))
    page.reload(wait_until="networkidle"); assert num(page, "#cb-height") == len(chain) - 1, "chain not persisted"

    mobile = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    mobile.goto(URL, wait_until="networkidle"); mobile.wait_for_function("document.fonts.status === 'loaded'")
    assert mobile.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "horizontal page scroll on mobile"
    mobile.screenshot(path=str(SHOTS / "08_mobile.png"))
    mobile.locator("#s3").scroll_into_view_if_needed(); mobile.screenshot(path=str(SHOTS / "09_mobile_steps.png"))
    browser.close()

errors = [e for e in errors if "favicon" not in e]
if errors: print("console errors:", errors); sys.exit(1)
print("E2E OK, screenshots in", SHOTS)
