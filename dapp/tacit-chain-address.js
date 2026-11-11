// Reproduce Tacit's optional chain lane from the same private identity key used
// for the EVM pool address. This mirrors tacit-chain-client.js chainSeed() and
// tacit-chain-wallet.js address()/chainAddressHash() without constructing a
// prover or retaining the chain wallet's secret keys.
import { secp, sha256, hmac, concatBytes } from './vendor/tacit-deps.min.js';
import { ml_kem768 } from './vendor/tacit-pq.min.js';
import { makeBtcPoolZk } from './btc-pool-zk.js';

const te = new TextEncoder();
const N_SECP = secp.CURVE.n;
const hash = (tag, ...parts) => sha256(concatBytes(te.encode(tag), ...parts));
const fromBe = (bytes) => bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n);
const toBe32 = (value) => {
  const out = new Uint8Array(32);
  let n = BigInt(value);
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  if (n !== 0n) throw new Error('chain address field does not fit 32 bytes');
  return out;
};
const scalarOf = (tag, seed) => {
  const x = fromBe(concatBytes(hash(tag, seed, Uint8Array.of(0)), hash(tag, seed, Uint8Array.of(1)))) % (N_SECP - 1n);
  return x + 1n;
};

// walletKeys only uses the hash and BabyJub operations, not Poseidon. Supplying
// a placeholder keeps this address-only helper independent of the chain prover.
const chainKeys = makeBtcPoolZk({ poseidon: () => 0n });

export function chainAddressHash(identityKey) {
  let key;
  if (typeof identityKey === 'string') {
    const hex = identityKey.replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Tacit identity key must be 32-byte hex');
    key = Uint8Array.from(hex.match(/.{2}/g), (b) => parseInt(b, 16));
  } else key = Uint8Array.from(identityKey);
  if (key.length !== 32) throw new Error('Tacit identity key must be 32 bytes');

  const seed = hmac(sha256, key, te.encode('tacit-chain-seed-v1'));
  let wallet = null, kemSeed = null, kemSecret = null, scan = 0n;
  try {
    wallet = chainKeys.walletKeys(seed, 'mainnet');
    scan = scalarOf('tacit-chain-memo-scan-v1', seed);
    const scanPub = secp.ProjectivePoint.BASE.multiply(scan).toRawBytes(true);
    kemSeed = concatBytes(hash('tacit-chain-memo-kem-v1', seed, Uint8Array.of(0)), hash('tacit-chain-memo-kem-v1', seed, Uint8Array.of(1)));
    const kem = ml_kem768.keygen(kemSeed);
    kemSecret = kem.secretKey;

    const addressBytes = concatBytes(
      toBe32(wallet.A[0]), toBe32(wallet.A[1]),
      toBe32(wallet.N[0]), toBe32(wallet.N[1]),
      scanPub, kem.publicKey,
    );
    return hash('tacit-chain-address-v1', addressBytes);
  } finally {
    key.fill(0); seed.fill(0); kemSeed?.fill(0); kemSecret?.fill(0);
    scan = 0n;
    if (wallet) { wallet.a = 0n; wallet.n = 0n; }
  }
}
