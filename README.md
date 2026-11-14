# memechain testnet data

This branch is written by the testnet bot (`.github/workflows/testnet.yml` on `main`) and force-pushed as a single commit
after every run. The site at https://larajeftic.github.io/memechain/ reads `chain.json` from here.

- `blocks_full.json`: the full chain, re-validated by `node.py` on every run
- `chain.json`, `status.json`: explorer export
- `memes/`: inscribed images, named by their SHA-256
- `anchors/`: OpenTimestamps proofs of every 10th block hash
