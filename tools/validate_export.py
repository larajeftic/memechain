"""Validate a chain JSON (e.g. exported from the browser demo) with the node's consensus code.

    python tools/validate_export.py chain.json                        # browser demo chain (16-bit genesis, 1 s block time)
    python tools/validate_export.py chain.json --bits 20 --block-time 60   # testnet chain

Runs node.py's Chain.validate_chain against a throw-away data dir, prints height, tip, owners and balances.
Exit code 0 = valid, 1 = invalid.
"""
import os, sys, json, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
args = [a for i, a in enumerate(sys.argv[1:], 1) if not a.startswith("--") and not sys.argv[i - 1].startswith("--")]
opt = lambda name, default: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default
bits, block_time = opt("--bits", "16"), opt("--block-time", "1")
if not args:
    print(__doc__); sys.exit(2)
tmp = tempfile.mkdtemp(prefix="memechain_validate_")
os.environ.update({"MC_INITIAL_BITS": bits, "MC_BLOCK_TIME": block_time, "MC_DATA": tmp, "MC_DOCS": os.path.join(tmp, "docs"),
                   "MC_PUBLISH": "0", "MC_MINE": "0", "GITHUB_TOKEN": ""})
sys.path.insert(0, str(ROOT))
import node as t  # noqa: E402

raw = json.loads(Path(args[0]).read_text(encoding="utf-8"))
chain = raw["blocks"] if isinstance(raw, dict) and "blocks" in raw else raw
ok = t.Chain.validate_chain(t.CH, chain)
if not ok:
    print("INVALID chain (see log line above for the first failing block)"); sys.exit(1)
balances, nonces, owners, listings = {}, set(), {}, {}
for b in chain: t.Chain._apply(t.CH, b, balances, nonces, owners, listings)
txs = [x for b in chain for x in b["txs"]]
print(f"VALID  height={len(chain) - 1}  tip={chain[-1]['hash']}  genesis_bits={bits}  block_time={block_time}s")
print(f"memes={len(owners)}  listed={len(listings)}  sales={sum(1 for x in txs if x['type'] == 'buy')}  transfers={sum(1 for x in txs if x['type'] == 'transfer')}  supply={sum(v for v in balances.values() if v > 0)} {t.TICKER}")
for a, v in sorted(balances.items(), key=lambda kv: -kv[1]):
    print(f"  {a}  {v} {t.TICKER}")
for h, o in owners.items():
    print(f"  meme {h[:16]}... owner {o}" + (f"  listed {listings[h]} {t.TICKER}" if h in listings else ""))
