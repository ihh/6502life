/**
 * Coin economics — solo mining rate decay, social multiplier, niche bonus.
 *
 * Solo mining rate decays with a configurable half-life since the last
 * social pairing. Social sessions apply a flat multiplier. Niche events
 * (cross-board organism presence) earn a per-event bonus.
 *
 * All parameters are configurable via a coinParams object, kept separate
 * from board/engine parameters.
 *
 * @module coin/economics
 */

/**
 * Default coin parameters. Override any subset via coinParams.
 */
export const DEFAULT_COIN_PARAMS = {
  /** Hours between solo rate halvings */
  soloHalfLife: 24,
  /** Minimum solo mining rate (fraction of max) */
  minSoloRate: 1 / 128,
  /** Multiplier applied during social sessions */
  socialMultiplier: 1.5,
  /** Bonus coins per Niche event */
  nicheBonus: 0.69,
};

/**
 * Compute the solo mining rate given hours since last social pairing.
 *
 * Rate starts at 1.0 and halves every `soloHalfLife` hours (step function,
 * not continuous decay). Clamped to `minSoloRate` at the bottom.
 *
 * @param {number} hoursSinceLastPairing
 * @param {Object} [params]
 * @param {number} [params.soloHalfLife=24]
 * @param {number} [params.minSoloRate=1/128]
 * @returns {number} rate in (0, 1]
 */
export function soloMiningRate(hoursSinceLastPairing, params = {}) {
  const halfLife = params.soloHalfLife ?? DEFAULT_COIN_PARAMS.soloHalfLife;
  const minRate = params.minSoloRate ?? DEFAULT_COIN_PARAMS.minSoloRate;
  const halvings = Math.floor(hoursSinceLastPairing / halfLife);
  return Math.max(minRate, Math.pow(0.5, halvings));
}

/**
 * @typedef {Object} CoinContext
 * @property {number|null} lastPairingTime - timestamp (ms) of last social session
 * @property {boolean} isSocial - whether this is a social session
 * @property {number} nicheEvents - count of Niche events in this session
 * @property {number} [now] - current timestamp (ms), defaults to Date.now()
 */

/**
 * @typedef {Object} CoinResult
 * @property {number} baseCoins - raw block count
 * @property {number} soloRate - solo mining rate (1.0 if social or just paired)
 * @property {number} socialMultiplier - 1.0 for solo, params.socialMultiplier for social
 * @property {number} nicheBonus - total niche bonus (nicheEvents * params.nicheBonus)
 * @property {number} totalCoins - baseCoins * soloRate * socialMultiplier + nicheBonus
 */

/**
 * @typedef {Object} SessionSummary
 * @property {string} sessionId
 * @property {string} gameId
 * @property {number} totalTicks
 * @property {number} wallTimeMs
 * @property {number} blockCount
 * @property {boolean} isSocial - whether this was a social mining session
 * @property {string|null} partnerPubkey - partner's public key (hex) if social
 * @property {Record<string, number>} lastSummary - engine summary from final block
 */

/**
 * Compute coin value for a session, incorporating solo decay, social
 * multiplier, and niche bonus.
 *
 * @param {SessionSummary} session
 * @param {CoinContext} context
 * @param {Object} [coinParams] - overrides for DEFAULT_COIN_PARAMS
 * @returns {CoinResult}
 */
export function computeCoinValue(session, context = {}, coinParams = {}) {
  const params = { ...DEFAULT_COIN_PARAMS, ...coinParams };

  const baseCoins = session.blockCount;

  // Solo decay: hours since last pairing
  let soloRate = 1.0;
  if (!context.isSocial && context.lastPairingTime != null) {
    const now = context.now ?? Date.now();
    const hoursSince = (now - context.lastPairingTime) / (1000 * 60 * 60);
    soloRate = soloMiningRate(hoursSince, params);
  }

  // Social multiplier
  const socialMult = context.isSocial ? params.socialMultiplier : 1.0;

  // Niche bonus
  const nicheEvents = context.nicheEvents ?? 0;
  const niche = nicheEvents * params.nicheBonus;

  const totalCoins = baseCoins * soloRate * socialMult + niche;

  return {
    baseCoins,
    soloRate,
    socialMultiplier: socialMult,
    nicheBonus: niche,
    totalCoins,
  };
}

/**
 * Build a SessionSummary from a finalized session record.
 *
 * Works with both solo sessions (from coin/session.js) and social
 * sessions (from coin/social-session.js).
 *
 * @param {Object} record - session record (solo or social)
 * @returns {SessionSummary}
 */
export function sessionToSummary(record) {
  const blocks = record.blocks || [];
  const lastBlock = blocks[blocks.length - 1];

  return {
    sessionId: record.id,
    gameId: record.config?.gameId ?? 'unknown',
    totalTicks: record.finalTick ?? 0,
    wallTimeMs: blocks.reduce((sum, b) => sum + (b.wallTimeMs || 0), 0),
    blockCount: blocks.length,
    isSocial: !!record.partnerPubkeyHex,
    partnerPubkey: record.partnerPubkeyHex ?? null,
    lastSummary: lastBlock?.summary ?? {}
  };
}
