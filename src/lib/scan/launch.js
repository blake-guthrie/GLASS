/**
 * @fileoverview Trajectory matching system for launch data.
 * Collects historical windows and matches against them for graduation prediction.
 *
 * @module scan/launch
 */

const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getMarketSummary } = require('./market-summary');
const { normalizeCurve } = require('./curve-normalizer');

/**
 * Config for scan window parameters.
 * @typedef {Object} ScanConfig
 * @property {number} windowDuration - Duration in minutes (5-15).
 * @property {number} txCount - Minimum transaction count per window.
 */

/**
 * Scan market data into windows.
 * @param {string} marketId - Market identifier.
 * @param {ScanConfig} config - Configuration for windowing.
 * @returns {Promise<Array>} Array of market summaries with windowed data.
 */
async function scan(marketId, config = {}) {
  const { windowDuration = 10, txCount = 80 } = config;
  const windowMs = windowDuration * 60 * 1000;
  const windows = [];

  // Simulate data collection (in real impl, this would be from blockchain)
  const mockData = await getMarketSummary(marketId);
  const priceData = mockData.price;
  const volumeData = mockData.volume;
  const buyerData = mockData.uniqueBuyers;
  const timestamps = Object.keys(priceData);

  for (let i = 0; i < timestamps.length; i += 10) {
    const start = timestamps[i];
    const end = timestamps[Math.min(i + 10, timestamps.length - 1)];
    const window = {
      id: uuidv4(),
      market: marketId,
      start,
      end,
      price: priceData[start],
      volume: volumeData[start],
      uniqueBuyers: buyerData[start],
      duration: windowDuration,
      txCount: 10,
    };

    // Normalize curves for consistency
    const normalized = {
      price: normalizeCurve(window.price),
      volume: normalizeCurve(window.volume),
      uniqueBuyers: normalizeCurve(window.uniqueBuyers),
    };

    window.normalized = normalized;
    windows.push(window);
  }

  // Validate schema
  const schema = {
    id: 'string',
    market: 'string',
    start: 'string',
    end: 'string',
    price: 'number',
    volume: 'number',
    uniqueBuyers: 'number',
    duration: 'number',
    txCount: 'number',
    normalized: {
      price: 'array',
      volume: 'array',
      uniqueBuyers: 'array',
    },
  };

  for (const win of windows) {
    if (!win.normalized || !win.normalized.price || !win.normalized.volume || !win.normalized.uniqueBuyers) {
      throw new Error(`Invalid window schema: ${JSON.stringify(win)}`);
    }
  }

  // Save to disk (mock)
  const outputPath = path.join(__dirname, '..', 'data', `${marketId}-windows.json`);
  await fs.writeFile(outputPath, JSON.stringify(windows, null, 2));
  console.log(`Saved ${windows.length} windows to ${outputPath}`);

  return windows;
}

/**
 * Build trajectory library from saved windows.
 * @param {string} dataDir - Directory containing windowed data.
 * @returns {Promise<Array>} Array of all windows in library.
 */
async function buildTrajectoryLibrary(dataDir = 'data') {
  const files = await fs.readdir(dataDir);
  const windows = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dataDir, file);
    const content = await fs.readFile(filePath, 'utf8');
    const windowsFromFile = JSON.parse(content);

    for (const win of windowsFromFile) {
      windows.push(win);
    }
  }

  console.log(`Built library with ${windows.length} windows.`);
  return windows;
}

/**
 * Get trajectory matches for a current launch against library.
 * @param {Object} currentLaunch - Current launch data.
 * @param {Array} library - Array of historical windows.
 * @returns {Array} Array of matches with similarity scores.
 */
async function getTrajectoryMatches(currentLaunch, library) {
  const matches = [];

  for (const window of library) {
    const similarity = calculateSimilarity(currentLaunch, window);
    if (similarity > 0.7) {
      matches.push({
        windowId: window.id,
        similarity,
        graduation: determineGraduation(similarity),
      });
    }
  }

  return matches;
}

/**
 * Calculate similarity between two launches.
 * @param {Object} current - Current launch data.
 * @param {Object} historical - Historical window data.
 * @returns {number} Similarity score (0-1).
 */
function calculateSimilarity(current, historical) {
