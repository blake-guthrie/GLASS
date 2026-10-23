# GLASS — Privacy Policy

_Last updated: 2026-10-23_

GLASS is a browser extension that analyses public Solana blockchain data about the token page you are viewing. It has no analytics or developer telemetry. The services you connect to see request metadata as described below; an optional community index is off by default.

## What GLASS does with data

- **Reads the page URL** of supported trading terminals (pump.fun, Axiom, Photon, BullX, GMGN, DexScreener, Padre, Birdeye, Solscan) to find the token address being viewed. It does not read page content, forms, cookies, or storage of those sites.
- **Fetches public blockchain data** about that token (transactions, wallet balances, prices) from a Solana RPC endpoint and from public market-data APIs (DexScreener, GeckoTerminal, Jito bundle explorer, and pump.fun's public coin API for a creator wallet's launch history). These requests contain only token and wallet addresses that are already public on-chain. They contain nothing about you.
- **Stores in browser extension storage:** settings (RPC URL, toggles) use browser sync storage; scan-result caches, panel position and the wallets ↔ launches memory stay in local extension storage. The popup provides cache and memory clearing controls.
- **Optional community index:** only after you enable it and select a host, GLASS requests a snapshot for the public mint address being viewed. That host sees the mint and connection IP. Requests omit credentials, referrers and bodies; RPC URLs, API keys, settings, local memory and browser scan results are not uploaded to the index. Shared snapshots are not added to local operator memory. Settings use the browser's sync storage and may sync under your browser account; report caches and operator memory use local storage.

## What GLASS does not do

- No analytics, telemetry, crash reporting, or "phone home" of any kind.
- No accounts, no sign-in, no cookies.
- No access to your wallet, seed phrase, or private keys. GLASS never builds, signs, or sends a transaction and never asks you to connect a wallet.
- No access to your browsing history or to any site other than the supported terminals.
- Does not sell data or transmit it beyond the RPC, public API and explicitly selected optional index requests described here.

## Third-party services you connect to

When GLASS runs a scan, your browser makes requests to the Solana RPC endpoint configured in the popup (default: `solana-rpc.publicnode.com`, with `api.zan.top` as a history fallback) and to `api.dexscreener.com`, `api.geckoterminal.com`, `bundles.jito.wtf` and `frontend-api-v3.pump.fun` (read-only; the request carries only the creator wallet address). Those services see your IP address and the public addresses being looked up, as with any website request. If you enter a Helius (or other provider) API key, requests go to that provider under your own account and their privacy policy applies.

An enabled community index is another operator-selected service, with no default provider. Its operator's privacy practices apply. Disable the checkbox to stop index requests; use the panel's ↻ button to bypass it for a full local scan. See [worker and index documentation](worker/README.md) for the published-field and source-trust contract.

## Permissions

- `storage` — save settings and cache locally.
- Host permissions for the terminals (to show the panel) and for the RPC / public API hosts above (to fetch public chain data).
- Optional host permission — requested for your selected RPC and, when enabled, community-index hosts. Localhost HTTP is available for a local worker; remote indexes require HTTPS.

## Contact

Questions or concerns: open an issue on the project repository.
