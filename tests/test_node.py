"""Focused tests for node.py (consensus, wallets, marketplace, HTTP API) and the browser port in docs/chain.js.

    python -m unittest discover -s tests -v

All node state goes to a temp dir (MC_DATA/MC_DOCS); nothing in data/ or docs/ is touched.
Runs with the browser-demo parameters (16-bit genesis, 1 s block time) so JS exports validate.
"""
import io, json, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = tempfile.mkdtemp(prefix="memechain_test_")
os.environ.update({"MC_INITIAL_BITS": "16", "MC_BLOCK_TIME": "1", "MC_DATA": TMP, "MC_DOCS": os.path.join(TMP, "docs"),
                   "MC_PUBLISH": "0", "MC_MINE": "0", "GITHUB_TOKEN": ""})
sys.path.insert(0, str(ROOT))
import node as t  # noqa: E402

TESTNET_GENESIS = "00000fcc888ffaab65434e9c60667ae27be1150b1e8fcae042e7b3cb460e33a9"   # 20-bit genesis of the testnet


def png_bytes(w=8, h=8, color=(255, 209, 102)):
    from PIL import Image
    buf = io.BytesIO(); Image.new("RGB", (w, h), color).save(buf, "PNG"); return buf.getvalue()


def fresh_chain():
    ch = t.Chain.__new__(t.Chain)
    ch.lock = t.threading.RLock(); ch.mempool = {}; ch.new_block_evt = t.threading.Event()
    ch.replace([t.genesis_block()], persist=False); return ch


def mine(ch, miner, ts=None):
    b = ch.candidate(miner.address)
    if ts is not None: b["timestamp"] = ts
    b = t.mine_block_sync(b); ok, why = ch.add_block(b); assert ok, why; return b


class Consensus(unittest.TestCase):
    def test_testnet_genesis_hash_is_reproducible(self):
        old = t.INITIAL_BITS; t.INITIAL_BITS = 20
        try: g = t.genesis_block()
        finally: t.INITIAL_BITS = old
        self.assertEqual(g["hash"], TESTNET_GENESIS); self.assertEqual(g["nonce"], 1938477)

    def test_wallet_sign_verify_and_tamper(self):
        w = t.Wallet(); tx = t.make_transfer(w, t.Wallet().address, 3, 1)
        self.assertTrue(t.verify_sig(tx)); self.assertTrue(t.valid_addr(w.address))
        bad = dict(tx); bad["amount"] = 4
        self.assertFalse(t.verify_sig(bad))
        self.assertEqual(t.Wallet(w.export()["private_key"]).address, w.address)

    def test_mine_meme_and_transfer_then_revalidate(self):
        ch = fresh_chain(); miner = t.Wallet(); user = t.Wallet()
        mine(ch, miner); self.assertEqual(ch.balances[miner.address], 50)
        ok, why = ch.add_tx(t.make_transfer(miner, user.address, 10)); self.assertTrue(ok, why)
        mine(ch, miner); self.assertEqual(ch.balances[user.address], 10)
        img = png_bytes(); tx = t.make_meme_tx(user, img, "first meme  ")
        self.assertEqual(tx["img_sha256"], t.sha256(img)); self.assertEqual(tx["caption"], "first meme")
        self.assertEqual(ch.add_tx(tx), (True, "ok"))
        self.assertEqual(ch.add_tx(dict(tx)), (False, "replay"))
        self.assertEqual(ch.add_tx(t.make_meme_tx(miner, img, "copy"))[1], "already inscribed")
        b3 = mine(ch, miner)
        self.assertEqual(b3["txs"][0]["amount"], 51)                     # reward + 1 MEME meme fee
        self.assertEqual(ch.balances[user.address], 9); self.assertEqual(ch.meme_count(), 1)
        self.assertEqual(ch.owners[tx["img_sha256"]], user.address)
        self.assertTrue(ch.validate_chain(ch.chain))
        forged = json.loads(json.dumps(ch.chain)); forged[3]["txs"][1]["caption"] = "edited"
        self.assertFalse(ch.validate_chain(forged))                       # txid/signature no longer match
        forged = json.loads(json.dumps(ch.chain)); forged[2]["nonce"] += 1
        self.assertFalse(ch.validate_chain(forged))                       # proof of work breaks

    def test_marketplace_sell_and_buy(self):
        ch = fresh_chain(); seller = t.Wallet(); buyer = t.Wallet(); miner = t.Wallet()
        mine(ch, seller); mine(ch, buyer)                                 # 50 each
        meme = t.make_meme_tx(seller, png_bytes(4, 4, (1, 2, 3)), "for sale"); sha = meme["img_sha256"]
        self.assertEqual(ch.add_tx(meme), (True, "ok")); mine(ch, miner)
        self.assertEqual(ch.add_tx(t.make_sell(buyer, sha, 20))[1], "not the owner")
        self.assertEqual(ch.add_tx(t.make_buy(buyer, sha, 20))[1], "not for sale")
        self.assertEqual(ch.add_tx(t.make_sell(seller, sha, 20)), (True, "ok")); mine(ch, miner)
        self.assertEqual(ch.listings[sha], 20)
        self.assertEqual(ch.add_tx(t.make_buy(buyer, sha, 19))[1], "price is 20 MEME")
        self.assertEqual(ch.add_tx(t.make_buy(seller, sha, 20))[1], "already yours")
        self.assertEqual(ch.add_tx(t.make_buy(buyer, sha, 20, fee=2)), (True, "ok"))
        b = mine(ch, miner)
        self.assertEqual(b["txs"][0]["amount"], 52)
        self.assertEqual(ch.owners[sha], buyer.address); self.assertNotIn(sha, ch.listings)
        self.assertEqual(ch.balances[seller.address], 50 - 1 + 20); self.assertEqual(ch.balances[buyer.address], 50 - 22)
        self.assertEqual(ch.add_tx(t.make_sell(seller, sha, 5))[1], "not the owner")    # ownership moved
        self.assertEqual(ch.add_tx(t.make_sell(buyer, sha, 0)), (True, "ok"))             # delist is allowed even if unlisted
        self.assertTrue(ch.validate_chain(ch.chain))
        forged = json.loads(json.dumps(ch.chain)); forged[5]["txs"][1]["amount"] = 1       # cheaper buy
        self.assertFalse(ch.validate_chain(forged))

    def test_rejects_bad_txs(self):
        ch = fresh_chain(); w = t.Wallet()
        self.assertEqual(ch.add_tx(t.make_transfer(w, t.Wallet().address, 1))[1], "insufficient funds")
        mine(ch, w)
        self.assertEqual(ch.add_tx(t.make_transfer(w, "meme1nope", 1))[1], "bad to")
        with self.assertRaises(ValueError): t.make_meme_tx(w, b"not an image", "x")
        with self.assertRaises(ValueError): t.make_meme_tx(w, png_bytes(600, 600, (1, 2, 3)) + b"\0" * 300000, "x")

    def test_retarget_clamps(self):
        ch = fresh_chain(); w = t.Wallet(); ts = ch.chain[0]["timestamp"] + 1
        for _ in range(10): mine(ch, w, ts)                                # ten blocks in the same second (target 1 s each)
        self.assertLess(int(ch.tip["target"], 16), int(ch.chain[1]["target"], 16))   # blocks came fast -> harder
        self.assertAlmostEqual(t.difficulty_of(ch.tip["target"]) / t.difficulty_of(ch.chain[1]["target"]), 4.0, places=3)


class BrowserPort(unittest.TestCase):
    """docs/chain.js must produce chains that node.py accepts (hashes, canonical JSON, secp256k1 signatures, marketplace)."""
    @unittest.skipUnless(shutil.which("node"), "node.js not installed")
    def test_js_chain_validates_in_python(self):
        p = subprocess.run(["node", "tests/js_chain_export.mjs"], cwd=ROOT, capture_output=True, timeout=300)
        self.assertEqual(p.returncode, 0, p.stderr.decode(errors="replace")[-500:])
        chain = json.loads(p.stdout.decode("utf-8"))
        self.assertEqual(t.canon(chain[0]), t.canon(t.genesis_block()))
        self.assertTrue(t.CH.validate_chain(chain)); self.assertEqual(len(chain), 12)
        types = [x["type"] for b in chain for x in b["txs"]]
        self.assertEqual(types.count("meme"), 1); self.assertEqual(types.count("sell"), 1); self.assertEqual(types.count("buy"), 1)
        self.assertIn("ü", next(x for b in chain for x in b["txs"] if x["type"] == "meme")["caption"])
        self.assertTrue(all(t.verify_sig(x) for b in chain for x in b["txs"][1:]))


class HttpApi(unittest.TestCase):
    def setUp(self):
        t.CH.replace([t.genesis_block()], persist=False); t.CH.mempool.clear(); t.FAUCET_SEEN.clear()
        self.c = t.app.test_client()
        mine(t.CH, t.NODE_WALLET)                                           # fund the faucet wallet

    def test_flow(self):
        st = self.c.get("/api/status").get_json(); self.assertEqual(st["height"], 1); self.assertEqual(st["ticker"], "MEME")
        w = self.c.get("/api/wallet/new").get_json(); self.assertTrue(t.valid_addr(w["address"]))
        r = self.c.post("/api/faucet", json={"address": w["address"]}); self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(self.c.post("/api/faucet", json={"address": w["address"]}).status_code, 429)
        mine(t.CH, t.NODE_WALLET)
        self.assertEqual(self.c.get(f"/api/balance/{w['address']}").get_json()["balance"], 10)
        r = self.c.post("/api/meme", data={"image": (io.BytesIO(png_bytes()), "m.png"), "caption": "api meme", "private_key": w["private_key"]},
                        content_type="multipart/form-data")
        self.assertEqual(r.status_code, 200, r.get_json()); txid = r.get_json()["txid"]; sha = r.get_json()["img_sha256"]
        self.assertEqual(len(self.c.get("/api/mempool").get_json()), 1)
        mine(t.CH, t.NODE_WALLET)
        blk = self.c.get("/api/block/3").get_json(); self.assertIn(txid, [x["txid"] for x in blk["txs"]])
        self.assertEqual(self.c.get(f"/api/balance/{w['address']}").get_json()["balance"], 9)
        self.assertEqual(self.c.get(f"/meme/{sha}").status_code, 200)
        self.assertEqual(self.c.post("/api/tx", json={"type": "transfer"}).status_code, 400)
        sell = t.make_sell(t.Wallet(w["private_key"]), sha, 3)
        self.assertEqual(self.c.post("/api/tx", json=sell).status_code, 200); mine(t.CH, t.NODE_WALLET)
        self.assertEqual(self.c.get("/api/market").get_json(), [{"img_sha256": sha, "owner": w["address"], "price": 3}])
        st = t.export_docs(); self.assertEqual(st["memes"], 1); self.assertEqual(st["listed"], 1)
        self.assertTrue((Path(os.environ["MC_DOCS"]) / "chain.json").exists())


if __name__ == "__main__":
    unittest.main()
