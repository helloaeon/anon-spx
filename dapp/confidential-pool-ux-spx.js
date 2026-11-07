// anon.spx profile of Tacit's MIT-licensed confidential-pool-ux.js.
// This snapshot retains the existing scan, shield, withdraw, send, claim, and refund paths,
// and exposes only the methods consumed by anon.spx. Update it with the upstream source when that API changes.

import { getConfidentialDeployment, activeNetwork, syncProtectedOutpoints, shownTicker } from './confidential-deployments.js';
import { bodyType } from './rpc-body.js';
import { makeEvmAccount } from './evm-account.js';
import { makeConfidentialIndexer } from './confidential-indexer.js';
import { makeConfidentialEvmLog } from './confidential-evm-log.js';
import { makeConfidentialRelay } from './confidential-relay.js';
import { verifyConfidentialInvoice } from './confidential-invoice.js';
import { makeEvmTx } from './evm-tx.js';
import { makeRecoveryGuard } from './confidential-recovery-guard.js';
import { makeConfidentialRouter } from './confidential-router.js';
import { makeConfidentialTransfer } from './confidential-transfer.js';
import { makeConfidentialRoute } from './confidential-route.js';
import { makeConfidentialSwap } from './confidential-swap.js';
import { makeConfidentialSwapCoordinator } from './confidential-swap-coordinator.js';
import { makeConfidentialLp } from './confidential-lp.js';
import { makeConfidentialCdp } from './confidential-cdp.js';
import { makeConfidentialFarm } from './confidential-farm.js';
import { makeConfidentialFarmProgram } from './confidential-farm-program.js';
import { makeConfidentialDefiActions } from './confidential-defi-actions.js';
import { makeConfidentialStealth } from './confidential-stealth.js';
import { makeConfidentialAirdrop } from './confidential-airdrop.js';
import { makeTacAirdrop, makeRpcCall as makeAirdropRpcCall } from './tac-airdrop.js';
import { makeConfidentialLockScan } from './confidential-lock-scan.js';
import { makeConfidentialBridgeMint } from './confidential-bridge-mint.js';
import { makeBridgeBurnBroadcaster } from './bridge-burn-broadcast.js';
import { signSchnorr, SECP_N } from './bulletproofs.js';
import { randomScalar, bppH, G as BPP_G } from './bulletproofs-plus.js';
import { hmac, sha256 as vendorSha256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialRecovery, privBytes, deriveOutputKeys } from './confidential-recovery.js';
import { makeImportedFarmStore } from './confidential-secret-store.js';
import { makeBtcHistoryProvider } from './confidential-recovery-btc.js';
import { makeCbtcNoteRecovery } from './cbtc-note-recovery.js';

let _externalTacHolders = () => [];
export function setExternalTacHolders(fn) { _externalTacHolders = typeof fn === 'function' ? fn : () => []; }

let _logDb = null;
function browserLogStore() {
  if (typeof indexedDB === 'undefined') return null;
  const open = () => (_logDb ||= new Promise((res, rej) => {
    const r = indexedDB.open('tacit-pool-logs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('q');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('log store blocked'));
  }));
  const run = (mode, fn) => open().then((db) => new Promise((res, rej) => {
    const t = db.transaction('q', mode), req = fn(t.objectStore('q'));
    t.oncomplete = () => res(req.result);
    t.onerror = t.onabort = () => rej(t.error);
  }));
  return { get: (k) => run('readonly', (st) => st.get(k)), put: (k, v) => run('readwrite', (st) => st.put(v, k)), del: (k) => run('readwrite', (st) => st.delete(k)) };
}

const _keyForgetters = new Set();
export function forgetKeys() {
  for (const forget of _keyForgetters) { try { forget(); } catch { } }
}

export function makeConfidentialPoolUx({ secp, keccak256, sha256, fetchImpl, network, logStore } = {}) {

  const cfg = getConfidentialDeployment(network);

  if (!cfg || !cfg.pool) throw new Error(`confidential pool not deployed on "${network || activeNetwork()}"`);

  const _fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);


  const evm = makeEvmAccount({ secp, keccak256, sha256 });

  const indexer = makeConfidentialIndexer({ secp, keccak256, sha256 });

  const evmLog = makeConfidentialEvmLog({ keccak256 });

  const memo = indexer._memo;

  const _ownKeys = new Map();

  const guard = makeRecoveryGuard({ memo, openKeyFor: (pub) => _ownKeys.get(String(pub).toLowerCase()) || null });

  const relay = makeConfidentialRelay({ base: cfg.relayBase, fetchImpl: _fetch, guard, checkEmittedMemos, saveMismatchedMemos });

  const SAVED_MEMOS_PREFIX = 'tacit:unrecoverable-memos:';

  function saveMismatchedMemos({ txHash, leaves, memos }) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(`${SAVED_MEMOS_PREFIX}${txHash}`, JSON.stringify({ leaves, memos, savedAt: Date.now() }));
  }

  function savedMemosByLeaf() {
    const byLeaf = new Map();
    try {
      if (typeof localStorage === 'undefined') return byLeaf;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(SAVED_MEMOS_PREFIX)) continue;
        let rec; try { rec = JSON.parse(localStorage.getItem(k)); } catch { continue; }
        if (!rec || !Array.isArray(rec.leaves) || !Array.isArray(rec.memos)) continue;
        rec.leaves.forEach((lf, j) => { if (typeof rec.memos[j] === 'string') byLeaf.set(String(lf).toLowerCase(), rec.memos[j]); });
      }
    } catch { }
    return byLeaf;
  }

  function withSavedMemos(events) {
    const saved = savedMemosByLeaf();
    if (!saved.size) return events;
    return events.map((ev) => {
      if (!ev || ev.type !== 'LeavesInserted' || !Array.isArray(ev.leaves) || !ev.leaves.some((lf) => saved.has(String(lf).toLowerCase()))) return ev;
      return { ...ev, memos: ev.leaves.map((lf, i) => saved.get(String(lf).toLowerCase()) ?? ev.memos[i]) };
    });
  }

  async function checkEmittedMemos({ txHash, leaves, memos }) {
    let receipt = null;
    for (let attempt = 0; attempt < 3 && !receipt; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
      try { receipt = await rpc('eth_getTransactionReceipt', [txHash]); } catch { }
    }
    if (!receipt || !Array.isArray(receipt.logs)) return { ok: null, mismatched: [], reason: 'receipt unavailable' };
    const emitted = new Map();
    for (const log of receipt.logs) {
      if (cfg.pool && String(log.address || '').toLowerCase() !== String(cfg.pool).toLowerCase()) continue;
      const ev = evmLog.decodeLog(log);
      if (!ev || ev.type !== 'LeavesInserted') continue;
      ev.leaves.forEach((lf, i) => emitted.set(String(lf).toLowerCase(), String(ev.memos[i] ?? '0x').toLowerCase()));
    }
    const norm = (m) => '0x' + String(m ?? '').replace(/^0x/, '').toLowerCase();
    const opensHere = (leaf, m) => [..._ownKeys.values()].some((priv) => !!memo.openMemo(priv, leaf, m));
    const mismatched = [];
    leaves.forEach((lf, i) => {
      const got = emitted.get(String(lf).toLowerCase());
      if (got !== undefined && (got === norm(memos[i]) || opensHere(lf, got))) return;
      mismatched.push({ index: i, leaf: lf, expected: norm(memos[i]), emitted: got ?? null });
    });
    return { ok: mismatched.length === 0, mismatched };
  }


  const _poolAssets = cfg.assets.filter((a) => a.assetId);

  const assetByTicker = Object.fromEntries(_poolAssets.map((a) => [a.ticker, a]));


  function account(walletPriv) { return evm.deriveEvmAccount(walletPriv, cfg.evmNetwork); }


  const RPC_COOL_MS = 60000;

  // Begin with bounded log ranges so public RPCs with small eth_getLogs windows can serve the first scan.
  const _eps = cfg.rpcs.map((url) => ({ url, coolUntil: 0, span: 1000 }));

  const _byHealth = () => { const now = Date.now(); return [..._eps.filter((e) => e.coolUntil <= now), ..._eps.filter((e) => e.coolUntil > now)]; };

  async function _post(ep, method, params, ms = 10000) {
    let r;
    try {
      r = await _fetch(ep.url, { method: 'POST', headers: { 'content-type': bodyType(ep.url) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw Object.assign(new Error((e && e.message) || String(e)), { kind: 'transport', timeout: !!e && (e.name === 'TimeoutError' || e.name === 'AbortError') });
    }
    let j = null;
    try { j = await r.json(); } catch { }
    if (j && j.error) {
      const msg = String(j.error.message || 'rpc error');
      throw Object.assign(new Error(msg), { kind: r.status === 429 || /rate limit|too many requests|usage limit|requests per/i.test(msg) ? 'busy' : 'rpc' });
    }
    if (!r.ok || !j) throw Object.assign(new Error(`rpc ${r.status}`), { kind: r.status === 429 ? 'busy' : 'http' });
    return j.result;
  }

  async function rpc(method, params, { retryPasses = 2 } = {}) {
    if (!_fetch) throw new Error('no fetch implementation');
    let lastErr;
    for (let pass = 0; pass < retryPasses; pass++) {
      if (pass > 0) await new Promise((res) => setTimeout(res, 400 * pass));
      for (const ep of _byHealth()) {
        try { return await _post(ep, method, params); } catch (e) { lastErr = e; if (e.kind !== 'rpc') ep.coolUntil = Date.now() + RPC_COOL_MS; }
      }
    }
    throw lastErr || new Error('all RPCs failed');
  }


  function ethCall(to, data) { return rpc('eth_call', [{ to: String(to).toLowerCase(), data }, 'latest']); }


  function _narrower(e, span) {
    if (e.kind === 'transport') return e.timeout && span > 2000 ? { span: Math.floor(span / 2) } : null;
    if (e.kind !== 'rpc') return null;
    const cap = e.message.match(/(?:max(?:imum)?\b\D{0,24}|\bover\s+|\bup to\s+|limited to\s+(?:a\s+)?)([\d,]{2,})/i);
    if (cap) { const n = Number(cap[1].replace(/,/g, '')); return n < span ? { span: n, cap: n } : null; }
    return /too (large|wide|big|many)|exceed|more than|response size/i.test(e.message) && span > 1 ? { span: Math.floor(span / 2) } : null;
  }

  async function _logsIn(params, from, to) {
    const out = [];
    for (let start = from, lastErr = null; start <= to;) {
      let got = null;
      for (let pass = 0; pass < 2 && !got; pass++) {
        if (pass > 0) await new Promise((res) => setTimeout(res, 400));
        const now = Date.now();
        const eps = _eps.map((e, i) => [e, i]).sort(([a, i], [b, j]) => (a.coolUntil > now) - (b.coolUntil > now) || (a.span < b.span) - (a.span > b.span) || i - j).map(([e]) => e);
        for (const ep of eps) {
          let span = Math.min(to - start + 1, ep.span);
          for (let tries = 0; tries < 16 && !got; tries++) {
            const end = start + span - 1;
            try {
              const logs = await _post(ep, 'eth_getLogs', [{ ...params, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }], 25000);
              got = { logs: Array.isArray(logs) ? logs : [], end };
            } catch (e) {
              lastErr = e;
              const n = _narrower(e, span);
              if (!n) { if (e.kind !== 'rpc') ep.coolUntil = Date.now() + RPC_COOL_MS; break; }
              if (n.cap) ep.span = Math.min(ep.span, n.cap);
              span = n.span;
            }
          }
          if (got) break;
        }
      }
      if (!got) throw lastErr || new Error('eth_getLogs: no endpoint answered');
      out.push(...got.logs);
      start = got.end + 1;
    }
    return out;
  }


  const FINAL = 64;

  const _logsCache = new Map();

  const _kept = logStore === undefined ? browserLogStore() : logStore;

  const _keptAt = new Map();

  const _qkey = (params, from) => `${cfg.chainId}|${String(cfg.pool).toLowerCase()}|${JSON.stringify(params.address)}|${JSON.stringify(params.topics)}|${from}`;

  const _blockOf = (l) => Number(BigInt(l.blockNumber));

  async function _leavesAddUp(params, from, logs, to) {
    const T = String(evmLog.TOPIC0.LeavesInserted).toLowerCase(), pool = String(cfg.pool).toLowerCase();
    const t0 = params.topics && params.topics[0];
    if (t0 != null && !(Array.isArray(t0) ? t0 : [t0]).some((t) => String(t).toLowerCase() === T)) return null;
    if (from > Number(cfg.deployBlock || 0)) return null;
    let next = 0;
    for (const l of logs) {
      if (String((l.topics || [])[0] || '').toLowerCase() !== T || String(l.address || pool).toLowerCase() !== pool) continue;
      const ev = evmLog.decodeLog(l);
      if (!ev || Number(ev.firstLeafIndex) !== next) return false;
      next += ev.leaves.length;
    }
    try { return next === Number(BigInt(await rpc('eth_call', [{ to: cfg.pool, data: '0x0be4f422' }, '0x' + to.toString(16)]))); } catch { return null; }
  }

  const _logsBusy = new Map();

  async function getLogsChunked(params, from, to) {
    const key = _qkey(params, from);
    for (let r; (r = _logsBusy.get(key)); ) await r.catch(() => {});
    const run = _getLogsChunked(params, from, to, key);
    _logsBusy.set(key, run);
    try { return await run; } finally { if (_logsBusy.get(key) === run) _logsBusy.delete(key); }
  }

  async function _getLogsChunked(params, from, to, key) {
    let cached = _logsCache.get(key);
    if (!cached && _kept) {
      const rec = await _kept.get(key).catch(() => null);
      if (rec && rec.v === 1 && Array.isArray(rec.logs) && Number.isFinite(rec.finalTo)) _logsCache.set(key, cached = { toBlock: rec.finalTo + FINAL, logs: rec.logs, stored: true });
    }
    if (cached && !cached.stored && to <= cached.toBlock - FINAL) return cached.logs.filter((l) => _blockOf(l) <= to);
    const walkFrom = cached ? Math.max(from, cached.toBlock - FINAL + 1) : from;
    let logs = [...(cached ? cached.logs.filter((l) => _blockOf(l) < walkFrom) : []), ...(await _logsIn(params, walkFrom, to))].filter((l) => _blockOf(l) <= to);
    let sound = true;
    if (cached && cached.stored && (await _leavesAddUp(params, from, logs, to)) === false) {
      logs = await _logsIn(params, from, to);
      sound = (await _leavesAddUp(params, from, logs, to)) !== false;
      if (_kept) _kept.del(key).catch(() => {});
    }
    _logsCache.set(key, { toBlock: to, logs });
    if (_kept && sound && Date.now() - (_keptAt.get(key) || 0) > 60000) {
      _keptAt.set(key, Date.now());
      _kept.put(key, { v: 1, finalTo: to - FINAL, logs: logs.filter((l) => _blockOf(l) <= to - FINAL) }).catch(() => {});
    }
    return logs;
  }

  async function headBlock() { return parseInt(await rpc('eth_blockNumber', []), 16); }

  async function fetchEvents({ fromBlock = cfg.deployBlock, toBlock = 'latest', include = [] } = {}) {
    const from = typeof fromBlock === 'number' ? fromBlock : parseInt(String(fromBlock), 16);
    const to = toBlock === 'latest' ? await headBlock() : (typeof toBlock === 'number' ? toBlock : parseInt(String(toBlock), 16));
    const inc = new Set(include);
    const T = evmLog.TOPIC0;
    const manager = cfg.farm && cfg.farm.manager ? String(cfg.farm.manager).toLowerCase() : null;
    const all = [T.LeavesInserted, T.NullifiersSpent, T.LockLeavesInserted, T.Wrap, T.CdpPositionInserted, T.CrossOutRecorded, ...(manager ? [T.Bonded, T.Harvested] : [])];
    const want = new Set([T.LeavesInserted, T.NullifiersSpent, T.LockLeavesInserted,
      ...(inc.has('wraps') ? [T.Wrap] : []), ...(inc.has('cdp') ? [T.CdpPositionInserted] : []), ...(inc.has('crossouts') ? [T.CrossOutRecorded] : []),
      ...(inc.has('bonds') && manager ? [T.Bonded, T.Harvested] : [])].map((t) => String(t).toLowerCase()));
    const managerTopics = new Set([T.Bonded, T.Harvested].map((t) => String(t).toLowerCase()));
    const poolLc = String(cfg.pool).toLowerCase();
    const logs = (await getLogsChunked({ address: manager ? [cfg.pool, cfg.farm.manager] : cfg.pool, topics: [all] }, from, to)).filter((l) => {
      const t = String((l.topics || [])[0] || '').toLowerCase(), a = String(l.address || '').toLowerCase();
      if (!want.has(t)) return false;
      if (managerTopics.has(t)) return !!manager && a === manager;
      return !inc.size || !a || a === poolLc;
    });
    return evmLog.decodeLogs(logs);
  }


  const lc = (h) => String(h == null ? '' : h).toLowerCase();

  const _cbtcRec = makeCbtcNoteRecovery({ hmac, sha256: vendorSha256, curveOrder: SECP_N });

  let _rec = null;

  const recovery = () => _rec || (_rec = makeConfidentialRecovery({
    pool, memo, keccak256, secp, hmac, sha256: vendorSha256, curveOrder: SECP_N, lockScan: _lockScan, airdrop: _airdrop, cdp: _cdp,
    bpp: { H: bppH(), G: BPP_G },
  }));

  const _rev = (h) => (String(h).replace(/^0x/, '').match(/../g) || []).reverse().join('');

  const _ckKey = (pubHex) => `tacit-memo-ck-v1:${network || activeNetwork()}:${_hex(sha256(new TextEncoder().encode('tacit-memo-ck-v1:' + lc(pubHex)))).slice(0, 32)}`;

  function _leavesDigest(leaves, upTo) {
    const enc = new TextEncoder();
    let h = new Uint8Array(32);
    for (let i = 0; i < upTo; i += 256) {
      let s = '';
      for (let j = i; j < Math.min(upTo, i + 256); j++) { const l = leaves[j]; s += lc(l.leaf) + '|' + (typeof l.memo === 'string' ? l.memo : JSON.stringify(l.memo ?? '')) + ';'; }
      const b = enc.encode(s), c = new Uint8Array(32 + b.length); c.set(h); c.set(b, 32);
      h = sha256(c);
    }
    return _hex(h);
  }

  function _loadMemoCk(key, leaves) {
    if (typeof localStorage === 'undefined') return null;
    try {
      const o = JSON.parse(localStorage.getItem(key) || 'null');
      if (!o || o.v !== 1 || !Number.isInteger(o.upTo) || o.upTo < 1 || o.upTo > leaves.length || !Array.isArray(o.mine)) return null;
      return o.digest === _leavesDigest(leaves, o.upTo) ? o : null;
    } catch { return null; }
  }

  function _saveMemoCk(key, leaves, found) {
    if (typeof localStorage === 'undefined' || !leaves.length) return;
    try { localStorage.setItem(key, JSON.stringify({ v: 1, upTo: leaves.length, digest: _leavesDigest(leaves, leaves.length), mine: found.map((n) => n.leafIndex) })); } catch {}
  }

  const _bridgeFound = new Map();

  const _bridgeFastTried = new Set();

  const _bridgeTried = new Set();

  // v2: a v1 set could hold leaves the search had found (it marked every leaf it searched), so a note it found was skipped on the next
  // page load and fell out of the balance; v1 is left unread, so each such leaf is searched once more.
  const _triedStoreKey = (wk, fast) => `tacit-bridge-tried-v2:${network || activeNetwork()}:${fast ? 'fast' : 'full'}:${wk}`;

  // A bridge mint the search found, kept per key: its leaf, value, asset, destination index and the burn's ν (no blinding, which is
  // derived from the key and ν). A later scan rebuilds each with one candidate instead of the whole search.
  const _foundStoreKey = (wk) => `tacit-bridge-found-v1:${network || activeNetwork()}:${wk}`;

  function _loadFoundHints(wk) {
    if (typeof localStorage === 'undefined') return new Map();
    try { return new Map((JSON.parse(localStorage.getItem(_foundStoreKey(wk)) || '[]') || []).filter((h) => h && h.leaf).map((h) => [lc(h.leaf), h])); } catch { return new Map(); }
  }

  function _saveFoundHints(wk, hints) {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(_foundStoreKey(wk), JSON.stringify([...hints.values()].slice(-512))); } catch {}
  }

  function _loadTried(wk, fast, sig, into) {
    if (typeof localStorage === 'undefined') return;
    try { const o = JSON.parse(localStorage.getItem(_triedStoreKey(wk, fast)) || 'null'); if (o && o.sig === sig) for (const lf of o.leaves || []) into.add(`${wk}:${sig}:${lf}`); } catch {}
  }

  function _saveTried(wk, fast, sig, from) {
    if (typeof localStorage === 'undefined') return;
    const pre = `${wk}:${sig}:`, leaves = [...from].filter((x) => x.startsWith(pre)).map((x) => x.slice(pre.length)).slice(-6000);
    try { localStorage.setItem(_triedStoreKey(wk, fast), JSON.stringify({ sig, leaves })); } catch {}
  }

  const _netName = network || activeNetwork();

  const _bridgeHintKeys = (pubHex) => {
    const p = lc(pubHex).replace(/^0x/, '');
    return { journal: `tacit-burndep-bridge-v1:${_netName}:${p}`, own: `tacit-bridge-amounts-v1:${_netName}:${p}` };
  };

  function _storedBridgeAmounts(pubHex) {
    if (typeof localStorage === 'undefined') return [];
    const k = _bridgeHintKeys(pubHex), out = [];
    const num = (v) => { const x = v && typeof v === 'object' ? v.__big : v; return /^\d+$/.test(String(x ?? '')) ? String(x) : null; };
    try { for (const r of JSON.parse(localStorage.getItem(k.journal) || '[]') || []) for (const v of [r?.source?.amount, r?.dest?.value]) { const x = num(v); if (x) out.push(x); } } catch {}
    try { for (const v of JSON.parse(localStorage.getItem(k.own) || '[]') || []) { const x = num(v); if (x) out.push(x); } } catch {}
    return out;
  }

  const _btcHistoryCache = new Map();

  const BTC_HISTORY_TTL_MS = 10 * 60 * 1000;

  function _defaultBtcHistory(priv) {
    const key = _hex(sha256(secp.getPublicKey(privBytes(priv), true)));
    const hit = _btcHistoryCache.get(key);
    if (hit && Date.now() - hit.at < BTC_HISTORY_TTL_MS) return hit.promise;
    const provider = makeBtcHistoryProvider({ fetchImpl: _fetch, sha256, hrp: Number(cfg.chainId) === 1 ? 'bc' : 'tb', store: _kept });
    const promise = provider.history(priv);
    const entry = { at: Date.now(), promise };
    _btcHistoryCache.set(key, entry);
    promise.catch(() => { entry.at = Date.now() - BTC_HISTORY_TTL_MS + 60000; });
    return promise;
  }

  const _lockVBtcCache = new Map();

  // The pool's record for many outputs at once, a multicall per 200: a wallet whose history holds many outputs shaped like a
  // lock (every Tacit note it was paid is one) costs a call or two, not a call each. A batch or call that fails is asked alone.
  async function _cbtcLockVBtcMany(outputs) {
    const sel = '0x' + _selector('cbtcLockVBtc(bytes32)');
    const rows = (outputs || []).map((o) => ({ txid: o.txid, vout: o.vout, outpoint: pool.outpointKey('0x' + _rev(o.txid), o.vout) }));
    const ask = [...new Set(rows.map((r) => r.outpoint).filter((op) => !_lockVBtcCache.has(op)))];
    for (let i = 0; i < ask.length; i += 200) {
      const part = ask.slice(i, i + 200);
      const got = await _multicall(part.map((op) => ({ to: cfg.pool, data: sel + _word(op) }))).catch(() => null);
      for (let j = 0; j < part.length; j++) {
        const r = got && got[j] != null ? got[j] : await ethCall(cfg.pool, sel + _word(part[j]));
        const vBtc = BigInt(r && r !== '0x' ? r : '0x0');
        if (vBtc > 0n) _lockVBtcCache.set(part[j], vBtc);
      }
    }
    return rows.map((r) => ({ ...r, vBtc: _lockVBtcCache.get(r.outpoint) || 0n }));
  }


  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

  async function _multicall(calls) {
    if (!calls.length) return [];
    const bodies = calls.map(({ to, data }) => {
      const d = String(data).replace(/^0x/, '');
      return _word(to) + _word(1n) + _word(0x60n) + _word(BigInt(d.length / 2)) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    });
    let off = calls.length * 32;
    const heads = bodies.map((b) => { const o = _word(BigInt(off)); off += b.length / 2; return o; });
    const out = String(await ethCall(MULTICALL3, '0x82ad56cb' + _word(0x20n) + _word(BigInt(calls.length)) + heads.join('') + bodies.join(''))).replace(/^0x/, '');
    const at = (i) => BigInt('0x' + (out.slice(i * 64, i * 64 + 64) || '0'));
    const arr = Number(at(0)) / 32;
    return calls.map((_, i) => {
      const e = arr + 1 + Number(at(arr + 1 + i)) / 32;
      if (at(e) !== 1n) return null;
      const b = e + Number(at(e + 1)) / 32, len = Number(at(b));
      return '0x' + out.slice(64 * (b + 1), 64 * (b + 1) + len * 2);
    });
  }


  const _knownAssets = (notes) => [...new Set([..._poolAssets.map((a) => a.assetId), ...notes.map((n) => n.asset)].map(lc))];


  const _spentDeposits = new Set();

  async function _stillWaiting(deposits) {
    const waiting = [];
    for (let i = 0; i < deposits.length; i += 8) {
      const part = deposits.slice(i, i + 8);
      const spent = await Promise.all(part.map(async (d) => {
        const k = lc(d.depositId);
        if (_spentDeposits.has(k)) return true;
        try {
          const r = await ethCall(cfg.pool, '0x' + _selector('depositStatus(bytes32)') + _word(d.depositId));
          if (r && r !== '0x' && BigInt(r) === 2n) { _spentDeposits.add(k); return true; }
        } catch { }
        return false;
      }));
      part.forEach((d, j) => { if (!spent[j]) waiting.push(d); });
    }
    return waiting;
  }


  // `recent`: a quick first read. With nothing kept for this key on this device (no valid memo checkpoint) only the newest `recent` leaves are
  // opened with the key, a note it made itself is found by derivation as ever (walkWraps), and nothing is kept as covered, so the full read that
  // follows still opens every older leaf. With a checkpoint it is ignored: the read is the same incremental one. `diag.quick` says it was one.
  async function _scanNotes({ walletPriv, events, deep = false, cbtc = true, btcHistory = null, bridge = true, bridgeAmounts = [], recent = 0 }) {
    const R = recovery();
    const id = identity(walletPriv);
    const { leaves, spent } = indexer.index(events);
    const tree = indexer.buildTree(leaves);
    const root = tree.root();
    const slot = new Map();
    leaves.forEach((l, i) => { if (l) slot.set(lc(l.leaf), i); });
    const nu = (n, leaf) => pool.nativeNu(n.owner, n.secret, leaf);
    const all = new Map();
    const diag = { errors: {} };
    const addDerived = (n, source, extra = {}) => {
      const lf = lc(n.leaf), leafIndex = slot.get(lf);
      if (leafIndex == null) return false;
      const held = all.get(lf);
      if (held) {
        if (held.inboundUnverified) { held.inboundUnverified = false; held.keyDerivedBy = source; }
        return false;
      }
      all.set(lf, { value: BigInt(n.value), blinding: n.blinding, secret: n.secret, asset: n.asset, owner: n.owner, cx: n.cx, cy: n.cy, leaf: n.leaf, leafIndex, nullifier: nu(n, n.leaf), source, ...extra });
      return true;
    };
    const _ck = _ckKey(id.pubHex), covered = deep ? null : _loadMemoCk(_ck, leaves);
    const quick = recent > 0 && !covered;
    if (quick) { cbtc = false; bridge = false; }       // a quick read leaves the long searches to the full read behind it
    const emptyLeaves = leaves.filter((l) => l && (!l.memo || l.memo === '0x'));
    diag.leaves = leaves.filter(Boolean).length; diag.emptyMemoLeaves = emptyLeaves.length;
    // The Bitcoin history the cBTC search reads is asked for now, while the pool's own steps run, and that search comes last: a
    // slow or rate-limited explorer holds back only cBTC notes, not the rest of the balance.
    const btcHist = cbtc && emptyLeaves.length
      ? Promise.resolve().then(() => (typeof btcHistory === 'function' ? btcHistory(id.priv) : (btcHistory || _defaultBtcHistory(id.priv))))
      : null;
    if (btcHist) btcHist.catch(() => {});

    const held = leaves.filter(Boolean);
    const fromMemos = await memo.scanSliced(_scanKeyHex(id.priv), quick ? held.slice(-recent) : held, [], nu, { covered });
    if (!quick) _saveMemoCk(_ck, leaves, fromMemos);
    diag.quick = quick;
    for (const n of fromMemos) all.set(lc(n.leaf), { ...n, inboundUnverified: true });
    diag.memoNotes = all.size;

    diag.wrap = { found: 0, pending: [], unsettled: [], scanned: [], truncated: [] };
    try {
      const w = R.walkWraps({ priv: id.priv, events, assets: [...new Map(_poolAssets.map((a) => [lc(a.assetId), a])).values()], minIndex: (assetId) => _wrapIndexHint(id.pubHex, assetId) });
      diag.wrap.scanned = w.scanned;
      diag.wrap.truncated = w.scanned.filter((s) => s.stoppedAtMaxIndex).map((s) => s.assetId);
      const wrapTx = new Map((events || []).filter((e) => e && e.type === 'Wrap' && e.txHash).map((e) => [lc(e.depositId), e.txHash]));
      for (const n of w.found) {
        if (slot.has(lc(n.leaf))) { if (addDerived(n, 'wrap', { wrapIndex: n.index })) diag.wrap.found++; }
        else if (!all.has(lc(n.leaf))) diag.wrap.unsettled.push({ index: n.index, asset: n.asset, value: n.value, depositId: n.depositId, txHash: wrapTx.get(lc(n.depositId)) || null });
      }
    } catch (e) { diag.errors.wrap = String(e && e.message || e); }
    diag.wrap.pending = await _stillWaiting(diag.wrap.unsettled);

    const tx = R.txIndex(events);
    const unexplained = () => emptyLeaves.filter((l) => !all.has(lc(l.leaf)));

    diag.bridge = { attempted: false, found: 0, unexplainedLeaves: 0, unsearchedLeaves: 0, candidatesTried: 0 };
    const fast = !deep;
    const amounts = [...new Set([...(bridgeAmounts || []), ..._storedBridgeAmounts(id.pubHex)].map((v) => { try { return BigInt(v); } catch { return 0n; } }).filter((v) => v > 0n).map(String))].sort();
    diag.bridge.amountsTried = amounts.length;
    {
      // With `bridge: false` (a read that must be quick) the notes this key has already found are still applied, from memory or its kept hints (one
      // candidate each); only the search for new ones is left out. A round-amount bridge note has no memo, so it appears nowhere else.
      const todo = new Map();
      const wk = lc(id.pubHex);
      const triedSet = fast ? _bridgeFastTried : _bridgeTried;
      const triedKey = (lf) => `${wk}:${amounts.join(',')}:${lf}`;
      _loadTried(wk, fast, amounts.join(','), triedSet);
      const hints = _loadFoundHints(wk), rebuild = new Map();
      const keep = (n) => {
        _bridgeFound.set(wk + ':' + lc(n.leaf), n);
        hints.set(lc(n.leaf), { leaf: lc(n.leaf), value: String(n.value), asset: n.asset, destIndex: Number(n.destIndex) || 0, burnNullifier: n.burnNullifier });
        if (addDerived(n, 'bridge-mint', { burnNullifier: n.burnNullifier })) diag.bridge.found++;
      };
      for (const l of unexplained()) {
        const lf = lc(l.leaf);
        const kept = _bridgeFound.get(wk + ':' + lf);
        if (kept) { if (addDerived(kept, 'bridge-mint', { burnNullifier: kept.burnNullifier })) diag.bridge.found++; continue; }
        const t = tx.txOfLeaf.get(lf);
        if (!t || !(tx.nullifiersOfTx.get(t) || []).length) continue;
        if (hints.has(lf)) { if (!rebuild.has(t)) rebuild.set(t, []); rebuild.get(t).push(lf); continue; }
        if (triedSet.has(triedKey(lf))) continue;
        if (!todo.has(t)) todo.set(t, []);
        todo.get(t).push(lf);
      }
      // What this key found before: one candidate each (its own value, asset and index), not the whole search.
      if (rebuild.size) {
        try {
          const hs = [...rebuild.values()].flat().map((lf) => hints.get(lf));
          const r = await R.walkBridgeMints({ priv: id.priv, tx, unexplained: rebuild, assets: [...new Map(hs.map((h) => [lc(h.asset), { assetId: h.asset }])).values()],
            values: [...new Set(hs.map((h) => h.value))].map((v) => BigInt(v)), roundValues: false, destIndexes: Math.max(...hs.map((h) => h.destIndex)) + 1, maxNullifiers: 4096 });
          const got = new Set(r.found.map((n) => lc(n.leaf)));
          for (const n of r.found) keep(n);
          // a hint that no longer rebuilds is dropped, and its leaf searched as any other
          for (const [t, lfs] of rebuild) for (const lf of lfs) if (!got.has(lf)) { hints.delete(lf); if (!todo.has(t)) todo.set(t, []); todo.get(t).push(lf); }
        } catch (e) { diag.errors.bridge = String(e && e.message || e); }
      }
      diag.bridge.unexplainedLeaves = [...todo.values()].reduce((sN, a) => sN + a.length, 0);
      if (!bridge) { diag.bridge.searchSkipped = true; todo.clear(); }
      if (todo.size) {
        diag.bridge.attempted = true;
        try {
          const assets = [...new Map(_poolAssets.filter((a) => a.bitcoinLink && (!fast || a.ticker === 'TAC' || a.ticker === 'cTAC')).map((a) => [lc(a.assetId), { assetId: a.assetId }])).values()];
          const walk = (unexplained, maxNullifiers) => R.walkBridgeMints({ priv: id.priv, tx, unexplained, assets, values: amounts.map((v) => BigInt(v)), destIndexes: fast ? 1 : 8, maxExp: fast ? 15 : 18, maxNullifiers });
          // The fast search goes newest first in slices of about 48 nullifiers, each kept as it ends (leaves tried, notes found),
          // so a page closed part way through carries on from there next time.
          const slices = [];
          if (fast) {
            let part = [], n = 0, total = 0;
            for (const g of [...todo].reverse()) {
              const k = (tx.nullifiersOfTx.get(g[0]) || []).length;
              if (total + k > 4096) break;
              if (part.length && n + k > 48) { slices.push([part, n]); part = []; n = 0; }
              part.push(g); n += k; total += k;
            }
            if (part.length) slices.push([part, n]);
          } else slices.push([[...todo].reverse(), 16]);
          const covered = new Set();
          for (const [part, budget] of slices) {
            const slice = new Map([...part].reverse());
            const r = await walk(slice, budget);
            for (const t of (r.searched || slice.keys())) covered.add(t);
            diag.bridge.candidatesTried += r.tried;
            const got = new Set(r.found.map((n) => lc(n.leaf)));
            for (const n of r.found) keep(n);
            // only a leaf searched and not found is marked tried; a found one is kept above and rebuilt on the next scan
            for (const [t, lfs] of slice) if (!r.searched || r.searched.has(t)) for (const lf of lfs) if (!got.has(lf)) triedSet.add(triedKey(lf));
            _saveTried(wk, fast, amounts.join(','), triedSet);
            _saveFoundHints(wk, hints);
          }
          // The leaves whose transactions the search did not get to (the deep search reads 16 nullifiers; the fast one up to 4,096): said, so a read is not called complete over them.
          diag.bridge.unsearchedLeaves = [...todo].filter(([t]) => !covered.has(t)).reduce((sN, [, a]) => sN + a.length, 0);
        } catch (e) { diag.errors.bridge = String(e && e.message || e); }
      }
      _saveFoundHints(wk, hints);
    }

    diag.cbtc = { attempted: false, found: 0, anchors: 0, lockOutputs: 0, locksRecorded: 0 };
    if (btcHist && unexplained().length) {
      diag.cbtc.attempted = true;
      try {
        const h = await btcHist;
        const seenA = new Set(), anchors = [];
        for (const a of h.anchors || []) { const k = `${a.txid}:${a.vout}`; if (!seenA.has(k)) { seenA.add(k); anchors.push(a); } }
        diag.cbtc.anchors = anchors.length; diag.cbtc.lockOutputs = (h.lockOutputs || []).length;
        const locks = (await _cbtcLockVBtcMany(h.lockOutputs)).filter((r) => r.vBtc > 0n);
        diag.cbtc.locksRecorded = locks.length;
        const cbtcNotes = R.scanCbtcNotes({ priv: id.priv, anchors, locks, cbtcAsset: pool.CBTC_ZK_ASSET_ID, slotOf: (lf) => (slot.has(lc(lf)) ? slot.get(lc(lf)) : null), rec: _cbtcRec });
        for (const n of cbtcNotes) if (addDerived(n, 'cbtc', { lockOutpoint: n.lockOutpoint })) diag.cbtc.found++;
      } catch (e) { diag.errors.cbtc = String(e && e.message || e); }
    }

    diag.change = { attempted: false, found: 0, skipped: [] };
    if (deep) {
      diag.change.attempted = true;
      try {
        const parents = [...all.values()].map((n) => ({ ...n, nullifier: n.nullifier }));
        const getTxInput = async (h) => { const t = await rpc('eth_getTransactionByHash', [h]); return t && t.input; };
        const c = await R.walkChange({ parents, tx, knownLeaves: new Set(all.keys()), getTxInput });
        diag.change.skipped = c.skipped;
        for (const n of c.found) if (addDerived(n, 'change', { parentLeaf: n.parentLeaf })) diag.change.found++;
      } catch (e) { diag.errors.change = String(e && e.message || e); }
    }

    diag.derived = { attempted: false, found: 0, skipped: [], depositsLocated: 0 };
    if (deep) {
      diag.derived.attempted = true;
      try {
        const getTxInput = async (h) => { const t = await rpc('eth_getTransactionByHash', [h]); return t && t.input; };
        const pendingDeposits = diag.wrap.unsettled.map((d) => ({ depositId: d.depositId, asset: d.asset, value: d.value }));
        const at = pendingDeposits.length ? await R.locateDepositTx({ deposits: pendingDeposits, events, getTxInput }) : new Map();
        const deposits = pendingDeposits.map((d) => ({ ...d, txHash: at.get(lc(d.depositId)) || null })).filter((d) => d.txHash);
        diag.derived.depositsLocated = deposits.length;
        const d = await R.walkDerivedOutputs({
          priv: id.priv, parents: [...all.values()], deposits, tx, knownLeaves: new Set(all.keys()), getTxInput,
          assets: _knownAssets([...all.values()]), lpShareOf: (pid) => _lp.lpShareId(pid),
        });
        diag.derived.skipped = d.skipped;
        for (const n of d.found) if (addDerived(n, 'derived', { role: n.role, roleIndex: n.index })) diag.derived.found++;
      } catch (e) { diag.errors.derived = String(e && e.message || e); }
    }

    const owned = [...all.values()].sort((a, b) => a.leafIndex - b.leafIndex);
    const notes = owned.filter((n) => !spent.has(lc(n.nullifier))).map((n) => ({ ...n, path: tree.rootAndPath(n.leafIndex).path, root }));
    diag.unattributedEmptyLeaves = unexplained().map((l) => ({ leafIndex: l.leafIndex, leaf: l.leaf }));
    diag.inboundUnverified = notes.filter((n) => n.inboundUnverified).length;
    return { notes, owned, tree, root, slot, spent, leaves, tx, diag, id };
  }


  async function balance(scanPriv, opts) {
    const o = opts || {};
    const events = withSavedMemos(await fetchEvents({ fromBlock: o.fromBlock, toBlock: o.toBlock, include: o.positions ? ['wraps', 'bonds'] : ['wraps'] }));
    const st = await _scanNotes({ walletPriv: scanPriv, events, cbtc: o.cbtc !== false, btcHistory: o.btcHistory || null, bridge: o.bridge !== false, bridgeAmounts: o.bridgeAmounts || [], recent: o.recent || 0 });
    const notes = st.notes;
    const byAsset = {};
    for (const n of notes) {
      const id = String(n.asset || '').toLowerCase();
      (byAsset[id] ||= { asset: id, ticker: tickerOf(id), value: 0n, notes: [] });
      byAsset[id].value += BigInt(n.value);
      byAsset[id].notes.push(n);
    }
    const ctac = assetByTicker.cTAC;
    if (ctac && ctac.assetId && o.fromBlock == null && o.toBlock == null) {
      const held = byAsset[String(ctac.assetId).toLowerCase()];
      _privateTacWei = held ? held.value * BigInt(ctac.unitScale || '1') : 0n;
      if (ctac.underlying) {
        try {
          let ext = [];
          try { ext = _externalTacHolders() || []; } catch {}
          const addrs = [...new Set([account(scanPriv).address, ...ext]
            .map((a) => String(a || '').toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
          let sum = 0n;
          for (const a of addrs) sum += BigInt((await ethCall(ctac.underlying, '0x70a08231' + a.slice(2).padStart(64, '0'))) || '0x0');
          _accountTacWei = sum;
        } catch { }
      }
    }
    const out = { notes, byAsset, poolStats: poolStatsFromEvents(events), diag: st.diag, leafCount: st.leaves.length, reading: !!(st.diag && st.diag.quick) };
    if (o.spent) out.spentNotes = (st.owned || []).filter((n) => st.spent.has(lc(n.nullifier))).map((n) => ({ nullifier: n.nullifier, asset: n.asset, value: n.value, owner: n.owner }));
    if (o.positions && !out.reading && cfg.farm && cfg.farm.manager && o.fromBlock == null && o.toBlock == null) {
      out.diag = { ...st.diag, errors: { ...((st.diag && st.diag.errors) || {}) } };
      try { out.farmPositions = await farmPositions({ walletPriv: scanPriv, events, _scan: st, _diag: {} }); }
      catch (e) { out.diag.errors.farm = String((e && e.message) || e); }
    }
    return out;
  }


  function poolStatsFromEvents(events) {
    let totalNotesCreated = 0, totalNullifiersSpent = 0;
    for (const e of events || []) {
      if (e.type === 'LeavesInserted') {
        const end = Number(e.firstLeafIndex) + (e.leaves ? e.leaves.length : 0);
        if (end > totalNotesCreated) totalNotesCreated = end;
      } else if (e.type === 'NullifiersSpent') {
        totalNullifiersSpent += (e.nullifiers ? e.nullifiers.length : 0);
      }
    }
    return { totalNotesCreated, totalNullifiersSpent, outstandingNotes: Math.max(0, totalNotesCreated - totalNullifiersSpent) };
  }


  function tickerOf(assetIdHex) {
    const id = String(assetIdHex || '').toLowerCase();
    const a = cfg.assets.find((x) =>
      (x.assetId && x.assetId.toLowerCase() === id)
      || (x.bitcoinLink && x.bitcoinLink.toLowerCase() === id));
    return a ? a.ticker : null;
  }

  function poolTickerOf(assetIdHex) {
    const id = lc(assetIdHex);
    if (cfg.farm && cfg.farm.rewardAsset && id === lc(cfg.farm.rewardAsset)) return 'cTAC';
    const rows = cfg.assets.filter((x) => (x.assetId && lc(x.assetId) === id) || (x.bitcoinLink && lc(x.bitcoinLink) === id));
    const row = rows.find((x) => RELAY_FEE_ASSETS[x.ticker]) || rows.find((x) => /^c/.test(x.ticker)) || rows[0];
    return row ? row.ticker : null;
  }


  const evmTx = makeEvmTx({ secp, keccak256 });

  const pool = indexer._pool;

  const _lp = makeConfidentialLp({
    keccak256,
    pool,
    kernelSign: (a) => _ct.kernelSign(a),
    rangeProve: (...a) => _ct.rangeProve(...a),
  });

  const _cdp = makeConfidentialCdp({ keccak256, pool, signSchnorr });


  const _hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

  const _word = (v) => (typeof v === 'bigint' ? v.toString(16) : String(v).replace(/^0x/, '')).padStart(64, '0');

  const _b32b = (h) => { const s = String(h).replace(/^0x/, '').padStart(64, '0'); const o = new Uint8Array(32); for (let i = 0; i < 32; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };

  const _pad32 = (h, what) => { const s = String(h == null ? '' : h).replace(/^0x/, ''); if (/[^0-9a-fA-F]/.test(s) || s.length > 64) throw new Error(`transfer: ${what} not a ≤32-byte hex value (${h})`); return '0x' + s.padStart(64, '0'); };

  const _evmAddr = (a, what) => {
    let s = String(a == null ? '' : a).trim();
    if (s && !s.startsWith('0x') && !s.startsWith('0X')) s = '0x' + s;
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`${what}: "${a}" is not a valid Ethereum address (need 0x + 40 hex digits)`);
    return s.toLowerCase();
  };

  const _rootFromPath = (leafHex, index, path) => {
    let h = _b32b(leafHex);
    for (let i = 0; i < path.length; i++) {
      const sib = _b32b(path[i]);
      const pair = new Uint8Array(64);
      if (((index >>> i) & 1) === 0) { pair.set(h, 0); pair.set(sib, 32); } else { pair.set(sib, 0); pair.set(h, 32); }
      h = keccak256(pair);
    }
    return '0x' + _hex(h);
  };

  const _selector = (sig) => _hex(keccak256(new TextEncoder().encode(sig)).subarray(0, 4));


  const freshEph = () => randomScalar();


  const deriveOutput = (walletPriv, anchor, role, index = 0) => deriveOutputKeys({ hmac, sha256: vendorSha256, curveOrder: SECP_N }, walletPriv, anchor, role, index);

  const _lockLeafOf = (r) => r.leaf || r.lockLeaf || _stealth.stealthLockLeafBlind(r.asset, r.lCx, r.lCy, r.ownerPub, r.deadline, r.refundPub);

  const _noteAnchor = (n, id) => {
    const owner = n.owner || id.owner;
    return pool.nativeNu(owner, n.secret, pool.leaf(n.asset, n.cx, n.cy, owner));
  };


  function identity(walletPriv) {
    const priv = walletPriv instanceof Uint8Array
      ? walletPriv
      : Uint8Array.from((String(walletPriv).replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)));
    const pub = secp.getPublicKey(priv, true);
    _ownKeys.set('0x' + _hex(pub), '0x' + _hex(priv));
    const tag = new TextEncoder().encode('tacit-evm-cnote-secret-v1');
    const buf = new Uint8Array(priv.length + tag.length); buf.set(priv); buf.set(tag, priv.length);
    const secret = '0x' + _hex(keccak256(buf));
    return { priv, pubHex: '0x' + _hex(pub), owner: pool.nkToOwner(secret), secret };
  }


  function buildWrap({ walletPriv, amountWei, ticker = 'cETH', index = 0 }) {
    const meta = assetByTicker[ticker];
    if (!meta) throw new Error(`unknown asset ${ticker}`);
    const amount = BigInt(amountWei);
    const unitScale = BigInt(meta.unitScale);
    if (amount <= 0n || amount % unitScale !== 0n) throw new Error('amount not aligned to unitScale');
    return _wrapOf({ walletPriv, meta, value: amount / unitScale, amount, index });
  }

  function _wrapOf({ walletPriv, meta, value, amount, index }) {
    if (value > (2n ** 64n - 1n)) throw new Error('value exceeds u64');

    const id = identity(walletPriv);
    const { secret, blinding } = pool.deriveNote(id.priv, meta.assetId, index);
    const owner = pool.nkToOwner(secret);
    const blindingHex = '0x' + BigInt(blinding).toString(16).padStart(64, '0');
    const { cx, cy } = pool.commitXY(value, blindingHex);
    const leaf = pool.leaf(meta.assetId, cx, cy, owner);
    const commit = pool.depositCommit(cx, cy, owner);
    const depositId = pool.depositId(meta.assetId, value, cx, cy, owner);
    const cb = chainBindingHex();
    const wrapCtx = pool.intentContext('tacit-wrap-intent-v1', cb, meta.assetId, depositId,
      [[cx, cy, owner]], [value]);
    const wrapNonce = pool.deriveOpeningNonce(blindingHex, wrapCtx, 'wrap');
    const wrapSig = pool.openingSigma(value, blindingHex, wrapCtx, wrapNonce);
    const note = { value: value.toString(), blinding: blindingHex, secret, asset: meta.assetId, owner, cx, cy };

    const ephRand = freshEph;
    const outputs = [{ ...note, ownerPub: id.pubHex }];
    const memos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves: [leaf], outputs, memos });
    const memoHex = memos[0];

    const calldata = '0x' + _selector('wrap(bytes32,uint256,bytes32)')
      + _word(meta.assetId) + _word(amount) + _word(commit);

    return {
      note, leaf, depositId, commit, memo: memoHex, memos, outputs, ephRand, index,
      wrapOp: { chainBinding: cb, asset: meta.assetId, value: value.toString(), cx, cy, owner,
        sigR: wrapSig.R, sigZ: wrapSig.z },
      to: cfg.pool, amount: amount.toString(), calldata,
      wrapArgs: { assetId: meta.assetId, amount: amount.toString(), commit },
    };
  }


  async function submitWrapSettle({ built, waitOpts, depositTx = null, selfSettle = null } = {}) {
    if (!built || !built.wrapOp) throw new Error('submitWrapSettle: pass the buildWrap() result');
    const spec = { type: 'wrap', op: built.wrapOp, leaves: [built.leaf], outputs: built.outputs, memos: built.memos, ephRand: built.ephRand };
    if (selfSettle) {
      // The deposit's transaction rides on the proof request too: the relay counts a wrap whose deposit tipped it as paid work, and a
      // proof asked for without it draws on the relay's free proofs, which run out for the day.
      const proven = await relay.prove(depositTx ? { ...spec, depositTx } : spec, waitOpts);
      if (proven.status === 'settled') return proven;
      const memos = proven.memos || built.memos;
      const sent = await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos });
      return relay.verifyEmittedMemos({ jobId: proven.jobId, status: 'settled', ...sent }, [built.leaf], memos);
    }
    const sub = await relay.submitOp({ ...spec, mode: 'settle', depositTx }, waitOpts);
    const st = sub.status === 'settled' ? { jobId: sub.jobId, ...sub } : await relay.waitForSettle(sub.jobId, waitOpts).catch((e) => { throw _sealedOpen(e, sub.sealedMemos, [built.leaf]); });
    return relay.verifyEmittedMemos(st, [built.leaf], sub.sealedMemos);
  }


  const _reservedWrapIndex = new Map();

  const WRAP_INDEX_HINT_PREFIX = 'tacit:next-wrap-index:';

  const _wrapHintKey = (pubHex, assetId) => `${WRAP_INDEX_HINT_PREFIX}${pubHex}:${String(assetId).toLowerCase()}`;

  function _wrapIndexHint(pubHex, assetId) {
    const key = _wrapHintKey(pubHex, assetId);
    let n = 0;
    try { n = Math.max(0, parseInt(localStorage.getItem(key), 10) || 0); } catch { }
    for (const i of _reservedWrapIndex.get(key) || []) n = Math.max(n, i + 1);
    return n;
  }

  async function wrapLogs(assetId) {
    const head = await headBlock();
    if (!Number.isFinite(head)) throw new Error('no head block');
    return getLogsChunked({ address: cfg.pool, topics: [evmLog.TOPIC0.Wrap, null, String(assetId).toLowerCase()] }, Number(cfg.deployBlock || 0), head);
  }

  async function nextWrapIndex({ walletPriv, ticker = 'cETH' } = {}) {
    const meta = assetByTicker[ticker];
    if (!meta) throw new Error(`unknown asset ${ticker}`);
    const id = identity(walletPriv);
    const assetId = String(meta.assetId).toLowerCase();
    const unitScale = BigInt(meta.unitScale);
    let events;
    try {
      events = evmLog.decodeLogs(await wrapLogs(assetId)).filter((e) => e.type === 'Wrap');
    } catch (e) {
      throw new Error(`nextWrapIndex: could not read this asset's wrap deposits (${e && e.message ? e.message : e}); retry, or pass an explicit index`);
    }
    const known = new Set(events.map((e) => String(e.depositId).toLowerCase()));
    const values = [...new Set(events.filter((e) => e.amount % unitScale === 0n).map((e) => e.amount / unitScale))];
    const hintKey = _wrapHintKey(id.pubHex, assetId);
    const start = _wrapIndexHint(id.pubHex, assetId);
    const taken = _reservedWrapIndex.get(hintKey) || new Set();
    for (let i = start; ; i++) {
      if (taken.has(i)) continue;
      const { secret, blinding } = pool.deriveNote(id.priv, meta.assetId, i);
      const owner = pool.nkToOwner(secret);
      const blindingHex = '0x' + BigInt(blinding).toString(16).padStart(64, '0');
      const used = values.some((v) => {
        const { cx, cy } = pool.commitXY(v, blindingHex);
        return known.has(String(pool.depositId(meta.assetId, v, cx, cy, owner)).toLowerCase());
      });
      if (used) continue;
      taken.add(i);
      _reservedWrapIndex.set(hintKey, taken);
      try { localStorage.setItem(hintKey, String(i + 1)); } catch { }
      return i;
    }
  }

  // Recovery from the key alone walks wrap indexes and stops after 24 in a row with no deposit, so an index reserved for a
  // deposit that was never sent (the wallet prompt was declined) is handed back, or enough cancelled tries would put a later
  // deposit out of its reach. Only the newest reservation can be returned: the hint is the next index to try.
  function releaseWrapIndex({ walletPriv, ticker = 'cETH', index } = {}) {
    const meta = assetByTicker[ticker];
    if (!meta || !Number.isInteger(index) || index < 0) return;
    const key = _wrapHintKey(identity(walletPriv).pubHex, String(meta.assetId).toLowerCase());
    const taken = _reservedWrapIndex.get(key);
    if (taken && taken.delete(index) && !taken.size) _reservedWrapIndex.delete(key);
    try { if (parseInt(localStorage.getItem(key), 10) === index + 1) localStorage.setItem(key, String(index)); } catch { }
  }


  async function _priorityTip() {
    const CAP = 1500000000n;
    try {
      const t = BigInt(await rpc('eth_maxPriorityFeePerGas', []));
      if (t > 0n) return t < CAP ? t : CAP;
      return 100000000n;
    } catch { return CAP; }
  }

  async function _sendEvmTx({ acct, to, value = 0n, data, gasLimit, nonce, send = true }) {
    const n = nonce != null ? BigInt(nonce) : BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = await _priorityTip();
    const base = BigInt(await rpc('eth_gasPrice', []) || '0x3b9aca00');
    const tx = { chainId: BigInt(cfg.chainId), nonce: n, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip,
      gasLimit: BigInt(gasLimit), to, value: BigInt(value), data };
    if (send) {
      const need = tx.gasLimit * tx.maxFeePerGas + tx.value;
      const have = BigInt(await rpc('eth_getBalance', [acct.address, 'latest']));
      if (have < need) throw new Error(`insufficient ETH for gas: ${acct.address} holds ${have} wei and this transaction reserves ${need} wei up front (gas limit x max fee + value)`);
      const hexq = (v) => '0x' + BigInt(v).toString(16);
      let why = null;
      try { await rpc('eth_call', [{ from: acct.address, to, value: hexq(tx.value), data, gas: hexq(tx.gasLimit) }, 'latest']); }
      catch (e) { const m = String((e && e.message) || e); if (/revert|out of gas|gas required exceeds/i.test(m)) why = m; }
      if (why) {
        const err = new Error(`this transaction would fail on chain, so it was not sent (${why.slice(0, 160)})`);
        err.wouldRevert = true;
        throw err;
      }
    }
    const signed = evmTx.signEip1559(tx, acct.priv);
    const txHash = send ? await rpc('eth_sendRawTransaction', [signed.raw]) : null;
    return { txHash, nonce: n, signedRaw: signed.raw };
  }

  async function _waitReceipt(txHash, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const r = await rpc('eth_getTransactionReceipt', [txHash]);
      if (r && r.blockNumber) {
        if (r.status === '0x0') {
          const err = new Error(`transaction ${txHash} reverted on chain, so it changed nothing`);
          err.reverted = true; err.receipt = r;
          throw err;
        }
        return r;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error(`receipt timeout ${txHash}`);
  }


  function lpBondPosition({ walletPriv, controller, lpAsset, anchorLeaf }) {
    if (!controller || !lpAsset || !anchorLeaf) throw new Error('lp-bond: position needs controller, lpAsset and anchorLeaf');
    const id = identity(walletPriv);
    const hb = (h, n) => Uint8Array.from((String(h).replace(/^0x/, '').padStart(n * 2, '0').match(/../g) || []).map((x) => parseInt(x, 16)));
    const enc = new TextEncoder();
    const body = [hb(String(controller).replace(/^0x/, '').slice(-40), 20), hb(lpAsset, 32), hb(anchorLeaf, 32)];
    const tagged = (tag) => {
      const t = enc.encode(tag);
      const m = new Uint8Array(t.length + id.priv.length + 84); m.set(t); m.set(id.priv, t.length); let o = t.length + id.priv.length;
      for (const x of body) { m.set(x, o); o += x.length; }
      return keccak256(m);
    };
    let d = 0n; for (const x of tagged('tacit-evm-lp-bond-receipt-key-v1')) d = (d << 8n) | BigInt(x);
    d %= SECP_N; if (d === 0n) d = 1n;
    const ownerPriv = '0x' + d.toString(16).padStart(64, '0');
    const owner = '0x' + _hex(secp.getPublicKey(hb(ownerPriv, 32), true).subarray(1));
    const nonce = '0x' + _hex(tagged('tacit-evm-lp-bond-nonce-v1'));
    return { owner, ownerPriv, nonce };
  }


  const _farmCfg = () => {
    if (!cfg.farm || !cfg.farm.manager) throw new Error('farm: no farm program on this network');
    return cfg.farm;
  };

  const _farmC32 = (manager) => '0x' + '00'.repeat(12) + String(manager).replace(/^0x/, '').toLowerCase();

  const _scanKeyHex = (p) => (p instanceof Uint8Array ? '0x' + _hex(p) : (String(p).startsWith('0x') ? String(p) : '0x' + String(p)));

  const _noteLeaf = (n) => pool.leaf(n.asset, n.cx, n.cy, n.owner);

  function farmProgram() {
    return makeConfidentialFarmProgram({ rpc, config: { pool: cfg.pool, ..._farmCfg() } });
  }


  async function farmPositions({ walletPriv, events, _scan = null, _diag = null } = {}) {
    const farm = _farmCfg();
    const lpAssets = new Set((farm.pools || []).map((p) => String(p.lpAsset).toLowerCase()));
    const evs = events || await fetchEvents({ include: ['wraps', 'bonds'] });
    const st = _scan || await _scanNotes({ walletPriv, events: evs, cbtc: false, bridge: false });
    const { slot } = st;
    const c32 = _farmC32(farm.manager);
    const hits = new Map();
    const held = st.owned.filter((n) => lpAssets.has(String(n.asset).toLowerCase()));
    for (const n of held) {
      const lpAsset = String(n.asset).toLowerCase();
      const anchorLeaf = _noteLeaf(n);
      const { owner, nonce } = lpBondPosition({ walletPriv, controller: farm.manager, lpAsset, anchorLeaf });
      const receiptLeaf = pool.farmReceiptLeaf(c32, lpAsset, BigInt(n.value), owner, nonce);
      const receiptIndex = slot.get(receiptLeaf.toLowerCase());
      if (receiptIndex != null) hits.set(receiptLeaf.toLowerCase(), { lpAsset, anchorLeaf, receiptLeaf, receiptIndex, via: 'lp-note' });
    }
    const bonded = evs.filter((e) => e && e.type === 'Bonded');
    const derived = recovery().deriveFarmPositions({
      bonded, pools: farm.pools || [], anchors: st.owned.map((n) => ({ leaf: _noteLeaf(n) })), manager: farm.manager,
      lpBondPosition: ({ controller, lpAsset, anchorLeaf }) => lpBondPosition({ walletPriv, controller, lpAsset, anchorLeaf }),
    });
    for (const d of derived.found) {
      const receiptIndex = slot.get(d.receiptLeaf);
      if (receiptIndex != null && !hits.has(d.receiptLeaf)) hits.set(d.receiptLeaf, { lpAsset: d.lpAsset, anchorLeaf: d.anchorLeaf, receiptLeaf: d.receiptLeaf, receiptIndex, via: 'bonded-event' });
    }
    const imported = [];
    for (const rec of await _importedFarmRecords(walletPriv)) {
      const receiptIndex = slot.get(String(rec.receiptLeaf).toLowerCase());
      if (receiptIndex == null || hits.has(String(rec.receiptLeaf).toLowerCase())) continue;
      hits.set(String(rec.receiptLeaf).toLowerCase(), { lpAsset: rec.lpAsset, anchorLeaf: null, receiptLeaf: rec.receiptLeaf, receiptIndex, via: 'imported-record' });
      imported.push(rec.receiptLeaf);
    }
    const prog = farmProgram();
    const list = [...hits.values()];
    const live = await Promise.all(list.map((h) => prog.position(h.receiptLeaf)));
    if (_diag) {
      Object.assign(_diag, {
        bondedEvents: bonded.length, derivedFromEvents: derived.found.length, anchorsTried: st.owned.length,
        bondedNotDerived: derived.unresolved.length, importedRecords: imported.length, checkedLive: list.length,
        derivedClosed: list.filter((_h, i) => !live[i].live).map((h) => h.receiptIndex),
        receipts: list.map((h) => ({ receiptLeaf: h.receiptLeaf, lpAsset: h.lpAsset })),
      });
    }
    return list.map((h, i) => ({ h, p: live[i] })).filter(({ p }) => p.live).map(({ h, p }) => ({
      pid: p.pid, pair: (_farmPoolOf(h.lpAsset) || {}).pair || null, controller: farm.manager, lpAsset: h.lpAsset,
      shares: p.shares, receiptLeaf: h.receiptLeaf, receiptIndex: h.receiptIndex, anchorLeaf: h.anchorLeaf,
      unlockAt: p.unlockAt, pendingUnits: p.pendingUnits, pendingTac: p.pendingTac,
      ...(h.via === 'imported-record' ? { imported: true } : {}),
    })).sort((a, b) => a.receiptIndex - b.receiptIndex);
  }

  const _farmPoolOf = (lpAsset) => (_farmCfg().pools || []).find((p) => String(p.lpAsset).toLowerCase() === String(lpAsset).toLowerCase());


  const _farmStore = makeImportedFarmStore({ sha256 });

  const _importedFarmRecords = (walletPriv) => _farmStore.list(walletPriv);


  async function ensureExactNote({ walletPriv, asset, amount, notes, onStep, selfSettle = null, waitOpts } = {}) {
    const want = BigInt(amount);
    const mine = (notes || []).filter((n) => String(n.asset).toLowerCase() === String(asset).toLowerCase());
    const exact = mine.find((n) => BigInt(n.value) === want);
    if (exact) return { note: exact, split: false };
    // an asset with no relay fee asset (an LP share: the pool cannot pay a relay out in it) splits with no fee, as the relay's sponsored LP move
    const ticker = poolTickerOf(asset);
    const splitFee = selfSettle || !ticker ? 0n : await gasAwareMinFee(ticker, 'transfer');
    const src = mine.filter((n) => BigInt(n.value) >= want + splitFee).sort((x, y) => (BigInt(x.value) > BigInt(y.value) ? 1 : -1))[0];
    if (!src) throw new Error(`lp-add: no single ${ticker} note covers ${want}${splitFee ? ' plus the split fee' : ''} — consolidate first`);
    onStep?.({ status: 'splitting', asset, ticker, amount: want.toString() });
    const id = identity(walletPriv);
    await transfer({ walletPriv, notes: [src], recipientPubHex: id.pubHex, amount: want, fee: splitFee, selfSettle, waitOpts });
    const { byAsset } = await balance(walletPriv);
    const fresh = (byAsset[String(asset).toLowerCase()]?.notes || []).find((n) => BigInt(n.value) === want);
    if (!fresh) throw new Error('lp-add: the split settled but the sized note is not scannable yet — retry in a moment');
    return { note: fresh, split: true };
  }


  const _ct = makeConfidentialTransfer({ keccak256 });

  const _stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer: _ct });

  function buildTransferOp({ walletPriv, notes, recipientPubHex, amount, fee = 0n, feeUsd = null }) {
    if (!notes || !notes.length) throw new Error('transfer: no input notes');
    const asset = notes[0].asset;
    if (notes.some((n) => n.asset !== asset)) throw new Error('transfer: all inputs must be one asset');
    amount = BigInt(amount); fee = BigInt(fee);
    const total = notes.reduce((s, n) => s + BigInt(n.value), 0n);
    if (amount + fee > total) throw new Error('transfer: amount + fee exceeds input value');
    const change = total - amount - fee;
    const id = identity(walletPriv);

    const isSelf = String(recipientPubHex).toLowerCase() === String(id.pubHex).toLowerCase();
    if (!isSelf) {
      throw new Error(
        'transfer: cannot send to a third party directly — a native note owner is keccak(nk ‖ dom), so the '
        + 'sender would have to know the recipient\'s spend key, and a pubkey-derived owner mints a note that '
        + 'is unspendable forever. Use the stealth lock/claim path (confidential-stealth.js) instead.',
      );
    }
    const anchor = _noteAnchor(notes[0], id);
    const recvKeys = deriveOutput(walletPriv, anchor, 'send', 0);
    const recvNk = recvKeys.nk;
    const recipientOwner = pool.nkToOwner(recvNk);
    const rRecv = recvKeys.blinding;
    const txOutputs = [{ value: amount, blinding: rRecv, owner: recipientOwner }];
    let rChange = null, changeNk = null, changeOwner = null;
    if (change > 0n) {
      const changeKeys = deriveOutput(walletPriv, anchor, 'change', 0);
      rChange = changeKeys.blinding;
      changeNk = changeKeys.nk;
      changeOwner = pool.nkToOwner(changeNk);
      txOutputs.push({ value: change, blinding: rChange, owner: changeOwner });
    }

    const t = _ct.buildTransfer({
      inputs: notes.map((n) => ({ value: BigInt(n.value), blinding: BigInt(n.blinding) })),
      outputs: txOutputs,
      fee,
      assetId: asset,
      domain: 'transfer',
    });
    if (!_ct.verifyTransfer(t)) throw new Error('transfer: self-verify failed');

    const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
    const ptHex = (P) => '0x' + _hex(P.toRawBytes(true));
    const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
    const cb = chainBindingHex();
    const spendRoot = notes[0].root;

    const inMeta = notes.map((n, i) => {
      const c = xy(t.inC[i]);
      if (String(c.cx).toLowerCase() !== String(n.cx).toLowerCase() || String(c.cy).toLowerCase() !== String(n.cy).toLowerCase()) {
        throw new Error('transfer: recomputed input commitment ≠ scanned note (value/blinding recovery mismatch)');
      }
      const leafIndex = Number(n.leafIndex);
      if (n.root == null || !n.path || n.path.length !== 32) throw new Error(`transfer: input ${i} missing membership witness (root/path)`);
      const cx = _pad32(n.cx, `input ${i} cx`), cy = _pad32(n.cy, `input ${i} cy`);
      const owner = _pad32(n.owner, `input ${i} owner`), secret = _pad32(n.secret, `input ${i} secret`);
      const path = n.path.map((p, k) => _pad32(p, `input ${i} path[${k}]`));
      const lf = pool.leaf(asset, cx, cy, owner);
      const reRoot = _rootFromPath(lf, leafIndex, path);
      if (reRoot.toLowerCase() !== _pad32(spendRoot, 'spendRoot').toLowerCase()) {
        throw new Error(`transfer: input ${i} membership does not reconstruct spendRoot (leafIndex ${leafIndex}); note witness is stale — rescan before sending`);
      }
      return { cx, cy, owner, nk: secret, leafIndex, path, secret };
    });
    const outOwners = [recipientOwner]; if (change > 0n) outOwners.push(changeOwner);
    const outMeta = txOutputs.map((_, j) => ({ cx: xy(t.outC[j]).cx, cy: xy(t.outC[j]).cy, owner: _pad32(outOwners[j], `output ${j} owner`) }));

    const op = {
      chainBinding: _pad32(cb, 'chainBinding'), spendRoot: _pad32(spendRoot, 'spendRoot'), asset: _pad32(asset, 'asset'),
      inputs: inMeta, outputs: outMeta,
      rangeProof: '0x' + _hex(t.rangeProof), kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
      fee: fee.toString(),
      ...(feeUsd != null ? { feeUsd } : {}),
    };
    try { if (typeof window !== 'undefined') window.__lastTransferOp = JSON.parse(JSON.stringify(op)); } catch { }

    const leaves = outMeta.map((m) => pool.leaf(asset, m.cx, m.cy, m.owner));
    const outputs = [{ value: amount.toString(), blinding: beHex(rRecv), secret: recvNk, asset, owner: recipientOwner, cx: outMeta[0].cx, cy: outMeta[0].cy, ownerPub: recipientPubHex }];
    if (change > 0n) outputs.push({ value: change.toString(), blinding: beHex(rChange), secret: changeNk, asset, owner: changeOwner, cx: outMeta[1].cx, cy: outMeta[1].cy, ownerPub: id.pubHex });
    const ephRand = freshEph;
    const memos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves, outputs, memos });

    return { op, leaves, outputs, memos, ephRand, amount, change, fee, asset };
  }


  async function transfer({ walletPriv, notes, recipientPubHex, amount, fee = 0n, feeUsd = null, selfRelay = false, selfSettle = null, waitOpts } = {}) {
    if (feeUsd == null && BigInt(fee) > 0n) {
      feeUsd = await feeUsdFor(fee, poolTickerOf(notes?.[0]?.asset)).catch(() => null);
    }
    const b = buildTransferOp({ walletPriv, notes, recipientPubHex, amount, fee, feeUsd });
    return _dispatch({
      type: 'transfer', spec: { op: b.op, leaves: b.leaves, outputs: b.outputs, ephRand: b.ephRand },
      sealedMemos: b.memos, selfRelay, selfSettle, walletPriv, waitOpts,
    });
  }


  const _airdrop = makeConfidentialAirdrop({ stealth: _stealth, secp, sha256, keccak256, curveOrder: SECP_N, pool, transfer: _ct });

  const _lockScan = makeConfidentialLockScan({ pool });

  const _bytesHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

  const _scalarHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');


  async function stealthSend({ walletPriv, recipientPubHex, notes, amount, deadline, selfRelay = false, selfSettle = null, waitOpts, onBuilt } = {}) {
    if (!notes || !notes.length) throw new Error('stealthSend: no input notes');
    const asset = notes[0].asset;
    if (notes.some((n) => n.asset !== asset)) throw new Error('stealthSend: all inputs must be one asset');
    amount = BigInt(amount);
    if (amount <= 0n) throw new Error('stealthSend: amount must be positive');
    const id = identity(walletPriv);
    if (String(recipientPubHex).toLowerCase() === String(id.pubHex).toLowerCase()) {
      throw new Error('stealthSend: recipient is your own address — use transfer() (a plain self-send) instead, it needs no proof round trip and no claim step');
    }
    const { note } = await ensureExactNote({ walletPriv, asset, amount, notes, selfSettle, waitOpts });

    const deadlineB = deadline != null ? BigInt(deadline) : coarseDeadline(90 * 24 * 3600, 3600);
    if (deadlineB <= 0n) throw new Error('stealthSend: deadline required');

    const ephemeralPriv = randomScalar();
    const { ownerPub } = _stealth.oneTimeAddress({ recipientSpendPub: recipientPubHex, ephemeralPriv });
    const lBlinding = _scalarHex(randomScalar());
    const refundPriv = randomScalar();
    const refundPub = _bytesHex(secp.ProjectivePoint.BASE.multiply(refundPriv).toRawBytes(true).slice(1));

    const op = _stealth.buildStealthLock({
      chainBinding: chainBindingHex(), asset, locker: note.owner, refundPub, ownerPub, amount,
      deadline: deadlineB, spendRoot: note.root, nNote: note, lBlinding,
    });
    const recipientMemo = _airdrop.sealStealthMemo({ recipientSpendPub: recipientPubHex, ephemeralPriv, asset, amount, lBlinding, deadline: deadlineB, refundPub });
    const refundPrivHex = _scalarHex(refundPriv);
    const ephemeralPub = _bytesHex(secp.ProjectivePoint.BASE.multiply(ephemeralPriv).toRawBytes(true));
    const senderTail = _airdrop.sealStealthSenderTail({
      senderPriv: _bytesHex(id.priv), ephemeralPub,
      asset, amount, lBlinding, deadline: deadlineB, refundPriv: refundPrivHex, ownerPub, recipientPub: recipientPubHex,
    });
    const memo = recipientMemo + senderTail.replace(/^0x/, '');
    const built = { lockLeaf: op.lockLeaf, asset, amount: amount.toString(), deadline: deadlineB.toString(), refundPriv: refundPrivHex, refundPub, recipientPubHex, memo, lCx: op.lCx, lCy: op.lCy, ownerPub, lBlinding };
    onBuilt?.(built);

    const r = await _dispatch({ type: 'stealthlock', spec: { op, lockMemos: [memo] }, sealedMemos: [memo], selfRelay, selfSettle, walletPriv, waitOpts });
    const memoCheck = await checkEmittedLockMemos({ txHash: r && r.txHash, lockLeaves: [op.lockLeaf], memos: [memo] });
    return { ...r, ...built, ...(memoCheck ? { memoCheck } : {}) };
  }


  async function checkEmittedLockMemos({ txHash, lockLeaves, memos }) {
    if (!txHash) return { ok: null, mismatched: [], reason: 'no settle tx hash — the lock memo was never checked' };
    let input = null;
    try { const t = await rpc('eth_getTransactionByHash', [txHash]); input = t && t.input; } catch { }
    if (!input) return { ok: null, mismatched: [], reason: 'settle calldata unavailable — the lock memo was not checked' };
    const decoded = _lockScan.decodeSettleCalls(input);
    const norm = (m) => '0x' + String(m ?? '').replace(/^0x/, '').toLowerCase();
    const want = lockLeaves.map((lf) => String(lf).toLowerCase());
    for (const call of (decoded && decoded.calls) || []) {
      let fields;
      try { fields = _lockScan.decodePublicValuesLockFields(call.publicValues); } catch { continue; }
      const got = (fields.lockLeaves || []).map((lf) => String(lf).toLowerCase());
      if (got.length !== want.length || got.some((lf, i) => lf !== want[i])) continue;
      if (call.memos.length !== fields.leavesCount + fields.lockLeaves.length) continue;
      const tail = call.memos.slice(fields.leavesCount);
      const mismatched = [];
      memos.forEach((m, i) => { if (norm(tail[i]) !== norm(m)) mismatched.push({ index: i, lockLeaf: lockLeaves[i], expected: norm(m), emitted: tail[i] == null ? null : norm(tail[i]) }); });
      if (mismatched.length && typeof saveMismatchedMemos === 'function') {
        try { await saveMismatchedMemos({ txHash, leaves: lockLeaves, memos, memoCheck: { ok: false, mismatched } }); } catch { }
      }
      return { ok: mismatched.length === 0, mismatched };
    }
    return { ok: null, mismatched: [], reason: 'this settle carries no matching lock-leaf set — the lock memo was not checked' };
  }


  const LOCK_COUNT_SLOT = '0x54';

  const LOCK_ROOT_SLOT = '0x55';

  const _txInputs = new Map();

  let _lockSetAt = null;

  async function scanLockSet(opts = {}) {
    const requested = opts && opts.toBlock;
    const head = requested == null || requested === 'latest'
      ? await headBlock()
      : (typeof requested === 'number' ? requested : parseInt(String(requested), 16));
    const shared = !(opts && opts.events) && Object.keys(opts || {}).every((k) => k === 'toBlock');
    if (shared && _lockSetAt && _lockSetAt.head === head) return _lockSetAt.p;
    const p = _readLockSet(opts, head);
    if (shared) { _lockSetAt = { head, p }; p.catch(() => { if (_lockSetAt && _lockSetAt.p === p) _lockSetAt = null; }); }
    return p;
  }

  async function _readLockSet(opts, head) {
    const events = (opts && opts.events) || await fetchEvents({ ...opts, toBlock: head });
    const getTxInput = async (txHash) => {
      const k = String(txHash).toLowerCase();
      if (_txInputs.has(k)) return _txInputs.get(k);
      const tx = await rpc('eth_getTransactionByHash', [txHash]);
      if (tx && tx.input) _txInputs.set(k, tx.input);
      return tx && tx.input;
    };
    const getLockState = async () => {
      const tag = '0x' + head.toString(16);
      const [count, root] = await Promise.all([
        rpc('eth_getStorageAt', [cfg.pool, LOCK_COUNT_SLOT, tag]),
        rpc('eth_getStorageAt', [cfg.pool, LOCK_ROOT_SLOT, tag]),
      ]);
      return { count, root };
    };
    return _lockScan.scanLockLeaves({ events, getTxInput, getLockState, strict: true });
  }


  async function scanStealthLocks({ walletPriv, opts } = {}) {
    const set = await scanLockSet(opts);
    const mine = await _flagSpentLocks(_openReceivedLocks(walletPriv, set));
    return {
      mine,
      lockSetRoot: set.lockSetRoot,
      verified: set.verified ?? null,
      locksWithoutMemo: set.lockMemos.filter((m) => !m).length,
      ...(set.unverifiedReason ? { unverifiedReason: set.unverifiedReason } : {}),
    };
  }

  const _lockMemosAt = (set, i) => {
    const c = set.lockMemoCandidates && set.lockMemoCandidates[i];
    return (c && c.length ? c : [set.lockMemos[i]]).filter(Boolean);
  };

  function _openReceivedLocks(walletPriv, set) {
    const { tree, lockLeaves } = set;
    const recipientSpendPrivHex = _bytesHex(identity(walletPriv).priv);
    const mine = [];
    for (let i = 0; i < lockLeaves.length; i++) {
      for (const memoHex of _lockMemosAt(set, i)) {
        try {
          const m = _airdrop.openStealthMemo({ recipientSpendPriv: recipientSpendPrivHex, leaf: lockLeaves[i], memoHex });
          if (!m) continue;
          const { oneTimePriv } = _stealth.recoverOneTimeKey({ recipientSpendPriv: recipientSpendPrivHex, ephemeralPub: m.ephemeralPub });
          const { path } = tree.rootAndPath(i);
          mine.push({ ...m, oneTimePriv, leaf: lockLeaves[i], lIndex: i, lPath: path });
          break;
        } catch { }
      }
    }
    return mine;
  }


  async function _flagSpentLocks(locks) {
    const out = [];
    for (const l of locks) {
      let spent = null;
      try { spent = await _mappingFlag(LOCK_SPENT_SLOT, pool.nullifier(l.leaf)); } catch { spent = null; }
      out.push({ ...l, spent });
    }
    return out;
  }


  async function scanSentLocks({ walletPriv, opts } = {}) {
    const set = await scanLockSet(opts);
    return { sent: await _openSentLocks(walletPriv, set), lockSetRoot: set.lockSetRoot };
  }

  const LOCK_SPENT_SLOT = 119n;

  async function _mappingFlag(slot, key) {
    const k = _hex(keccak256(Uint8Array.from([..._b32b(key), ..._b32b('0x' + slot.toString(16))])));
    const v = await rpc('eth_getStorageAt', [cfg.pool, '0x' + k, 'latest']);
    return BigInt(v || '0x0') !== 0n;
  }

  async function _openSentLocks(walletPriv, { tree, lockLeaves, lockMemos, lockMemoCandidates }) {
    const opened = recovery().openSentLocks({ senderPriv: _bytesHex(identity(walletPriv).priv), lockLeaves, lockMemos, lockMemoCandidates });
    const out = [];
    for (const o of opened) {
      let spent = null;
      try { spent = await _mappingFlag(LOCK_SPENT_SLOT, pool.nullifier(o.leaf)); } catch { spent = null; }
      out.push({ ...o, lPath: tree.rootAndPath(o.lIndex).path, spent });
    }
    return out;
  }


  async function stealthClaim({ walletPriv, lockRecord, lockSetRoot, fee = 0n, selfRelay = false, selfSettle = null, waitOpts } = {}) {
    const id = identity(walletPriv);
    const net = BigInt(lockRecord.amount) - BigInt(fee);
    if (net <= 0n) throw new Error('stealthClaim: fee exceeds the locked amount');
    const claimKeys = deriveOutput(walletPriv, pool.nullifier(_lockLeafOf(lockRecord)), 'claim', 0);
    const mBlinding = claimKeys.blinding;
    const claimNk = claimKeys.nk;
    const claimOwner = pool.nkToOwner(claimNk);
    const claim = _stealth.buildStealthClaim({
      chainBinding: chainBindingHex(), asset: lockRecord.asset, lCx: lockRecord.lCx, lCy: lockRecord.lCy,
      ownerPub: lockRecord.ownerPub, amount: lockRecord.amount, deadline: lockRecord.deadline,
      locker: lockRecord.refundPub, lBlinding: lockRecord.lBlinding, lockSetRoot,
      lIndex: lockRecord.lIndex, lPath: lockRecord.lPath, oneTimePriv: lockRecord.oneTimePriv,
      mOwner: claimOwner, fee, mBlinding,
    });
    const mLeaf = pool.leaf(lockRecord.asset, claim.mCx, claim.mCy, claimOwner);
    const output = { value: net.toString(), blinding: _scalarHex(mBlinding), secret: claimNk, asset: lockRecord.asset, owner: claimOwner, cx: claim.mCx, cy: claim.mCy, ownerPub: id.pubHex };
    const ephRand = freshEph;
    const memos = guard.sealMemosForOutputs({ outputs: [output], ephRand });
    guard.assertOutputsRecoverable({ leaves: [mLeaf], outputs: [output], memos });
    const op = { ...claim, mRange: _bytesHex(claim.mRange) };
    const r = await _dispatch({ type: 'stealthclaim', spec: { op, leaves: [mLeaf], outputs: [output], ephRand }, sealedMemos: memos, selfRelay, selfSettle, walletPriv, waitOpts });
    return { ...r, net, asset: lockRecord.asset };
  }


  async function stealthRefund({ walletPriv, lockRecord, refundPriv, lockSetRoot, fee = 0n, selfRelay = false, selfSettle = null, waitOpts } = {}) {
    const id = identity(walletPriv);
    const net = BigInt(lockRecord.amount) - BigInt(fee);
    if (net <= 0n) throw new Error('stealthRefund: fee exceeds the locked amount');
    const refundKeys = deriveOutput(walletPriv, pool.nullifier(_lockLeafOf(lockRecord)), 'refund', 0);
    const oBlinding = refundKeys.blinding;
    const refundNk = refundKeys.nk;
    const refundOwner = pool.nkToOwner(refundNk);
    const refund = _stealth.buildStealthRefund({
      chainBinding: chainBindingHex(), asset: lockRecord.asset, lCx: lockRecord.lCx, lCy: lockRecord.lCy,
      ownerPub: lockRecord.ownerPub, amount: lockRecord.amount, deadline: lockRecord.deadline,
      locker: lockRecord.refundPub, lockerPriv: refundPriv, refundOwner, lockSetRoot,
      lIndex: lockRecord.lIndex, lPath: lockRecord.lPath, lBlinding: lockRecord.lBlinding, fee, oBlinding,
    });
    const oLeaf = pool.leaf(lockRecord.asset, refund.oCx, refund.oCy, refundOwner);
    const output = { value: net.toString(), blinding: _scalarHex(oBlinding), secret: refundNk, asset: lockRecord.asset, owner: refundOwner, cx: refund.oCx, cy: refund.oCy, ownerPub: id.pubHex };
    const ephRand = freshEph;
    const memos = guard.sealMemosForOutputs({ outputs: [output], ephRand });
    guard.assertOutputsRecoverable({ leaves: [oLeaf], outputs: [output], memos });
    const op = { ...refund, oRange: _bytesHex(refund.oRange) };
    const r = await _dispatch({ type: 'stealthrefund', spec: { op, leaves: [oLeaf], outputs: [output], ephRand }, sealedMemos: memos, selfRelay, selfSettle, walletPriv, waitOpts });
    return { ...r, net, asset: lockRecord.asset };
  }


  async function stealthLockPosition({ lockLeaf, opts } = {}) {
    const { tree, lockLeaves, lockSetRoot } = await scanLockSet(opts);
    const lIndex = lockLeaves.findIndex((l) => String(l).toLowerCase() === String(lockLeaf).toLowerCase());
    if (lIndex < 0) return null;
    const { path } = tree.rootAndPath(lIndex);
    return { lIndex, lPath: path, lockSetRoot };
  }


  async function settleFromAccount({ settlerPriv, publicValues, proof, memos = [], pair = null } = {}) {
    const acct = account(settlerPriv);
    const data = settleCalldata({ publicValues, proof, memos, pair });
    let gasLimit = 1200000n;
    try { gasLimit = (BigInt(await rpc('eth_estimateGas', [{ from: acct.address, to: cfg.pool, data }])) * 13n) / 10n; } catch { }
    const sent = await _sendEvmTx({ acct, to: cfg.pool, data, gasLimit });
    await _waitReceipt(sent.txHash);
    return { from: acct.address, txHash: sent.txHash };
  }


  function settleCalldata({ publicValues, proof, memos = [], pair = null } = {}) {
    const pv = String(publicValues).startsWith('0x') ? publicValues : '0x' + publicValues;
    const pf = String(proof).startsWith('0x') ? proof : '0x' + proof;
    const strip0x = (h) => String(h).replace(/^0x/, '');
    const enc = (hex) => { const b = strip0x(hex); const len = (b.length / 2); const padded = b + '0'.repeat((64 - (b.length % 64)) % 64); return { len, padded }; };
    const word = (n) => BigInt(n).toString(16).padStart(64, '0');
    const a = enc(pv), b = enc(pf);
    const pvBlock = word(a.len) + a.padded;
    const pfBlock = word(b.len) + b.padded;
    const headWords = pair ? 6 : 3;
    const offPv = headWords * 32;
    const offPf = offPv + 32 + a.padded.length / 2;
    const offMemos = offPf + 32 + b.padded.length / 2;
    const memosBlock = memos.length === 0 ? word(0) : (() => {
      let head = word(memos.length), body = '', cursor = memos.length * 32;
      for (const m of memos) { const e = enc(m); head += word(cursor); body += word(e.len) + e.padded; cursor += 32 + e.padded.length / 2; }
      return head + body;
    })();
    return '0x' + (pair ? _selector('createPairAndSettle(bytes32,bytes32,uint32,bytes,bytes,bytes[])') : _selector('settle(bytes,bytes,bytes[])'))
      + (pair ? word(BigInt(pair.assetA)) + word(BigInt(pair.assetB)) + word(BigInt(pair.feeBps)) : '')
      + word(offPv) + word(offPf) + word(offMemos) + pvBlock + pfBlock + memosBlock;
  }


  function _sealedOpen(e, sealedMemos = [], leaves = []) {
    if (!e || !e.open) return e;
    const m = e.open.memos, s = sealedMemos || [];
    if (Array.isArray(m) && m.length === s.length && m.every((x, i) => String(x).toLowerCase() === String(s[i]).toLowerCase())) e.open = { ...e.open, memos: s, leaves };
    else { e.open = null; e.code = undefined; }
    return e;
  }


  async function _dispatch({ type, spec, sealedMemos, selfRelay, selfSettle = null, walletPriv, waitOpts, pair = null }) {
    if (!selfRelay && !selfSettle) return relay.settle({ type, ...spec, memos: sealedMemos }, waitOpts);
    const proven = await relay.prove({ type, ...spec, memos: sealedMemos }, waitOpts);
    if (proven.status === 'settled') return proven;
    const memos = proven.memos || sealedMemos;
    if (selfSettle) return { jobId: proven.jobId, ...(await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos, pair })) };
    return settleFromAccount({ settlerPriv: walletPriv, publicValues: proven.publicValues, proof: proven.proof, memos, pair });
  }


  const RELAY_FEE_BPS = 30n;

  const HOLDER_FEE_TIERS = [[10000n, 15n], [1000n, 20n], [100n, 25n]];

  let _privateTacWei = 0n;

  let _accountTacWei = 0n;

  let _publicTacWei = 0n;

  function holderFeeBps() {
    const whole = (_privateTacWei + _accountTacWei + _publicTacWei) / 10n ** 18n;
    for (const [min, bps] of HOLDER_FEE_TIERS) if (whole >= min) return bps;
    return RELAY_FEE_BPS;
  }

  const CTAC_FEE_FLOOR_UNDERLYING = 2000000000000000000n;

  const RELAY_FEE_ASSETS = {
    cETH:  { usd: 'eth',    minUnderlying: 100000000000000n },
    cUSDC: { usd: 'stable', minUnderlying: 300000n },
    cUSDT: { usd: 'stable', minUnderlying: 300000n },
    cUSD:  { usd: 'stable', minUnderlying: 300000000000000000n },
    cBTC:  { usd: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', minUnderlying: 2000000000000n },
    cTAC:  { minUnderlying: CTAC_FEE_FLOOR_UNDERLYING },
  };

  const _unitScaleOf = (ticker) => BigInt((assetByTicker[ticker] && assetByTicker[ticker].unitScale) || '1');

  function relayMinFee(ticker) {
    const wei = RELAY_FEE_ASSETS[ticker] && RELAY_FEE_ASSETS[ticker].minUnderlying;
    return wei == null ? 0n : wei / _unitScaleOf(ticker);
  }

  const SETTLE_GAS = { unwrap: 450000n, sendunwrap: 680000n, transfer: 620000n, lp: 780000n, lpremove: 720000n, route: 600000n, swap: 600000n, bridgeburn: 600000n };

  const PROVE_COST_WEI = 40000000000000n;

  const PROVE_TOKEN = '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29';

  const ZQUOTER = '0x000000bd2DB80567c23E353ca95a251c573cBf9B';

  const PROVE_PROBE_WEI = 100000000000000000000n;

  const PROVE_PER_OP_BPS = 3892n;

  let _proveCost = { at: 0, v: null };


  async function proveCostWei() {
    if (Date.now() - _proveCost.at < 300000 && _proveCost.v) return _proveCost.v;
    try {
      const w = (x) => BigInt(x).toString(16).padStart(64, '0');
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const data = '0xe7798987' + w(ZQUOTER) + w(0) + w(PROVE_TOKEN) + w(0) + w(PROVE_PROBE_WEI) + w(50) + w(deadline);
      const r = await rpc('eth_call', [{ to: ZQUOTER, data }, 'latest']);
      if (!r || r.length < 2 + 256) return _proveCost.v || PROVE_COST_WEI;
      const ethOut = BigInt('0x' + r.slice(2).slice(192, 256));
      if (ethOut <= 0n) return _proveCost.v || PROVE_COST_WEI;
      const perOp = (ethOut * PROVE_PER_OP_BPS) / 10000n / (PROVE_PROBE_WEI / (10n ** 18n));
      const lo = PROVE_COST_WEI / 10n, hi = PROVE_COST_WEI * 10n;
      const v = perOp < lo ? lo : perOp > hi ? hi : perOp;
      _proveCost = { at: Date.now(), v };
      return v;
    } catch { return _proveCost.v || PROVE_COST_WEI; }
  }

  let _gp = null;

  const _gasPriceNow = () => {
    if (_gp && Date.now() - _gp.at < 8e3) return _gp.p;
    const p = Promise.resolve(rpc('eth_gasPrice', []));
    _gp = { at: Date.now(), p };
    p.catch(() => { if (_gp && _gp.p === p) _gp = null; });
    return p;
  };

  const _ladderFee = (v) => {
    let x = BigInt(v);
    if (x <= 0n) return 0n;
    let digits = 0n, t = x;
    while (t > 0n) { t /= 10n; digits += 1n; }
    if (digits <= 2n) return x;
    const scale = 10n ** (digits - 2n);
    return ((x + scale - 1n) / scale) * scale;
  };

  async function gasAwareMinFee(ticker, opKind) {
    const staticFloor = relayMinFee(ticker);
    const pol = RELAY_FEE_ASSETS[ticker];
    const meta = assetByTicker[ticker];
    if (!pol || !meta) return staticFloor;
    let gwei; try { gwei = BigInt((await _gasPriceNow()) || '0'); } catch { return staticFloor; }
    if (gwei <= 0n) return staticFloor;
    const DRIFT_HEADROOM_WEI = 300000000n;
    const margin = gwei * 135n / 100n;
    const quoteGwei = margin > gwei + DRIFT_HEADROOM_WEI ? margin : gwei + DRIFT_HEADROOM_WEI;
    const costWei = (SETTLE_GAS[opKind] || 500000n) * quoteGwei + (await proveCostWei()) * 135n / 100n;
    let floor;
    if (pol.usd === 'eth') {
      floor = _ladderFee(costWei / _unitScaleOf(ticker));
    } else if (pol.usd) {
      const ethPx = await ethUsdPrice();
      const assetPx = pol.usd === 'stable' ? 1 : await feedUsdPrice(pol.usd);
      if (!ethPx || !assetPx || !Number.isFinite(meta.decimals)) return staticFloor;
      const costUsd = (Number(costWei) / 1e18) * ethPx;
      const underlying = BigInt(Math.ceil((costUsd / assetPx) * 10 ** meta.decimals));
      floor = _ladderFee(underlying / _unitScaleOf(ticker));
      if (staticFloor > 0n && floor > staticFloor * 50n) floor = _ladderFee(staticFloor * 50n);
    } else {
      return staticFloor;
    }
    return _ladderFee(floor > staticFloor ? floor : staticFloor);
  }


  const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';

  const _feedPx = new Map();

  async function feedUsdPrice(feed) {
    const k = String(feed).toLowerCase();
    const c = _feedPx.get(k);
    if (c && Date.now() - c.at < 60000 && c.v) return c.v;
    try {
      const r = await rpc('eth_call', [{ to: feed, data: '0xfeaf968c' }, 'latest']);
      if (!r || r.length < 2 + 128) return c ? c.v : null;
      const answer = BigInt('0x' + r.slice(2).slice(64, 128));
      if (answer > 0n) { const v = Number(answer) / 1e8; _feedPx.set(k, { at: Date.now(), v }); return v; }
    } catch { }
    return c ? c.v : null;
  }

  const ethUsdPrice = () => feedUsdPrice(CHAINLINK_ETH_USD);

  async function feeUsdFor(feeUnits, ticker = 'cETH') {
    const meta = assetByTicker[ticker];
    const pol = RELAY_FEE_ASSETS[ticker];
    if (!meta || !pol || !pol.usd) return null;
    const px = pol.usd === 'eth' ? await ethUsdPrice()
      : pol.usd === 'stable' ? 1
      : await feedUsdPrice(pol.usd);
    if (!px || !Number.isFinite(meta.decimals)) return null;
    const underlying = Number(BigInt(feeUnits) * _unitScaleOf(ticker));
    return (underlying / 10 ** meta.decimals) * px;
  }


  function chainBindingHex() {
    const cid = BigInt(cfg.chainId).toString(16).padStart(64, '0');
    const addr = cfg.pool.replace(/^0x/, '').toLowerCase().padStart(40, '0');
    const bytes = Uint8Array.from(((cid + addr).match(/../g) || []).map((h) => parseInt(h, 16)));
    return '0x' + _hex(keccak256(bytes));
  }


  function coarseDeadline(ttlSecs = 3600, bucket = 600) {
    return BigInt(Math.ceil((Math.floor(Date.now() / 1000) + ttlSecs) / bucket) * bucket);
  }


  function quoteUnwrapFee(value, ticker = 'cETH', { feeBps = holderFeeBps(), minFee } = {}) {
    const v = BigInt(value);
    const floor = minFee != null ? BigInt(minFee) : relayMinFee(ticker);
    const pct = (v * BigInt(feeBps) + 9999n) / 10000n;
    let fee = _ladderFee(pct > floor ? pct : floor);
    if (fee > v) fee = v;
    return { fee, net: v - fee, value: v };
  }


  function buildUnwrap({ note, walletPriv, recipient, feeOpts, selfSettle = false, ttlSecs = 3600 } = {}) {
    if (!note) throw new Error('buildUnwrap: note required');
    const ticker = poolTickerOf(note.asset) || 'cETH';
    let fee, net;
    if (selfSettle) {
      fee = 0n; net = BigInt(note.value);
    } else {
      ({ fee, net } = quoteUnwrapFee(note.value, ticker, feeOpts || {}));
      if (net <= 0n) throw new Error('note too small for a gasless exit (relay fee ≥ value); self-settle instead');
    }
    const to = _evmAddr(recipient || account(walletPriv).address, 'buildUnwrap: recipient');
    const cb = chainBindingHex();
    const recip32 = '0x' + '0'.repeat(24) + to.replace(/^0x/, '');
    const deadline = ttlSecs > 0 ? coarseDeadline(ttlSecs) : 0n;
    const ctx = pool.intentContext('tacit-unwrap-intent-v1', cb, note.asset, recip32,
      [[note.cx, note.cy, note.owner]], [BigInt(note.value), fee, deadline]);
    const nonce = pool.deriveOpeningNonce(note.blinding, ctx, 'unwrap');
    const sig = pool.openingSigma(BigInt(note.value), note.blinding, ctx, nonce);
    const op = {
      chainBinding: cb,
      spendRoot: note.root,
      asset: note.asset,
      cx: note.cx, cy: note.cy, owner: note.owner,
      leafIndex: Number(note.leafIndex),
      path: note.path,
      nk: note.secret,
      secret: note.secret,
      value: String(note.value),
      recipient: to,
      fee: fee.toString(),
      deadline: deadline.toString(),
      sigR: sig.R, sigZ: sig.z,
    };
    return { op, fee, net, recipient: to, asset: note.asset, ticker, selfSettle };
  }


  async function waitForExit({ walletPriv, note, jobId, waitOpts }) {
    let stop = false;
    const relayP = relay.waitForSettle(jobId, waitOpts).then((st) => ({ status: st.status, txHash: st.txHash }));
    const sameNote = (n) => { try { return BigInt(n.cx) === BigInt(note.cx) && BigInt(n.cy) === BigInt(note.cy); } catch { return false; } };
    const chainP = new Promise((resolve) => {
      (async () => {
        let seen = false, misses = 0;
        for (let i = 0; i < 80 && !stop; i++) {
          await new Promise((r) => setTimeout(r, 6000));
          if (stop) return;
          try {
            const { byAsset } = await balance(walletPriv);
            const held = byAsset[String(note.asset).toLowerCase()];
            if (held?.notes?.some(sameNote)) { seen = true; misses = 0; continue; }
            if (seen && ++misses >= 2) return resolve({ status: 'settled', txHash: null });
          } catch { }
        }
      })();
    });
    try { return await Promise.race([relayP, chainP]); }
    finally { stop = true; }
  }


  const _floorRefused = (e) => /fee below the current floor/i.test(String((e && e.message) || e));

  async function _withFloorRetry(ticker, opKind, feeOpts, run) {
    const minFee = await gasAwareMinFee(ticker, opKind);
    try { return await run({ ...feeOpts, minFee }); }
    catch (e) {
      if (!_floorRefused(e)) throw e;
      const higher = (minFee > 0n ? minFee : relayMinFee(ticker)) * 2n;
      try { return await run({ ...feeOpts, minFee: higher }); }
      catch (e2) {
        if (_floorRefused(e2)) throw Object.assign(new Error('The network fee rose while this was being sent. Try again in a minute; the fee is worked out again each time.'), { code: 'FEE_MOVED', cause: e2 });
        throw e2;
      }
    }
  }

  async function unwrap(args = {}) {
    if (!args.note || args.selfSettle || (args.feeOpts && args.feeOpts.minFee != null)) return _unwrapOnce(args);
    return _withFloorRetry(poolTickerOf(args.note.asset) || 'cETH', 'unwrap', args.feeOpts, (feeOpts) => _unwrapOnce({ ...args, feeOpts }));
  }

  async function _unwrapOnce({ note, walletPriv, recipient, feeOpts, wait = true, waitOpts, selfSettle = null } = {}) {
    if (selfSettle) {
      const built = buildUnwrap({ note, walletPriv, recipient, selfSettle: true });
      const proven = await relay.prove({ type: 'unwrap', op: built.op, memos: [] }, waitOpts);
      if (proven.status === 'settled') return { ...built, jobId: proven.jobId, status: 'settled', txHash: proven.txHash || null };
      const sent = await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos: [] });
      return { ...built, jobId: proven.jobId, status: 'settled', txHash: sent && sent.txHash };
    }
    const ticker = poolTickerOf(note.asset) || 'cETH';
    const minFee = (feeOpts && feeOpts.minFee != null) ? feeOpts.minFee : await gasAwareMinFee(ticker, 'unwrap');
    const built = buildUnwrap({ note, walletPriv, recipient, feeOpts: { ...feeOpts, minFee } });
    const sub = await relay.submitOp({ type: 'unwrap', op: built.op, memos: [] }, waitOpts);
    if (!wait) return { ...built, jobId: sub.jobId, status: sub.status };
    const st = await waitForExit({ walletPriv, note, jobId: sub.jobId, waitOpts }).catch((e) => { throw _sealedOpen(e, [], []); });
    return { ...built, jobId: sub.jobId, status: st.status, txHash: st.txHash };
  }


  // A note of exactly the amount leaves by plain unwrap, whose floor is lower than send-and-unwrap's (no change note to make).
  const _exitKind = (note, amount) => (BigInt(note.value) === BigInt(amount) ? 'unwrap' : 'sendunwrap');

  async function sendUnwrap(args = {}) {
    if (!args.note || args.selfSettle || (args.feeOpts && args.feeOpts.minFee != null)) return _sendUnwrapOnce(args);
    return _withFloorRetry(poolTickerOf(args.note.asset) || 'cETH', _exitKind(args.note, args.amount), args.feeOpts, (feeOpts) => _sendUnwrapOnce({ ...args, feeOpts }));
  }

  // A send-and-unwrap's op, its change note and what the exit says it is: the same for a relayed exit, one proved first and an exit proved
  // ahead. `{ exact: true }` for a note of exactly the amount, which leaves by plain unwrap.
  async function _sendUnwrapExit({ note, walletPriv, recipient, amount, feeOpts, selfSettle = null } = {}) {
    if (!note) throw new Error('sendUnwrap: note required');
    const ticker = poolTickerOf(note.asset) || 'cETH';
    amount = BigInt(amount);
    const noteValue = BigInt(note.value);
    if (amount > noteValue) throw new Error('sendUnwrap: amount exceeds the note (merge notes first)');
    const fee = selfSettle ? 0n : quoteUnwrapFee(amount, ticker, { ...feeOpts, minFee: (feeOpts && feeOpts.minFee != null) ? feeOpts.minFee : await gasAwareMinFee(ticker, _exitKind(note, amount)) }).fee;
    const payout = amount - fee;
    if (payout <= 0n) throw new Error('sendUnwrap: amount too small for the relay fee');
    const change = noteValue - amount;
    if (change === 0n) return { exact: true };
    const id = identity(walletPriv);
    const to = _evmAddr(recipient, 'sendUnwrap: recipient');
    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    const rChange = pool.deriveOpeningNonce(note.blinding, note.cx, 'sendunwrap-change-v1');
    const changeNk = '0x' + pool.deriveOpeningNonce(note.blinding, note.cx, 'sendunwrap-change-nk-v1').toString(16).padStart(64, '0');
    const changeOwner = pool.nkToOwner(changeNk);
    const built = _stealth.buildSendUnwrap({
      chainBinding: chainBindingHex(), asset: note.asset,
      note: { cx: note.cx, cy: note.cy, owner: note.owner, nk: note.secret, blinding: note.blinding, value: noteValue, leafIndex: Number(note.leafIndex), path: note.path, secret: note.secret },
      recipient: to, payout, fee, opDeadline: coarseDeadline(3600),
      change: [{ value: change, blinding: rChange, owner: changeOwner }],
      spendRoot: note.root,
    });
    const changeOut = [{ value: change.toString(), blinding: beHex(rChange), secret: changeNk, asset: note.asset, owner: changeOwner, cx: built.change[0].cx, cy: built.change[0].cy, ownerPub: id.pubHex }];
    const changeLeaf = pool.leaf(note.asset, built.change[0].cx, built.change[0].cy, changeOwner);
    const ephRand = freshEph;
    const op = {
      chainBinding: built.chainBinding, spendRoot: built.spendRoot, asset: built.asset,
      input: built.input, recipient: built.recipient, payout: built.payout, fee: built.fee, opDeadline: built.opDeadline,
      pokR: built.pokR, pokZv: built.pokZv, pokZr: built.pokZr, change: built.change,
      rangeProof: built.rangeProof, kernel: { R: built.kernelR, z: built.kernelZ },
    };
    const out = { ...built, fee, payout, change, recipient: to, ticker };
    return { op, changeLeaf, changeOut, ephRand, out };
  }

  async function _sendUnwrapOnce({ note, walletPriv, recipient, amount, feeOpts, wait = true, waitOpts, selfSettle = null } = {}) {
    const x = await _sendUnwrapExit({ note, walletPriv, recipient, amount, feeOpts, selfSettle });
    if (x.exact) return unwrap({ note, walletPriv, recipient, feeOpts, wait, waitOpts, selfSettle });
    const { op, changeLeaf, changeOut, ephRand, out } = x;
    if (selfSettle) {
      const spec = { type: 'sendunwrap', op, leaves: [changeLeaf], outputs: changeOut };
      const sealed = guard.sealMemosForOutputs({ outputs: changeOut, ephRand });
      const proven = await relay.prove({ ...spec, memos: sealed }, waitOpts);
      if (proven.status === 'settled') return { ...out, jobId: proven.jobId, status: 'settled', txHash: proven.txHash || null };
      const memos = proven.memos || sealed;
      const sent = await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos });
      const checked = await relay.verifyEmittedMemos({ jobId: proven.jobId, status: 'settled', ...sent }, [changeLeaf], memos);
      return { ...out, jobId: proven.jobId, status: 'settled', txHash: checked.txHash, ...(checked.memoCheck ? { memoCheck: checked.memoCheck } : {}) };
    }
    const sub = await relay.submitOp({ type: 'sendunwrap', op, leaves: [changeLeaf], outputs: changeOut, ephRand }, waitOpts);
    const verifyMemos = async () => {
      let st = { jobId: sub.jobId, status: sub.status, txHash: sub.txHash || null };
      if (!st.txHash) {
        try { const rs = await relay.status(sub.jobId); if (rs) st = { ...st, status: rs.status || st.status, txHash: rs.txHash || null }; } catch { }
      }
      return relay.verifyEmittedMemos(st, [changeLeaf], sub.sealedMemos);
    };
    if (!wait) {
      if (sub.status === 'settled') {
        const early = await verifyMemos();
        return { ...out, jobId: sub.jobId, status: early.status, txHash: early.txHash || null, ...(early.memoCheck ? { memoCheck: early.memoCheck } : {}), verifyMemos };
      }
      return { ...out, jobId: sub.jobId, status: sub.status, memoCheck: { ok: null, reason: 'the settle has not landed yet — call verifyMemos() once it has' }, verifyMemos };
    }
    const st = await waitForExit({ walletPriv, note, jobId: sub.jobId, waitOpts }).catch((e) => { throw _sealedOpen(e, sub.sealedMemos, [changeLeaf]); });
    let landed = st;
    if (!landed.txHash && landed.status === 'settled') {
      try { const rs = await relay.status(sub.jobId); if (rs && rs.txHash) landed = { ...landed, txHash: rs.txHash }; } catch { }
    }
    const checked = await relay.verifyEmittedMemos(landed, [changeLeaf], sub.sealedMemos);
    return { ...out, jobId: sub.jobId, status: checked.status, txHash: checked.txHash, ...(checked.memoCheck ? { memoCheck: checked.memoCheck } : {}) };
  }
  return { cfg, assetByTicker, account, ethCall, balance, identity, quoteOpFee: gasAwareMinFee, transfer, nextWrapIndex, releaseWrapIndex, buildWrap, submitWrapSettle, waitReceipt: _waitReceipt, sendUnwrap, stealthSend, scanStealthLocks, stealthClaim, scanSentLocks, stealthLockPosition, stealthRefund };
}
