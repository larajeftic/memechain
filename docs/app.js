// memechain browser demo: wires the page to chain.js. All state lives in this browser's localStorage.
import * as C from './chain.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
let busy = false;
const save = () => { store.set('mc_chain', chain.chain); if (W) store.set('mc_wallets', W); };
const imgKey = (sha) => 'mc_img_' + sha;
const imgUrl = (sha) => store.get(imgKey(sha), null) || BUNDLED[sha] || null;
const BUNDLED = {};                                // sha256 -> bundled image path, filled at start
const who = (a) => !W ? short(a) : a === W.hot.address ? 'you' : a === W.cold.address ? 'cold vault' : a === W.buyer.address ? 'test buyer' : short(a);
const badge = (a) => `<span class="badge ${a === W?.hot.address || a === W?.cold.address ? 'you' : a === W?.buyer.address ? 'buyer' : ''}">${esc(who(a))}</span>`;
const bal = (w) => (W ? chain.balance(w.address) : 0);
const hasSale = () => chain.chain.some((b) => b.txs.some((t) => t.type === 'buy'));

// ---------------------------------------------------------------- render ---
function render() {
  $('#cb-height').textContent = fmt(chain.height);
  $('#pill-mining').hidden = !busy;
  for (const k of ['hot', 'cold', 'buyer']) {
    $('#w-' + k).textContent = W ? fmt(bal(W[k])) : '0';
    $('#a-' + k).textContent = W ? W[k].address : 'no key yet';
  }
  const memes = chain.memes();
  const mine = memes.filter((m) => m.owner === W?.hot.address);
  const listedByYou = mine.some((m) => m.price);
  const done = { s1: !!W, s2: chain.height >= 1 && bal(W?.hot || {}) > 0 || chain.height >= 5, s3: memes.length > 0, s4: listedByYou || hasSale(), s5: hasSale(), s6: W && bal(W.cold) > 0, s7: false };
  for (const [id, ok] of Object.entries(done)) $('#' + id).classList.toggle('done', !!ok);
  $('#b-wallets').textContent = W ? 'New wallets' : 'Create wallets';
  $('#b-mine').disabled = !W || busy;
  $('#b-inscribe').disabled = !W || busy || bal(W.hot) < C.PARAMS.memeFee;
  $('#b-sell').disabled = !W || busy || !mine.length;
  $('#b-buy').disabled = !W || busy || !memes.some((m) => m.price && m.owner !== W.buyer.address);
  $('#b-cold').disabled = !W || busy || bal(W.hot) < 4;
  $('#b-topup').disabled = !W || busy || bal(W.cold) < 50;
  $('#b-verify').disabled = chain.height < 1 || busy; $('#b-export').disabled = chain.height < 1;

  $('#blocks tbody').innerHTML = chain.chain.slice().reverse().slice(0, 60).map((b) => `<tr data-h="${b.height}" tabindex="0">
    <td>${b.height}</td><td title="${b.hash}">${short(b.hash)}</td><td title="${when(b.timestamp)}">${b.height ? ago(b.timestamp) : 'genesis'}</td>
    <td>${b.txs.length}${b.txs.length > 1 ? ' <span style="color:var(--muted)">(' + b.txs.slice(1).map((t) => t.type).join(', ') + ')</span>' : ''}</td>
    <td>${fmt(C.difficultyOf(b.target).toFixed(2))}</td><td>${b.nonce}</td><td>${b.txs[0].amount}</td><td title="${b.txs[0].to}">${esc(who(b.txs[0].to))}</td></tr>`).join('');

  $('#market-grid').innerHTML = memes.length ? memes.slice().reverse().map((m) => {
    const u = imgUrl(m.tx.img_sha256); const yours = m.owner === W?.hot.address; const buyerOwns = m.owner === W?.buyer.address;
    const sha = m.tx.img_sha256;
    let actions = '';
    if (yours) actions = m.price ? `<button class="button ghost" data-act="delist" data-sha="${sha}" type="button">Delist</button>`
      : `<input class="num" type="number" min="1" step="1" value="25" aria-label="Price" data-price="${sha}"><button class="button" data-act="sell" data-sha="${sha}" type="button">Sell</button>`;
    else if (m.price) actions = `<button class="button green" data-act="buy" data-sha="${sha}" data-as="${buyerOwns ? 'hot' : 'buyer'}" type="button">Buy as ${buyerOwns ? 'you' : 'test buyer'}</button>`;
    else if (buyerOwns) actions = `<input class="num" type="number" min="1" step="1" value="30" aria-label="Price" data-price="${sha}"><button class="button ghost" data-act="sell-buyer" data-sha="${sha}" type="button">Buyer sells</button>`;
    return `<div class="mcard">${u ? `<img src="${u}" alt="">` : ''}<div class="body">
      <div class="cap">${esc(m.tx.caption) || '(no caption)'}</div>
      <div class="own"><span>owner ${badge(m.owner)}</span><span>block ${m.block.height}</span></div>
      <div class="price ${m.price ? '' : 'none'}">${m.price ? fmt(m.price) + ' <small>MEME</small>' : 'not for sale'}</div>
      <div class="row">${actions}</div></div></div>`;
  }).join('') : '<p class="empty">No memes on your chain yet. Step 3 inscribes the first one.</p>';
}

function ticket(b, title) {
  const h = C.blockHash(b);
  return `<div class="ticket"><div class="th"><b>${title || 'Block ' + b.height}</b><span>${h === b.hash && C.meetsTarget(h, b.target) ? 'proof of work ok' : 'PROOF OF WORK FAILS'}</span></div><dl>
    <dt>Hash</dt><dd class="hl">${b.hash}</dd><dt>Previous</dt><dd>${b.prev_hash}</dd>
    <dt>Nonce</dt><dd>${fmt(b.nonce)} <span style="color:var(--muted)">difficulty ${fmt(C.difficultyOf(b.target).toFixed(2))}</span></dd>
    <dt>Merkle root</dt><dd>${b.merkle_root}</dd>
    <dt>Coinbase</dt><dd>${b.txs[0].amount} MEME to ${esc(who(b.txs[0].to))}</dd>
    <dt>Transactions</dt><dd>${b.txs.length}${b.txs.length > 1 ? ': ' + b.txs.slice(1).map((t) => t.type + ' ' + short(t.txid)).join(', ') : ''}</dd></dl></div>`;
}
const txCard = (t, status) => `<div class="txcard">${imgUrl(t.img_sha256) ? `<img src="${imgUrl(t.img_sha256)}" alt="">` : '<div></div>'}<div>
  <div class="cap">${esc(t.caption ?? t.type)}</div>
  <div class="meta">txid <b>${t.txid}</b><br>${t.img_sha256 ? `image sha256 <b>${t.img_sha256}</b><br>` : ''}${t.type} · fee ${t.fee} MEME${t.amount ? ' · ' + t.amount + ' MEME' : ''}${t.price !== undefined ? ' · price ' + t.price + ' MEME' : ''} · signed by ${esc(who(t.from))}<br>${status}</div></div></div>`;

// ---------------------------------------------------------------- mining ---
function mineOne(miner, statusEl) {
  return new Promise((resolve) => {
    const b = chain.candidate(miner.address); const t0 = performance.now(); let n = 0;
    const tick = () => {
      const found = C.mineStep(b, 1500); n += 1500;
      const secs = (performance.now() - t0) / 1000;
      if (statusEl) statusEl.textContent = `block ${b.height} · nonce ${fmt(b.nonce)} · ${fmt(Math.round(n / Math.max(secs, 0.05)))} H/s`;
      if (!found) { setTimeout(tick, 0); return; }
      const [ok, why] = chain.addBlock(b);
      if (statusEl) statusEl.textContent = ok ? `block ${b.height} found in ${secs.toFixed(1)} s` : 'rejected: ' + why;
      save(); render(); resolve(ok ? b : null);
    };
    setTimeout(tick, 0);
  });
}
async function run(statusEl, outEl, fn) {           // one user action: lock buttons, run, show result or error
  if (busy) return; busy = true; render();
  try { await fn(); } catch (e) { outEl.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; }
  busy = false; render();
}
const submit = (tx, what) => { const [ok, why] = chain.addTx(tx); if (!ok) throw new Error(`${what}: ${why}`); return tx; };

// --------------------------------------------------------------- actions ---
$('#b-wallets').addEventListener('click', () => {
  const b = $('#b-wallets');
  if (W && !b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Click again: new keys cannot spend the old MEME'; setTimeout(() => { delete b.dataset.sure; render(); }, 5000); return; }
  delete b.dataset.sure;
  W = { hot: C.createWallet(), cold: C.createWallet(), buyer: C.createWallet() }; save(); render();
  $('#o1').innerHTML = `<div class="flow"><div>hot   <span class="ok">${W.hot.address}</span></div><div>cold  <span class="ok">${W.cold.address}</span></div><div>buyer <span class="ok">${W.buyer.address}</span></div></div>
    <div class="note info">Addresses are meme1 + sha256(public key). The private keys stay in this browser. <button class="button ghost" id="b-reveal" type="button" style="padding:3px 8px;margin-left:6px">Show private keys</button></div>`;
  $('#b-reveal').addEventListener('click', () => { $('#o1 .flow').insertAdjacentHTML('beforeend', `<div style="color:var(--muted)">hot key   ${W.hot.private_key}</div><div style="color:var(--muted)">cold key  ${W.cold.private_key}</div><div style="color:var(--muted)">buyer key ${W.buyer.private_key}</div>`); $('#b-reveal').remove(); });
});

$('#b-mine').addEventListener('click', () => run($('#m2'), $('#o2'), async () => {
  const before = bal(W.hot); let last;
  for (let i = 0; i < 5; i++) { last = await mineOne(W.hot, $('#m2')); if (!last) throw new Error('block rejected'); }
  $('#o2').innerHTML = ticket(last, `Block ${last.height}, the last of five`) + `<div class="note">Hot wallet: ${fmt(before)} → ${fmt(bal(W.hot))} MEME. Five coinbase rewards of 50 MEME each.</div>`;
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
  if (bytes.length > C.PARAMS.maxImg) throw new Error(`Image is ${fmt(bytes.length)} bytes; the limit is ${fmt(C.PARAMS.maxImg)}.`);
  const ext = detectExt(bytes); if (!ext) throw new Error('Not a jpg, png, gif or webp file.');
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
  if (chain.owners[img.img_sha256]) throw new Error('This image is already on your chain. Pick another one.');
  const tx = submit(C.makeMemeTx(W.hot, { ...img, caption: $('#caption').value }), 'inscribe');
  $('#o3').innerHTML = txCard(tx, 'signed, in the mempool, mining…');
  const b = await mineOne(W.hot, $('#m3'));
  $('#o3').innerHTML = txCard(tx, `mined into block ${b.height}`) + ticket(b)
    + `<div class="note">You own this meme now. The 1 MEME fee went to the miner, which is you, so the coinbase is ${b.txs[0].amount} MEME.</div>`;
  $('#s4').scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  if (!mine.length) throw new Error('All your memes are listed already. Use the market below to delist or buy back.');
  await sell(W.hot, mine[mine.length - 1].tx.img_sha256, price, $('#m4'), $('#o4'));
  $('#s5').scrollIntoView({ behavior: 'smooth', block: 'center' });
}));

async function buy(buyerW, sha, statusEl, outEl) {
  const price = chain.listings[sha]; if (!price) throw new Error('Not for sale.');
  const seller = chain.owners[sha]; const sellerBefore = chain.balance(seller);
  const lines = [];
  const log = (s, ok = true) => { lines.push(`<div>${ok ? '<span class="ok">✓</span>' : '·'} ${s}</div>`); outEl.innerHTML = `<div class="flow">${lines.join('')}</div>`; };
  let mined = 0;
  while (chain.balance(buyerW.address) < price) {
    log(`${esc(who(buyerW.address))} has ${fmt(chain.balance(buyerW.address))} MEME, needs ${fmt(price)}: mining a block…`, false);
    const b = await mineOne(buyerW, statusEl); mined++;
    log(`block ${b.height} mined by ${esc(who(buyerW.address))}: +${b.txs[0].amount} MEME`);
  }
  const tx = submit(C.makeBuy(buyerW, sha, price, 0), 'buy');
  log(`buy transaction signed by ${esc(who(buyerW.address))}: ${fmt(price)} MEME for ${short(sha)}`);
  const b = await mineOne(W.hot, statusEl);
  log(`block ${b.height} mined, ownership moved to ${esc(who(buyerW.address))}`);
  outEl.innerHTML += txCard(tx, `mined into block ${b.height}`)
    + `<div class="note">${esc(who(seller))} received ${fmt(price)} MEME (${fmt(sellerBefore)} → ${fmt(chain.balance(seller))}). ${mined ? `The buyer first mined ${mined} block${mined > 1 ? 's' : ''} to afford it.` : ''}</div>`;
  return tx;
}
$('#b-buy').addEventListener('click', () => run($('#m5'), $('#o5'), async () => {
  const listed = chain.memes().filter((m) => m.price && m.owner !== W.buyer.address);
  if (!listed.length) throw new Error('Nothing is listed that the buyer does not already own.');
  await buy(W.buyer, listed[listed.length - 1].tx.img_sha256, $('#m5'), $('#o5'));
  $('#s6').scrollIntoView({ behavior: 'smooth', block: 'center' });
}));

async function transfer(fromW, toW, amount, statusEl, outEl, label) {
  const tx = submit(C.makeTransfer(fromW, toW.address, amount, 0), label);
  const b = await mineOne(W.hot, statusEl);
  outEl.innerHTML = txCard(tx, `mined into block ${b.height}`)
    + `<div class="note">Hot ${fmt(bal(W.hot))} MEME · Cold ${fmt(bal(W.cold))} MEME. The cold key never signs anything in this demo; it only receives.</div>`;
}
$('#b-cold').addEventListener('click', () => run($('#m6'), $('#o6'), async () => {
  const amt = Math.floor(bal(W.hot) * 0.75); if (amt < 1) throw new Error('Nothing to move.');
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

$('#b-verify').addEventListener('click', () => run(null, $('#o7'), async () => {
  const lines = []; const add = (ok, text, detail) => lines.push(`<li class="${ok ? '' : 'fail'}">${text}${detail ? ` <span class="mono">${esc(detail)}</span>` : ''}</li>`);
  const g = C.genesisBlock();
  add(C.hex(C.canon(chain.chain[0])) === C.hex(C.canon(g)), 'Genesis is the canonical 16-bit genesis', g.hash);
  const v = C.validateChain(chain.chain);
  add(v.ok, v.ok ? `All ${chain.height} blocks re-validated: link, target, proof of work, time, merkle root, reward` : 'Chain invalid', v.why);
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
  $('#o7').innerHTML = `<ul class="check">${lines.join('')}</ul><div class="flow">${balances.map(([a, n]) => `<div>${fmt(n).padStart(6)} MEME  ${a}  ${esc(who(a))}</div>`).join('')}</div>
    <div class="note ${v.ok && !bad ? '' : 'bad'}">${v.ok && !bad ? 'Everything checks out. Export the chain and run <code>python tools/validate_export.py chain.json</code> to confirm it with the Python node.' : 'Something is broken. Reset the demo to start over.'}</div>`;
}));

$('#b-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(chain.chain)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'memechain-browser-chain.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('#reset').addEventListener('click', () => {
  const b = $('#reset');
  if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Click again to erase'; setTimeout(() => { delete b.dataset.sure; b.textContent = 'Reset'; }, 5000); return; }
  for (const k of Object.keys(localStorage)) if (k.startsWith('mc_')) store.del(k);
  W = null; chain = new C.Chain(); delete b.dataset.sure; b.textContent = 'Reset';
  for (let i = 1; i <= 7; i++) $('#o' + i).innerHTML = '';
  document.querySelectorAll('.mining').forEach((m) => { m.textContent = ''; });
  $('#block-detail').hidden = true; $('#tx-detail').innerHTML = ''; render(); window.scrollTo({ top: 0 });
});

$('#blocks tbody').addEventListener('click', (e) => showBlock(e.target.closest('tr')));
$('#blocks tbody').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showBlock(e.target.closest('tr')); } });
function showBlock(tr) {
  if (!tr || !tr.dataset.h) return;
  const b = chain.chain[Number(tr.dataset.h)];
  document.querySelectorAll('#blocks tr.sel').forEach((x) => x.classList.remove('sel')); tr.classList.add('sel');
  const d = $('#block-detail'); d.hidden = false;
  d.innerHTML = `<div class="two"><div><h4>Block ${b.height} header → hash</h4><pre>${esc(C.headerString(b))}</pre><p style="margin-top:8px;font-size:12px;color:var(--muted)">sha256(sha256(header)) =</p><pre>${C.blockHash(b)}</pre></div>
    <div><h4>Block ${b.height} as stored</h4><pre>${esc(JSON.stringify(b, null, 1))}</pre></div></div>`;
}

// ------------------------------------------------------- testnet snapshot --
async function loadTestnet() {
  const out = $('#testnet-out');
  try {
    const r = await fetch('chain.json', { cache: 'no-store' }); if (!r.ok) throw new Error(r.status);
    const d = await r.json(); const s = d.status; const memes = d.memes || [], blocks = d.blocks || [], anchors = d.anchors || [], sales = d.sales || [];
    out.innerHTML = `<div class="stats"><span class="pill">exported <b>${when(s.updated)}</b></span><span class="pill">height <b>${fmt(s.height)}</b></span><span class="pill">memes <b>${fmt(s.memes)}</b></span><span class="pill">sales <b>${fmt(sales.length)}</b></span><span class="pill">supply <b>${fmt(s.supply)} ${s.ticker}</b></span><span class="pill">difficulty <b>${fmt(s.difficulty)}</b></span><span class="pill">Bitcoin anchors <b>${fmt(s.anchors)}</b></span></div>
      ${memes.length ? `<div class="market" style="margin-bottom:12px">${memes.slice(0, 8).map((m) => `<div class="mcard"><img src="${m.img}" alt="" loading="lazy"><div class="body"><div class="cap">${esc(m.caption) || '(no caption)'}</div><div class="own"><span>owner <b title="${m.owner || ''}">${short(m.owner || m.from)}</b></span><span>block ${m.height}</span></div><div class="price ${m.price ? '' : 'none'}">${m.price ? fmt(m.price) + ' <small>' + s.ticker + '</small>' : 'not for sale'}</div></div></div>`).join('')}</div>` : ''}
      <div class="tablewrap"><table><thead><tr><th>Block</th><th>Hash</th><th>Mined</th><th>Txs</th><th>Memes</th><th>Difficulty</th><th>Nonce</th><th>Reward</th><th>Miner</th></tr></thead><tbody>
      ${blocks.slice(0, 12).map((b) => `<tr><td>${b.height}</td><td title="${b.hash}">${short(b.hash)}</td><td title="${when(b.time)}">${b.height ? ago(b.time) : 'genesis'}</td><td>${b.txs}</td><td>${b.memes || ''}</td><td>${fmt(b.difficulty)}</td><td>${b.nonce}</td><td>${b.reward}</td><td title="${b.miner}">${short(b.miner)}</td></tr>`).join('')}</tbody></table></div>
      <p style="margin-top:10px;font-size:12.5px;color:var(--muted)">${anchors.length ? `${anchors.length} OpenTimestamps proof${anchors.length > 1 ? 's' : ''}: ` + anchors.map((a) => `<a href="${a.file}">block ${a.height}</a>`).join(', ') + '. ' : 'No Bitcoin anchor yet; the first one is made at block 10. '}Raw data: <a href="chain.json">chain.json</a>, <a href="blocks_full.json">full chain</a>.</p>`;
  } catch { out.innerHTML = '<p class="empty">No testnet snapshot is published on this site yet. Run node.py to create one.</p>'; }
}

// bundled image hashes, so market cards can show pictures for memes inscribed from the bundle
(async () => {
  for (const el of document.querySelectorAll('input[name=img]')) if (el.value !== 'upload') { try { BUNDLED[C.sha256hex(await fetchBytes(el.value))] = el.value; } catch { /* offline */ } }
  render();
})();
render(); loadTestnet();
