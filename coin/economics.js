/**
 * Economics analysis — sketch of how coin value might be computed.
 *
 * Coins are always minted at a constant rate (1 per unit of verified
 * simulation time). What changes is the exchange value, which depends
 * on session richness: duration, partner diversity, simulation activity.
 *
 * This module provides a simple scoring function and the interface for
 * a future, more sophisticated valuation model.
 *
 * @module coin/economics
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
 * @typedef {Object} NetworkHistory
 * @property {number} totalSessions - total sessions in the network
 * @property {number} totalSocialSessions - sessions with social mining
 * @property {number} uniquePlayers - distinct public keys seen
 * @property {Map<string, number>} playerSessionCounts - sessions per player pubkey
 * @property {Map<string, Set<string>>} socialGraph - pubkey -> set of partner pubkeys
 */

/**
 * @typedef {Object} CoinValue
 * @property {number} baseValue - raw time-based value (1 per block)
 * @property {number} activityMultiplier - bonus for interesting simulation (1.0-2.0)
 * @property {number} socialMultiplier - bonus for social mining (1.0-1.5)
 * @property {number} networkMultiplier - bonus for well-connected player (1.0-2.0)
 * @property {number} totalValue - baseValue * all multipliers
 * @property {Record<string, number>} breakdown - detailed scoring breakdown
 */

/**
 * Compute a coin value estimate for a session.
 *
 * This is a sketch implementation. The real valuation would emerge from
 * market dynamics (see gridcoin-proposal.md Section 6.2), but this gives
 * a reasonable starting point for comparing sessions.
 *
 * @param {SessionSummary} session
 * @param {NetworkHistory} [networkHistory] - optional network context
 * @returns {CoinValue}
 */
export function computeCoinValue(session, networkHistory = null) {
  const breakdown = {};

  // Base value: 1 per block
  const baseValue = session.blockCount;
  breakdown.blocks = session.blockCount;

  // Activity multiplier: reward interesting simulations over dead boards
  const activityMultiplier = computeActivityMultiplier(session, breakdown);

  // Social multiplier: reward social mining
  const socialMultiplier = computeSocialMultiplier(session, breakdown);

  // Network multiplier: reward well-connected players
  const networkMultiplier = networkHistory
    ? computeNetworkMultiplier(session, networkHistory, breakdown)
    : 1.0;

  const totalValue = baseValue * activityMultiplier * socialMultiplier * networkMultiplier;

  return {
    baseValue,
    activityMultiplier,
    socialMultiplier,
    networkMultiplier,
    totalValue,
    breakdown
  };
}

/**
 * Score simulation activity/interestingness.
 *
 * Dead boards (all zeros, no changes) get multiplier 1.0.
 * Active boards with diversity get up to 2.0.
 *
 * @param {SessionSummary} session
 * @param {Record<string, number>} breakdown
 * @returns {number} multiplier in [1.0, 2.0]
 */
function computeActivityMultiplier(session, breakdown) {
  const summary = session.lastSummary;
  if (!summary) return 1.0;

  let score = 0;

  // Game of Life: density near 0.5 is more interesting than 0 or 1
  if (summary.density != null) {
    // Peaked at 0.3-0.5 (typical GoL equilibrium density)
    const densityScore = 1 - Math.abs(summary.density - 0.35) * 2;
    score += Math.max(0, densityScore) * 0.3;
    breakdown.densityScore = densityScore;
  }

  // Birth/death activity suggests non-static board
  if (summary.totalBorn != null && session.totalTicks > 0) {
    const birthRate = summary.totalBorn / session.totalTicks;
    // Typical GoL on 32x32 has birth rate ~10-50 per tick
    const birthScore = Math.min(1, birthRate / 20);
    score += birthScore * 0.3;
    breakdown.birthRate = birthRate;
  }

  // 6502life: copies and swaps indicate replication
  if (summary.totalCopies != null) {
    const copyRate = summary.totalCopies / Math.max(1, session.totalTicks);
    score += Math.min(1, copyRate * 10) * 0.3;
    breakdown.copyRate = copyRate;
  }

  // Unique cell hashes indicate diversity
  if (summary.uniqueHashes != null && summary.activeCells != null) {
    const diversityRatio = summary.uniqueHashes / Math.max(1, summary.activeCells);
    score += Math.min(1, diversityRatio) * 0.4;
    breakdown.diversityRatio = diversityRatio;
  }

  // Clamp to [1.0, 2.0]
  return 1.0 + Math.min(1.0, Math.max(0, score));
}

/**
 * Score social mining.
 *
 * Solo sessions get 1.0. Social sessions get up to 1.5.
 *
 * @param {SessionSummary} session
 * @param {Record<string, number>} breakdown
 * @returns {number} multiplier in [1.0, 1.5]
 */
function computeSocialMultiplier(session, breakdown) {
  if (!session.isSocial) {
    breakdown.socialBonus = 0;
    return 1.0;
  }

  // Base social bonus: 1.3x just for having a partner
  let bonus = 0.3;
  breakdown.socialBonus = bonus;

  // Duration bonus: longer social sessions are more valuable
  // (harder to fake sustained proximity)
  if (session.wallTimeMs > 5 * 60 * 1000) {
    // >5 minutes
    bonus += 0.1;
    breakdown.socialDurationBonus = 0.1;
  }
  if (session.wallTimeMs > 30 * 60 * 1000) {
    // >30 minutes
    bonus += 0.1;
    breakdown.socialDurationBonus = 0.2;
  }

  return 1.0 + Math.min(0.5, bonus);
}

/**
 * Score network connectivity.
 *
 * Players who mine with many different partners are rewarded,
 * because their organisms have had more opportunity to spread.
 *
 * @param {SessionSummary} session
 * @param {NetworkHistory} networkHistory
 * @param {Record<string, number>} breakdown
 * @returns {number} multiplier in [1.0, 2.0]
 */
function computeNetworkMultiplier(session, networkHistory, breakdown) {
  // How many unique partners has this player mined with?
  const playerKey = session.isSocial ? session.partnerPubkey : null;
  // We look at the author's connectivity in the social graph
  // For now, since we don't have the author key in SessionSummary,
  // use the network-wide stats as a proxy

  let score = 0;

  // Network diversity: more unique players = more valuable network
  if (networkHistory.uniquePlayers > 1) {
    const networkScale = Math.log2(networkHistory.uniquePlayers) / 10;
    score += Math.min(0.5, networkScale);
    breakdown.networkScale = networkScale;
  }

  // Social graph density: fraction of possible edges present
  if (networkHistory.uniquePlayers > 1 && networkHistory.socialGraph) {
    let totalEdges = 0;
    for (const partners of networkHistory.socialGraph.values()) {
      totalEdges += partners.size;
    }
    const maxEdges = networkHistory.uniquePlayers * (networkHistory.uniquePlayers - 1);
    const graphDensity = totalEdges / Math.max(1, maxEdges);
    score += graphDensity * 0.5;
    breakdown.graphDensity = graphDensity;
  }

  return 1.0 + Math.min(1.0, score);
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
