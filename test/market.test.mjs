// test/market.test.mjs
import { describe, it, expect, vi } from "vitest";
import { calculateMarketCap, __private } from "../src/lib/market.js";

// Mock the HTTP price fetcher.
vi.mock("../src/lib/http.js", () => ({
  getPrice: vi.fn()
}));
import { getPrice } from "../src/lib/http.js";

describe("calculateMarketCap", () => {
  it("uses raw price when quote is USDC", async () => {
    // Pair SOL/USDC, supply 1,000,000 SOL, price 20 USDC per SOL.
    getPrice.mockImplementation(async (base, quote) => {
      if (base === "SOL" && quote === "USDC") return 20; // price in USDC
      throw new Error("Unexpected call");
    });

    const cap = await calculateMarketCap({ base: "SOL", quote: "USDC" }, 1_000_000);
    expect(cap).toBe(20_000_000); // 20 * 1,000,000
  });

  it("converts price when quote is not USDC", async () => {
    // Pair ABC/SOL, supply 500,000 ABC, price 0.5 SOL per ABC, SOL price 30 USDC.
    getPrice.mockImplementation(async (base, quote) => {
      if (base === "ABC" && quote === "SOL") return 0.5; // price in SOL
      if (base === "SOL" && quote === "USDC") return 30; // SOL/USD price
      throw new Error("Unexpected call");
    });

    const cap = await calculateMarketCap({ base: "ABC", quote: "SOL" }, 500_000);
    // Expected: 0.5 SOL * 30 USDC = 15 USDC per ABC => 15 * 500,000 = 7,500,000
    expect(cap).toBe(7_500_000);
  });
});
