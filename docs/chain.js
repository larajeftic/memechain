// memechain consensus rules, JavaScript port of node.py (same hashes, same
// transaction format, same validation). Runs in the browser and in Node 18+.
// A chain built here can be re-validated by node.py: python tools/validate_export.py chain.json
import { sha256, hmac, secp } from './vendor/noble.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

export const PARAMS = {
  name: 'memechain', ticker: 'MEME',
  blockTime: 1,        // node.py testnet default is 60 s; the browser demo runs MC_BLOCK_TIME=1 so difficulty settles near one block per second
  reward: 50, halving: 100000, retarget: 10,
  initialBits: 16,     // node.py default is 20; the browser demo uses MC_INITIAL_BITS=16 so blocks mine in about a second
  minBits: 16, memeFee: 1, maxImg: 250000, maxCaption: 140, maxTxs: 200,
  genesisTs: 1761350400,
  genesisMsg: 'memechain genesis - the first block is a meme about blocks. 2026-10-25',
};
const MAX_TARGET = 1n << BigInt(256 - PARAMS.minBits);

// ---------------------------------------------------------------- bytes ----
const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(s);
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
export const sha256hex = (b) => hex(sha256(b));
export const sha256d = (b) => hex(sha256(sha256(b)));

// Python json.dumps(obj, sort_keys=True, separators=(",", ":")) with ensure_ascii.
export function canon(obj) {
  const sort = (v) => Array.isArray(v) ? v.map(sort)
    : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return utf8(JSON.stringify(sort(obj)).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
}
const body = (tx) => Object.fromEntries(Object.entries(tx).filter(([k]) => k !== 'sig' && k !== 'txid'));

// --------------------------------------------------------------- wallet ----
export function addrFromPub(pubHex) {
  const h = sha256(fromHex(pubHex));
  return 'meme1' + hex(h).slice(0, 36) + sha256hex(h).slice(0, 4);
}
export const validAddr = (a) => typeof a === 'string' && /^meme1[0-9a-f]{36}[0-9a-f]{4}$/.test(a);

export function walletFromPriv(privHex) {
  const pub = hex(secp.getPublicKey(fromHex(privHex), true));
  return { private_key: privHex, public_key: pub, address: addrFromPub(pub) };
}
export const createWallet = () => walletFromPriv(hex(secp.utils.randomPrivateKey()));

export function signTx(wallet, tx) {
  const msg = sha256(canon(body(tx)));
  tx.sig = secp.sign(msg, fromHex(wallet.private_key), { lowS: true }).toCompactHex();
  tx.txid = sha256hex(canon(tx));
  return tx;
}
export function verifySig(tx) {
  try {
    const msg = sha256(canon(body(tx)));
    return secp.verify(fromHex(tx.sig), msg, fromHex(tx.pubkey), { lowS: false }) && addrFromPub(tx.pubkey) === tx.from;
  } catch { return false; }
}
let NONCE = 0;
const nextNonce = () => { NONCE = Math.max(NONCE + 1, Date.now()); return NONCE; };
export const makeTransfer = (wallet, to, amount, fee = 0, nonce = nextNonce()) =>
  signTx(wallet, { type: 'transfer', from: wallet.address, pubkey: wallet.public_key, to, amount: Number(amount), fee: Number(fee), nonce });
export const makeMemeTx = (wallet, { img_sha256, img_ext, img_size, caption = '', via = '' }, nonce = nextNonce()) => {
  const tx = { type: 'meme', from: wallet.address, pubkey: wallet.public_key, caption: caption.trim().slice(0, PARAMS.maxCaption),
    img_sha256, img_ext, img_size, fee: PARAMS.memeFee, nonce };
  if (via) tx.via = via;
  return signTx(wallet, tx);
};
// Marketplace: the owner of an inscribed meme lists it (price 0 = delist); a buyer pays the listed price to the owner.
export const makeSell = (wallet, img_sha256, price, nonce = nextNonce()) =>
  signTx(wallet, { type: 'sell', from: wallet.address, pubkey: wallet.public_key, img_sha256, price: Number(price), fee: 0, nonce });
export const makeBuy = (wallet, img_sha256, amount, fee = 0, nonce = nextNonce()) =>
  signTx(wallet, { type: 'buy', from: wallet.address, pubkey: wallet.public_key, img_sha256, amount: Number(amount), fee: Number(fee), nonce });

// --------------------------------------------------------------- blocks ----
export function merkleRoot(txids) {
  if (!txids.length) return sha256hex(new Uint8Array());
  let layer = txids.slice();
  while (layer.length > 1) {
    if (layer.length % 2) layer.push(layer[layer.length - 1]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256hex(utf8(layer[i] + layer[i + 1])));
    layer = next;
  }
  return layer[0];
}
export const headerString = (b) => `${b.height}|${b.prev_hash}|${b.timestamp}|${b.merkle_root}|${b.target}|${b.nonce}`;
export const blockHash = (b) => sha256d(utf8(headerString(b)));
export const blockReward = (height) => PARAMS.reward >> Math.floor(height / PARAMS.halving);
const hex64 = (n) => n.toString(16).padStart(64, '0');

export function targetFor(chain) {
  const h = chain.length;
  if (h === 0) return hex64(1n << BigInt(256 - PARAMS.initialBits));
  const prevT = BigInt('0x' + chain[h - 1].target);
  if (h % PARAMS.retarget !== 0) return chain[h - 1].target;
  const first = chain[h - PARAMS.retarget];
  const actual = Math.max(1, chain[h - 1].timestamp - first.timestamp);
  const expected = PARAMS.blockTime * (PARAMS.retarget - 1);
  const ratio = Math.min(4.0, Math.max(0.25, actual / expected));
  let t = BigInt(Math.trunc(Number(prevT) * ratio));       // same float64 arithmetic as Python's int(prev_t * ratio)
  if (t > MAX_TARGET) t = MAX_TARGET;
  if (t < 1n) t = 1n;
  return hex64(t);
}
export const difficultyOf = (targetHex) => Number(MAX_TARGET) / Number(BigInt('0x' + targetHex));
export const meetsTarget = (hashHex, targetHex) => BigInt('0x' + hashHex) < BigInt('0x' + targetHex);

let GENESIS = null;
export function genesisBlock() {
  if (GENESIS) return structuredClone(GENESIS);
  const cb = { type: 'coinbase', to: 'meme1' + '0'.repeat(40), amount: 0, height: 0, msg: PARAMS.genesisMsg };
  cb.txid = sha256hex(canon(cb));
  const b = { height: 0, prev_hash: '0'.repeat(64), timestamp: PARAMS.genesisTs, merkle_root: merkleRoot([cb.txid]),
    target: hex64(1n << BigInt(256 - PARAMS.initialBits)), nonce: 0, txs: [cb] };
  while (!meetsTarget(blockHash(b), b.target)) b.nonce++;
  b.hash = blockHash(b);
  GENESIS = b;
  return structuredClone(b);
}

// Run up to `iterations` hashes on a candidate. Returns true when a valid nonce was found (b.hash is set).
export function mineStep(b, iterations) {
  const target = BigInt('0x' + b.target);
  for (let i = 0; i < iterations; i++) {
    const h = blockHash(b);
    if (BigInt('0x' + h) < target) { b.hash = h; return true; }
    b.nonce = (b.nonce + 1) >>> 0;
  }
  return false;
}

// ----------------------------------------------------------------- state ---
// balances: address -> MEME; nonces: "from:nonce" seen; owners: img_sha256 -> address; listings: img_sha256 -> price
export const newState = () => ({ balances: {}, nonces: new Set(), owners: {}, listings: {} });
const cloneState = (s) => ({ balances: { ...s.balances }, nonces: new Set(s.nonces), owners: { ...s.owners }, listings: { ...s.listings } });

export function applyTx(tx, st) {
  if (tx.type === 'coinbase') { st.balances[tx.to] = (st.balances[tx.to] || 0) + tx.amount; return; }
  const fee = tx.fee || 0, amt = tx.amount || 0;
  st.balances[tx.from] = (st.balances[tx.from] || 0) - fee - amt;
  st.nonces.add(tx.from + ':' + tx.nonce);
  if (tx.type === 'transfer') st.balances[tx.to] = (st.balances[tx.to] || 0) + amt;
  else if (tx.type === 'meme') st.owners[tx.img_sha256] = tx.from;
  else if (tx.type === 'sell') { if (tx.price > 0) st.listings[tx.img_sha256] = tx.price; else delete st.listings[tx.img_sha256]; }
  else if (tx.type === 'buy') {
    const seller = st.owners[tx.img_sha256];
    st.balances[seller] = (st.balances[seller] || 0) + amt;
    st.owners[tx.img_sha256] = tx.from; delete st.listings[tx.img_sha256];
  }
}

export function validateTx(tx, st) {
  const t = tx.type;
  if (!['meme', 'transfer', 'sell', 'buy'].includes(t)) return [false, 'bad type'];
  for (const k of ['from', 'pubkey', 'nonce', 'fee', 'sig', 'txid']) if (!(k in tx)) return [false, 'missing ' + k];
  if (sha256hex(canon(Object.fromEntries(Object.entries(tx).filter(([k]) => k !== 'txid')))) !== tx.txid) return [false, 'bad txid'];
  if (!verifySig(tx)) return [false, 'bad signature'];
  if (!validAddr(tx.from)) return [false, 'bad from'];
  if (st.nonces.has(tx.from + ':' + tx.nonce)) return [false, 'replay'];
  const fee = tx.fee; let amt = tx.amount || 0;
  if (!Number.isInteger(fee) || fee < 0) return [false, 'bad fee'];
  if (t === 'meme') {
    if (fee < PARAMS.memeFee) return [false, `meme fee is ${PARAMS.memeFee} ${PARAMS.ticker}`];
    if (!/^[0-9a-f]{64}$/.test(tx.img_sha256 || '')) return [false, 'bad img hash'];
    if (!['jpg', 'png', 'gif', 'webp'].includes(tx.img_ext)) return [false, 'bad img ext'];
    if (!Number.isInteger(tx.img_size) || !(tx.img_size > 0 && tx.img_size <= PARAMS.maxImg)) return [false, 'bad img size'];
    if (typeof tx.caption !== 'string' || tx.caption.length > PARAMS.maxCaption) return [false, 'bad caption'];
    if (tx.img_sha256 in st.owners) return [false, 'already inscribed'];
    amt = 0;
  } else if (t === 'transfer') {
    if (!validAddr(tx.to || '')) return [false, 'bad to'];
    if (!Number.isInteger(amt) || amt <= 0) return [false, 'bad amount'];
  } else if (t === 'sell') {
    if (st.owners[tx.img_sha256] !== tx.from) return [false, 'not the owner'];
    if (!Number.isInteger(tx.price) || tx.price < 0) return [false, 'bad price'];
    amt = 0;
  } else if (t === 'buy') {
    const price = st.listings[tx.img_sha256];
    if (price === undefined) return [false, 'not for sale'];
    if (!Number.isInteger(amt) || amt !== price) return [false, `price is ${price} ${PARAMS.ticker}`];
    if (st.owners[tx.img_sha256] === tx.from) return [false, 'already yours'];
  }
  if ((st.balances[tx.from] || 0) < fee + amt) return [false, 'insufficient funds'];
  return [true, 'ok'];
}

export function validateBlock(b, prefix, st, now = Date.now() / 1000) {
  const prev = prefix[prefix.length - 1];
  if (b.height !== prev.height + 1 || b.prev_hash !== prev.hash) return [false, 'bad link'];
  if (b.target !== targetFor(prefix)) return [false, 'bad target'];
  const h = blockHash(b);
  if (!meetsTarget(h, b.target) || h !== b.hash) return [false, 'bad pow'];
  if (b.timestamp > now + 120 || b.timestamp <= prev.timestamp - 600) return [false, 'bad time'];
  if (!b.txs || !b.txs.length || b.txs[0].type !== 'coinbase' || b.txs.length > PARAMS.maxTxs) return [false, 'bad coinbase'];
  if (merkleRoot(b.txs.map((t) => t.txid)) !== b.merkle_root) return [false, 'bad merkle'];
  let fees = 0; const s = cloneState(st);
  for (const tx of b.txs.slice(1)) {
    const [ok, why] = validateTx(tx, s);
    if (!ok) return [false, why];
    applyTx(tx, s); fees += tx.fee;
  }
  const cb = b.txs[0];
  if (cb.amount !== blockReward(b.height) + fees || cb.height !== b.height) return [false, 'bad reward'];
  if (!validAddr(cb.to)) return [false, 'bad miner'];
  return [true, 'ok'];
}

// Full re-validation from genesis. Returns {ok, why, height, state}.
export function validateChain(chain) {
  const g = genesisBlock();
  if (!chain || !chain.length || hex(canon(chain[0])) !== hex(canon(g))) return { ok: false, why: 'bad genesis', height: -1 };
  const st = newState(); for (const tx of chain[0].txs) applyTx(tx, st);
  for (let i = 1; i < chain.length; i++) {
    const [ok, why] = validateBlock(chain[i], chain.slice(0, i), st);
    if (!ok) return { ok: false, why: `block ${i}: ${why}`, height: i - 1, state: st };
    for (const tx of chain[i].txs) applyTx(tx, st);
  }
  return { ok: true, why: 'ok', height: chain.length - 1, state: st };
}

// ----------------------------------------------------------------- chain ---
export class Chain {
  constructor(blocks) {
    this.mempool = {};
    this.replace(blocks && blocks.length ? blocks : [genesisBlock()]);
  }
  get tip() { return this.chain[this.chain.length - 1]; }
  get height() { return this.chain.length - 1; }
  get balances() { return this.state.balances; }
  get owners() { return this.state.owners; }
  get listings() { return this.state.listings; }
  balance(a) { return this.state.balances[a] || 0; }
  supply() { return Object.values(this.state.balances).filter((v) => v > 0).reduce((a, b) => a + b, 0); }
  memeCount() { return Object.keys(this.state.owners).length; }
  static validateChain(chain) { return validateChain(chain); }

  replace(blocks) {
    this.chain = blocks; this.state = newState();
    for (const b of blocks) for (const tx of b.txs) applyTx(tx, this.state);
    for (const txid of Object.keys(this.mempool))
      if (blocks.slice(-50).some((b) => b.txs.some((t) => t.txid === txid))) delete this.mempool[txid];
  }
  // State as it would be after the mempool is mined (used to validate new txs and to show pending balances).
  pendingState() {
    const s = cloneState(this.state);
    for (const m of Object.values(this.mempool)) applyTx(m, s);
    return s;
  }
  addTx(tx) {
    const [ok, why] = validateTx(tx, this.pendingState());
    if (ok) this.mempool[tx.txid] = tx;
    return [ok, why];
  }
  addBlock(b) {
    const [ok, why] = validateBlock(b, this.chain, this.state);
    if (!ok) return [ok, why];
    this.chain.push(b); for (const tx of b.txs) applyTx(tx, this.state);
    for (const tx of b.txs) delete this.mempool[tx.txid];
    return [true, 'ok'];
  }
  candidate(minerAddr, timestamp = Math.floor(Date.now() / 1000)) {
    const txs = Object.values(this.mempool).sort((a, b) => b.fee - a.fee).slice(0, PARAMS.maxTxs - 1);
    const fees = txs.reduce((n, t) => n + t.fee, 0); const h = this.height + 1;
    const cb = { type: 'coinbase', to: minerAddr, amount: blockReward(h) + fees, height: h };
    cb.txid = sha256hex(canon(cb));
    const all = [cb, ...txs];
    return { height: h, prev_hash: this.tip.hash, timestamp, merkle_root: merkleRoot(all.map((t) => t.txid)),
      target: targetFor(this.chain), nonce: Math.floor(Math.random() * 2 ** 32), txs: all };
  }
  findTx(txid) {
    for (const b of this.chain) for (const t of b.txs) if (t.txid === txid) return { tx: t, block: b };
    return null;
  }
  memes() {   // every inscribed meme with its current owner and listing
    const out = [];
    for (const b of this.chain) for (const t of b.txs) if (t.type === 'meme')
      out.push({ tx: t, block: b, owner: this.state.owners[t.img_sha256], price: this.state.listings[t.img_sha256] });
    return out;
  }
}
