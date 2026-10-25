// Community-maintained labels. Exchange hot wallets classify funding sources; router/bot program IDs
// label the "route" fingerprint; launcher fee/tip wallets name the launch tool when one is detected.
// Plain ES module (not JSON) so it loads in every Chrome version's extension service worker.
// PRs welcome — add an entry with a source link in the PR. Addresses are matched exactly.
export default {
  exchanges: {
    '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance',
    '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Binance',
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Binance',
    'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': 'Coinbase',
    'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE': 'Coinbase',
    '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD': 'OKX',
    'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2': 'Bybit',
    'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5': 'Kraken',
    'u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w': 'Gate.io',
    'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6': 'KuCoin',
    'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ': 'MEXC',
    'AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATSyrS': 'Crypto.com',
    '88xTWZMeKfiTgbfEmPLdsUCQcZinwUfk25EBQZ21XMAZ': 'HTX',
  },
  programs: {
    'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW': 'Photon',
    'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'Meteora DAMM v2',
  },
  // Fee / tip wallets of launch tools (Proxima, Sumo, Fortune, Rapid Launch, ...). GLASS discovers shared
  // non-protocol fee recipients per launch automatically; add confirmed ones here to label them by name.
  launchers: {},
};
