import { secp, keccak_256, sha256, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';
import { prfBytesToScalar } from '/prf-wallet.js';
import { makeEvmWallet } from '/evm-wallet.js';
import { makeConfidentialPoolUx } from '/confidential-pool-ux.js';
import { unifiedAddress } from '/tacit-unified.js';
import { makeTacitAddress } from '/tacit-address.js';
import { makeStealthSendStore } from '/confidential-secret-store.js';
import { addressId } from '/address-id.js';

const TOKEN = '0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C';
const TICKER = 'cSPX';
const DECIMALS = 8;
const SELECTOR = { balanceOf: '70a08231', allowance: 'dd62ed3e', approve: '095ea7b3' };
const $ = (id) => document.getElementById(id);
const evm = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' });
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet' });
const tacitCodec = makeTacitAddress({ secp });
const stealthStore = makeStealthSendStore({ sha256 });
const asset = ux.assetByTicker[TICKER];
const state = { identity: null, walletPriv: null, account: null, tacitAddress: '', notes: [], incomingLocks: [], lockSetRoot: null, promptedIncoming: new Set(), walletBalance: 0n, statusBusy: false };

if (!asset || asset.underlying?.toLowerCase() !== TOKEN.toLowerCase() || !asset.live) {
  $('status').dataset.tone = 'error';
  $('status').textContent = 'SPX is not enabled in this deployment configuration.';
  $('shield-btn').disabled = $('withdraw-btn').disabled = $('send-btn').disabled = true;
}

function wordAddress(addr) { return String(addr).replace(/^0x/i, '').toLowerCase().padStart(64, '0'); }
function wordUint(n) { return BigInt(n).toString(16).padStart(64, '0'); }
function fmtUnits(value, decimals = DECIMALS, places = 5) {
  const n = BigInt(value), base = 10n ** BigInt(decimals), whole = n / base;
  const frac = (n % base).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
function parseUnits(text) {
  const s = String(text || '').trim();
  if (!/^\d+(?:\.\d*)?$/.test(s)) throw new Error('Enter a valid SPX amount.');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > DECIMALS) throw new Error('SPX supports up to 8 decimal places.');
  return BigInt(whole) * (10n ** BigInt(DECIMALS)) + BigInt((frac + '0'.repeat(DECIMALS)).slice(0, DECIMALS) || '0');
}
function setStatus(message, tone = '') { const el = $('status'); el.textContent = message; el.dataset.tone = tone; }
function busy(on) {
  state.statusBusy = on;
  $('shield-btn').disabled = on;
  $('withdraw-btn').disabled = on;
  $('send-btn').disabled = on;
  $('connect-btn').disabled = on;
}
function activityKey(){return `spx:v1:activity:${state.identity?.pubHex||''}`}function readActivity(){try{return JSON.parse(localStorage.getItem(activityKey())||'[]').slice(0,50)}catch{return[]}}function recordActivity(action,amount,txHash=''){if(!state.identity)return;const entries=[{action,amount:String(amount),txHash:String(txHash||''),timestamp:Date.now()},...readActivity()].slice(0,50);try{localStorage.setItem(activityKey(),JSON.stringify(entries))}catch{}renderActivity()}function renderActivity(){if(!state.identity||!$('activity-list'))return;const entries=readActivity(),list=$('activity-list');list.replaceChildren();$('activity-empty').hidden=Boolean(entries.length);for(const entry of entries){const row=document.createElement('div');row.className='activity-row';const details=document.createElement('div');details.className='activity-details';const label=document.createElement('strong');label.textContent=`${entry.action} · ${fmtUnits(entry.amount)} SPX`;const date=document.createElement('time');date.dateTime=new Date(entry.timestamp).toISOString();date.textContent=new Date(entry.timestamp).toLocaleString();details.append(label,date);row.append(details);if(entry.txHash){const link=document.createElement('a');link.href=`https://etherscan.io/tx/${encodeURIComponent(entry.txHash)}`;link.target='_blank';link.rel='noreferrer';link.textContent=`${entry.txHash.slice(0,8)}…${entry.txHash.slice(-6)}`;link.setAttribute('aria-label',`View ${entry.action} transaction on Etherscan`);row.append(link)}list.append(row)}}function pendingKey() { return `spx:v1:pending-wrap:${state.identity?.pubHex || ''}`; }
function readPending() { try { return JSON.parse(localStorage.getItem(pendingKey()) || 'null'); } catch { return null; } }
function savePending(p) { try { p ? localStorage.setItem(pendingKey(), JSON.stringify(p)) : localStorage.removeItem(pendingKey()); } catch { } }
function renderPending() {
  const box = $('pending'), p = readPending();
  if (!p || !state.walletPriv) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  box.replaceChildren();
  box.append('A shield transaction may still need relay settlement. ', document.createElement('br'));
  const hash = document.createElement('code'); hash.textContent = String(p.txHash || ''); box.append(hash, document.createElement('br'));
  const button = document.createElement('button'); button.id = 'resume-wrap'; button.type = 'button'; button.textContent = 'Resume settlement'; box.append(button);
  $('resume-wrap').onclick = resumePending;
}
function fmtAddr(addr) { return `${addr.slice(0, 8)}…${addr.slice(-6)}`; }
function fmtTacit(addr) { return addr ? `${addr.slice(0, 11)}…${addr.slice(-8)}` : ''; }
function bytesHex(bytes) { return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`; }

async function connect() {
  if (state.statusBusy) return;
  if (state.identity) return lockWallet();
  busy(true); setStatus('Connect your Ethereum wallet and approve the free Tacit identity signature…');
  try {
    const identity = await evm.deriveIdentity();
    const walletPriv = hexToBytes(identity.priv);
    state.identity = identity;
    state.walletPriv = walletPriv;
    state.account = ux.account(walletPriv);
    state.tacitAddress = unifiedAddress(walletPriv).address;
    $('connect-btn').textContent = 'Lock wallet';
    $('tacit-address').hidden = false; $('incoming-open').hidden = false;
    $('tacit-address').textContent = fmtTacit(state.tacitAddress);
    $('tacit-address').title = `Copy Tacit address: ${state.tacitAddress}`;
    $('tacit-address').setAttribute('aria-label', `Copy Tacit address ${state.tacitAddress}`);
    $('account-full-address').textContent = state.tacitAddress;
    $('account-description').textContent = `Your Tacit address, opened with 0x${identity.address.slice(0, 4)}…${identity.address.slice(-4)}. Address ID ${addressId(state.tacitAddress)}.`;
    $('account-wallet-name').textContent = `${identity.label || 'Ethereum wallet'} · 0x${identity.address.slice(0, 4)}…${identity.address.slice(-4)}`;
    $('private-address').disabled = false;
    $('private-address').textContent = state.account.address;
    $('recipient').value = `0x${identity.address}`;
    setStatus('Wallet connected. Checking SPX and scanning for private notes…', 'ok');
    await refreshAll();
    renderSentPayments();
    renderPending();
    if (readPending()) setStatus('A prior shield is waiting for settlement. Resume it before making another deposit.');
  } catch (e) {
    setStatus(e?.message || String(e), 'error');
  } finally { busy(false); }
}

function lockWallet() {
  try { state.walletPriv?.fill(0); } catch { }
  if (state.identity) state.identity.priv = '';
  state.identity = null; state.walletPriv = null; state.account = null; state.notes = []; state.walletBalance = 0n; state.incomingLocks = []; state.lockSetRoot = null; state.promptedIncoming.clear(); $('incoming-open').hidden = true; $('incoming-dialog').close();
  state.tacitAddress = '';
  $('connect-btn').textContent = 'Connect wallet';
  $('tacit-address').hidden = true; $('tacit-address').textContent = ''; $('tacit-address').title = 'Copy your Tacit address'; $('tacit-address').setAttribute('aria-label', 'Copy your Tacit address');
  $('private-address').disabled = true; $('private-address').textContent = 'Connect wallet';
  $('wallet-balance').textContent = 'Connect wallet to view';
  $('private-balance').innerHTML = '— <small>SPX</small>';
  $('note-select').innerHTML = '<option value="">Connect wallet to scan notes</option>';
  $('sent-payments').hidden = true; $('sent-payment-list').replaceChildren();
  $('recipient').value = '';
  renderPending();
  setStatus('Wallet locked. Your private key was cleared from page memory.');
}

async function assertWalletReady() {
  if (!state.identity || !state.walletPriv || !state.account) throw new Error('Connect your Ethereum wallet first.');
  const provider = state.identity.provider;
  const chainId = Number(await provider.request({ method: 'eth_chainId' }));
  if (chainId !== 1) throw new Error('Switch your wallet to Ethereum mainnet before signing.');
  const accounts = await provider.request({ method: 'eth_accounts' });
  const active = String(accounts?.[0] || '').toLowerCase().replace(/^0x/, '');
  if (active !== String(state.identity.address).toLowerCase().replace(/^0x/, '')) throw new Error('The active wallet account changed. Reconnect to derive the matching private account.');
  return provider;
}

async function tokenBalance(owner, provider = state.identity?.provider) {
  const data = `0x${SELECTOR.balanceOf}${wordAddress(owner)}`;
  return BigInt(await ux.ethCall(TOKEN, data) || '0x0');
}
async function allowance(owner) {
  const data = `0x${SELECTOR.allowance}${wordAddress(owner)}${wordAddress(ux.cfg.pool)}`;
  return BigInt(await ux.ethCall(TOKEN, data) || '0x0');
}
async function refreshAll() {
  if (!state.walletPriv) return;
  const publicBalance = await tokenBalance(`0x${state.identity.address}`); state.walletBalance = publicBalance; $('wallet-balance').textContent = `${fmtUnits(publicBalance)} SPX`; const scan = await ux.balance(state.walletPriv);
  state.walletBalance = publicBalance;
  state.notes = (scan.notes || []).filter((n) => String(n.asset).toLowerCase() === String(asset.assetId).toLowerCase());
  const privateBalance = state.notes.reduce((n, note) => n + BigInt(note.value), 0n);
  $('wallet-balance').textContent = `${fmtUnits(publicBalance)} SPX`;
  $('private-balance').innerHTML = `${fmtUnits(privateBalance)} <small>SPX</small>`;
  $('note-select').innerHTML = state.notes.length
    ? state.notes.map((n, i) => `<option value="${i}">${fmtUnits(n.value)} SPX · note ${i + 1}</option>`).join('')
    : '<option value="">No private SPX notes found</option>';
  $('send-note-select').innerHTML = state.notes.length
    ? state.notes.map((n, i) => `<option value="${i}">${fmtUnits(n.value)} SPX · note ${i + 1}</option>`).join('')
    : '<option value="">No private SPX notes found</option>';
  if (state.notes.length) $('withdraw-amount').value = fmtUnits(state.notes[0].value, DECIMALS, DECIMALS);
  if (state.notes.length) $('send-amount').value = fmtUnits(state.notes[0].value, DECIMALS, DECIMALS); try { const lockScan = await ux.scanStealthLocks({ walletPriv: state.walletPriv }); state.lockSetRoot = lockScan.lockSetRoot; state.incomingLocks = (lockScan.mine || []).filter((lock) => String(lock.asset).toLowerCase() === String(asset.assetId).toLowerCase() && lock.spent !== true); renderIncomingClaims(true); } catch (e) { state.incomingLocks = []; state.lockSetRoot = null; renderIncomingClaims(false, e?.message || String(e)); }
  renderPending();
}

function renderIncomingClaims(prompt=false,scanError=''){const dialog=$('incoming-dialog'),list=$('incoming-list'),count=state.incomingLocks.length;list.replaceChildren();$('incoming-count').textContent=count?`${count} private SPX payment${count===1?'':'s'} waiting`:(scanError?'Incoming payments could not be checked':'No incoming SPX payments found');if(scanError){const error=document.createElement('p');error.className='incoming-error';error.textContent='Scan failed: '+scanError;list.append(error)}state.incomingLocks.forEach((lock,index)=>{const row=document.createElement('div');row.className='incoming-payment';const info=document.createElement('span');info.textContent=fmtUnits(lock.amount)+' SPX';const button=document.createElement('button');button.type='button';button.className='claim-payment';button.textContent='Claim SPX';button.addEventListener('click',()=>claimIncoming(index,button));row.append(info,button);list.append(row)});$('incoming-empty').hidden=Boolean(count||scanError);$('incoming-open').textContent=count?`Claim SPX (${count})`:'Payments';if(prompt&&count&&!dialog.open&&state.incomingLocks.some(lock=>!state.promptedIncoming.has(String(lock.leaf).toLowerCase()))){for(const lock of state.incomingLocks)state.promptedIncoming.add(String(lock.leaf).toLowerCase());dialog.showModal()}if(!count)state.promptedIncoming.clear()}async function claimIncoming(index,button){if(!state.walletPriv||state.statusBusy)return;const lock=state.incomingLocks[index];if(!lock||!state.lockSetRoot)return;busy(true);button.disabled=true;button.textContent='Claiming…';try{setStatus('Proving your incoming SPX claim and submitting it through Tacit V1…');const result=await ux.stealthClaim({walletPriv:state.walletPriv,lockRecord:lock,lockSetRoot:state.lockSetRoot,waitOpts:{timeoutMs:15*60*1000}});setStatus(`SPX claimed into your private balance${result?.txHash?`: ${result.txHash}`:'.'}`,'ok');state.promptedIncoming.delete(String(lock.leaf).toLowerCase());await refreshAll();if(!state.incomingLocks.length)$('incoming-dialog').close()}catch(e){setStatus(e?.message||String(e),'error');button.disabled=false;button.textContent='Claim SPX'}finally{busy(false)}}function selectedNote() { const i = Number($('note-select').value); return Number.isInteger(i) ? state.notes[i] || null : null; }
function txHashLink(hash) { return hash; }
async function waitTransaction(hash, label) {
  setStatus(`${label} submitted: ${txHashLink(hash)} — waiting for confirmation…`);
  await ux.waitReceipt(hash);
}
async function sendWalletTx(provider, tx, label) {
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
  await waitTransaction(hash, label);
  return hash;
}

async function shield() {
  if (state.statusBusy) return;
  busy(true);
  let built = null, wrapHash = null;
  try {
    const provider = await assertWalletReady();
    if (readPending()) throw new Error('Settle the earlier confirmed shield first; do not submit the same deposit again.');
    const amount = parseUnits($('shield-amount').value);
    if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
    if (state.walletBalance < amount) throw new Error(`The connected wallet holds ${fmtUnits(state.walletBalance)} SPX.`);
    setStatus('Preparing your private note and checking token approval…');
    const index = await ux.nextWrapIndex({ walletPriv: state.walletPriv, ticker: TICKER });
    built = ux.buildWrap({ walletPriv: state.walletPriv, amountWei: amount.toString(), ticker: TICKER, index });
    if (await allowance(`0x${state.identity.address}`) < amount) {
      setStatus('Approve the exact SPX amount in your wallet…');
      const approval = `0x${SELECTOR.approve}${wordAddress(ux.cfg.pool)}${wordUint(amount)}`;
      await sendWalletTx(provider, { from: `0x${state.identity.address}`, to: TOKEN, value: '0x0', data: approval }, 'Approval');
    }
    setStatus('Confirm the SPX deposit in your wallet…');
    wrapHash = await provider.request({ method: 'eth_sendTransaction', params: [{
      from: `0x${state.identity.address}`, to: ux.cfg.pool, value: '0x0', data: built.calldata,
    }] });
    savePending({ txHash: wrapHash, amount: amount.toString(), index });
    renderPending();
    await waitTransaction(wrapHash, 'SPX deposit');
    setStatus('Deposit confirmed. Sending the note proof to Tacit’s relay for settlement…');
    await ux.submitWrapSettle({ built, depositTx: wrapHash }); recordActivity('Shielded', amount, wrapHash);
    savePending(null); renderPending();
    setStatus('SPX shielded. Your private note has settled.', 'ok');
    $('shield-amount').value = '';
    await refreshAll();
  } catch (e) {
    if (wrapHash && built) {
      if (e?.reverted) {
        savePending(null); renderPending();
        try { ux.releaseWrapIndex({ walletPriv: state.walletPriv, ticker: TICKER, index: Number(built.index) }); } catch { }
        setStatus('The deposit transaction reverted, so no SPX was wrapped. You can try again.', 'error');
        return;
      }
      savePending({ txHash: wrapHash, amount: built.amount, index: built.index });
      renderPending();
      setStatus(`The deposit is on Ethereum (${wrapHash}), but settlement did not finish. Resume settlement below; do not deposit again. ${e?.message || e}`, 'error');
    } else {
      if (built) { try { ux.releaseWrapIndex({ walletPriv: state.walletPriv, ticker: TICKER, index: Number(built.index) }); } catch { } }
      setStatus(e?.message || String(e), 'error');
    }
  } finally { busy(false); }
}

async function resumePending() {
  if (state.statusBusy) return;
  const p = readPending();
  if (!p || !state.walletPriv) return;
  busy(true);
  try {
    setStatus('Rebuilding the same note and resuming relay settlement…');
    await ux.waitReceipt(p.txHash);
    const built = ux.buildWrap({ walletPriv: state.walletPriv, amountWei: p.amount, ticker: TICKER, index: Number(p.index) });
    await ux.submitWrapSettle({ built, depositTx: p.txHash }); recordActivity('Shielded', p.amount, p.txHash);
    savePending(null); renderPending();
    setStatus('SPX shielded. Your private note has settled.', 'ok');
    await refreshAll();
  } catch (e) {
    if (e?.reverted) {
      savePending(null); renderPending();
      try { ux.releaseWrapIndex({ walletPriv: state.walletPriv, ticker: TICKER, index: Number(p.index) }); } catch { }
      setStatus('The deposit transaction reverted, so no SPX was wrapped. You can try again.', 'error');
    } else setStatus(`Settlement is still pending. You can retry safely; do not deposit again. ${e?.message || e}`, 'error');
  }
  finally { busy(false); }
}

async function withdraw() {
  if (state.statusBusy) return;
  busy(true);
  try {
    if (!state.walletPriv) throw new Error('Connect your Ethereum wallet first.');
    const note = selectedNote();
    if (!note) throw new Error('No private SPX note is available to withdraw.');
    const amount = parseUnits($('withdraw-amount').value);
    if (amount <= 0n || amount > BigInt(note.value)) throw new Error('Choose an amount up to the selected note balance.');
    const recipient = $('recipient').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/i.test(recipient)) throw new Error('Enter a valid non-zero Ethereum address.');
    setStatus('Proving the withdrawal and waiting for the relay to submit it…');
    const result = await ux.sendUnwrap({ note, walletPriv: state.walletPriv, recipient, amount, waitOpts: { timeoutMs: 15 * 60 * 1000 } }); recordActivity('Withdrew', amount, result?.txHash);
    const fee = result.fee != null ? ` Relay fee: ${fmtUnits(result.fee)} SPX.` : '';
    setStatus(`Withdrawal settled${result.txHash ? `: ${result.txHash}` : '.'}${fee}`, 'ok');
    await refreshAll();
  } catch (e) { setStatus(e?.message || String(e), 'error'); }
  finally { busy(false); }
}

async function sendPrivate() {
  if (state.statusBusy) return;
  busy(true);
  let built = null, savePromise = null;
  try {
    if (!state.walletPriv) throw new Error('Connect your Ethereum wallet first.');
    const noteIndex = Number($('send-note-select').value);
    const note = Number.isInteger(noteIndex) ? state.notes[noteIndex] : null;
    if (!note) throw new Error('No private SPX note is available to send.');
    const amount = parseUnits($('send-amount').value);
    if (amount <= 0n || amount > BigInt(note.value)) throw new Error('Choose an amount up to the selected note balance.');
    const decoded = tacitCodec.decodeTacitAddress($('send-recipient').value.trim());
    if (decoded.network !== 'mainnet') throw new Error('Recipient address must use the Ethereum mainnet Tacit network.');
    if (!decoded.lanes.evm?.ownerPub) throw new Error('Recipient Tacit address must include an Ethereum lane.');
    const recipientPubHex = bytesHex(decoded.lanes.evm.ownerPub);
    setStatus('Creating a one-time claimable SPX payment and submitting it through Tacit V1…');
    const result = await ux.stealthSend({
      walletPriv: state.walletPriv, recipientPubHex, notes: [note], amount,
      waitOpts: { timeoutMs: 15 * 60 * 1000 }, onBuilt: (record) => {
        built = record;
        savePromise = stealthStore.add(state.walletPriv, {
          lockLeaf: record.lockLeaf, asset: record.asset, ticker: 'SPX', dec: DECIMALS,
          amount: record.amount, deadline: record.deadline, lCx: record.lCx, lCy: record.lCy,
          ownerPub: record.ownerPub, lBlinding: record.lBlinding, refundPriv: record.refundPriv,
          refundPub: record.refundPub, recipientPubHex: record.recipientPubHex,
          senderPubHex: state.identity.pubHex, createdAt: Date.now(),
        });
      },
    });
    const saved = savePromise ? await savePromise : { persisted: false }; recordActivity('Sent privately', amount, result?.txHash);
    const deadline = built ? new Date(Number(built.deadline) * 1000).toLocaleString() : 'after the claim deadline';
    const recovery = saved.persisted ? ` Unclaimed funds can be refunded after ${deadline}.` : ' The encrypted local refund record could not be saved; keep this browser open and recover from this device if needed.';
    setStatus(`Private SPX payment sent${result?.txHash ? `: ${result.txHash}` : '.'} Share your Tacit address with the recipient so they can scan and claim it.${recovery}`, saved.persisted ? 'ok' : 'error');
    $('send-amount').value = '';
    renderSentPayments();
    await refreshAll();
  } catch (e) {
    const saved = savePromise ? await savePromise : null;
    const recovery = built ? (saved?.persisted ? ' Its encrypted refund record is saved under Sent payments.' : ' Its refund record is available only until this page is closed.') : '';
    setStatus(`${e?.message || String(e)}${recovery}`, 'error');
    if (built) renderSentPayments();
  }
  finally { busy(false); }
}

async async function renderSentPayments() {
  const mine = state.identity ? stealthStore.list().filter((rec) => String(rec.senderPubHex || '').toLowerCase() === String(state.identity.pubHex).toLowerCase()) : []; let open = mine;let open = mine;
  const box = $('sent-payments'), list = $('sent-payment-list');
  if(mine.length){try{const{sent}=await ux.scanSentLocks({walletPriv:state.walletPriv});const spent=new Set((sent||[]).filter(item=>item.spent===true).map(item=>String(item.leaf).toLowerCase()));for(const rec of mine)if(spent.has(String(rec.lockLeaf).toLowerCase()))stealthStore.remove(rec.lockLeaf);open=mine.filter(rec=>!spent.has(String(rec.lockLeaf).toLowerCase()))}catch(e){const warning=document.createElement('p');warning.className='activity-empty';warning.textContent=`Could not refresh payment status: ${e?.message||String(e)}`;list.append(warning)}}box.hidden=!open.length&&!list.childElementCount;
  list.replaceChildren();
  for (const [index, rec] of open.entries()) {
    const row = document.createElement('div'); row.className = 'sent-payment';
    const info = document.createElement('span');
    const deadline = Number(rec.deadline) * 1000;
    info.textContent = `${fmtUnits(rec.amount)} SPX · ${Date.now() >= deadline ? 'refund available' : `refundable ${new Date(deadline).toLocaleDateString()}`}`;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = Date.now() >= deadline ? 'Refund' : 'Refund later'; button.disabled = Date.now() < deadline;
    button.addEventListener('click', () => refundSent(index, button));
    row.append(info, button); list.append(row);
  }
}

async function refundSent(index, button) {
  if (!state.walletPriv || state.statusBusy) return;
  const rec = stealthStore.list().filter((item) => String(item.senderPubHex || '').toLowerCase() === String(state.identity.pubHex).toLowerCase())[index];
  if (!rec) return;
  busy(true); button.disabled = true; button.textContent = 'Refunding…';
  try {
    const pos = await ux.stealthLockPosition({ lockLeaf: rec.lockLeaf });
    if (!pos) throw new Error('This payment is not visible on-chain yet. Try again after it settles.');
    let auth = await stealthStore.secretsFor(state.walletPriv, rec);
    if (!auth?.refundPriv || !auth?.lBlinding) {
      const { sent } = await ux.scanSentLocks({ walletPriv: state.walletPriv });
      const found = (sent || []).find((item) => String(item.leaf).toLowerCase() === String(rec.lockLeaf).toLowerCase());
      if (!found) throw new Error('The refund secret is unavailable for this wallet.');
      auth = { refundPriv: found.refundPriv, lBlinding: found.lBlinding };
    }
    const lockRecord = { asset: rec.asset, lCx: rec.lCx, lCy: rec.lCy, ownerPub: rec.ownerPub, amount: rec.amount, deadline: rec.deadline, refundPub: rec.refundPub, lBlinding: auth.lBlinding, lIndex: pos.lIndex, lPath: pos.lPath };
    await ux.stealthRefund({ walletPriv: state.walletPriv, lockRecord, refundPriv: auth.refundPriv, lockSetRoot: pos.lockSetRoot });
    stealthStore.remove(rec.lockLeaf);
    setStatus('Unclaimed SPX refunded to your private balance.', 'ok');
    await refreshAll();
  } catch (e) { setStatus(e?.message || String(e), 'error'); }
  finally { busy(false); renderSentPayments(); }
}

function setTab(which) {
  for (const tab of ['shield', 'withdraw', 'send']) {
    const active = which === tab;
    $(`tab-${tab}`).classList.toggle('active', active);
    $(`tab-${tab}`).setAttribute('aria-selected', String(active));
    $(`panel-${tab}`).hidden = !active;
  }
}

$('connect-btn').addEventListener('click', connect);
$('shield-btn').addEventListener('click', shield);
$('withdraw-btn').addEventListener('click', withdraw);
$('send-btn').addEventListener('click', sendPrivate);
$('tab-shield').addEventListener('click', () => setTab('shield'));
$('tab-withdraw').addEventListener('click', () => setTab('withdraw'));
$('tab-send').addEventListener('click', () => { setTab('send'); renderSentPayments(); });
$('refresh-btn').addEventListener('click', async () => {
  if (!state.walletPriv) return setStatus('Connect your wallet first.');
  busy(true); setStatus('Scanning the V1 pool for your private SPX notes…');
  try { await refreshAll(); setStatus('Private balance refreshed.', 'ok'); }
  catch (e) { setStatus(e?.message || String(e), 'error'); }
  finally { busy(false); }
});
$('shield-max').addEventListener('click', () => { if (state.walletBalance) $('shield-amount').value = fmtUnits(state.walletBalance, DECIMALS, DECIMALS); });
$('withdraw-max').addEventListener('click', () => { const note = selectedNote(); if (note) $('withdraw-amount').value = fmtUnits(note.value, DECIMALS, DECIMALS); });
$('send-max').addEventListener('click', () => { const i = Number($('send-note-select').value); const note = Number.isInteger(i) ? state.notes[i] : null; if (note) $('send-amount').value = fmtUnits(note.value, DECIMALS, DECIMALS); });
$('note-select').addEventListener('change', () => { const note = selectedNote(); if (note) $('withdraw-amount').value = fmtUnits(note.value, DECIMALS, DECIMALS); });
$('send-note-select').addEventListener('change', () => { const i = Number($('send-note-select').value); const note = Number.isInteger(i) ? state.notes[i] : null; if (note) $('send-amount').value = fmtUnits(note.value, DECIMALS, DECIMALS); });
$('send-refresh-btn').addEventListener('click', async () => {
  if (!state.walletPriv) return setStatus('Connect your wallet first.');
  busy(true); setStatus('Scanning the V1 pool for your private SPX notes…');
  try { await refreshAll(); setStatus('Private balance refreshed.', 'ok'); }
  catch (e) { setStatus(e?.message || String(e), 'error'); }
  finally { busy(false); }
});
$('sent-refresh-btn').addEventListener('click', renderSentPayments); document.addEventListener('visibilitychange', () => { if (!document.hidden && state.walletPriv && !$('panel-send').hidden) renderSentPayments(); }); setInterval(() => { if (!document.hidden && state.walletPriv && !state.statusBusy && !$('panel-send').hidden) renderSentPayments(); }, 30000); $('incoming-close').addEventListener('click',()=> $('incoming-dialog').close()); $('incoming-done').addEventListener('click',()=> $('incoming-dialog').close()); $('incoming-open').addEventListener('click',()=>{if(state.walletPriv)$('incoming-dialog').showModal()}); $('incoming-dialog').addEventListener('click',event=>{if(event.target===$('incoming-dialog'))$('incoming-dialog').close()}); $('incoming-refresh').addEventListener('click',async()=>{if(!state.walletPriv||state.statusBusy)return;busy(true);$('incoming-refresh').disabled=true;$('incoming-refresh').textContent='Scanning…';try{await refreshAll()}finally{busy(false);$('incoming-refresh').disabled=false;$('incoming-refresh').textContent='Scan again'}});
$('recipient-me').addEventListener('click', () => { if (state.identity) $('recipient').value = `0x${state.identity.address}`; });
$('private-address').addEventListener('click', async () => {
  if (!state.account) return;
  try { await navigator.clipboard.writeText(state.account.address); setStatus('Private account address copied.', 'ok'); }
  catch { setStatus(`Private account: ${state.account.address}`); }
});
$('tacit-address').addEventListener('click', async () => {
  if (!state.tacitAddress || !$('account-dialog').showModal) return;
  $('account-dialog').showModal();
});
$('account-close').addEventListener('click', () => $('account-dialog').close());
$('account-dialog').addEventListener('click', (event) => { if (event.target === $('account-dialog')) $('account-dialog').close(); });
$('account-copy').addEventListener('click', async () => {
  if (!state.tacitAddress) return;
  try { await navigator.clipboard.writeText(state.tacitAddress); setStatus('Tacit address copied.', 'ok'); }
  catch { setStatus('Clipboard access is unavailable. Select and copy the address above.'); }
});
$('account-signout').addEventListener('click', () => { $('account-dialog').close(); lockWallet(); });
$('account-switch').addEventListener('click', async () => {
  if (state.statusBusy) return;
  $('account-dialog').close(); lockWallet(); busy(true); setStatus('Choose another Ethereum wallet account…');
  try { await evm.changeAccount(); }
  catch (e) { busy(false); setStatus(e?.message || String(e), 'error'); return; }
  busy(false); await connect();
});

window.addEventListener('pagehide', () => { try { state.walletPriv?.fill(0); if (state.identity) state.identity.priv = ''; } catch { } });
