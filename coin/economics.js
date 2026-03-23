/**
 * Coin economics v2 — local rate limiter with earn, spend, and decay.
 *
 * Coins are a metering mechanism. They exist on your board, stay on your
 * board, and cannot be transferred.
 *
 * - Earn: one coin per T_coin ticks of simulation (faster during shares)
 * - Spend: making a Move costs coins
 * - Decay: coins halve over a fixed half-life (use them or lose them)
 *
 * @module coin/economics
 */

/**
 * Default coin parameters. Override any subset via params.
 */
export const DEFAULT_COIN_PARAMS = {
  /** Ticks per coin earned */
  T_coin: 1000,
  /** Multiplier on earn rate while sharing */
  shareBoost: 2,
  /** Half-life of coin balance in ticks */
  coinHalfLife: 100000,
  /** Cost in coins per Move */
  moveCost: 1,
};

/**
 * Compute coins earned over a number of ticks.
 *
 * @param {number} ticks - simulation ticks elapsed
 * @param {boolean} isSharing - whether the player is in a share session
 * @param {Object} [params] - overrides for DEFAULT_COIN_PARAMS
 * @returns {number} coins earned
 */
export function coinsEarned(ticks, isSharing, params = {}) {
  const baseRate = 1 / (params.T_coin ?? DEFAULT_COIN_PARAMS.T_coin);
  const shareMultiplier = isSharing ? (params.shareBoost ?? DEFAULT_COIN_PARAMS.shareBoost) : 1;
  return ticks * baseRate * shareMultiplier;
}

/**
 * Apply exponential decay to a coin balance.
 *
 * @param {number} balance - current balance
 * @param {number} ticksElapsed - ticks since balance was last computed
 * @param {Object} [params] - overrides for DEFAULT_COIN_PARAMS
 * @returns {number} decayed balance
 */
export function decayedBalance(balance, ticksElapsed, params = {}) {
  const halfLife = params.coinHalfLife ?? DEFAULT_COIN_PARAMS.coinHalfLife;
  return balance * Math.pow(0.5, ticksElapsed / halfLife);
}

/**
 * Check if the player can afford a Move.
 *
 * @param {number} balance - current coin balance
 * @param {number} [moveCost] - cost per Move (default from params)
 * @returns {boolean}
 */
export function canAffordMove(balance, moveCost = DEFAULT_COIN_PARAMS.moveCost) {
  return balance >= moveCost;
}

/**
 * @typedef {Object} HistoryEntry
 * @property {number} tick - simulation tick of this event
 * @property {'earn'|'spend'} type - event type
 * @property {number} amount - coins earned or spent
 * @property {boolean} [isSharing] - whether earning happened during a share
 */

/**
 * Compute the current coin balance from a full history of earn/spend events.
 *
 * Applies decay between each event and from the last event to currentTick.
 *
 * @param {HistoryEntry[]} history - ordered list of earn/spend events
 * @param {number} currentTick - the tick at which to evaluate the balance
 * @param {Object} [params] - overrides for DEFAULT_COIN_PARAMS
 * @returns {number} current balance after all events and decay
 */
export function computeBalance(history, currentTick, params = {}) {
  let balance = 0;
  let lastTick = 0;

  for (const entry of history) {
    // Apply decay from last event to this one
    const elapsed = entry.tick - lastTick;
    if (elapsed > 0) {
      balance = decayedBalance(balance, elapsed, params);
    }

    // Apply earn or spend
    if (entry.type === 'earn') {
      balance += entry.amount;
    } else if (entry.type === 'spend') {
      balance -= entry.amount;
    }

    lastTick = entry.tick;
  }

  // Apply final decay to currentTick
  const finalElapsed = currentTick - lastTick;
  if (finalElapsed > 0) {
    balance = decayedBalance(balance, finalElapsed, params);
  }

  return balance;
}
