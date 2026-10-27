// Builds a small chain with the browser implementation (docs/chain.js) and prints it as JSON.
// node tests/js_chain_export.mjs > chain.json ; python tools/validate_export.py chain.json
// Exercises: genesis, coinbase reward, meme tx, transfer, sell + buy (marketplace), fees, 11 blocks (one retarget), unicode caption.
import { Chain, createWallet, makeMemeTx, makeTransfer, makeSell, makeBuy, mineStep, sha256hex, utf8, verifySig, PARAMS } from '../docs/chain.js';

const alice = createWallet(), bob = createWallet();
const ch = new Chain();
let t = PARAMS.genesisTs + 60;
const mine = (miner) => { const b = ch.candidate(miner, t); t += 1; while (!mineStep(b, 1e6)); const [ok, why] = ch.addBlock(b); if (!ok) throw new Error(`block ${b.height}: ${why}`); return b; };
const must = ([ok, why], what) => { if (!ok) throw new Error(what + ': ' + why); };
const mustNot = ([ok, why], expect, what) => { if (ok || why !== expect) throw new Error(`${what}: expected "${expect}", got ${ok} "${why}"`); };

mine(alice.address);                                                     // block 1: alice 50
const img = utf8('not really an image, but the chain only commits the hash');
const sha = sha256hex(img);
const meme = makeMemeTx(alice, { img_sha256: sha, img_ext: 'png', img_size: img.length, caption: 'gm ☕ – ünïcödé caption 🐸' }, 1);
must(ch.addTx(meme), 'meme tx');
mustNot(ch.addTx(makeMemeTx(bob, { img_sha256: sha, img_ext: 'png', img_size: img.length, caption: 'copy' }, 1)), 'already inscribed', 'duplicate meme');
must(ch.addTx(makeTransfer(alice, bob.address, 7, 0, 2)), 'transfer');
mine(alice.address);                                                     // block 2: alice +51, -1 fee, -7
mustNot(ch.addTx(makeSell(bob, sha, 5, 3)), 'not the owner', 'sell by non-owner');
mustNot(ch.addTx(makeBuy(bob, sha, 5, 0, 4)), 'not for sale', 'buy unlisted');
must(ch.addTx(makeSell(alice, sha, 5, 3)), 'sell');
mine(bob.address);                                                       // block 3: bob +50
mustNot(ch.addTx(makeBuy(bob, sha, 4, 0, 5)), 'price is 5 MEME', 'wrong price');
mustNot(ch.addTx(makeBuy(alice, sha, 5, 0, 6)), 'already yours', 'self buy');
must(ch.addTx(makeBuy(bob, sha, 5, 1, 7)), 'buy');
mine(alice.address);                                                     // block 4: alice +51 (fee 1) +5 sale
if (ch.owners[sha] !== bob.address) throw new Error('ownership did not move');
if (ch.listings[sha] !== undefined) throw new Error('listing not cleared');
for (let i = 5; i <= 11; i++) mine(i % 2 ? alice.address : bob.address); // through one retarget at height 10
if (!verifySig(meme)) throw new Error('self verify failed');
const expectAlice = 50 + 51 - 1 - 7 + 51 + 5 + 50 * 4;   // blocks 1,2,4,5,7,9,11
const expectBob = 7 + 50 - 5 - 1 + 50 * 3;              // blocks 3,6,8,10
if (ch.balance(alice.address) !== expectAlice) throw new Error('alice balance ' + ch.balance(alice.address) + ' != ' + expectAlice);
if (ch.balance(bob.address) !== expectBob) throw new Error('bob balance ' + ch.balance(bob.address) + ' != ' + expectBob);
const v = Chain.validateChain(ch.chain); if (!v.ok) throw new Error('js validate: ' + v.why);
process.stdout.write(JSON.stringify(ch.chain));
