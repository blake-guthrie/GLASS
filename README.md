<p align="center">
  <img src="brand/glass-avatar-400.png" width="120" alt="GLASS" />
</p>

<h1 align="center">GLASS</h1>

<p align="center">
  <b>See who is really behind a Solana launch on the token page you're already looking at.</b>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3ecf8e" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/version-0.3.3-4cc9f0" alt="version 0.3.3" />
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-3ecf8e" alt="zero runtime dependencies" />
  <img src="https://img.shields.io/badge/wallet%20access-none-3ecf8e" alt="no wallet access" />
  <a href="#get-paid-to-make-glass-better"><img src="https://img.shields.io/badge/bounties-paid%20in%20%24GLASS%20fees-f5b544" alt="paid bounties" /></a>
</p>

---

Every terminal tells you **"bundled 23%"**. GLASS tells you *whose* bundle it is, whether that dev has ever let a coin run, and whether they're selling right now.

GLASS is a free, open-source Chrome extension. Open a token on **pump.fun, Axiom, Photon, BullX, GMGN, DexScreener, Padre, Birdeye or Solscan** and the panel appears with the full picture. You don't copy the contract address, open a new tab, or paste anything.

<p align="center">
  <img src="docs/screenshots/01-panel-pumpfun.png" alt="GLASS panel on a live pump.fun launch" />
  <br />
  <sub>A live pump.fun launch, eight minutes old. GLASS has already caught the dev selling 89% of their bag.</sub>
</p>

## What you get

| | |
|---|---|
| **A call in two seconds** | **Avoid · Caution · Neutral · Interesting**, with a confidence level, the reasons behind it, and an explicit list of what GLASS doesn't know yet. |
| **The dev's entire history** | Every token the creator wallet has ever launched, from pump.fun's own record rather than a sample: how many, how often, how far they ran, how many graduated, and how fast the dev sold. **Token farms** that mint dozens a day get flagged by name. |
| **Who really bought the launch block** | Launch buyers split into the operator's **bundle wallets**, **sniper bots**, **organic buyers** and the **dev**, with the reason for each label and a receipt for every wallet. |
| **How the bundle is hidden** | Identical transaction fingerprints, shared Jito bundles, shared funders and fee-payers, private launch-tool fee wallets, and the **WSOL-close funding trick** that makes wallets invisible to transfer-graph tools. |
| **The exit, live** | Every cluster wallet's balance is streamed over a websocket. You see the sell the moment it confirms, with coordinated exits and token hand-offs called out. |
| **Where this dev's coins top out** | The low, typical and high peak of the dev's previous launches, and the market cap where they usually start selling. |
| **It learns** | Sniper bots, fee wallets, funders, devs and transaction fingerprints you've seen before are recognised the next time they show up. |

## See it

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/02-call-and-launch.png" alt="Call, verdict and launch window" />
      <p><b>The call and the launch block.</b> One word, how sure GLASS is, and why. Below it, exactly who bought in the first slots.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/03-dev-history.png" alt="Dev history" />
      <p><b>Dev history.</b> Every previous launch from this wallet: peak, how long it took to get there, where it is now, and how fast the dev sold. The bottom shows where this dev's coins usually top out.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/04-insider-flow.png" alt="Insider flow, live" />
      <p><b>Insider flow, live.</b> Each cluster wallet's balance and status (holding, trimmed or sold out), plus a feed of their sells as they confirm.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/05-coordination-wallets.png" alt="Coordination and launch wallets" />
      <p><b>Coordination and launch wallets.</b> Shared transaction fingerprints, Jito bundles and fee wallets, plus how and by whom each launch wallet was funded.</p>
      <img src="docs/screenshots/07-settings.png" width="300" alt="GLASS settings" />
      <p><b>Settings.</b> Click the GLASS icon in Chrome's toolbar to choose your RPC, add a free Helius key, adjust scan depth, or export and wipe GLASS's memory.</p>
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/06-collapsed-pill.png" alt="Collapsed to a pill and dragged over the chart" />
  <br />
  <sub>Collapse it to a one-line pill and drag it anywhere. The call stays visible.</sub>
</p>

### Why GLASS is different

| | Typical terminal panel | Transfer-graph tools | **GLASS** |
|---|:---:|:---:|:---:|
| Bundle / sniper percentage | ✓ | — | ✓ |
| Which wallets are the operator vs bots vs real buyers | — | partial | **✓** |
| Wallets funded through WSOL-close / exchanges / fee-payers | — | — | **✓** |
| Dev's full launch history, outcomes and sell timing | count only | — | **✓** |
| Token-farm detection | — | — | **✓** |
| Live cluster sells and coordinated exits | — | — | **✓** |
| Historical exit zone for this dev | — | — | **✓** |
| Evidence shown for every claim | — | partial | **✓** |
| Open source, and anyone can get paid to improve it | — | — | **✓** |

Launch tools now fund their wallets through exchanges, fee-payers and closed WSOL accounts, so the transfer graph shows nothing. They can't hide identical execution, a shared fee-payer, or a dev's track record. GLASS reads all three and shows you the receipts, not just a verdict.

> GLASS recognises historical patterns. It is not financial advice, and it will sometimes be wrong; operators change their behaviour.

---

## Install

1. Download `glass-extension-x.y.z.zip` from the [latest release](../../releases/latest) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and select the unzipped folder (the one containing `manifest.json`).
3. Open any token on a supported terminal. The panel appears and fills in stage by stage; the call usually lands within a few seconds. Drag it anywhere, and use **—** to collapse it to a pill.

**Recommended: add a free [Helius](https://dashboard.helius.dev) API key.** Click the GLASS icon in the toolbar, paste the key, then **Use** and **Save**. Free public RPCs only keep about 14–18 hours of chain history; with a key, every token and wallet is fully scannable at higher rate limits.

**Updating:** unzip over the old folder, press ↻ on the GLASS card in `chrome://extensions`, then reload the terminal tab.

*Chrome Web Store listing: coming soon.*

---

## $GLASS

$GLASS is the token that funds GLASS. **Its creator fees pay people to make the tool better.** Find a bundling trick GLASS misses, label a launch tool's wallets, or build the next detector, and the bounty is paid out of $GLASS fees.

| | |
|---|---|
| **Contract address** | `Launching soon` |
| **Chain / launchpad** | Solana · pump.fun |
| **Official links** | [X / Twitter](https://x.com/glassonsol) · [pump.fun](https://pump.fun/profile/GLASStreasury) |
| **Treasury** | `5s1Lim2SqhTyDxeGdtmDzL4V8pPdwoiRRYL6uKLXwxYr` |

### Where the fees go

$GLASS creator fees go to the **Treasury**. The Treasury uses them for three things:

- **Bounties (the majority).** Paid to contributors whose work is merged into GLASS.
- **Buybacks.** $GLASS bought back from the market.
- **Burns.** $GLASS permanently removed from supply.

Every bounty payment, buyback and burn from the Treasury is recorded with its transaction link in [`TREASURY.md`](TREASURY.md). The Treasury wallet is public, so anyone can check the log against the chain.

### Try it: run GLASS on $GLASS

The best way to judge a launch-transparency tool is to point it at its own coin. Install GLASS, open $GLASS on pump.fun or Axiom, and read the panel: who bought the launch block, how those wallets are linked, the dev's history, and what the cluster is doing right now. Then decide for yourself.

### What the token is, and what it isn't

- **The extension is and will stay free.** Every feature works the same whether or not you hold $GLASS. There is no paywall, gated tier or holder-only feature.
- **$GLASS is a memecoin.** It carries no ownership, revenue share, governance rights or promise of returns. It exists to fund an open-source tool. Don't buy what you can't afford to lose.
- **The only official contract address is the one in this README** and on the official X account. Anyone DMing you a different one is a scammer.

---

## Get paid to make GLASS better

**Anyone can claim a bounty.** You don't need to hold $GLASS, ask permission or be a "core" developer. If your pull request is merged, you get paid from the $GLASS Treasury.

### How to claim a bounty

1. **Pick a bounty.** Browse [issues labelled `bounty`](../../issues?q=is%3Aissue+is%3Aopen+label%3Abounty). Each one states the task, what "done" means, and the payout. You can also open a new issue using the **Bounty proposal** template, for example to report a detection gap you've found, and a maintainer will set a payout.
2. **Claim it.** Comment `I'm on it` on the issue so others know it's taken.
3. **Build it.** Every heuristic is a small, pure function with tests next to it, and `npm test` runs the whole suite offline in seconds against real mainnet fixtures. Add a failing test that shows the gap, then make it pass.
4. **Open a pull request.** Link the issue and put your **Solana payout address** in the PR description.
5. **Get paid.** Once the PR is merged, the bounty is paid from the Treasury to that address and the transaction is added to [`TREASURY.md`](TREASURY.md).

Security findings get paid even without a fix: if you find anything that contradicts [Verify it isn't a drainer](#verify-it-isnt-a-drainer), report it privately and that's the highest-paying bounty there is.

### Open bounty areas

| Area | What's needed | Where |
|---|---|---|
| **Security review** | Anything that contradicts *Verify it isn't a drainer* | everywhere |
| **Launcher labels** | Confirmed fee and tip wallets of Proxima, Sumo, Fortune, Rapid Launch and others, with on-chain evidence, so the panel can say "launched with X" | `src/data/known.js` |
| **Bot / router labels** | Program IDs and fee accounts of Axiom, BullX, GMGN, Trojan, Maestro, Bloom and other bots | `src/data/known.js` |
| **Exchange hot wallets** | More labelled CEX withdrawal wallets, with a source | `src/data/known.js` |
| **New evasion patterns** | Any funding or execution trick that beats the current signals (Jupiter-swap funding, multi-hop WSOL, delayed warm-ups). Ship the detector and a fixture | `src/lib/scan/wallets.js`, `fingerprint.js` |
| **Similar launches** | Match operators across rotated wallets by fingerprint, funding style and sniper mix: "17 launches like this in 30 days, median peak 3.8×" | `src/lib/scan/`, new `worker/` |
| **Trajectory matching** | Compare the first 5–15 minutes of price, volume and buyers against past launches | new `src/lib/scan/trajectory.js` |
| **Pre-scan worker** | Scan every new pump.fun mint as it lands and publish to a shared index, so the panel is instant and everyone's scans make GLASS smarter | new `worker/` |
| **USDC-quoted pairs** | Correct USD maths for pump.fun tokens paired with USDC | `src/lib/scan/*` |
| **Other launchpads** | Creator history for Bonk, Raydium LaunchLab and Meteora launches | `src/lib/scan/devprofile.js` |
| **Firefox build** | MV3 service-worker differences | `manifest.json`, `src/background.js` |

---

## Verify it isn't a drainer

Don't trust an extension that sits on your trading terminal because a README says so. You can check all of this yourself in a few minutes.

**1. It cannot touch your wallet.** In `manifest.json`:
- `permissions` contains only `storage` (its own settings and cache). There is no `tabs`, `cookies`, `webRequest`, `scripting`, `clipboardRead`, `downloads` or `nativeMessaging`.
- Content scripts run only on the listed terminal domains, never on wallet extensions, exchanges, or any page where you'd type a seed phrase.
- `host_permissions` lists only RPC providers and the public read APIs GLASS uses. `optional_host_permissions` is requested only if *you* enter a custom RPC URL.

**2. It never asks you to sign anything.**

```bash
grep -rniE "signTransaction|signMessage|window\.solana|phantom|privateKey|secretKey|mnemonic|seed phrase" src/
```

This returns zero matches. GLASS only reads public chain data and has no code path that builds, signs or sends a transaction.

**3. It only talks to public data sources.**

```bash
grep -rnE "fetch\(|new WebSocket\(" src/
```

Every request goes to the RPC you chose (or the built-in fallbacks `solana-rpc.publicnode.com` and `api.zan.top`), its websocket endpoint for live balances, or the read-only APIs `api.dexscreener.com`, `api.geckoterminal.com`, `bundles.jito.wtf` and `frontend-api-v3.pump.fun`. The only data in those requests is public token and wallet addresses. You can watch every request live under `chrome://extensions` → GLASS → *service worker* → **Network**.

**4. It doesn't read the page.** The panel lives in an isolated Shadow DOM. The content script reads only `location.href`, to find the token address, and never the page's DOM, forms or storage.

**5. No build step, no dependencies.** What's in `src/` is exactly what Chrome runs: no bundler, no minified code, and zero runtime npm packages. Base58, PDA derivation and the ed25519 curve check are plain, readable JS (`src/lib/base58.js`, `src/lib/pda.js`).

**6. The release matches the source.** Run `sha256sum glass-extension-x.y.z.zip` and compare it with the hash published on the release.

---

## Development

```bash
npm test                          # full test suite, real mainnet fixtures, offline
node cli/scan.mjs <mint-or-pair>  # the same engine in your terminal (--json out.json, --rpc URL)
node cli/pack.mjs                 # builds dist/glass-extension-<version>.zip
```

| Path | What it is |
|---|---|
| `src/background.js` | Service worker: runs scans, caches results, streams live balances |
| `src/content.js` | The on-page panel |
| `src/popup.html` | Settings (the toolbar icon) |
| `src/sites/urls.js` | Maps each terminal URL to its token |
| `src/lib/scan/` | Detection stages: resolve → creation → launch → fingerprint → wallets → live → dev history → score |
| `src/lib/livewatch.js` | Websocket subscriptions for real-time cluster balances and price |
| `src/data/known.js` | Community labels: exchanges, routers, launch tools |

### Trajectory comparison

Trajectory comparison is available as a pure, caller-supplied-data module. See the
[input contract, metric and synthetic example](docs/trajectory.md). It compares all
three timed curves and reports historical outcome counts; it does not collect a
library, add a panel feature, or predict graduation.

## License

[MIT](LICENSE). Use it, fork it, build on it.
