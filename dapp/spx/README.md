# anon.spx

anon.spx is an Ethereum mainnet front end for shielding SPX6900 into Tacit's V1 privacy pool, sending SPX privately to another Tacit address, and withdrawing SPX back to an Ethereum address. It uses the existing Tacit V1 pool and relay; it does not deploy a separate pool or custody user funds.

## Features

- Connect an Ethereum wallet and derive a Tacit account.
- Shield SPX6900 into the Tacit V1 pool.
- Send SPX privately to a Tacit unified address with an Ethereum lane.
- Withdraw SPX to an Ethereum address.
- View and copy the Tacit address associated with the connected wallet.

The app is configured for Ethereum mainnet only (chain ID 1).

## Run locally

Requirements: Node.js 20 or newer.

From the repository root, run:

```sh
npm run serve
```

Then open [http://localhost:8787/spx/](http://localhost:8787/spx/). The page is served locally and does not require a build step or dependency installation. Press Ctrl+C to stop the server.

The app reads Ethereum mainnet data and uses Tacit's production relay. Wallet actions submit transactions on Ethereum mainnet and require confirmation in the connected wallet. Use a wallet without funds if you only want to inspect the interface.

## Deploy as a website

Deploy it as a Render Static Site so it can be updated by pushing changes to the connected Git branch. In Render, connect this repository and configure:

- **Root Directory:** `dapp`
- **Build Command:** `rm -rf .render-build && cp -R . .render-build && cp spx/index.html .render-build/index.html`
- **Publish Directory:** `.render-build`
- **Environment Variable:** `SKIP_INSTALL_DEPS=true`

The static publish step includes the shared Tacit modules and makes anon.spx the homepage. Hosting the frontend does not deploy or modify Ethereum contracts; wallet actions continue to use the existing Tacit V1 pool and relay.

## On-chain configuration

- SPX6900 token: `0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C` (8 decimals).
- Tacit V1 `ConfidentialPool`: `0x000000000Ed1eabD231Be41d93b719056F7febFC`.
- Tacit V1 asset ID: `0x45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48`.

Shielding requests an SPX allowance and calls the V1 pool's wrap flow. Withdrawals and private sends use Tacit's existing V1 proof and relay flow. A private send creates a one-time claimable payment; unclaimed payments can be refunded after the 90-day deadline.

## Source and attribution

The anon.spx page is implemented in `index.html`, `spx.css`, and `spx.js`. It imports shared V1 wallet, note, proof, and address modules from the surrounding `dapp/` directory. This repository contains Tacit open-source code; retain its license and attribution when redistributing or modifying those files.
