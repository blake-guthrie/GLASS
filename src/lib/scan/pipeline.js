import { getMarketCap } from '../market.js';
import { SOL_MINT } from '../constants.js';

// ... (rest of the imports)

export async function processTokenData(data, solPrice) {
  const { mint, supply, priceData } = data;
  
  // Ensure we pass the quoteMint to the market cap calculation
  // priceData should contain { price, quoteMint }
  const quoteMint = priceData.quoteMint || SOL_MINT;
  
  const mcap = getMarketCap(
    supply,
    priceData.price,
    quoteMint,
    solPrice
  );

  return {
    ...data,
    marketCap: mcap
  };
}
