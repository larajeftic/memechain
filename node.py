#!/usr/bin/env python3
"""
memechain - a proof-of-work blockchain for memes. Testnet.

Single-file node: PoW consensus (double SHA-256, Bitcoin-style retargeting),
secp256k1 wallets, meme inscriptions (image committed on-chain by SHA-256),
HTTP P2P, built-in miner, public explorer export (GitHub Pages),
Bitcoin anchoring of the chain head via OpenTimestamps,
and a GitHub-Issues intake so anyone can inscribe a meme without running a node.

Pattern follows "Learn Blockchains by Building One" (dvf/blockchain, MIT) and
Bitcoin's header/retarget rules, rewritten here for the meme use case.
"""
import os, sys, io, json, time, math, hashlib, threading, re, base64, shutil, subprocess, random
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory, abort, Response
import ecdsa
from PIL import Image

# ---------------------------------------------------------------- config ---
NAME        = os.environ.get("MC_NAME", "memechain")
TICKER      = os.environ.get("MC_TICKER", "MEME")
BLOCK_TIME  = int(os.environ.get("MC_BLOCK_TIME", "60"))      # seconds
REWARD      = int(os.environ.get("MC_REWARD", "50"))
HALVING     = int(os.environ.get("MC_HALVING", "100000"))     # blocks
RETARGET    = int(os.environ.get("MC_RETARGET", "10"))        # blocks
INITIAL_BITS= int(os.environ.get("MC_INITIAL_BITS", "20"))    # leading zero bits of genesis target
MIN_BITS    = 16
MEME_FEE    = 1
FAUCET_AMT  = 10
MAX_IMG     = 250_000                                           # bytes
MAX_CAPTION = 140
MAX_TXS     = 200
PORT        = int(os.environ.get("MC_PORT", "5050"))
GH_REPO     = os.environ.get("MC_GH_REPO", "larajeftic/memechain")
PAGES_URL   = os.environ.get("MC_PAGES_URL", f"https://{GH_REPO.split('/')[0]}.github.io/{GH_REPO.split('/')[1]}/")
PUBLISH     = os.environ.get("MC_PUBLISH", "1") == "1"
MINE        = os.environ.get("MC_MINE", "1") == "1"
ANCHOR_EVERY= int(os.environ.get("MC_ANCHOR_EVERY", "10"))
GENESIS_TS  = 1761350400   # 2026-10-25 00:00:00 UTC
GENESIS_MSG = "memechain genesis - the first block is a meme about blocks. 2026-10-25"

ROOT  = Path(__file__).resolve().parent
DATA  = Path(os.environ.get("MC_DATA", ROOT / "data")); DATA.mkdir(parents=True, exist_ok=True)   # MC_DATA: node-local state (tests use a temp dir)
DOCS  = Path(os.environ.get("MC_DOCS", ROOT / "docs")); DOCS.mkdir(parents=True, exist_ok=True)   # MC_DOCS: public export folder (GitHub Pages)
MEMES = DATA / "memes"; MEMES.mkdir(exist_ok=True)
(DOCS / "memes").mkdir(exist_ok=True)
(DOCS / "anchors").mkdir(exist_ok=True)
CHAIN_FILE = DATA / "chain.json"
WALLET_FILE= DATA / "wallet.json"
PEERS_FILE = DATA / "peers.json"
LOG_FILE   = DATA / "node.log"

def _load_env():
    for p in [ROOT / ".env"]:
        if p.exists():
            for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
                if "=" in line and not line.strip().startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
_load_env()
GH_TOKEN = os.environ.get("GITHUB_TOKEN", "")

def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f: f.write(line + "\n")
    except Exception: pass

# --------------------------------------------------------------- crypto ----
def sha256(b: bytes) -> str: return hashlib.sha256(b).hexdigest()
def sha256d(b: bytes) -> str: return hashlib.sha256(hashlib.sha256(b).digest()).hexdigest()
def canon(obj) -> bytes: return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()

def addr_from_pub(pub_hex: str) -> str:
    h = hashlib.sha256(bytes.fromhex(pub_hex)).digest()
    chk = hashlib.sha256(h).hexdigest()[:4]
    return "meme1" + h.hex()[:36] + chk

def valid_addr(a: str) -> bool:
    if not (isinstance(a, str) and a.startswith("meme1") and len(a) == 45): return False
    body, chk = a[5:41], a[41:]
    return bool(re.fullmatch(r"[0-9a-f]{36}", body)) and bool(re.fullmatch(r"[0-9a-f]{4}", chk))

class Wallet:
    def __init__(self, sk_hex=None):
        self.sk = ecdsa.SigningKey.from_string(bytes.fromhex(sk_hex), curve=ecdsa.SECP256k1) if sk_hex \
                  else ecdsa.SigningKey.generate(curve=ecdsa.SECP256k1)
        self.pub = self.sk.get_verifying_key().to_string("compressed").hex()
        self.address = addr_from_pub(self.pub)
    def sign(self, tx: dict) -> dict:
        body = {k: v for k, v in tx.items() if k not in ("sig", "txid")}
        tx["sig"] = self.sk.sign_deterministic(canon(body), hashfunc=hashlib.sha256).hex()
        tx["txid"] = sha256(canon(tx))
        return tx
    def export(self): return {"private_key": self.sk.to_string().hex(), "public_key": self.pub, "address": self.address}

def verify_sig(tx: dict) -> bool:
    try:
        body = {k: v for k, v in tx.items() if k not in ("sig", "txid")}
        vk = ecdsa.VerifyingKey.from_string(bytes.fromhex(tx["pubkey"]), curve=ecdsa.SECP256k1)
        return vk.verify(bytes.fromhex(tx["sig"]), canon(body), hashfunc=hashlib.sha256) \
               and addr_from_pub(tx["pubkey"]) == tx["from"]
    except Exception:
        return False

def merkle_root(txids):
    if not txids: return sha256(b"")
    layer = list(txids)
    while len(layer) > 1:
        if len(layer) % 2: layer.append(layer[-1])
        layer = [sha256((layer[i] + layer[i+1]).encode()) for i in range(0, len(layer), 2)]
    return layer[0]

# --------------------------------------------------------------- blocks ----
MAX_TARGET = 1 << (256 - MIN_BITS)

def header_bytes(b: dict) -> bytes:
    return f"{b['height']}|{b['prev_hash']}|{b['timestamp']}|{b['merkle_root']}|{b['target']}|{b['nonce']}".encode()

def block_hash(b: dict) -> str: return sha256d(header_bytes(b))

def block_reward(height: int) -> int: return REWARD >> (height // HALVING)

def target_for(chain: list) -> str:
    """Bitcoin-style retarget: every RETARGET blocks, scale by actual/expected time, clamp 1/4..4x."""
    h = len(chain)
    if h == 0: return format(1 << (256 - INITIAL_BITS), "064x")
    prev_t = int(chain[-1]["target"], 16)
    if h % RETARGET != 0: return chain[-1]["target"]
    first = chain[h - RETARGET]
    actual = max(1, chain[-1]["timestamp"] - first["timestamp"])
    expected = BLOCK_TIME * (RETARGET - 1)
    ratio = min(4.0, max(0.25, actual / expected))
    new_t = min(MAX_TARGET, int(prev_t * ratio))
    return format(max(1, new_t), "064x")

def difficulty_of(target_hex: str) -> float: return MAX_TARGET / int(target_hex, 16)

def genesis_block() -> dict:
    cb = {"type": "coinbase", "to": "meme1" + "0"*40, "amount": 0, "height": 0, "msg": GENESIS_MSG}
    cb["txid"] = sha256(canon(cb))
    b = {"height": 0, "prev_hash": "0"*64, "timestamp": GENESIS_TS, "merkle_root": merkle_root([cb["txid"]]),
         "target": format(1 << (256 - INITIAL_BITS), "064x"), "nonce": 0, "txs": [cb]}
    while int(block_hash(b), 16) >= int(b["target"], 16): b["nonce"] += 1
    b["hash"] = block_hash(b)
    return b

# ---------------------------------------------------------------- state ----
class Chain:
    def __init__(self):
        self.lock = threading.RLock()
        self.chain = []
        self.balances = {}
        self.mempool = {}        # txid -> tx
        self.seen_nonces = set() # (from, nonce)
        self.new_block_evt = threading.Event()
        self.load()

    # persistence
    def load(self):
        if CHAIN_FILE.exists():
            try:
                chain = json.loads(CHAIN_FILE.read_text())
                if self.validate_chain(chain):
                    self.replace(chain, persist=False); log(f"[CHAIN] loaded {len(chain)} blocks"); return
                log("[CHAIN] stored chain invalid, starting fresh")
            except Exception as e:
                log(f"[CHAIN] load failed: {e}")
        self.replace([genesis_block()], persist=True)
    def persist(self):
        tmp = CHAIN_FILE.with_suffix(".tmp"); tmp.write_text(json.dumps(self.chain)); tmp.replace(CHAIN_FILE)

    # accounting. State = balances (addr -> MEME), nonces, owners (img_sha256 -> addr), listings (img_sha256 -> price)
    @staticmethod
    def _apply_tx(tx, balances, nonces, owners, listings):
        if tx["type"] == "coinbase":
            balances[tx["to"]] = balances.get(tx["to"], 0) + tx["amount"]; return
        fee = tx.get("fee", 0); amt = tx.get("amount", 0)
        balances[tx["from"]] = balances.get(tx["from"], 0) - fee - amt
        nonces.add((tx["from"], tx["nonce"]))
        if tx["type"] == "transfer": balances[tx["to"]] = balances.get(tx["to"], 0) + amt
        elif tx["type"] == "meme": owners[tx["img_sha256"]] = tx["from"]
        elif tx["type"] == "sell":
            if tx["price"] > 0: listings[tx["img_sha256"]] = tx["price"]
            else: listings.pop(tx["img_sha256"], None)
        elif tx["type"] == "buy":
            seller = owners[tx["img_sha256"]]
            balances[seller] = balances.get(seller, 0) + amt
            owners[tx["img_sha256"]] = tx["from"]; listings.pop(tx["img_sha256"], None)

    def _apply(self, block, balances, nonces, owners=None, listings=None):
        if owners is None: owners = {}
        if listings is None: listings = {}
        for tx in block["txs"]: self._apply_tx(tx, balances, nonces, owners, listings)

    def replace(self, chain, persist=True):
        with self.lock:
            self.chain = chain; self.balances = {}; self.seen_nonces = set(); self.owners = {}; self.listings = {}
            for b in chain: self._apply(b, self.balances, self.seen_nonces, self.owners, self.listings)
            for txid in list(self.mempool):
                if any(txid == t.get("txid") for b in chain[-50:] for t in b["txs"]): self.mempool.pop(txid, None)
            if persist: self.persist()
            self.new_block_evt.set()

    @property
    def tip(self): return self.chain[-1]
    @property
    def height(self): return len(self.chain) - 1
    def supply(self): return sum(v for v in self.balances.values() if v > 0)
    def meme_count(self): return len(self.owners)

    # validation
    def validate_tx(self, tx, balances, nonces, owners=None, listings=None):
        owners = owners if owners is not None else self.owners; listings = listings if listings is not None else self.listings
        t = tx.get("type")
        if t not in ("meme", "transfer", "sell", "buy"): return False, "bad type"
        for k in ("from", "pubkey", "nonce", "fee", "sig", "txid"):
            if k not in tx: return False, f"missing {k}"
        if sha256(canon({k: v for k, v in tx.items() if k != "txid"})) != tx["txid"]: return False, "bad txid"
        if not verify_sig(tx): return False, "bad signature"
        if not valid_addr(tx["from"]): return False, "bad from"
        if (tx["from"], tx["nonce"]) in nonces: return False, "replay"
        fee = tx["fee"]; amt = tx.get("amount", 0)
        if not isinstance(fee, int) or fee < 0: return False, "bad fee"
        if t == "meme":
            if fee < MEME_FEE: return False, f"meme fee is {MEME_FEE} {TICKER}"
            if not re.fullmatch(r"[0-9a-f]{64}", tx.get("img_sha256", "")): return False, "bad img hash"
            if tx.get("img_ext") not in ("jpg", "png", "gif", "webp"): return False, "bad img ext"
            if not isinstance(tx.get("img_size"), int) or not 0 < tx["img_size"] <= MAX_IMG: return False, "bad img size"
            if not isinstance(tx.get("caption"), str) or len(tx["caption"]) > MAX_CAPTION: return False, "bad caption"
            if tx["img_sha256"] in owners: return False, "already inscribed"
            amt = 0
        elif t == "transfer":
            if not valid_addr(tx.get("to", "")): return False, "bad to"
            if not isinstance(amt, int) or amt <= 0: return False, "bad amount"
        elif t == "sell":
            if owners.get(tx.get("img_sha256")) != tx["from"]: return False, "not the owner"
            if not isinstance(tx.get("price"), int) or tx["price"] < 0: return False, "bad price"
            amt = 0
        else:  # buy
            price = listings.get(tx.get("img_sha256"))
            if price is None: return False, "not for sale"
            if not isinstance(amt, int) or amt != price: return False, f"price is {price} {TICKER}"
            if owners.get(tx["img_sha256"]) == tx["from"]: return False, "already yours"
        if balances.get(tx["from"], 0) < fee + amt: return False, "insufficient funds"
        return True, "ok"

    def validate_block(self, b, prefix, balances, nonces, owners=None, listings=None):
        """prefix = the chain up to and including the parent block."""
        owners = owners if owners is not None else self.owners; listings = listings if listings is not None else self.listings
        prev = prefix[-1]
        if b["height"] != prev["height"] + 1 or b["prev_hash"] != prev["hash"]: return False, "bad link"
        if b["target"] != target_for(prefix): return False, "bad target"
        if int(block_hash(b), 16) >= int(b["target"], 16) or block_hash(b) != b["hash"]: return False, "bad pow"
        if b["timestamp"] > time.time() + 120 or b["timestamp"] <= prev["timestamp"] - 600: return False, "bad time"
        if not b["txs"] or b["txs"][0]["type"] != "coinbase" or len(b["txs"]) > MAX_TXS: return False, "bad coinbase"
        if merkle_root([t["txid"] for t in b["txs"]]) != b["merkle_root"]: return False, "bad merkle"
        fees = 0; nonces = set(nonces); bal = dict(balances); own = dict(owners); lst = dict(listings)
        for tx in b["txs"][1:]:
            ok, why = self.validate_tx(tx, bal, nonces, own, lst)
            if not ok: return False, why
            self._apply_tx(tx, bal, nonces, own, lst); fees += tx["fee"]
        cb = b["txs"][0]
        if cb["amount"] != block_reward(b["height"]) + fees or cb.get("height") != b["height"]: return False, "bad reward"
        if not valid_addr(cb["to"]): return False, "bad miner"
        return True, "ok"

    def validate_chain(self, chain):
        g = genesis_block()
        if not chain or canon(chain[0]) != canon(g): return False
        balances, nonces, owners, listings = {}, set(), {}, {}; self._apply(chain[0], balances, nonces, owners, listings)
        for i in range(1, len(chain)):
            ok, why = self.validate_block(chain[i], chain[:i], balances, nonces, owners, listings)
            if not ok: log(f"[CHAIN] foreign block {i} invalid: {why}"); return False
            self._apply(chain[i], balances, nonces, owners, listings)
        return True

    # mutation
    def add_tx(self, tx):
        with self.lock:
            bal = dict(self.balances); nonces = set(self.seen_nonces); own = dict(self.owners); lst = dict(self.listings)
            for m in self.mempool.values(): self._apply_tx(m, bal, nonces, own, lst)
            ok, why = self.validate_tx(tx, bal, nonces, own, lst)
            if ok: self.mempool[tx["txid"]] = tx
            return ok, why

    def add_block(self, b):
        with self.lock:
            ok, why = self.validate_block(b, self.chain, self.balances, self.seen_nonces, self.owners, self.listings)
            if not ok: return False, why
            self.chain.append(b); self._apply(b, self.balances, self.seen_nonces, self.owners, self.listings)
            for tx in b["txs"]: self.mempool.pop(tx.get("txid"), None)
            self.persist(); self.new_block_evt.set()
            return True, "ok"

    def candidate(self, miner_addr):
        with self.lock:
            txs = sorted(self.mempool.values(), key=lambda t: -t["fee"])[:MAX_TXS - 1]
            fees = sum(t["fee"] for t in txs); h = self.height + 1
            cb = {"type": "coinbase", "to": miner_addr, "amount": block_reward(h) + fees, "height": h}
            cb["txid"] = sha256(canon(cb))
            txs = [cb] + txs
            return {"height": h, "prev_hash": self.tip["hash"], "timestamp": int(time.time()),
                    "merkle_root": merkle_root([t["txid"] for t in txs]), "target": target_for(self.chain),
                    "nonce": random.randrange(1 << 32), "txs": txs}

CH = Chain()

# --------------------------------------------------------------- wallet ----
if WALLET_FILE.exists():
    NODE_WALLET = Wallet(json.loads(WALLET_FILE.read_text())["private_key"])
else:
    NODE_WALLET = Wallet(); WALLET_FILE.write_text(json.dumps(NODE_WALLET.export(), indent=1))
log(f"[NODE] {NAME} node wallet {NODE_WALLET.address}")

def make_meme_tx(wallet: Wallet, img_bytes: bytes, caption: str, via: str = "") -> dict:
    """Validate image, store it, return a signed meme tx (caller submits)."""
    if len(img_bytes) > MAX_IMG: raise ValueError(f"image too large (max {MAX_IMG//1000} KB)")
    try:
        im = Image.open(io.BytesIO(img_bytes)); im.verify(); fmt = (im.format or "").lower()
    except Exception: raise ValueError("not a valid image")
    ext = {"jpeg": "jpg", "png": "png", "gif": "gif", "webp": "webp"}.get(fmt)
    if not ext: raise ValueError("use jpg/png/gif/webp")
    digest = sha256(img_bytes)
    (MEMES / f"{digest}.{ext}").write_bytes(img_bytes)
    tx = {"type": "meme", "from": wallet.address, "pubkey": wallet.pub, "caption": caption.strip()[:MAX_CAPTION],
          "img_sha256": digest, "img_ext": ext, "img_size": len(img_bytes), "fee": MEME_FEE, "nonce": next_nonce()}
    if via: tx["via"] = via
    return wallet.sign(tx)

_NONCE = [0]
def next_nonce() -> int:
    _NONCE[0] = max(_NONCE[0] + 1, int(time.time() * 1000)); return _NONCE[0]

def make_transfer(wallet: Wallet, to: str, amount: int, fee: int = 0) -> dict:
    return wallet.sign({"type": "transfer", "from": wallet.address, "pubkey": wallet.pub, "to": to,
                        "amount": int(amount), "fee": int(fee), "nonce": next_nonce()})

def make_sell(wallet: Wallet, img_sha256: str, price: int) -> dict:
    """List an inscribed meme you own for `price` MEME (0 = delist)."""
    return wallet.sign({"type": "sell", "from": wallet.address, "pubkey": wallet.pub, "img_sha256": img_sha256,
                        "price": int(price), "fee": 0, "nonce": next_nonce()})

def make_buy(wallet: Wallet, img_sha256: str, amount: int, fee: int = 0) -> dict:
    """Buy a listed meme: pays the listed price to the current owner, ownership moves to the buyer."""
    return wallet.sign({"type": "buy", "from": wallet.address, "pubkey": wallet.pub, "img_sha256": img_sha256,
                        "amount": int(amount), "fee": int(fee), "nonce": next_nonce()})

# ---------------------------------------------------------------- miner ----
HASHRATE = {"hps": 0.0}
def mine_block_sync(b: dict) -> dict:
    """Grind nonces until the header meets the target (no tip checks). Used by tests and tools."""
    target = int(b["target"], 16)
    while int(sha256d(header_bytes(b)), 16) >= target: b["nonce"] = (b["nonce"] + 1) & 0xffffffff
    b["hash"] = block_hash(b); return b

def miner_loop():
    log(f"[MINER] mining to {NODE_WALLET.address}")
    while True:
        b = CH.candidate(NODE_WALLET.address); target = int(b["target"], 16)
        tip_hash = b["prev_hash"]; n = 0; t0 = time.time()
        while True:
            hb = header_bytes(b)
            if int(sha256d(hb), 16) < target:
                b["hash"] = block_hash(b); ok, why = CH.add_block(b)
                if ok:
                    log(f"[MINER] block {b['height']} {b['hash'][:16]} txs={len(b['txs'])} diff={difficulty_of(b['target']):.0f}")
                    gossip(b)
                else: log(f"[MINER] own block rejected: {why}")
                break
            b["nonce"] = (b["nonce"] + 1) & 0xffffffff; n += 1
            if n % 20000 == 0:
                dt = time.time() - t0; HASHRATE["hps"] = n / dt if dt else 0
                if CH.tip["hash"] != tip_hash or len(CH.mempool) != len(b["txs"]) - 1: break   # tip moved or new txs
                b["timestamp"] = int(time.time())

# ------------------------------------------------------------------ p2p -----
PEERS = set(json.loads(PEERS_FILE.read_text())) if PEERS_FILE.exists() else set()
for p in os.environ.get("MC_PEERS", "").split(","):
    if p.strip(): PEERS.add(p.strip().rstrip("/"))
def save_peers(): PEERS_FILE.write_text(json.dumps(sorted(PEERS)))

def gossip(block):
    for p in list(PEERS):
        try: requests.post(f"{p}/api/block", json=block, timeout=5)
        except Exception: pass

def sync_loop():
    while True:
        for p in list(PEERS):
            try:
                st = requests.get(f"{p}/api/status", timeout=5).json()
                if st.get("height", 0) > CH.height:
                    chain = requests.get(f"{p}/api/chain", timeout=60).json()
                    if len(chain) > len(CH.chain) and CH.validate_chain(chain):
                        CH.replace(chain); log(f"[P2P] adopted longer chain from {p}: height {CH.height}")
            except Exception: pass
        time.sleep(30)

# ------------------------------------------------------------ anchoring ----
def ots_stamp(data: bytes):
    try:
        from opentimestamps.core.timestamp import DetachedTimestampFile
        from opentimestamps.calendar import RemoteCalendar
        from opentimestamps.core.op import OpSHA256
        from opentimestamps.core.serialize import BytesSerializationContext
        det = DetachedTimestampFile.from_fd(OpSHA256(), io.BytesIO(data)); ok = []
        for url in ("https://alice.btc.calendar.opentimestamps.org", "https://bob.btc.calendar.opentimestamps.org",
                    "https://finney.calendar.eternitywall.com"):
            try: det.timestamp.merge(RemoteCalendar(url).submit(det.timestamp.msg, timeout=20)); ok.append(url)
            except Exception as e: log(f"[ANCHOR] calendar {url} failed: {str(e)[:60]}")
        if not ok: return None, []
        ctx = BytesSerializationContext(); det.serialize(ctx); return ctx.getbytes(), ok
    except Exception as e:
        log(f"[ANCHOR] stamp failed: {e}"); return None, []

ANCHORS_FILE = DOCS / "anchors.json"
ANCHORS = json.loads(ANCHORS_FILE.read_text()) if ANCHORS_FILE.exists() else []
def anchor_loop():
    while True:
        CH.new_block_evt.wait(); CH.new_block_evt.clear()
        h = CH.height
        if h and h % ANCHOR_EVERY == 0 and not any(a["height"] == h for a in ANCHORS):
            b = CH.chain[h]; data = b["hash"].encode()
            ots, cals = ots_stamp(data)
            if ots:
                fn = f"{h}_{b['hash'][:16]}.ots"; (DOCS / "anchors" / fn).write_bytes(ots)
                ANCHORS.append({"height": h, "hash": b["hash"], "stamped_at": int(time.time()), "file": f"anchors/{fn}", "calendars": cals})
                ANCHORS_FILE.write_text(json.dumps(ANCHORS, indent=1)); log(f"[ANCHOR] block {h} submitted to Bitcoin via OpenTimestamps")
                PUBLISH_EVT.set()

# ------------------------------------------------------------- publisher ---
PUBLISH_EVT = threading.Event()
def export_docs():
    chain = CH.chain
    memes = []; sales = []
    for b in chain:
        for t in b["txs"]:
            if t["type"] == "meme":
                src = MEMES / f"{t['img_sha256']}.{t['img_ext']}"; dst = DOCS / "memes" / src.name
                if src.exists() and not dst.exists(): shutil.copy(src, dst)
                memes.append({"height": b["height"], "block_hash": b["hash"], "time": b["timestamp"], "txid": t["txid"],
                              "from": t["from"], "via": t.get("via", ""), "caption": t["caption"], "img": f"memes/{src.name}",
                              "img_sha256": t["img_sha256"], "img_size": t["img_size"],
                              "owner": CH.owners.get(t["img_sha256"]), "price": CH.listings.get(t["img_sha256"])})
            elif t["type"] == "buy":
                sales.append({"height": b["height"], "time": b["timestamp"], "txid": t["txid"], "img_sha256": t["img_sha256"],
                              "buyer": t["from"], "amount": t["amount"]})
    blocks = [{"height": b["height"], "hash": b["hash"], "prev_hash": b["prev_hash"], "time": b["timestamp"], "nonce": b["nonce"],
               "target": b["target"], "difficulty": round(difficulty_of(b["target"]), 2), "txs": len(b["txs"]),
               "memes": sum(1 for t in b["txs"] if t["type"] == "meme"), "miner": b["txs"][0]["to"], "reward": b["txs"][0]["amount"]}
              for b in chain]
    status = {"name": NAME, "ticker": TICKER, "height": CH.height, "tip": CH.tip["hash"], "supply": CH.supply(), "memes": len(memes),
              "difficulty": round(difficulty_of(CH.tip["target"]), 2), "block_time_target": BLOCK_TIME, "reward": block_reward(CH.height + 1),
              "halving": HALVING, "mempool": len(CH.mempool), "updated": int(time.time()), "genesis": chain[0]["hash"],
              "anchors": len(ANCHORS), "repo": f"https://github.com/{GH_REPO}", "meme_fee": MEME_FEE, "max_img": MAX_IMG,
              "wallets": len([a for a, v in CH.balances.items() if v > 0]), "listed": len(CH.listings), "sales": len(sales)}
    (DOCS / "chain.json").write_text(json.dumps({"status": status, "blocks": blocks[::-1], "memes": memes[::-1], "sales": sales[::-1], "anchors": ANCHORS}))
    (DOCS / "status.json").write_text(json.dumps(status))
    (DOCS / "blocks_full.json").write_text(json.dumps(chain))
    return status

def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=120)

def publish_loop():
    last = 0
    while True:
        CH.new_block_evt.wait(timeout=5); PUBLISH_EVT.clear()
        try: st = export_docs()
        except Exception as e: log(f"[PUBLISH] export failed: {e}"); time.sleep(5); continue
        if not PUBLISH or time.time() - last < 45: time.sleep(5); continue
        try:
            git("add", "-A", "docs")
            r = git("commit", "-q", "-m", f"block {st['height']} {st['tip'][:12]} memes={st['memes']}")
            if r.returncode == 0:
                p = git("push", "-q")
                if p.returncode == 0: log(f"[PUBLISH] pushed height {st['height']} -> {PAGES_URL}")
                else: log(f"[PUBLISH] push failed: {p.stderr.strip()[:200]}")
            last = time.time()
        except Exception as e: log(f"[PUBLISH] git failed: {e}")

# ---------------------------------------------------------- github intake --
IMG_RE = re.compile(r"(https://(?:github\.com/user-attachments/assets/[\w-]+|user-images\.githubusercontent\.com/[^\s)\"'>]+|private-user-images\.githubusercontent\.com/[^\s)\"'>]+|i\.imgur\.com/[^\s)\"'>]+|i\.redd\.it/[^\s)\"'>]+))")
def gh(method, path, **kw):
    hdr = {"Authorization": f"Bearer {GH_TOKEN}", "Accept": "application/vnd.github+json", "User-Agent": NAME}
    return requests.request(method, f"https://api.github.com{path}", headers=hdr, timeout=20, **kw)

def issue_intake_loop():
    if not GH_TOKEN: log("[ISSUES] no GITHUB_TOKEN, intake disabled"); return
    while True:
        try:
            r = gh("GET", f"/repos/{GH_REPO}/issues", params={"state": "open", "per_page": 20})
            for iss in (r.json() if r.ok else []):
                if "pull_request" in iss or any(l["name"] == "onchain" for l in iss.get("labels", [])): continue
                body = iss.get("body") or ""; m = IMG_RE.search(body)
                num = iss["number"]; login = iss["user"]["login"]
                if not m:
                    gh("POST", f"/repos/{GH_REPO}/issues/{num}/comments", json={"body": "No image found. Drag an image (jpg/png/gif/webp, max 250 KB) into the issue body and I will inscribe it."})
                    gh("POST", f"/repos/{GH_REPO}/issues/{num}/labels", json={"labels": ["onchain"]}); gh("PATCH", f"/repos/{GH_REPO}/issues/{num}", json={"state": "closed"}); continue
                try:
                    img = requests.get(m.group(1), timeout=30, headers={"User-Agent": NAME}, stream=True)
                    data = img.raw.read(MAX_IMG + 1)
                    tx = make_meme_tx(NODE_WALLET, data, iss.get("title") or "", via=f"github:{login}")
                    ok, why = CH.add_tx(tx)
                    if not ok: raise ValueError(why)
                    gh("POST", f"/repos/{GH_REPO}/issues/{num}/comments", json={"body":
                        f"Inscribed. txid `{tx['txid']}`, image sha256 `{tx['img_sha256']}`. It lands in the next block (~{BLOCK_TIME}s). "
                        f"Explorer: {PAGES_URL}#tx-{tx['txid']}"})
                    log(f"[ISSUES] inscribed issue #{num} by {login}")
                except Exception as e:
                    gh("POST", f"/repos/{GH_REPO}/issues/{num}/comments", json={"body": f"Could not inscribe: {str(e)[:200]}"})
                gh("POST", f"/repos/{GH_REPO}/issues/{num}/labels", json={"labels": ["onchain"]})
                gh("PATCH", f"/repos/{GH_REPO}/issues/{num}", json={"state": "closed"})
        except Exception as e: log(f"[ISSUES] poll failed: {e}")
        time.sleep(60)

# ------------------------------------------------------------------ http ----
app = Flask(__name__, static_folder=None)
FAUCET_SEEN = {}

@app.after_request
def cors(resp): resp.headers["Access-Control-Allow-Origin"] = "*"; return resp

@app.get("/")
def index(): return send_from_directory(DOCS, "index.html")
@app.get("/<path:p>")
def docs_static(p):
    if (DOCS / p).is_file(): return send_from_directory(DOCS, p)
    abort(404)

@app.get("/api/status")
def api_status():
    return jsonify({"name": NAME, "ticker": TICKER, "height": CH.height, "tip": CH.tip["hash"], "difficulty": difficulty_of(CH.tip["target"]),
                    "target": CH.tip["target"], "supply": CH.supply(), "memes": CH.meme_count(), "mempool": len(CH.mempool),
                    "peers": sorted(PEERS), "hashrate": round(HASHRATE["hps"]), "node_address": NODE_WALLET.address, "anchors": len(ANCHORS)})
@app.get("/api/chain")
def api_chain(): return Response(json.dumps(CH.chain), mimetype="application/json")
@app.get("/api/block/<key>")
def api_block(key):
    if key.isdigit() and int(key) <= CH.height: return jsonify(CH.chain[int(key)])
    for b in CH.chain:
        if b["hash"] == key: return jsonify(b)
    abort(404)
@app.get("/api/mempool")
def api_mempool(): return jsonify(list(CH.mempool.values()))
@app.get("/api/balance/<addr>")
def api_balance(addr): return jsonify({"address": addr, "balance": CH.balances.get(addr, 0)})
@app.get("/api/market")
def api_market():
    """Every inscribed meme with its current owner and (if listed) price."""
    return jsonify([{"img_sha256": h, "owner": o, "price": CH.listings.get(h)} for h, o in CH.owners.items()])
@app.get("/api/wallet/new")
def api_wallet_new(): return jsonify(Wallet().export())
@app.post("/api/tx")
def api_tx():
    ok, why = CH.add_tx(request.get_json(force=True) or {}); return jsonify({"ok": ok, "msg": why}), (200 if ok else 400)
@app.post("/api/block")
def api_block_post():
    b = request.get_json(force=True) or {}
    if b.get("height", 0) > CH.height + 1: threading.Thread(target=sync_loop_once, daemon=True).start(); return jsonify({"ok": False, "msg": "syncing"})
    ok, why = CH.add_block(b)
    if ok: log(f"[P2P] accepted block {b['height']} from peer"); gossip(b)
    return jsonify({"ok": ok, "msg": why})
def sync_loop_once():
    for p in list(PEERS):
        try:
            chain = requests.get(f"{p}/api/chain", timeout=60).json()
            if len(chain) > len(CH.chain) and CH.validate_chain(chain): CH.replace(chain); return
        except Exception: pass
@app.post("/api/peers")
def api_peers():
    for p in (request.get_json(force=True) or {}).get("peers", []):
        if isinstance(p, str) and p.startswith("http"): PEERS.add(p.rstrip("/"))
    save_peers(); return jsonify(sorted(PEERS))
@app.post("/api/faucet")
def api_faucet():
    addr = (request.get_json(force=True) or {}).get("address", "")
    if not valid_addr(addr): return jsonify({"ok": False, "msg": "bad address"}), 400
    ip = request.headers.get("X-Forwarded-For", request.remote_addr)
    if FAUCET_SEEN.get(addr, 0) > time.time() - 3600 or FAUCET_SEEN.get(ip, 0) > time.time() - 600:
        return jsonify({"ok": False, "msg": "faucet cooldown"}), 429
    tx = make_transfer(NODE_WALLET, addr, FAUCET_AMT); ok, why = CH.add_tx(tx)
    if ok: FAUCET_SEEN[addr] = FAUCET_SEEN[ip] = time.time()
    return jsonify({"ok": ok, "msg": why, "txid": tx["txid"], "amount": FAUCET_AMT}), (200 if ok else 400)
@app.post("/api/meme")
def api_meme():
    """multipart: image=<file>, caption=<str>, private_key=<hex> (omit to post via the node wallet, local only)."""
    f = request.files.get("image")
    if not f: return jsonify({"ok": False, "msg": "image missing"}), 400
    sk = request.form.get("private_key", "").strip()
    if sk: w = Wallet(sk)
    elif request.remote_addr in ("127.0.0.1", "::1"): w = NODE_WALLET
    else: return jsonify({"ok": False, "msg": "private_key required"}), 400
    try: tx = make_meme_tx(w, f.read(MAX_IMG + 1), request.form.get("caption", ""))
    except ValueError as e: return jsonify({"ok": False, "msg": str(e)}), 400
    ok, why = CH.add_tx(tx)
    return jsonify({"ok": ok, "msg": why, "txid": tx["txid"], "img_sha256": tx["img_sha256"]}), (200 if ok else 400)
@app.get("/meme/<digest>")
def meme_img(digest):
    for p in MEMES.glob(f"{digest}.*"): return send_from_directory(MEMES, p.name)
    abort(404)

# ------------------------------------------------------------------ main ----
if __name__ == "__main__":
    export_docs()
    for fn in (sync_loop, anchor_loop, publish_loop, issue_intake_loop):
        threading.Thread(target=fn, daemon=True).start()
    if MINE: threading.Thread(target=miner_loop, daemon=True).start()
    log(f"[NODE] {NAME} testnet node on http://localhost:{PORT}  height={CH.height} peers={len(PEERS)} publish={PUBLISH}")
    from werkzeug.serving import make_server
    make_server("0.0.0.0", PORT, app, threaded=True).serve_forever()
