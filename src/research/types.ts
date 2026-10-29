import type { Venue } from "../data/programs.js";
import type { RankingId } from "../ranking/rank.js";

/** A fill on the tape: the first trade at or after the action time. */
export interface Fill {
  t: number;
  price: number | null;
  reserveSol: number | null;
  /** No trade within an hour, liquidity below the floor, or buy-only tape (honeypot). */
  rug: boolean;
  /** The tape could not be read (not stored and not fetchable): unknown, never counted as a rug. */
  missing?: boolean;
}

export interface LeaderSell {
  t: number;
  /** Fraction of the holding (as of just before this sell) that the leader sold. */
  frac: number;
  /** Leader's own SOL per token received (fees included); for a transfer out, the last traded price (placeholder). */
  price: number;
  poolPrice: number | null;
  /** "out": the leader transferred tokens away. A copier sees the tokens leave and exits; the leader's value for
   * these tokens is the tape price at that moment (delay-0 fill), not its own flows. Absent = "sell". */
  kind?: "sell" | "out";
}

/** Everything needed to re-simulate a follower of one leader buy, at any delay, without fetching. */
export interface ReplRecord {
  step: number;
  wallet: string;
  group: "ranked" | "random";
  ranks: Partial<Record<RankingId, number>>;
  sig: string;
  t: number;
  mint: string;
  pool: string;
  venue: Venue;
  leaderSol: number;
  leaderTokens: number;
  /** Leader's own pool price at the buy (zero-delay fill). */
  leaderPoolPrice: number;
  entryReserveSol: number | null;
  buyers30: number;
  sells: LeaderSell[];
  timeStopT: number;
  /** Per delay (seconds, as string keys): entry fill, mirrored exit fills, time-stop fill. */
  fills: Record<string, { entry: Fill; exits: Fill[]; timeStop: Fill | null }>;
  /** Sparse price path [t, price, reserveSol] in (t, timeStopT], for stops (probed records only). */
  path: Array<[number, number, number | null]> | null;
}
