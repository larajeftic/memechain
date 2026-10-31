// memechain site: shows the public testnet (exported by the testnet bot to the `testnet` branch) and runs a
// browser-local chain with the same rules (chain.js). Browser chain state lives in this browser's localStorage.
import * as C from './chain.js';

const REPO = 'larajeftic/memechain';
const NET_SOURCES = [`https://raw.githubusercontent.com/${REPO}/testnet/`, ''];   // live branch first, then the snapshot in docs/
const NODE_ADDR = 'meme18af139f145d279fc003af0a7bfd18bfdb9c2ec3a';               // wallet of the testnet node / bot
const BOT_EVERY_MIN = 20;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');
const short = (h) => h ? h.slice(0, 10) + '…' + h.slice(-6) : '';
const when = (t) => new Date(t * 1000).toLocaleString();
const ago = (t) => { const d = Math.max(0, Date.now() / 1000 - t); return d < 60 ? Math.round(d) + ' s ago' : d < 3600 ? Math.round(d / 60) + ' min ago' : d < 86400 ? Math.round(d / 3600) + ' h ago' : Math.round(d / 86400) + ' d ago'; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ----------------------------------------------------------------- state ---
let W = store.get('mc_wallets', null);            // {hot, cold, buyer}
let chain;
{
  const saved = store.get('mc_chain', null);
  const v = saved ? C.validateChain(saved) : { ok: false };
  chain = new C.Chain(v.ok ? saved : null);
  if (saved && !v.ok) store.del('mc_chain');
}
let view = W && chain.height > 0 ? 'local' : 'testnet';
let NET = null, NETBASE = '', NETLIVE = false, NETFULL = null, BOTS = new Set();
let filter = 'all', selected = null, busy = false, rows = 12;
const mining = { on: false, height: 0, nonce: 0, hps: 0 };

const save = () => { store.set('mc_chain', chain.chain); if (W) store.set('mc_wallets', W); };
const imgKey = (sha) => 'mc_img_' + sha;
const BUNDLED = {};                                // sha256 -> bundled image path, filled at start
const imgUrl = (sha) => store.get(imgKey(sha), null) || BUNDLED[sha] || null;
const who = (a) => !W ? short(a) : a === W.hot.address ? 'you' : a === W.cold.address ? 'cold vault' : a === W.buyer.address ? 'test buyer' : short(a);
const badge = (a) => view === 'testnet'
  ? `<span class="badge ${a === NODE_ADDR || BOTS.has(a) ? 'bot' : ''}" title="${esc(a)}">${a === NODE_ADDR ? 'testnet node' : BOTS.has(a) ? 'testnet bot' : esc(short(a))}</span>`
  : `<span class="badge ${a === W?.hot.address || a === W?.cold.address ? 'you' : a === W?.buyer.address ? 'buyer' : ''}" title="${esc(a)}">${esc(who(a))}</span>`;
const bal = (w) => (W ? chain.balance(w.address) : 0);
const hasSale = () => chain.chain.some((b) => b.txs.some((t) => t.type === 'buy'));

// A 5x5 mirrored pattern from the block hash, for blocks without a meme.
function identicon(hash) {
  let cells = '';
  const cell = (x, y, o) => `<rect x="${x}" y="${y}" width="1" height="1" fill="#a99fff" opacity="${o}"/>`;
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    const v = parseInt(hash[24 + y * 3 + x], 16);
    if (v % 3) { const o = (0.35 + (v / 15) * 0.6).toFixed(2); cells += cell(x, y, o); if (x < 2) cells += cell(4 - x, y, o); }
  }
  return `<svg viewBox="-1.5 -1.5 8 8" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect x="-2" y="-2" width="10" height="10" fill="#6c5cff"/>${cells}</svg>`;
}

// ----------------------------------------------------------------- models --
// One shape for both chains so the strip, market and explorer render the same way.
function model() {
  if (view === 'testnet') {
    if (!NET) return null;
    const s = NET.status, memeAt = {};
    for (const m of NET.memes) (memeAt[m.height] ||= m);
    const salesOf = (sha) => NET.sales.filter((x) => x.img_sha256 === sha).length;
    return {
      height: s.height, tipTime: NET.blocks[0]?.time, difficulty: s.difficulty, supply: s.supply, ticker: s.ticker,
      extra: ['Bitcoin anchors', fmt(s.anchors)],
      blocks: NET.blocks.map((b) => ({ ...b, img: memeAt[b.height] ? NETBASE + memeAt[b.height].img : null, kinds: b.memes ? `${b.memes} meme${b.memes > 1 ? 's' : ''}` : '' })),
      memes: NET.memes.map((m) => ({ sha: m.img_sha256, caption: m.caption, img: NETBASE + m.img, height: m.height, time: m.time, owner: m.owner || m.from, price: m.price, sales: salesOf(m.img_sha256) })),
    };
  }
  const memes = chain.memes().map((m) => ({ sha: m.tx.img_sha256, caption: m.tx.caption, img: imgUrl(m.tx.img_sha256), height: m.block.height, time: m.block.timestamp, owner: m.owner, price: m.price,
    sales: chain.chain.reduce((n, b) => n + b.txs.filter((t) => t.type === 'buy' && t.img_sha256 === m.tx.img_sha256).length, 0) })).reverse();
  const memeAt = {}; for (const m of memes) memeAt[m.height] ||= m;
  return {
    height: chain.height, tipTime: chain.tip.timestamp, difficulty: C.difficultyOf(chain.tip.target), supply: chain.supply(), ticker: 'MEME',
    extra: ['Sales', fmt(chain.chain.reduce((n, b) => n + b.txs.filter((t) => t.type === 'buy').length, 0))],
    blocks: chain.chain.slice().reverse().map((b) => ({ height: b.height, hash: b.hash, time: b.timestamp, txs: b.txs.length, nonce: b.nonce, reward: b.txs[0].amount,
      miner: b.txs[0].to, difficulty: C.difficultyOf(b.target), img: memeAt[b.height]?.img || null, kinds: b.txs.slice(1).map((t) => t.type).join(', ') })),
    memes,
  };
}

// ---------------------------------------------------------------- render ---
function render() {
  const M = model();
  $('#v-testnet').setAttribute('aria-selected', String(view === 'testnet'));
  $('#v-local').setAttribute('aria-selected', String(view === 'local'));
  renderNote(); renderStack(M); renderStrip(M); renderStats(M); renderMarket(M); renderExplorer(M); renderMine();
}

function renderNote() {
  $('#chainnote').innerHTML = view === 'local'
    ? 'Lives in this browser only. You mine it with the steps below.'
    : !NET ? 'Loading the testnet.'
    : NETLIVE ? `Mined by the testnet bot on GitHub Actions, about every ${BOT_EVERY_MIN} minutes. Last export ${ago(NET.status.updated)}.`
    : `Showing the last published snapshot (${when(NET.status.updated)}).`;
}

const STACK_DEFAULT = [{ img: 'img/pepe.jpg', caption: 'feels good man' }, { img: 'img/doge.jpg', caption: 'such block' }, { img: 'img/wojak.png', caption: 'mined it myself' }];
function renderStack(M) {
  const list = (M?.memes.length >= 3 ? M.memes : STACK_DEFAULT).slice(0, 3).reverse();
  $('#stack').innerHTML = list.map((m) => `<figure class="polaroid"><div class="im"><img src="${esc(m.img)}" alt=""><span>${esc(m.caption)}</span></div>
    <figcaption>${m.height !== undefined ? `<span>block ${fmt(m.height)}</span><b>${esc(m.sha.slice(0, 8))}</b>` : '<span>bundled meme</span>'}</figcaption></figure>`).join('');
}

function cube(b, i) {
  const chars = i === 0 ? '<img class="char peek" src="img/characters/pepe-peek.png" alt="">' : i === 3 ? '<img class="char sit" src="img/characters/pepe-sit.png" alt="">' : '';
  return `<button type="button" class="cube ${b.img ? 'meme' : ''} ${selected === b.height ? 'sel' : ''}" data-h="${b.height}" aria-label="Block ${b.height}">
    ${chars}<span class="h">#${fmt(b.height)}</span><span class="top-f"></span><span class="side-f"></span>
    <span class="face">${b.img ? `<img src="${esc(b.img)}" alt="" loading="lazy">` : identicon(b.hash)}
    <span class="lbl"><b>${b.txs} tx${b.txs > 1 ? 's' : ''}</b><span>${b.height ? ago(b.time) : 'genesis'}</span></span></span></button>`;
}
function pendingText() {
  if (view === 'local') return mining.on ? [`nonce ${fmt(mining.nonce)}`, `${fmt(mining.hps)} H/s`] : ['waiting', 'mine it below'];
  if (!NET || !NETLIVE) return ['next block', 'when a node runs'];
  const next = NET.status.updated + BOT_EVERY_MIN * 60 - Date.now() / 1000;
  return ['next run', next > 60 ? `in ~${Math.round(next / 60)} min` : 'any minute'];
}
function renderStrip(M) {
  const el = $('#strip');
  if (!M) { el.innerHTML = '<p class="empty">Loading blocks.</p>'; return; }
  const [a, b] = pendingText();
  el.innerHTML = `<div class="cube pending ${view === 'local' && mining.on ? 'active' : ''}" aria-label="Next block"><span class="h">#${fmt(M.height + 1)}</span><span class="top-f"></span><span class="side-f"></span>
      <span class="face"><span class="lbl"><b id="pend-a">${a}</b><span id="pend-b">${b}</span></span></span></div>
    <span class="divider" aria-hidden="true"></span>${M.blocks.slice(0, 10).map(cube).join('')}`;
}
function updatePending() {
  if (view !== 'local') return;
  const a = $('#pend-a'), b = $('#pend-b'); if (!a) return;
  const [x, y] = pendingText(); a.textContent = x; b.textContent = y;
  a.closest('.cube').classList.toggle('active', mining.on);
}
function renderStats(M) {
  const items = !M ? [] : [['Height', fmt(M.height)], ['Last block', M.height ? ago(M.tipTime) : 'genesis'], ['Difficulty', fmt(Math.round(M.difficulty))],
    ['Memes', fmt(M.memes.length)], ['Supply', fmt(M.supply) + ' ' + M.ticker, 'g'], M.extra];
  $('#stats').innerHTML = items.map(([k, v, c]) => `<div><dt>${k}</dt><dd class="${c || ''}">${v}</dd></div>`).join('');
}

function renderMarket(M) {
  $('#market-sub').textContent = view === 'testnet'
    ? 'Every meme inscribed on the public testnet, its owner and its price. Switch to your browser chain to inscribe and trade your own.'
    : 'Every meme on your browser chain. Selling and buying are signed on-chain transactions.';
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.filter === filter));
  if (!M) { $('#market-grid').innerHTML = '<p class="empty">Loading memes.</p>'; return; }
  const list = M.memes.filter((m) => filter === 'all' || (filter === 'sale' ? m.price : m.sales > 0));
  if (!list.length) {
    $('#market-grid').innerHTML = `<p class="empty">${filter !== 'all' ? 'Nothing matches this filter yet.' : view === 'local' ? 'No memes on your chain yet. Step 3 inscribes the first one.' : 'No memes on the testnet yet.'}</p>`;
    return;
  }
  $('#market-grid').innerHTML = list.map((m, i) => {
    const featured = i === 0 && filter === 'all' && list.length >= 3;
    return `<article class="mcard ${featured ? 'featured' : ''}"><div class="pic">${m.img ? `<img src="${esc(m.img)}" alt="" loading="lazy">` : identicon(m.sha.padEnd(64, '0'))}</div><div class="body">
      ${featured ? '<span class="tag">Newest inscription</span>' : ''}
      <div class="cap">${esc(m.caption) || 'Untitled'}</div>
      <div class="own"><span>owner ${badge(m.owner)}</span><span>block ${fmt(m.height)}</span>${m.sales ? `<span>sold ${m.sales}×</span>` : ''}</div>
      <div class="price ${m.price ? '' : 'none'}">${m.price ? fmt(m.price) + ' <small>MEME</small>' : 'Not for sale'}</div>
      <div class="row">${view === 'local' ? actions(m) : ''}</div></div></article>`;
  }).join('');
}
function actions(m) {
  if (!W) return '';
  const sha = m.sha, yours = m.owner === W.hot.address, buyerOwns = m.owner === W.buyer.address;
  if (yours) return m.price ? `<button class="btn" data-act="delist" data-sha="${sha}" type="button">Delist</button>`
    : `<input class="num-in" type="number" min="1" step="1" value="25" aria-label="Price" data-price="${sha}"><button class="btn primary" data-act="sell" data-sha="${sha}" type="button">Sell</button>`;
  if (m.price) return `<button class="btn buy" data-act="buy" data-sha="${sha}" data-as="${buyerOwns ? 'hot' : 'buyer'}" type="button">Buy as ${buyerOwns ? 'you' : 'test buyer'}</button>`;
  if (buyerOwns) return `<input class="num-in" type="number" min="1" step="1" value="30" aria-label="Price" data-price="${sha}"><button class="btn" data-act="sell-buyer" data-sha="${sha}" type="button">Buyer sells</button>`;
  return '';
}

function renderExplorer(M) {
  $('#explorer-sub').textContent = view === 'testnet'
    ? 'The public testnet. Select a block: your browser recomputes its hash from the header.'
    : 'Your browser chain. Select a block to see its header, its hash and the block as stored.';
  if (!M) return;
  $('#more-blocks').hidden = M.blocks.length <= rows;
  $('#blocks tbody').innerHTML = M.blocks.slice(0, rows).map((b) => `<tr data-h="${b.height}" tabindex="0" class="${selected === b.height ? 'sel' : ''}">
    <td>${fmt(b.height)}</td><td class="mono" title="${b.hash}">${short(b.hash)}</td><td title="${when(b.time)}">${b.height ? ago(b.time) : 'genesis'}</td>
    <td>${b.txs}${b.kinds ? ` <span class="ty">(${esc(b.kinds)})</span>` : ''}</td><td>${fmt(Math.round(b.difficulty * 100) / 100)}</td><td class="mono">${b.nonce}</td>
    <td>${b.reward}</td><td>${badge(b.miner)}</td></tr>`).join('');
}

function renderMine() {
  $('#cb-height').textContent = fmt(chain.height);
  $('#pill-mining').hidden = !busy;
  for (const k of ['hot', 'cold', 'buyer']) {
    $('#w-' + k).textContent = W ? fmt(bal(W[k])) : '0';
    $('#a-' + k).textContent = W ? W[k].address : 'no key yet';
  }
  const memes = chain.memes();
  const mine = memes.filter((m) => m.owner === W?.hot.address);
  const done = { s1: !!W, s2: chain.height >= 5, s3: memes.length > 0, s4: mine.some((m) => m.price) || hasSale(), s5: hasSale(), s6: W && bal(W.cold) > 0, s7: false };
  for (const [id, ok] of Object.entries(done)) $('#' + id).classList.toggle('done', !!ok);
  $('#b-wallets').textContent = W ? 'New wallets' : 'Create wallets';
  $('#b-mine').disabled = !W || busy;
  $('#b-inscribe').disabled = !W || busy || bal(W.hot) < C.PARAMS.memeFee;
  $('#b-sell').disabled = !W || busy || !mine.length;
  $('#b-buy').disabled = !W || busy || !memes.some((m) => m.price && m.owner !== W.buyer.address);
  $('#b-cold').disabled = !W || busy || bal(W.hot) < 4;
  $('#b-topup').disabled = !W || busy || bal(W.cold) < 50;
  $('#b-verify').disabled = chain.height < 1 || busy; $('#b-export').disabled = chain.height < 1;
}

function renderTape() {
  if (!NET) { $('.tape').hidden = true; return; }
  const ev = [];
  for (const b of NET.blocks.slice(0, 14)) ev.push({ t: b.time, h: `<span class="k"></span>Block <b>#${fmt(b.height)}</b> mined, ${b.reward} MEME to ${b.miner === NODE_ADDR ? 'the testnet node' : BOTS.has(b.miner) ? 'the testnet bot' : short(b.miner)}` });
  for (const m of NET.memes.slice(0, 10)) ev.push({ t: m.time, h: `<img src="${esc(NETBASE + m.img)}" alt=""><b>“${esc(m.caption) || 'Untitled'}”</b> inscribed in #${fmt(m.height)}` });
  for (const s of NET.sales.slice(0, 10)) { const m = NET.memes.find((x) => x.img_sha256 === s.img_sha256); ev.push({ t: s.time, h: `${m ? `<img src="${esc(NETBASE + m.img)}" alt="">` : ''}<b>“${esc(m?.caption || 'a meme')}”</b> sold for <span class="g">${fmt(s.amount)} MEME</span>` }); }
  ev.sort((a, b) => b.t - a.t);
  const items = ev.slice(0, 24).map((e) => `<span class="ev">${e.h}<span>${ago(e.t)}</span></span>`).join('');
  $('.tape').hidden = false;
  $('#tape').innerHTML = items + items.replace(/<span class="ev">/g, '<span class="ev" aria-hidden="true">');
}
function renderNetPill() {
  const pill = $('#netpill');
  if (!NET) { $('#netpill-txt').textContent = 'testnet offline'; pill.classList.remove('live'); return; }
  const fresh = NETLIVE && Date.now() / 1000 - NET.status.updated < 3 * BOT_EVERY_MIN * 60;
  pill.classList.toggle('live', fresh);
  $('#netpill-txt').innerHTML = `testnet <b>#${fmt(NET.status.height)}</b> ${ago(NET.blocks[0]?.time || NET.status.updated)}`;
}

function setView(v) { if (view === v) return; view = v; selected = null; rows = 12; $('#block-detail').hidden = true; render(); }

// ---------------------------------------------------------------- tickets --
function ticket(b, title) {
  const h = C.blockHash(b);
  return `<div class="ticket"><div class="th"><b>${title || 'Block ' + b.height}</b><span>${h === b.hash && C.meetsTarget(h, b.target) ? 'proof of work ok' : 'PROOF OF WORK FAILS'}</span></div><dl>
    <dt>Hash</dt><dd class="hl">${b.hash}</dd><dt>Previous</dt><dd>${b.prev_hash}</dd>
    <dt>Nonce</dt><dd>${fmt(b.nonce)}, difficulty ${fmt(C.difficultyOf(b.target).toFixed(2))}</dd>
    <dt>Merkle root</dt><dd>${b.merkle_root}</dd>
    <dt>Coinbase</dt><dd>${b.txs[0].amount} MEME to ${esc(who(b.txs[0].to))}</dd>
    <dt>Transactions</dt><dd>${b.txs.length}${b.txs.length > 1 ? ': ' + b.txs.slice(1).map((t) => t.type + ' ' + short(t.txid)).join(', ') : ''}</dd></dl></div>`;
}
const txCard = (t, status) => `<div class="txcard">${imgUrl(t.img_sha256) ? `<img src="${imgUrl(t.img_sha256)}" alt="">` : '<div></div>'}<div>
  <div class="cap">${esc(t.caption ?? t.type)}</div>
  <div class="meta">txid <b>${t.txid}</b><br>${t.img_sha256 ? `image sha256 <b>${t.img_sha256}</b><br>` : ''}${t.type}, fee ${t.fee} MEME${t.amount ? ', ' + t.amount + ' MEME' : ''}${t.price !== undefined ? ', price ' + t.price + ' MEME' : ''}, signed by ${esc(who(t.from))}<br>${status}</div></div></div>`;

// ---------------------------------------------------------------- mining ---
function mineOne(miner, statusEl) {
  return new Promise((resolve) => {
    const b = chain.candidate(miner.address); const t0 = performance.now(); let n = 0;
    Object.assign(mining, { on: true, height: b.height, nonce: b.nonce, hps: 0 }); updatePending();
    const tick = () => {
      const found = C.mineStep(b, 1500); n += 1500;
      const secs = (performance.now() - t0) / 1000;
      mining.nonce = b.nonce; mining.hps = Math.round(n / Math.max(secs, 0.05));
      if (statusEl) statusEl.textContent = `block ${b.height}, nonce ${fmt(b.nonce)}, ${fmt(mining.hps)} H/s`;
      updatePending();
      if (!found) { setTimeout(tick, 0); return; }
      const [ok, why] = chain.addBlock(b);
      if (statusEl) statusEl.textContent = ok ? `block ${b.height} found in ${secs.toFixed(1)} s` : 'rejected: ' + why;
      mining.on = false; save(); render(); resolve(ok ? b : null);
    };
    setTimeout(tick, 0);
  });
}
async function run(statusEl, outEl, fn) {           // one user action: show the browser chain, lock buttons, run, show result or error
  if (busy) return; busy = true; setView('local'); render();
  try { await fn(); } catch (e) { outEl.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; }
  busy = false; mining.on = false; render();
}
const submit = (tx, what) => { const [ok, why] = chain.addTx(tx); if (!ok) throw new Error(`${what}: ${why}`); return tx; };

// --------------------------------------------------------------- actions ---
$('#b-wallets').addEventListener('click', () => {
  const b = $('#b-wallets');
  if (W && !b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Click again: new keys cannot spend the old MEME'; setTimeout(() => { delete b.dataset.sure; render(); }, 5000); return; }
  delete b.dataset.sure;
  W = { hot: C.createWallet(), cold: C.createWallet(), buyer: C.createWallet() }; save(); setView('local'); render();
  $('#o1').innerHTML = `<div class="flow">hot   <span class="ok">${W.hot.address}</span>\ncold  <span class="ok">${W.cold.address}</span>\nbuyer <span class="ok">${W.buyer.address}</span></div>
    <div class="note">An address is meme1 plus the SHA-256 of the public key. The private keys stay in this browser. <button class="btn ghost sm" id="b-reveal" type="button">Show private keys</button></div>`;
  $('#b-reveal').addEventListener('click', () => { $('#o1 .flow').insertAdjacentHTML('beforeend', `\n\nhot key   ${W.hot.private_key}\ncold key  ${W.cold.private_key}\nbuyer key ${W.buyer.private_key}`); $('#b-reveal').remove(); });
});

$('#b-mine').addEventListener('click', () => run($('#m2'), $('#o2'), async () => {
  const before = bal(W.hot); let last;
  for (let i = 0; i < 5; i++) { last = await mineOne(W.hot, $('#m2')); if (!last) throw new Error('block rejected'); }
  $('#o2').innerHTML = ticket(last, `Block ${last.height}, the last of five`) + `<div class="note">Hot wallet: ${fmt(before)} to ${fmt(bal(W.hot))} MEME. Five block rewards of 50 MEME each.</div>`;
}));

$('#file').addEventListener('change', () => { if ($('#file').files[0]) $('input[name=img][value=upload]').checked = true; });
function detectExt(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}
async function fetchBytes(url) { const r = await fetch(url); if (!r.ok) throw new Error('Could not load ' + url); return new Uint8Array(await r.arrayBuffer()); }
async function selectedImage() {
  const choice = document.querySelector('input[name=img]:checked').value;
  let bytes;
  if (choice === 'upload') { const f = $('#file').files[0]; if (!f) throw new Error('Choose a file first.'); bytes = new Uint8Array(await f.arrayBuffer()); }
  else bytes = await fetchBytes(choice);
  if (bytes.length > C.PARAMS.maxImg) throw new Error(`The image is ${fmt(bytes.length)} bytes. The limit is ${fmt(C.PARAMS.maxImg)}.`);
  const ext = detectExt(bytes); if (!ext) throw new Error('Use a jpg, png, gif or webp file.');
  const sha = C.sha256hex(bytes);
  if (choice === 'upload') {
    const mime = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext];
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    store.set(imgKey(sha), `data:${mime};base64,` + btoa(bin));
  } else BUNDLED[sha] = choice;
  return { img_sha256: sha, img_ext: ext, img_size: bytes.length };
}

$('#b-inscribe').addEventListener('click', () => run($('#m3'), $('#o3'), async () => {
  const img = await selectedImage();
  if (chain.owners[img.img_sha256]) throw new Error('This picture is already on your chain. Pick another one.');
  const tx = submit(C.makeMemeTx(W.hot, { ...img, caption: $('#caption').value }), 'inscribe');
  $('#o3').innerHTML = txCard(tx, 'signed, waiting in the mempool, mining');
  const b = await mineOne(W.hot, $('#m3'));
  $('#o3').innerHTML = txCard(tx, `mined into block ${b.height}`) + ticket(b)
    + `<div class="note">You own this meme now. The 1 MEME fee went to the miner, which is you, so this block paid ${b.txs[0].amount} MEME.</div>`;
}));

async function sell(ownerW, sha, price, statusEl, outEl) {
  const tx = submit(C.makeSell(ownerW, sha, price), price ? 'list' : 'delist');
  const b = await mineOne(W.hot, statusEl);
  outEl.innerHTML = txCard(tx, `mined into block ${b.height}`) + `<div class="note">${price ? `Listed for ${fmt(price)} MEME. Anyone with enough MEME can buy it now.` : 'Delisted.'}</div>`;
  return tx;
}
$('#b-sell').addEventListener('click', () => run($('#m4'), $('#o4'), async () => {
  const price = Math.floor(Number($('#price').value)); if (!(price >= 1)) throw new Error('Enter a price of at least 1 MEME.');
  const mine = chain.memes().filter((m) => m.owner === W.hot.address && !m.price);
  if (!mine.length) throw new Error('All your memes are listed already. Delist or buy back from the market.');
  await sell(W.hot, mine[mine.length - 1].tx.img_sha256, price, $('#m4'), $('#o4'));
}));

async function buy(buyerW, sha, statusEl, outEl) {
  const price = chain.listings[sha]; if (!price) throw new Error('This meme is not for sale.');
  const seller = chain.owners[sha]; const sellerBefore = chain.balance(seller);
  const lines = [];
  const log = (s, ok = true) => { lines.push(`${ok ? '<span class="ok">ok</span>' : '..'} ${s}`); outEl.innerHTML = `<div class="flow">${lines.join('\n')}</div>`; };
  let mined = 0;
  while (chain.balance(buyerW.address) < price) {
    log(`${esc(who(buyerW.address))} has ${fmt(chain.balance(buyerW.address))} MEME, needs ${fmt(price)}: mining a block`, false);
    const b = await mineOne(buyerW, statusEl); mined++;
    log(`block ${b.height} mined by ${esc(who(buyerW.address))}: +${b.txs[0].amount} MEME`);
  }
  const tx = submit(C.makeBuy(buyerW, sha, price, 0), 'buy');
  log(`buy transaction signed by ${esc(who(buyerW.address))}: ${fmt(price)} MEME for ${short(sha)}`);
  const b = await mineOne(W.hot, statusEl);
  log(`block ${b.height} mined, ownership moved to ${esc(who(buyerW.address))}`);
  outEl.innerHTML += txCard(tx, `mined into block ${b.height}`)
    + `<div class="note">${esc(who(seller))} received ${fmt(price)} MEME (${fmt(sellerBefore)} to ${fmt(chain.balance(seller))}). ${mined ? `The buyer first mined ${mined} block${mined > 1 ? 's' : ''} to afford it.` : ''}</div>`;
  return tx;
}
$('#b-buy').addEventListener('click', () => run($('#m5'), $('#o5'), async () => {
  const listed = chain.memes().filter((m) => m.price && m.owner !== W.buyer.address);
  if (!listed.length) throw new Error('Nothing is listed that the buyer does not own already.');
  await buy(W.buyer, listed[listed.length - 1].tx.img_sha256, $('#m5'), $('#o5'));
}));

async function transfer(fromW, toW, amount, statusEl, outEl, label) {
  const tx = submit(C.makeTransfer(fromW, toW.address, amount, 0), label);
  const b = await mineOne(W.hot, statusEl);
  outEl.innerHTML = txCard(tx, `mined into block ${b.height}`)
    + `<div class="note">Hot ${fmt(bal(W.hot))} MEME, cold ${fmt(bal(W.cold))} MEME. In this demo the cold key only signs top-ups.</div>`;
}
$('#b-cold').addEventListener('click', () => run($('#m6'), $('#o6'), async () => {
  const amt = Math.floor(bal(W.hot) * 0.75); if (amt < 1) throw new Error('There is nothing to move.');
  await transfer(W.hot, W.cold, amt, $('#m6'), $('#o6'), 'move to cold');
}));
$('#b-topup').addEventListener('click', () => run($('#m6'), $('#o6'), async () => {
  await transfer(W.cold, W.hot, Math.min(50, bal(W.cold)), $('#m6'), $('#o6'), 'top up hot');
}));

$('#market-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const sha = btn.dataset.sha; const out = $('#o4'); const st = $('#m4');
  const priceInput = $('#market-grid').querySelector(`input[data-price="${sha}"]`);
  run(st, out, async () => {
    if (btn.dataset.act === 'sell') await sell(W.hot, sha, Math.max(1, Math.floor(Number(priceInput.value) || 1)), st, out);
    else if (btn.dataset.act === 'sell-buyer') await sell(W.buyer, sha, Math.max(1, Math.floor(Number(priceInput.value) || 1)), st, out);
    else if (btn.dataset.act === 'delist') await sell(W.hot, sha, 0, st, out);
    else if (btn.dataset.act === 'buy') await buy(btn.dataset.as === 'hot' ? W.hot : W.buyer, sha, $('#m5'), $('#o5'));
  });
});
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { filter = c.dataset.filter; renderMarket(model()); }));
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

$('#b-verify').addEventListener('click', () => run(null, $('#o7'), async () => {
  const lines = []; const add = (ok, text, detail) => lines.push(`<li class="${ok ? '' : 'fail'}">${text}${detail ? ` <span class="mono">${esc(detail)}</span>` : ''}</li>`);
  const g = C.genesisBlock();
  add(C.hex(C.canon(chain.chain[0])) === C.hex(C.canon(g)), 'Genesis is the canonical 16-bit genesis', g.hash);
  const v = C.validateChain(chain.chain);
  add(v.ok, v.ok ? `All ${chain.height} blocks re-validated: link, target, proof of work, time, merkle root, reward` : 'The chain is invalid', v.why);
  let sigs = 0, imgOk = 0, imgN = 0, bad = 0;
  for (const b of chain.chain) for (const t of b.txs.slice(1)) {
    sigs++; if (!C.verifySig(t)) { bad++; add(false, 'Signature does not verify', t.txid); }
    if (t.type === 'meme') { const u = imgUrl(t.img_sha256); if (!u) continue; imgN++; const bytes = await fetchBytes(u); if (C.sha256hex(bytes) === t.img_sha256 && bytes.length === t.img_size) imgOk++; else add(false, 'Image bytes do not match the on-chain hash', t.img_sha256); }
  }
  add(bad === 0, `${sigs} transaction signature${sigs === 1 ? '' : 's'} verified`);
  if (imgN) add(imgOk === imgN, `${imgOk} of ${imgN} meme images re-hashed and matched`);
  const st = v.state || chain.state;
  const owners = Object.entries(st.owners); const sales = chain.chain.reduce((n, b) => n + b.txs.filter((t) => t.type === 'buy').length, 0);
  add(true, `${owners.length} meme${owners.length === 1 ? '' : 's'} owned, ${Object.keys(st.listings).length} listed, ${sales} sale${sales === 1 ? '' : 's'} settled`);
  const balances = Object.entries(st.balances).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const supply = balances.reduce((n, [, x]) => n + x, 0);
  add(supply === chain.height * C.PARAMS.reward, `Supply ${fmt(supply)} MEME = ${chain.height} blocks × 50`, supply === chain.height * C.PARAMS.reward ? '' : 'mismatch');
  $('#o7').innerHTML = `<ul class="check">${lines.join('')}</ul><div class="flow">${balances.map(([a, n]) => `${fmt(n).padStart(6)} MEME  ${a}  ${esc(who(a))}`).join('\n')}</div>
    <div class="note ${v.ok && !bad ? '' : 'bad'}">${v.ok && !bad ? 'Everything checks out. Export the chain and run <code>python tools/validate_export.py chain.json</code> to confirm it with the Python node.' : 'Something is broken. Reset your chain to start over.'}</div>`;
}));

$('#b-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(chain.chain)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'memechain-browser-chain.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('#reset').addEventListener('click', () => {
  const b = $('#reset');
  if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Click again to erase'; setTimeout(() => { delete b.dataset.sure; b.textContent = 'Reset my chain'; }, 5000); return; }
  for (const k of Object.keys(localStorage)) if (k.startsWith('mc_')) store.del(k);
  W = null; chain = new C.Chain(); delete b.dataset.sure; b.textContent = 'Reset my chain';
  for (let i = 1; i <= 7; i++) $('#o' + i).innerHTML = '';
  document.querySelectorAll('.mining').forEach((m) => { m.textContent = ''; });
  $('#block-detail').hidden = true; selected = null; render();
});

$('#more-blocks').addEventListener('click', () => { rows += 24; renderExplorer(model()); });
$('#copy-run').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#run-cmd').textContent); $('#copy-run').textContent = 'Copied'; } catch { $('#copy-run').textContent = 'Select and copy'; }
  setTimeout(() => { $('#copy-run').textContent = 'Copy'; }, 2000);
});

// -------------------------------------------------------------- explorer ---
$('#blocks tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr'); if (tr) showBlock(Number(tr.dataset.h)); });
$('#blocks tbody').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const tr = e.target.closest('tr'); if (tr) showBlock(Number(tr.dataset.h)); } });
$('#strip').addEventListener('click', (e) => { const c = e.target.closest('button.cube'); if (!c) return; showBlock(Number(c.dataset.h)); $('#explorer').scrollIntoView({ behavior: 'smooth' }); });

async function showBlock(h) {
  selected = h;
  document.querySelectorAll('#blocks tr.sel, .cube.sel').forEach((x) => x.classList.remove('sel'));
  document.querySelectorAll(`#blocks tr[data-h="${h}"], .cube[data-h="${h}"]`).forEach((x) => x.classList.add('sel'));
  const d = $('#block-detail'); d.hidden = false;
  let b = view === 'local' ? chain.chain[h] : null;
  if (view === 'testnet') {
    d.innerHTML = '<p class="note">Loading the full block.</p>';
    try { NETFULL ||= await (await fetch(NETBASE + 'blocks_full.json', { cache: 'no-store' })).json(); b = NETFULL[h]; } catch { /* below */ }
    if (!b) { d.innerHTML = '<p class="note bad">Could not load the full testnet chain.</p>'; return; }
  }
  const re = C.blockHash(b), ok = re === b.hash && C.meetsTarget(re, b.target);
  d.innerHTML = `<div class="two"><div><h4>Block ${b.height} header</h4><pre>${esc(C.headerString(b))}</pre>
      <p class="match ${ok ? '' : 'bad'}">${ok ? 'Recomputed in your browser: the hash matches and meets the target.' : 'The recomputed hash does not match.'}</p>
      <h4>sha256(sha256(header))</h4><pre>${re}</pre></div>
    <div><h4>Block ${b.height} as stored</h4><pre>${esc(JSON.stringify(b, null, 1))}</pre></div></div>`;
}

// --------------------------------------------------------------- testnet ---
async function loadNet() {
  for (const base of NET_SOURCES) {
    try {
      const r = await fetch(base + 'chain.json' + (base ? `?t=${Math.floor(Date.now() / 60000)}` : ''), { cache: 'no-store' });
      if (!r.ok) continue;
      const d = await r.json(); if (!d.status || !d.blocks) continue;
      if (NET && NETLIVE && !base && d.status.height <= NET.status.height) return;
      if (!NET || d.status.updated !== NET.status.updated) NETFULL = null;
      NET = { ...d, memes: d.memes || [], sales: d.sales || [] }; NETBASE = base; NETLIVE = !!base;
      if (base) try { BOTS = new Set((await (await fetch(base + 'bot.json?t=' + Math.floor(Date.now() / 60000))).json()).addresses || []); } catch { /* optional */ }
      break;
    } catch { /* try the next source */ }
  }
  renderTape(); renderNetPill();
  if (view === 'testnet') render(); else renderNote();
}

// bundled image hashes, so market cards can show pictures for memes inscribed from the bundle
(async () => {
  for (const el of document.querySelectorAll('input[name=img]')) if (el.value !== 'upload') { try { BUNDLED[C.sha256hex(await fetchBytes(el.value))] = el.value; } catch { /* offline */ } }
  if (view === 'local') render();
})();
render(); loadNet();
setInterval(loadNet, 120000);
setInterval(() => { if (!busy) { renderNetPill(); if (view === 'testnet') { renderStrip(model()); renderStats(model()); renderNote(); } } }, 30000);
