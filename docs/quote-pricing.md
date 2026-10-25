# Quote-aware pump.fun pricing

The decoder follows `TradeEvent`, `CreateEvent`, `Shareholder` and `BondingCurve`
in the [official pump.fun IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json),
read on 2026-10-25. Trade quote fields follow a variable-length instruction name
and a vector of shareholders; they cannot be read at one fixed byte offset.
The deprecated SOL fields and the appended quote fields are distinct fields.

`vQuote`, `rQuote`, `quoteAmount` and `priceQuote` use the quote mint's units.
Native SOL/WSOL has nine decimals, USDC has six. The zero public key in older
records represents native SOL. Unsupported quote mints produce no derived price.
USDC identification uses its official mint, not a token's untrusted ticker.
USDC fallback prices assume one USDC equals one USD; indexed USD prices are
preferred when available. This does not implement a live USDC/USD exchange feed.

The scanner prefers an existing provider market cap, then its USD token price
times supply, then decoded quote reserves. Historical trade valuations and live
curve updates use the same quote conversion. Fields labelled `sol` retain the
deprecated SOL amount, so USDC spend is not reported as SOL spend.

Run `node --test test/quote.test.mjs` for offline regressions. These use synthetic
IDL encodings, including nonempty shareholder vectors and zero deprecated SOL
reserves, plus the existing checked-in SOL transaction fixtures. Pipeline tests
execute the real scanner through its launch stage with mocked HTTP/RPC responses.
No live USDC mainnet transaction or installed Chrome extension session was tested.

This change does not generalize instruction slippage decoding, pool resolution,
base-token decimals, per-launch supply discovery, or historical OHLCV cache keys.
