"""Advance the public testnet by a few blocks. Run by .github/workflows/testnet.yml every 20 minutes.

    python tools/testnet_bot.py <net_dir>

<net_dir> is a checkout of the `testnet` branch: blocks_full.json, chain.json, status.json, memes/, anchors/.
The bot loads that chain with node.py's own code (full re-validation), mines for a time budget with the
testnet wallet from the MC_BOT_KEY secret, inscribes the next unused image from testnet/pool/ when the chain
has gone 12 blocks without a meme, stamps every 10th block into Bitcoin via OpenTimestamps, and exports
the result back into <net_dir>. The workflow then force-pushes <net_dir> as a single commit.

Environment: MC_BOT_KEY (hex private key of the testnet node wallet; without it the run mines to a fresh key), MC_BOT_SECONDS (default 300), MC_BOT_BLOCKS (default 8).
"""
import json, os, shutil, sys, tempfile, time
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NET = Path(sys.argv[1] if len(sys.argv) > 1 else "net").resolve(); NET.mkdir(parents=True, exist_ok=True)
POOL = ROOT / "testnet" / "pool"
SECONDS = int(os.environ.get("MC_BOT_SECONDS", "300"))
MAX_BLOCKS = int(os.environ.get("MC_BOT_BLOCKS", "8"))
MEME_GAP = 12                                            # blocks without a meme before the bot inscribes one

data = Path(tempfile.mkdtemp(prefix="memechain_bot_"))
key = os.environ.get("MC_BOT_KEY", "").strip()
if key: (data / "wallet.json").write_text(json.dumps({"private_key": key}))
if (NET / "blocks_full.json").exists(): shutil.copy(NET / "blocks_full.json", data / "chain.json")
os.environ.update({"MC_DATA": str(data), "MC_DOCS": str(NET), "MC_PUBLISH": "0", "MC_MINE": "0", "GITHUB_TOKEN": ""})
sys.path.insert(0, str(ROOT))
import node as N                                         # noqa: E402  (loads and re-validates the chain on import)

start = time.time(); N.log(f"[BOT] height {N.CH.height}, mining to {N.NODE_WALLET.address}, budget {SECONDS}s / {MAX_BLOCKS} blocks")

def maybe_inscribe():
    recent = [t for b in N.CH.chain[-MEME_GAP:] for t in b["txs"] if t["type"] == "meme"]
    if recent or N.CH.balances.get(N.NODE_WALLET.address, 0) < N.MEME_FEE: return
    captions = json.loads((POOL / "captions.json").read_text(encoding="utf-8")) if (POOL / "captions.json").exists() else {}
    for f in sorted(POOL.iterdir()):
        if f.suffix.lower() not in (".jpg", ".png", ".gif", ".webp"): continue
        if N.sha256(f.read_bytes()) in N.CH.owners: continue
        tx = N.make_meme_tx(N.NODE_WALLET, f.read_bytes(), captions.get(f.name, ""), via="testnet-bot")
        ok, why = N.CH.add_tx(tx)
        N.log(f"[BOT] inscribe {f.name}: {why}"); return

def mine_one():
    """Same header and hash as node.header_bytes/block_hash, with the constant prefix hashed outside the loop."""
    b = N.CH.candidate(N.NODE_WALLET.address); target = bytes.fromhex(b["target"])
    while time.time() - start < SECONDS:
        b["timestamp"] = int(time.time())
        prefix = f"{b['height']}|{b['prev_hash']}|{b['timestamp']}|{b['merkle_root']}|{b['target']}|".encode()
        n0 = b["nonce"]
        for n in range(n0, min(n0 + 400000, 1 << 32)):
            if sha256(sha256(prefix + str(n).encode()).digest()).digest() < target:
                b["nonce"] = n; b["hash"] = N.block_hash(b); ok, why = N.CH.add_block(b)
                N.log(f"[BOT] block {b['height']} {b['hash'][:16]} txs={len(b['txs'])} diff={N.difficulty_of(b['target']):.0f} {why}")
                return ok
        b["nonce"] = (n + 1) & 0xffffffff
    return False

def anchor():
    h = N.CH.height
    if h % N.ANCHOR_EVERY or any(a["height"] == h for a in N.ANCHORS): return
    blk = N.CH.chain[h]; ots, cals = N.ots_stamp(blk["hash"].encode())
    if not ots: return
    fn = f"{h}_{blk['hash'][:16]}.ots"; (NET / "anchors" / fn).write_bytes(ots)
    N.ANCHORS.append({"height": h, "hash": blk["hash"], "stamped_at": int(time.time()), "file": f"anchors/{fn}", "calendars": cals})
    N.ANCHORS_FILE.write_text(json.dumps(N.ANCHORS, indent=1)); N.log(f"[BOT] block {h} stamped via OpenTimestamps")

mined = 0
while mined < MAX_BLOCKS and time.time() - start < SECONDS:
    maybe_inscribe()
    if not mine_one(): break
    mined += 1; anchor()

bot_file = NET / "bot.json"                              # addresses the bot mined to, so the site can label them
bots = json.loads(bot_file.read_text()).get("addresses", []) if bot_file.exists() else []
if mined and N.NODE_WALLET.address not in bots: bots = (bots + [N.NODE_WALLET.address])[-500:]
bot_file.write_text(json.dumps({"addresses": bots}))
st = N.export_docs()
N.log(f"[BOT] done: +{mined} blocks, height {st['height']}, memes {st['memes']}, {time.time() - start:.0f}s")
