# SPX private pool front end

A focused Ethereum mainnet front end for shielding, privately sending, and withdrawing SPX6900 through Tacit's existing V1 `ConfidentialPool`. It reuses Tacit's V1 wallet, note, proof, indexer, and relay modules; it does not deploy or operate a separate pool.

## Run locally

From the repository root, with Node.js 20 or newer:

```sh
npm run serve
```

Open [http://localhost:8787/spx/](http://localhost:8787/spx/). The static server binds to `127.0.0.1`; no build step or dependency installation is required for the page. Stop it with Ctrl+C.

In the current Codex workspace, the task-scoped Node binary is available if `node` is not on your shell path:

```sh
../work/toolchain/node/node-v24.22.2-darwin-arm64/bin/node tools/serve-dapp.mjs
```

The local page reads Ethereum mainnet state and uses Tacit's production relay. Wallet actions still target Ethereum mainnet. A shield requires an ERC-20 approval and a V1 pool deposit, each confirmed in the connected wallet; withdrawing and private sending ask the relay to prove and submit a V1 operation. Do not use a funded wallet when you only want to inspect the page.

## Integration details

- Chain: Ethereum mainnet only (chain ID 1).
- SPX token: `0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C` (8 decimals).
- V1 pool: `0x000000000Ed1eabD231Be41d93b719056F7febFC`.
- V1 asset ID: `0x45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48`.
- Shield path: the app derives a Tacit identity from the user's Ethereum wallet signature, builds the V1 wrap note, requests an exact SPX allowance to the pool, calls `ConfidentialPool.wrap`, then submits the matching proof through Tacit's relay.
- Withdraw path: the app scans V1 notes for the derived identity and requests a V1 `sendUnwrap` operation through the relay.
- Send path: enter a mainnet `tacit1…` address that includes an Ethereum lane. The app creates a one-time claimable V1 stealth lock; the recipient can scan and claim it using their Tacit identity. Unclaimed locks have a 90-day refund deadline. Refund secrets are kept in Tacit's encrypted local send store, keyed from the wallet-derived private key.
- Clicking the top-right Tacit address opens the account dialog with the full unified address, address ID, connected wallet, copy action, sign-out action, and wallet-switch action. Keep the address private if you do not want others to identify your incoming-payment address.
- The local front end keeps the private key in page memory and clears its byte buffer when the page closes. It stores a pending wrap's transaction hash, amount, and note index so a confirmed deposit can be resumed after a relay interruption.

The UI follows the single-card, dark serif/monospace visual language of anon.wei, while using Tacit's V1 pool flows. It exposes Shield, Send, and Withdraw for SPX on Ethereum.

## Repository review

This page is part of the Tacit source tree and imports the shared V1 modules from `dapp/`. For a public repository, keep the upstream Tacit license and attribution with those modules. The files specific to this front end are `index.html`, `spx.css`, and `spx.js` in this directory.
