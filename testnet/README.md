# Testnet pool

Images in `pool/` are inscribed on the public testnet by the testnet bot (`tools/testnet_bot.py`), one at a time,
whenever the chain has gone 12 blocks without a new meme. Captions come from `pool/captions.json`.

Want your meme on the testnet? Open a pull request that adds an image (jpg, png, gif or webp, max 250 KB) to `pool/`
and a caption to `captions.json`. Only add images you made or that are free to share.

Sources: `apu.jpg`, `chad.jpg`, `gigachad.jpg` see `docs/img/ATTRIBUTION.md`; `doge.png` and `pepe-thumbs.png` are cut-outs
from the Memegle artwork; `bugs_bunny_no.jpg`, `miyazaki_tired.jpg` and `weird_knowledge_increased.jpg` are example memes
from [meme-search](https://github.com/meme-search/meme-search) (Apache-2.0 repository).
