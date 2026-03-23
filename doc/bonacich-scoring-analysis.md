# Bonacich Centrality Scoring Analysis for 6502coin

Date: 2026-03-23

## The Proposed Model

The score vector is defined as:

```
s = (I - alpha * A)^{-1} Y
```

where:
- `n` = number of players
- `I` is the n x n identity matrix
- `A` is an n x n adjacency matrix where `A_{ij}` = fraction of player i's board time spent sharing with player j. Each row sums to at most 1: `sum_j A_{ij} <= 1`, with the remainder `1 - sum_j A_{ij}` being solo simulation time.
- `Y` is the intrinsic score vector: `Y_i` = total simulation time (in ticks) for player i
- `alpha` is a damping parameter with `0 < alpha < 1`

---

## 1. Well-Definedness: When Does (I - alpha A)^{-1} Exist?

### Claim to verify

Since A is substochastic (row sums <= 1), the spectral radius rho(A) <= 1, and therefore (I - alpha A)^{-1} exists for all alpha in (0, 1).

### Verification

**Step 1: A is substochastic implies rho(A) <= 1.**

A matrix A with non-negative entries and row sums at most 1 is called substochastic. We need to show rho(A) <= 1.

Let lambda be an eigenvalue of A with eigenvector v, so Av = lambda v. Take the component v_i with maximum absolute value, i.e., |v_i| = ||v||_inf. Then:

```
|lambda| |v_i| = |lambda v_i| = |(Av)_i| = |sum_j A_{ij} v_j|
                <= sum_j A_{ij} |v_j|
                <= sum_j A_{ij} |v_i|
                = |v_i| sum_j A_{ij}
                <= |v_i| * 1
```

Since |v_i| > 0 (eigenvectors are nonzero), we divide both sides by |v_i| to get |lambda| <= 1. Since this holds for every eigenvalue, rho(A) <= 1. **Confirmed.**

This is a standard application of the Gershgorin circle theorem (or equivalently, the infinity-norm bound on eigenvalues).

**Step 2: (I - alpha A)^{-1} exists when alpha * rho(A) < 1.**

The matrix (I - alpha A) is singular if and only if 1/alpha is an eigenvalue of A, i.e., alpha = 1/lambda for some eigenvalue lambda of A. Since |lambda| <= 1 for all eigenvalues, we need alpha != 1/lambda for all lambda. If alpha < 1 and |lambda| <= 1, then |1/lambda| >= 1 > alpha, so alpha != 1/lambda. **Confirmed: (I - alpha A) is invertible for all alpha in (0, 1).**

**Step 3: Neumann series convergence.**

When alpha * rho(A) < 1, the Neumann series converges:

```
(I - alpha A)^{-1} = sum_{k=0}^{infinity} (alpha A)^k = I + alpha A + alpha^2 A^2 + ...
```

This converges because ||(alpha A)^k|| <= (alpha * rho(A))^k (in spectral norm after taking the k-th root and using Gelfand's formula), and alpha * rho(A) < 1. **Confirmed.**

**Boundary case: alpha = 1.** If A has an eigenvalue exactly equal to 1 (which happens when some row sums equal exactly 1, i.e., some player spends 100% of their time sharing), then (I - A) is singular. So alpha = 1 is excluded in general, but alpha < 1 always works. **Confirmed.**

**Conclusion: The claim is correct.** For any substochastic A and any alpha in (0,1), the inverse (I - alpha A)^{-1} exists and equals the convergent Neumann series.

---

## 2. Interpretation of the (i,j) Entry

### Claim to verify

The (i,j) entry of (I - alpha A)^{-1} equals sum_{k=0}^{infinity} alpha^k (A^k)_{ij}, which represents the sum over all paths of length k from i to j, weighted by alpha^k and the sharing fractions along the path. The score s_i therefore equals:

```
s_i = Y_i + alpha * sum_j A_{ij} Y_j + alpha^2 * sum_{j,k} A_{ij} A_{jk} Y_k + ...
```

This is "simulation time attenuated by social distance."

### Verification

From the Neumann series:

```
s = (I - alpha A)^{-1} Y = sum_{k=0}^{infinity} (alpha A)^k Y
  = Y + alpha A Y + alpha^2 A^2 Y + ...
```

The i-th component is:

```
s_i = Y_i + alpha (AY)_i + alpha^2 (A^2 Y)_i + ...
    = Y_i + alpha sum_j A_{ij} Y_j + alpha^2 sum_j (A^2)_{ij} Y_j + ...
```

Now, `(A^k)_{ij} = sum over all paths of length k from i to j of the product of edge weights along the path`. For k=1: `A_{ij}` is the direct sharing fraction. For k=2: `(A^2)_{ij} = sum_m A_{im} A_{mj}`, the sum over all two-step paths from i through m to j.

So:

```
s_i = sum_{j} [(I - alpha A)^{-1}]_{ij} Y_j
```

where `[(I - alpha A)^{-1}]_{ij}` is the total alpha-discounted path weight from i to j across all path lengths.

**The interpretation is correct.** Player i's score is their own simulation time, plus alpha times the weighted simulation time of direct partners, plus alpha^2 times the weighted time of partners-of-partners, etc.

**Note on directionality:** The matrix A encodes *outgoing* sharing from i's perspective: A_{ij} is what fraction of i's time is spent sharing with j. The Bonacich centrality (I - alpha A)^{-1} Y propagates value *forward* along edges: i receives credit for j's intrinsic value Y_j if i shares with j (A_{ij} > 0). This means **you benefit from sharing with high-value players**. The direction is: your score increases if you share with players who have high Y (or who share with others with high Y, etc.).

This is the correct direction for the intended incentive. It rewards seeking out and sharing with active, well-connected players.

---

## 3. Sybil Resistance

### Setup

Player M (the manipulator) creates N fake accounts (Sybils) S_1, ..., S_N. The Sybils share exclusively among themselves. The adjacency matrix restricted to the Sybil clique is A_clique, a dense substochastic matrix. There are no edges between the clique and the real network.

### Analysis of disconnected Sybil clique

The block structure of A is:

```
A = [ A_real     0      ]
    [ 0        A_clique ]
```

Then:

```
(I - alpha A)^{-1} = [ (I - alpha A_real)^{-1}     0                          ]
                      [ 0                            (I - alpha A_clique)^{-1}  ]
```

The scores decouple completely:

```
s_real   = (I - alpha A_real)^{-1} Y_real
s_clique = (I - alpha A_clique)^{-1} Y_clique
```

The clique's score depends entirely on Y_clique (the intrinsic simulation time of the Sybils). **If the Sybils actually run fast simulations, their Y_clique is large, and their scores are large.** The Bonacich model with a disconnected clique provides ZERO Sybil resistance against players who can generate large Y values.

### Comparison with PageRank

In PageRank, the transition matrix is *row-normalized* (each row sums to exactly 1). A disconnected clique has PageRank proportional to its size relative to the full network, not proportional to some exogenous quality. PageRank measures structural importance, not intrinsic value amplified by structure.

Bonacich centrality with exogenous values Y is fundamentally different: it amplifies Y by network position. If Y is large, the amplification is large regardless of connectivity to the rest of the network.

### Key finding: Bonacich does NOT resist Sybils

**The Bonacich model provides no Sybil resistance whatsoever for disconnected cliques.** The clique's score is determined by (I - alpha A_clique)^{-1} Y_clique. A manipulator who creates N Sybils, each with simulation time T, gets a total clique score that is at least N * T (from the identity term alone), amplified by the internal sharing structure.

This is strictly WORSE than the current multiplicative model `score = simulation_time * sharing_frequency * trust_score`, which at least zeros out disconnected players via PageRank.

### What if the clique connects to the real network?

If a few edges connect the clique to the real network, the block structure breaks. Let the full matrix be:

```
A = [ A_real   B   ]
    [ C     A_cl   ]
```

where B and C are small cross-block matrices. The Neumann series (I - alpha A)^{-1} now couples the two blocks. Specifically, real player i gets a contribution from Sybil j's value Y_j via paths that go through the cross-edges. Conversely, Sybils get contributions from real players' values.

The concern: Sybils might not benefit much from connections to the real network (they already have high Y), but the real players are now artificially boosted by (or depleted by, depending on direction) the Sybil values. This does not help the Sybils directly but distorts the real network's scores.

**Conclusion: Bonacich centrality is NOT Sybil-resistant.** It is designed to measure power/influence in a network, not to resist manipulation. Adding it to a coin protocol without additional defenses is dangerous.

---

## 4. Time Dilation Attack

### Setup

Player F (fast miner) runs their simulation at 1000x real-time speed. They spend all their time simulating and never share: A_{F,*} = 0 (all zeros in F's row).

### Analysis

With A_{F,*} = 0, the F-th row of (I - alpha A) is just the F-th row of I (all zeros except a 1 on the diagonal). Therefore:

```
s_F = [(I - alpha A)^{-1} Y]_F
```

Since F's row of A is zero, the Neumann series gives:

```
s_F = Y_F + alpha * 0 + alpha^2 * 0 + ... = Y_F
```

Wait -- this is not quite right. The (I - alpha A)^{-1} matrix is not block-diagonal just because one row of A is zero. Let me be more careful.

The Neumann series gives s = sum_{k=0}^{inf} alpha^k A^k Y. The i-th component is:

```
s_i = sum_{k=0}^{inf} alpha^k sum_j (A^k)_{ij} Y_j
```

For i = F: `(A^k)_{Fj} = ?` We need to compute the F-th row of A^k. Since the F-th row of A is all zeros, `(A^2)_{Fj} = sum_m A_{Fm} A_{mj} = 0` for all j (because A_{Fm} = 0 for all m). By induction, `(A^k)_{Fj} = 0` for all k >= 1.

Therefore:

```
s_F = Y_F + sum_{k=1}^{inf} alpha^k * 0 = Y_F
```

**Confirmed: A player who never shares has score exactly equal to their intrinsic simulation time.** Running 1000x faster gives exactly 1000x the score. The Bonacich model provides zero defense against time dilation for non-sharing players.

### Is this desirable?

This is the question. Arguments:

**For (this is fine):**
- A player who runs faster really has simulated more. If the goal is to measure simulation work, this is correct.
- The Bonacich model adds social bonuses on top of intrinsic value. Solo miners get no social bonus. This is the intended tradeoff.

**Against (this is a problem):**
- Per Attack 2 in the adversarial analysis, simulation time is trivially inflatable by running faster. The entire `Y` vector is gameable.
- If the protocol's goal is to reward *real-time* simulation commitment, then raw simulation ticks should not be the intrinsic value.
- A well-resourced player with a fast server dominates all phone-based players, regardless of social activity.

**Verdict:** Whether this is desirable depends on the protocol's philosophy. If "mining" is literally "running 6502 simulation cycles," then faster miners earn more, full stop. The Bonacich model does not change this -- it only adds a social amplifier. The fundamental time dilation vulnerability from the adversarial analysis (Attack 2/10) remains fully intact.

---

## 5. Cold Start

### Claim to verify

A new player with Y_i > 0 but no social connections has score = Y_i (not zero).

### Verification

A new player i has no sharing connections: A_{ij} = 0 for all j, and A_{ji} = 0 for all j.

From the analysis in Section 4 above, `s_i = Y_i`. **Confirmed.**

Moreover, other players' scores are unaffected by the new player's existence (since A_{ji} = 0, no paths lead through the new player).

**This is a significant improvement over the current multiplicative formula.** In the current spec (Section 11.1), `score = simulation_time * sharing_frequency * trust_score`, a player with zero sharing and zero trust gets score = 0. In the Bonacich model, the same player gets score = Y_i > 0.

The cold-start problem identified in Attacks 7 and 18 of the adversarial analysis is resolved by the additive structure of Bonacich centrality.

---

## 6. Alternative: Normalize A by Simulation Time

### Proposal

Define `A_{ij} = (time sharing with j) / (total simulation time of i)`. Then a player who shares 50% of their time has row sum 0.5, and a player who never shares has row sum 0.

### Analysis

This is already the definition given in the proposal. The row sum `sum_j A_{ij}` equals the fraction of player i's total time spent sharing (with anyone). The remainder `1 - sum_j A_{ij}` is solo time.

**Properties:**
- A is substochastic (row sums <= 1). All results from Sections 1-5 hold.
- A player who shares more (as a fraction of their time) has larger row sum, meaning more of their score comes from the social amplification terms.
- A player who shares 100% of their time has row sum 1, which is the boundary case. The spectral radius could equal 1 in this case, but alpha < 1 ensures convergence.

**Incentive structure:** Suppose player i doubles their simulation speed. Then Y_i doubles. But if their absolute sharing time stays the same, A_{ij} = (time sharing with j) / (2 * original total time), so A_{ij} halves. The social amplification terms change:

```
s_i = 2 Y_i + alpha * sum_j (A_{ij}/2) * Y_j + ...
```

The intrinsic term doubles, but the social terms are attenuated. Fast solo miners benefit linearly from speed. Fast social miners get diminishing social returns from speed.

This is arguably a good property: it means you cannot simultaneously game both the intrinsic value and the social amplifier by running faster.

---

## 7. Alternative: Use Sharing RATE Instead of Fraction

### Proposal

Define `A_{ij} = (number of shares with j) / (total board time of i)`, i.e., shares per unit time.

### Analysis

**Critical issue: A may no longer be substochastic.** If player i shares very frequently (e.g., shares with 100 partners every tick), the row sum `sum_j A_{ij}` could exceed 1. In this case, rho(A) could exceed 1, and the constraint alpha < 1/rho(A) becomes binding. The safe range of alpha shrinks.

Worse, if the sharing rate is unbounded, the spectral radius is unbounded, and there may be no valid alpha > 0.

**To make this work, the sharing rate must be bounded.** For example, require that at most one share can happen per tick, so `sum_j A_{ij} <= 1/board_time * total_shares <= 1` (if total shares <= board time). This recovers the substochastic property.

**Advantage over fraction-based A:** A separates simulation speed from sharing activity. Two players who share once per day have the same A_{ij} regardless of how fast they simulate. This means the social amplification is purely about social activity, not simulation speed.

**Disadvantage:** Requires bounding the sharing rate to keep A substochastic. The bound must be specified in the protocol.

**My recommendation:** Use the fraction-based definition (Section 6). It is naturally bounded, substochastic by construction, and has the desirable property of attenuating social terms for fast solo miners.

---

## 8. Choice of alpha

### Role of alpha

The parameter alpha controls how much weight is given to indirect connections.

From the Neumann series, the contribution of a path of length k is weighted by alpha^k. The "effective radius" of social influence is roughly 1/(1 - alpha) hops (the geometric series sum).

| alpha | Effective radius | Behavior |
|-------|-----------------|----------|
| 0.1   | ~1.1 hops       | Essentially only direct partners matter |
| 0.5   | 2 hops          | Direct and second-degree connections matter |
| 0.8   | 5 hops          | Deep network effects; distant connections significant |
| 0.95  | 20 hops         | Network structure dominates intrinsic value |
| 0.99  | 100 hops        | Approaches global averaging |

### Considerations for 6502coin

1. **Sybil resistance favors low alpha.** With low alpha, creating deep Sybil chains provides little benefit (each hop attenuates by alpha). Only direct connections matter. This limits the amplification a Sybil clique can achieve.

2. **Social incentives favor moderate alpha.** If only direct connections matter (low alpha), there is no incentive to build a broad network. Players only care about their immediate partners. With moderate alpha, players benefit from their partners being well-connected, which incentivizes community building.

3. **Stability favors low alpha.** With high alpha, small changes to the network topology (a player joins or leaves) propagate widely through the score vector. With low alpha, scores are mostly determined by local structure and are stable.

4. **Computation favors low alpha.** The Neumann series converges faster for smaller alpha. Truncating at k terms gives error bounded by alpha^k / (1 - alpha) (in operator norm relative to ||Y||).

### Quantitative recommendation

For a social game protocol, I recommend **alpha in [0.3, 0.5]**. This gives:

- Direct partners contribute at 30-50% of their intrinsic value
- Partners-of-partners contribute at 9-25%
- Three hops away: 2.7-12.5%
- Beyond three hops: negligible

At alpha = 0.5, a Sybil chain of length k amplifies the endpoint's value by at most alpha^k = 0.5^k. A chain of 10 Sybils amplifies by 0.1%. This makes long Sybil chains pointless.

At alpha = 0.5 with a dense clique of N Sybils all sharing equally, the maximum eigenvalue of A_clique approaches 1 (for large N), so (1 - 0.5 * 1)^{-1} = 2, meaning each Sybil's score is at most 2x their intrinsic Y value. The amplification is bounded and modest.

### Formal bound for clique amplification

Consider N Sybils sharing equally. Within the clique, A_{ij} = 1/(N-1) for i != j and A_{ii} = 0. The matrix A_clique has eigenvalues:
- lambda_1 = (N-1)/(N-1) = 1 (eigenvector: all-ones)
- lambda_2 = ... = lambda_N = -1/(N-1) (eigenvectors: orthogonal to all-ones)

Wait, let me recompute. A_clique = (1/(N-1)) * (J - I) where J is the all-ones matrix. J has eigenvalues N (multiplicity 1) and 0 (multiplicity N-1). So:

```
A_clique = (1/(N-1)) * (J - I)
```

Eigenvalues:
- For the all-ones eigenvector: (1/(N-1)) * (N - 1) = 1
- For vectors orthogonal to all-ones: (1/(N-1)) * (0 - 1) = -1/(N-1)

So rho(A_clique) = 1 (the spectral radius is exactly 1).

**But wait: the row sums of A_clique are exactly 1** (each node shares equally with all N-1 others, fractions sum to 1). This means A_clique is stochastic, not just substochastic. For alpha < 1, the inverse still exists:

```
(I - alpha A_clique)^{-1}
```

The eigenvalues of (I - alpha A_clique) are:
- 1 - alpha * 1 = 1 - alpha (for the all-ones direction)
- 1 - alpha * (-1/(N-1)) = 1 + alpha/(N-1) (for the other N-1 directions)

The inverse has eigenvalues:
- 1/(1 - alpha) (for all-ones)
- (N-1)/(N-1 + alpha) (for the other directions)

If all Sybils have the same intrinsic value Y_i = T, then Y_clique = T * (1, 1, ..., 1)^T, which is in the all-ones eigenspace. Therefore:

```
s_clique = (I - alpha A_clique)^{-1} (T * 1) = (1/(1-alpha)) * T * 1
```

Each Sybil's score is T / (1 - alpha).

At alpha = 0.5: each Sybil scores 2T (double their intrinsic value).
At alpha = 0.8: each Sybil scores 5T.
At alpha = 0.95: each Sybil scores 20T.

**This is the maximum amplification a clique can achieve.** For a clique of N equally-sharing Sybils, each Sybil's score is Y_i / (1 - alpha), regardless of N. The amplification factor is 1/(1 - alpha) and is independent of clique size.

This is actually a useful property: making the clique larger does NOT increase the per-node amplification. It only increases the TOTAL score (which is N * Y / (1-alpha)), but that is just because there are N nodes each with intrinsic value Y.

---

## 9. Adversarial Analysis: Each Attack from coin-protocol-adversarial.md

### Attack 1: Sybil Farming via Attestation Rings

**Bonacich effect: WORSENS the attack (compared to current multiplicative model).**

In the current model, disconnected Sybils have PageRank = 0, so score = 0 regardless of simulation time. In the Bonacich model, disconnected Sybils have score = Y (intrinsic value), which is nonzero. The Bonacich model gives Sybils a baseline they did not have before.

However, the amplification from internal sharing is bounded by 1/(1-alpha) per node (Section 8 analysis). For alpha = 0.5, this is 2x. A Sybil farm of 1000 nodes each running T ticks scores total 1000 * 2T = 2000T. In the current model, the same farm scores 0 (disconnected from real network) or very little (if connected, limited by PageRank share).

**If the Sybils connect to the real network:** The Bonacich model provides some resistance here. Unlike PageRank, which flows freely through the network, Bonacich influence is attenuated by alpha per hop. A Sybil cluster connected by a few bridge edges to the real network gets limited "inflow" of real players' values, attenuated by alpha at each bridge crossing. But the main concern is the intrinsic Y values of the Sybils themselves, which are not attenuated.

**Verdict: Bonacich is worse for Sybil resistance than the current model.** The current model's multiplicative structure with PageRank zeros out disconnected Sybils completely. Bonacich gives them score = Y > 0.

### Attack 2/10: History Fabrication / Time Dilation

**Bonacich effect: NO CHANGE.**

The attack targets Y (simulation time), not the social structure. Whether the score formula is multiplicative with PageRank or Bonacich makes no difference: Y is gameable in both models. The Bonacich model makes time dilation slightly worse for solo miners (they get score = Y instead of score = 0 from the current model's multiplicative collapse), but this is the same issue as Sybil resistance.

### Attack 3/6: Challenge Protocol Evasion / Merkle Forgery

**Bonacich effect: NO EFFECT.**

These attacks target the cryptographic verification layer, not the scoring model. Bonacich vs. multiplicative scoring is orthogonal to challenge protocol design.

### Attack 4: Trivial Edge Sharing

**Bonacich effect: SLIGHTLY MITIGATES (but does not eliminate).**

In the current model, trivial sharing earns a flat 1.5x multiplier. In the Bonacich model, sharing with a partner who has low Y_j contributes little to your score (alpha * A_{ij} * Y_j is small if Y_j is small). Two empty boards sharing with each other amplify each other's values, but if their Y values are small (empty boards simulate cheaply, so Y is small per unit wall-clock time), the amplified values are still small.

However, if the trivial boards are run on fast hardware, their Y can be large, and the amplification applies. So the mitigation is partial: it ties the social bonus to the partner's intrinsic value rather than being a flat multiplier.

### Attack 5: Timestamper Griefing

**Bonacich effect: NO EFFECT.**

Timestamper griefing targets the move-ordering layer, not scoring.

### Attack 7: Selective Attestation / Cold Start

**Bonacich effect: MITIGATES the cold start problem.**

As shown in Section 5, a new player with no connections has score = Y_i > 0 in the Bonacich model, versus score = 0 in the current multiplicative model. This eliminates the cold-start zeroing problem (Attack 18 in the adversarial analysis).

Selective attestation (elite gatekeeping) is partially mitigated: new players are not shut out entirely (they have score = Y > 0 from solo mining), but well-connected players still have higher scores due to social amplification.

### Attack 8: State Size DoS

**Bonacich effect: NO EFFECT.**

This targets the verification protocol, not scoring.

### Attack 17: Collusion Equilibrium

**Bonacich effect: WORSENS (slightly).**

Two colluders who share maximally (A_{ij} large) amplify each other's scores. In the current model, collusion earns a flat 1.5x multiplier. In the Bonacich model, two players sharing all their time with each other get:

For two players sharing 100% with each other: A_{12} = A_{21} = 1, all other entries 0. Then:

```
A = [0  1]
    [1  0]
```

Eigenvalues of A: +1 and -1. (I - alpha A) has eigenvalues (1 - alpha) and (1 + alpha). The inverse:

```
(I - alpha A)^{-1} = 1/((1-alpha)(1+alpha)) * [(1+alpha)  alpha    ]
                                                 [alpha      (1+alpha)]
                    = 1/(1-alpha^2) * [1+alpha   alpha  ]
                                       [alpha     1+alpha]
```

Scores:

```
s_1 = ((1+alpha) Y_1 + alpha Y_2) / (1 - alpha^2)
s_2 = (alpha Y_1 + (1+alpha) Y_2) / (1 - alpha^2)
```

If Y_1 = Y_2 = T:

```
s_1 = s_2 = T(1 + 2*alpha) / (1 - alpha^2) = T(1 + 2*alpha) / ((1-alpha)(1+alpha))
           = T / (1 - alpha)  [simplifying: (1+2alpha)/((1-alpha)(1+alpha))]
```

Wait, let me recompute: `(1 + alpha) T + alpha T = (1 + 2 alpha) T`. Divided by `(1 - alpha^2) = (1-alpha)(1+alpha)`:

```
s = (1 + 2 alpha) / ((1-alpha)(1+alpha)) * T
```

At alpha = 0.5: s = 2 / (0.5 * 1.5) * T = 2/0.75 * T = 2.667 T.

Compare with a solo miner: score = T. The two colluders each get 2.667x their intrinsic value, versus the current model's 1.5x social multiplier.

At alpha = 0.3: s = 1.6 / (0.7 * 1.3) * T = 1.6 / 0.91 * T = 1.758 T. More modest.

**So the collusion amplification at alpha = 0.5 is 2.667x, versus the current model's 1.5x. This is worse.** But the Bonacich model has the advantage that the amplification depends on the partner's Y value (a partner with low Y contributes little), whereas the current 1.5x is unconditional.

---

## 10. Can Two Colluders Optimize Their Sharing Fraction?

### Setup

Players 1 and 2 collude. They choose A_{12} = a and A_{21} = b (the sharing fractions they allocate to each other). All other entries are 0. They want to maximize their total score s_1 + s_2.

The 2x2 system (ignoring other players for clarity):

```
A = [0  a]
    [b  0]
```

Eigenvalues: +/- sqrt(ab). The inverse:

```
(I - alpha A)^{-1} = 1/(1 - alpha^2 ab) * [1        alpha*a]
                                             [alpha*b  1      ]
```

Verification: (I - alpha A) * (I - alpha A)^{-1} should equal I.

```
[1      -alpha*a] * 1/(1-alpha^2*ab) * [1        alpha*a]
[-alpha*b  1    ]                       [alpha*b  1      ]

Row 1: [1 - alpha*a*alpha*b,  alpha*a - alpha*a] / (1-alpha^2*ab)
     = [1 - alpha^2*ab,  0] / (1-alpha^2*ab) = [1, 0]  Correct.

Row 2: [-alpha*b + alpha*b,  -alpha^2*ab + 1] / (1-alpha^2*ab)
     = [0, 1-alpha^2*ab] / (1-alpha^2*ab) = [0, 1]  Correct.
```

**Confirmed.**

Scores:

```
s_1 = (Y_1 + alpha * a * Y_2) / (1 - alpha^2 * a * b)
s_2 = (alpha * b * Y_1 + Y_2) / (1 - alpha^2 * a * b)
```

Total score:

```
S = s_1 + s_2 = (Y_1 + Y_2 + alpha(a Y_2 + b Y_1)) / (1 - alpha^2 a b)
```

To maximize S, we choose a and b. Constraints: 0 <= a <= 1, 0 <= b <= 1.

**Taking partial derivative with respect to a:**

Let D = 1 - alpha^2 a b and N = Y_1 + Y_2 + alpha(a Y_2 + b Y_1).

```
dS/da = (alpha Y_2 * D + alpha^2 b * N) / D^2
      = (alpha Y_2 (1 - alpha^2 ab) + alpha^2 b (Y_1 + Y_2 + alpha a Y_2 + alpha b Y_1)) / D^2
```

The numerator is always positive (all terms are non-negative with positive Y values). **Therefore S is strictly increasing in a.** Similarly, S is strictly increasing in b.

**Conclusion: The optimal strategy for colluders is a = b = 1 (share 100% of their time with each other).** This maximizes total score.

At a = b = 1:

```
S = (Y_1 + Y_2 + alpha(Y_2 + Y_1)) / (1 - alpha^2)
  = (1 + alpha)(Y_1 + Y_2) / (1 - alpha^2)
  = (1 + alpha)(Y_1 + Y_2) / ((1-alpha)(1+alpha))
  = (Y_1 + Y_2) / (1 - alpha)
```

Compare with no sharing (a = b = 0): S = Y_1 + Y_2.

The collusion amplification factor is 1/(1-alpha):
- alpha = 0.3: amplification = 1.43x
- alpha = 0.5: amplification = 2x
- alpha = 0.8: amplification = 5x

---

## 11. Provably Optimal Strategy for a Rational Player

### Solo player optimization

A player with no connections maximizes score by maximizing Y_i (run the simulation as fast as possible). Score = Y_i. There is no strategic decision beyond computational investment.

### Player with one potential partner

Player 1 can share with player 2. Player 1 chooses a = A_{12} (fraction of time sharing with player 2). Player 2 chooses b = A_{21} independently.

Player 1's score:

```
s_1 = (Y_1 + alpha * a * Y_2) / (1 - alpha^2 * a * b)
```

Taking derivative with respect to a:

```
ds_1/da = (alpha Y_2 (1 - alpha^2 ab) + alpha^2 b (Y_1 + alpha a Y_2)) / (1 - alpha^2 ab)^2
```

All terms in the numerator are non-negative (assuming Y_1, Y_2, a, b, alpha > 0). **So s_1 is strictly increasing in a, regardless of b.**

**This means: regardless of what your partner does, you always benefit from sharing MORE with them.** Setting a = 1 (sharing 100% of your time with one partner) is always optimal if you have exactly one partner.

### Player with multiple potential partners

Player i has potential partners j_1, j_2, ..., j_m. They choose sharing fractions a_1, a_2, ..., a_m with sum(a_k) <= 1.

The full score depends on the entire network structure. In general, the player should allocate sharing time to the partner with the highest "effective value" -- roughly, the partner whose Bonacich centrality is highest. But the Bonacich centralities depend on everyone's choices simultaneously, creating a complex game.

### Nash equilibrium analysis (simplified)

In the two-player case, both players maximizing their individual scores leads to a = b = 1 (both share 100% of their time). This is a Nash equilibrium: neither player can increase their score by deviating.

But this means neither player does any solo simulation! If sharing time is separate from simulation time (i.e., you can simulate AND share simultaneously), then there is no tradeoff. But if sharing requires board time (ticks spent on boundary exchange instead of solo simulation), there IS a tradeoff.

**Under the model as defined** (A_{ij} = fraction of board time spent sharing), setting a = 1 means the player spends all board time sharing and none solo. But Y_i = total simulation time, which includes time spent sharing. So Y_i does not decrease when a increases -- the player is just running their simulation while exchanging boundaries.

**Therefore there is no tradeoff in the model as defined.** A player should always share as much as possible with the highest-value partners. The optimal strategy is:

1. Run your simulation as fast as possible (maximize Y_i)
2. Share with as many high-Y partners as possible (maximize the A_{ij} values with partners who have high Bonacich centrality)
3. If time is limited, prioritize partners with the highest effective values

This is actually a *desirable* incentive structure for the protocol: it rewards both computation (large Y) and social connectivity (large A entries with high-value partners). The concern is that it also rewards Sybil farming (Section 3).

---

## Summary and Recommendations

### Properties of the Bonacich Model

| Property | Assessment |
|----------|-----------|
| Well-defined for alpha in (0,1) | YES (proven in Section 1) |
| Interpretable as social-distance-weighted value | YES (proven in Section 2) |
| Sybil resistant (disconnected cliques) | NO -- cliques score Y > 0 (Section 3) |
| Sybil resistant (connected cliques) | WEAK -- amplification bounded by 1/(1-alpha) (Section 8) |
| Time dilation resistant | NO -- solo miners score proportional to Y (Section 4) |
| Cold start friendly | YES -- new players score Y > 0 (Section 5) |
| Collusion resistant | WEAK -- two colluders get 1/(1-alpha) amplification (Section 10) |
| Incentive-compatible | YES -- sharing more always helps (Section 11) |

### Comparison with Current Multiplicative Model

| Dimension | Current Model | Bonacich |
|-----------|--------------|----------|
| Cold start | Score = 0 (BROKEN) | Score = Y > 0 (FIXED) |
| Sybil resistance | Disconnected Sybils score 0 (GOOD) | Disconnected Sybils score Y > 0 (WORSE) |
| Collusion amplification | 1.5x (flat) | 1/(1-alpha) (tunable, higher for large alpha) |
| Social incentive structure | Flat multiplier | Recursive, decaying by social distance |
| Computation | Requires PageRank (iterative) | Requires matrix inverse or series truncation |

### Key Mathematical Findings

1. **(I - alpha A)^{-1} is well-defined for alpha in (0,1).** This is correct and follows from the substochastic property of A.

2. **The maximum amplification any clique can achieve is 1/(1-alpha) per node.** This is a hard upper bound independent of clique size. This is actually a useful property: making a Sybil clique larger does not increase per-capita amplification.

3. **The optimal colluder strategy is to share 100% of time with each other.** The total score monotonically increases with sharing fraction. There is no interior optimum.

4. **The model solves the cold-start problem** at the cost of weakening Sybil resistance. This is the fundamental tradeoff.

### Recommendations

1. **Use alpha in [0.3, 0.5].** This limits collusion amplification to 1.43x--2x while providing meaningful social incentives.

2. **Combine Bonacich with an independent Sybil defense.** The Bonacich model is not Sybil-resistant on its own. Layer it with identity cost (proof-of-work on pubkey), activity thresholds, or personalized trust scores.

3. **Consider a hybrid model:**
   ```
   score = (1-beta) * Y_i + beta * [(I - alpha A)^{-1} Y]_i
   ```
   where beta in (0,1) controls the weight of social vs. intrinsic value. At beta = 0, pure solo mining. At beta = 1, full Bonacich. A moderate beta (e.g., 0.3) ensures solo mining is the dominant contributor while social activity provides a meaningful bonus.

   Note: this is equivalent to `score = [(1-beta) I + beta (I - alpha A)^{-1}] Y]_i`, which is still a linear function of Y. For beta < 1, the matrix `(1-beta) I + beta (I - alpha A)^{-1}` is always invertible and well-conditioned, so this is numerically stable.

4. **Normalize Y by real-time attestation if possible.** The time dilation vulnerability is shared by both models. If external entropy or interactive proofs can bound Y to real-time, the Bonacich model becomes much more robust.

5. **Do not use Bonacich alone as a replacement for PageRank.** PageRank measures structural importance (independent of exogenous values). Bonacich amplifies exogenous values by structural position. These are complementary. Consider:
   ```
   score = [(I - alpha A)^{-1} Y]_i * PageRank_i^gamma
   ```
   where gamma > 0 controls the weight of structural trust. This reintroduces Sybil resistance (disconnected cliques have low PageRank) while preserving the cold-start benefit (Y > 0 ensures non-zero score as long as PageRank > 0, and even disconnected nodes have some PageRank from the teleportation/damping factor in standard PageRank).
