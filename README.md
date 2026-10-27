# memechain

A proof-of-work blockchain for memes, with a test market. Experimental MVP in two parts that share one set of rules:

| Part | What it is | Where it runs |
|---|---|---|
| `node.py` | Independent testnet chain: double-SHA-256 proof of work with Bitcoin-style retargeting, secp256k1 wallets, meme inscriptions (image committed by SHA-256), a sell/buy market, HTTP peer sync, faucet, GitHub-issue intake, OpenTimestamps anchoring into Bitcoin | On a node operator's machine. Nothing runs it 24/7. |
| `docs/` | The website: a browser-local chain with the same rules (`chain.js` is a port of `node.py`) and an explorer for the last testnet export | GitHub Pages (static files). It cannot run a node. |

**Site:** https://larajeftic.github.io/memechain/

MEME is a test token. It has no value, is not sold and cannot be bought with money. There is no payment code in this repository.

## The walkthrough (browser)

Seven one-click steps. Every click signs real transactions with [noble-secp256k1](https://github.com/paulmillr/noble-secp256k1) and mines a real block in your browser ([`docs/chain.js`](docs/chain.js)):

1. **Create wallets**: three key pairs. *Hot* signs and spends, *cold* only receives, *test buyer* is your counterparty.
2. **Mine 5 blocks**: 50 MEME coinbase each, to the hot wallet.
3. **Inscribe a meme**: pick Pepe, Apu, Doge, Chad, GigaChad, Wojak or your own image (jpg/png/gif/webp, max 250 KB). The transaction commits the image's SHA-256, size and caption and pays a 1 MEME fee. Each image can be inscribed once per chain.
4. **Put it up for sale**: a signed `sell` transaction with your price.
5. **Test buyer buys it**: the buyer mines a block if it cannot afford the price, signs a `buy` transaction, the price moves to you and ownership moves to the buyer.
6. **Move 75% to the cold vault**: a transfer from hot to cold. *Top up hot* moves 50 back. This is the hot/cold treasury pattern (small float online, the rest in a key that never signs) run with test tokens.
7. **Verify**: replays the chain from genesis (links, targets, proof of work, timestamps, merkle roots, rewards, signatures, image hashes, ownership, listings, balances). Export the chain and confirm it with the node's own code:

```
python tools/validate_export.py memechain-browser-chain.json
```

The market section lists every meme on your chain with owner and price; sell, delist, buy and buy back from there. The chain is stored in `localStorage` of your browser only. Nobody else sees it, and *Reset* erases it. The browser chain differs from the testnet only in two parameters so that blocks take about a second on a phone: `MC_INITIAL_BITS=16` (testnet 20) and `MC_BLOCK_TIME=1` (testnet 60).

## Transactions

| Type | Fields | Rule |
|---|---|---|
| `coinbase` | `to`, `amount`, `height` | first tx of a block; amount = reward + fees |
| `transfer` | `to`, `amount`, `fee` | sender balance ≥ amount + fee |
| `meme` | `img_sha256`, `img_ext`, `img_size`, `caption`, `fee` ≥ 1 | image hash not yet inscribed; sender becomes owner |
| `sell` | `img_sha256`, `price` (0 = delist) | sender must own the meme |
| `buy` | `img_sha256`, `amount` = listed price, `fee` | meme must be listed; price goes to the owner, ownership to the buyer |

All transactions carry `from`, `pubkey`, `nonce`, `sig` (secp256k1 ECDSA, RFC 6979, over canonical JSON) and `txid` (SHA-256 of the signed tx). State = balances, seen nonces, owners (`img_sha256 → address`), listings (`img_sha256 → price`).

## Run the testnet node

```
git clone https://github.com/larajeftic/memechain
cd memechain
pip install flask requests ecdsa pillow opentimestamps-client
set MC_PUBLISH=0                    # 1 = commit+push docs/ exports to GitHub Pages after each block
set MC_PEERS=http://<a-peer>:5050   # optional
python node.py
```

Local explorer and API at http://localhost:5050 (serves `docs/`). The node mines to its own wallet in `data/wallet.json` (keep it private; `data/` is git-ignored). With a `GITHUB_TOKEN` in `.env` the node also watches the repo's issues: an issue with an image attached gets inscribed and answered with the txid.

Environment: `MC_PORT`, `MC_PEERS`, `MC_MINE`, `MC_PUBLISH`, `MC_INITIAL_BITS`, `MC_BLOCK_TIME`, `MC_DATA` (state dir), `MC_DOCS` (export dir), `MC_ANCHOR_EVERY`, `MC_GH_REPO`.

Consensus: double SHA-256 over `height|prev|time|merkle|target|nonce`; 60 s target block time, retarget every 10 blocks clamped 0.25x–4x; 50 MEME reward halving every 100,000 blocks, fees to the miner; longest valid chain; every 10th block hash anchored via OpenTimestamps (`docs/anchors/`).

API: `GET /api/status`, `/api/chain`, `/api/block/<height|hash>`, `/api/mempool`, `/api/balance/<addr>`, `/api/market`, `/api/wallet/new`; `POST /api/faucet {"address"}` (10 MEME, once per address per hour), `POST /api/meme` (multipart `image`, `caption`, `private_key`), `POST /api/tx` (any signed tx, e.g. from `make_sell` / `make_buy`), `POST /api/block`, `POST /api/peers`; `GET /meme/<sha256>`.

## Testnet snapshot on the site

The "Testnet snapshot" section shows `docs/chain.json`, which a node writes after each block. It only changes when a node operator runs `node.py` and pushes. The current snapshot is from a local run on 2026-10-27: 52 blocks, 4 memes, 2 sales, 4 OpenTimestamps anchors. An `.ots` proof is complete once the calendar servers have committed it to a Bitcoin block; verify it against the block hash (ASCII text) at https://opentimestamps.org.

## Development

```
python tools/serve.py 8080          # serve docs/ locally with correct MIME types (Windows' http.server sends .js as text/plain)
npm test                            # JS chain export -> Python validator -> unittest (consensus, market, wallet, HTTP API)
python tests/e2e_browser.py         # Playwright walkthrough in the installed Chrome against http://127.0.0.1:8080/
python tools/check_public.py        # no credential files or token-like strings in docs/ or the git index
python tools/git_push.py --check    # which account the local token belongs to and whether it can push here
```

No build step: `docs/` is deployed as-is by GitHub Pages (branch `main`, folder `/docs`). `docs/vendor/noble.js` is an esbuild bundle of `@noble/secp256k1` 2.3.0 and `@noble/hashes` 1.8.0 (MIT, see `docs/vendor/LICENSES.md`). Credentials (`Githubtoken.txt`, `.env`, `data/`) are git-ignored and never copied into `docs/`; `tools/check_public.py` fails if they show up anywhere public.

## Honest notes

- The browser demo is a demonstration, not a network. Every visitor builds their own chain; the buyer is a second key in the same browser.
- The testnet is a small CPU-mined chain. It only advances while someone runs a node, and a small proof-of-work chain is cheap to rewrite. Bitcoin anchors make rewriting detectable, not impossible.
- The site reports what the code computed. There are no user counts, volumes, partners or endorsements.
- Images are stored by nodes and in the explorer; the chain commits only their hash. Browser images stay in your browser.
- Meme characters are used as small non-commercial demo images; see [`docs/img/ATTRIBUTION.md`](docs/img/ATTRIBUTION.md). Removed on request.

## Monetization

Ideas for later, deliberately outside this demo, never a token sale and never a promise of returns:

- **Real-money sales with a hot/cold treasury**: the on-chain `sell`/`buy` flow exists; a real version would price in a real currency, settle through a payment provider, and keep only a small float in an online (hot) wallet while the rest sits in an offline (cold) key, paying out gradually. The demo rehearses exactly this split with test tokens.
- **Pinning and hosting** of meme images for node operators (the chain stores hashes, someone has to keep the bytes).
- **Sponsored slot** on the explorer, clearly labelled.
- **Merchandise**: prints with block hash and timestamp.
- **Private chains**: setup and support for teams that want their own chain with these rules.

## License and credits

MIT (`LICENSE`). Chain pattern after [Learn Blockchains by Building One](https://github.com/dvf/blockchain) (MIT) and Bitcoin's header and retargeting rules. Cryptography by noble-secp256k1 and noble-hashes (MIT). Image credits in [`docs/img/ATTRIBUTION.md`](docs/img/ATTRIBUTION.md).
