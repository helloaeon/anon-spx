# anon.spx

anon.spx is an Ethereum mainnet website for shielding SPX6900 into Tacit's V1 privacy pool, privately sending SPX to another Tacit address, and withdrawing SPX to an Ethereum address. It uses the existing V1 pool and Tacit relay; it does not deploy a new pool or run a separate backend.

The site is configured for Ethereum mainnet only. Its SPX contract is `0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C` (8 decimals). Wallet transactions require the user's confirmation and execute on Ethereum mainnet.

## Run locally

Requirements: Node.js 20 or newer.

From the repository root:

```sh
npm run serve
```

Open [http://localhost:8787/spx/](http://localhost:8787/spx/). The page is served locally without a build step or dependency installation. Press Ctrl+C to stop the server.

The local page still connects to Ethereum mainnet and Tacit's production relay. Use a wallet without funds if you only want to inspect the interface.

## Deploy as a website

The frontend is a static site and can be deployed as a Render Static Site, following Tacit's conventional hosting model. It has no web server or frontend build dependencies; Render only needs to copy the static files and make the SPX page the site homepage.

Create a Static Site in Render, connect this repository, and set:

- **Root Directory:** `dapp`
- **Build Command:** `rm -rf .render-build && cp -R . .render-build && cp spx/index.html .render-build/index.html`
- **Publish Directory:** `.render-build`
- **Environment Variable:** `SKIP_INSTALL_DEPS=true`

The build copies the shared Tacit modules and assets into the published directory, then places anon.spx at `/`. Use Render's **Static Site** option; the repository's root `render.yaml` defines a separate verification service and is not the frontend deployment. Render publishes each successful update to its CDN and can redeploy automatically when the selected Git branch changes. Add a custom domain in Render after reviewing the preview URL. This only hosts the frontend; the existing Tacit V1 pool and relay remain the on-chain and proving services.

## Code and protocol

The site page lives in [`dapp/spx/`](dapp/spx/). It imports shared Tacit wallet, address, proof, and pool modules from [`dapp/`](dapp/). Keep the full `dapp/` directory available in the deployed output so those imports resolve.

- SPX6900 token: `0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C`
- Tacit V1 `ConfidentialPool`: `0x000000000Ed1eabD231Be41d93b719056F7febFC`
- Tacit V1 asset ID: `0x45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48`

The shield flow approves SPX and wraps it through the V1 pool. Withdrawals and private sends use Tacit's V1 proof and relay flow. Private sends create one-time claimable payments, with refunds available to the sender after the 90-day deadline.

This code builds on the [Tacit open-source project](https://github.com/src-company/tacit). Preserve its license and attribution when sharing or modifying the source. See [`dapp/spx/README.md`](dapp/spx/README.md) for integration notes.
