// Pump.fun Bot Sprint: a small-stake launch sniper for agent-fun/replay/v2.
//
// The bot watches every new pump.fun bonding curve from its CreateEvent and
// buys a tiny fixed stake in launches whose opening tape looks alive: the
// coin is only a few trades old, most of its last few trades are buys, and
// the curve already holds real SOL. One tranche per coin, at most five open
// positions, exits on take-profit (+30%) / stop-loss (-8%) / trailing stop
// (arms +15%, sells on an 8% pullback) / stale tape / a hard hold cap.
// A round trip costs roughly 3% in curve + tx fees and the median new coin
// drifts down, so the edge — if any — is in catching the minority of
// launches that pop right after birth and cutting the rest fast.
//
// Deterministic: every decision is a pure function of the harness batches
// (no clock, no randomness, no network, no environment reads), so two runs
// on the same window produce byte-identical action logs.
//
// Run by the grader as `node main.ts` (Node 22.18+ strips the types).
// No dependencies.

// ---------------------------------------------------------------- parameters
const STAKE_LAMPORTS = 20_000_000n; // 0.02 SOL per coin, one tranche
const MIN_BUY_LAMPORTS = 10_000_000n; // a round trip must be >= 0.01 SOL
const MIN_REAL_SOL = 2_000_000_000n; // curve must hold >= 2 SOL to enter
const ENTRY_MIN_TRADES = 2; // buy on the coin's 2nd..8th trade
const ENTRY_MAX_TRADES = 8;
const ENTRY_MIN_BUYS_LAST3 = 2; // >= 2 of the last 3 trades are buys
const TP_BPS = 3000; // take profit: +30% over cost
const SL_BPS = 800; // stop loss: -8% under cost
const TRAIL_ARM_BPS = 1500; // trailing stop arms at +15%
const TRAIL_BPS = 800; // ... and sells on an 8% pullback from the best
const STALE_TRADES = 150; // stale exit: 150 trades after entry ...
const STALE_GAIN_BPS = 500; // ... while still under +5%
const MAX_HOLD_SLOTS = 40000; // hard hold cap, in slots
const MAX_ROUND_TRIPS = 35; // stop entering after this many round trips
const DEV_SELL_EXIT = true; // exit when the creator sells while held
const BUY_SLIPPAGE_BPS = 10000;
const SELL_SLIPPAGE_BPS = 10000;
const SIZE_CAP_FRAC_NUM = 4n; // never spend more than 80% of the
const SIZE_CAP_FRAC_DEN = 5n; // protocol size cap (1% of real reserves)
const FEE_BPS = 125n; // curve fees on a sale: protocol 95 + creator 30
const BPS = 10000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

// ---------------------------------------------------------------- types
type U64 = string;

interface Hello {
  type: "hello";
  protocol: string;
  seed: U64;
  universe: unknown;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

interface ChainEvent {
  event: string;
  mint: string;
  slot: number;
  [key: string]: unknown;
}

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface Fill {
  client_id: string;
  mint: string;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "failed";
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}

interface Position {
  mint: string;
  token_amount: U64;
  cost_lamports: U64;
}

interface Batch {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: U64; positions: Position[] };
}

interface Done {
  type: "done";
  seq: number;
  reason: string;
  account: { cash_lamports: U64; positions: Position[] };
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: U64;
  token_amount?: U64;
  max_slippage_bps: number;
}

// ---------------------------------------------------------------- per-coin tape
interface Coin {
  mint: string;
  creator: string;
  createSlot: number;
  vq0: bigint;
  vt0: bigint;
  trades: number;
  last3: boolean[]; // is_buy of the last <= 3 trades, oldest first
  buyers: Set<string>;
  bought: bigint;
  soldByOthers: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  attempted: boolean; // a buy was already sent for this coin
  done: boolean; // never consider again (exited, completed, too old)
}

interface Curve {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  openedTrades: number;
  best: bigint; // best net sell value seen, lamports
  txPaid: bigint; // tx fees paid on this position's fills
  devSoldAtOpen: boolean;
}

interface Pending {
  side: "buy" | "sell";
  mint: string;
  amount: bigint;
}

// ---------------------------------------------------------------- state
let hello: Hello | null = null;
let cash = 0n;
let txFee = 0n;
const positions = new Map<string, { tokens: bigint; cost: bigint }>();
const curves = new Map<string, Curve>();
const coins = new Map<string, Coin>();
const held = new Map<string, Held>();
const pending = new Map<string, Pending>();
const selling = new Set<string>();
let roundTrips = 0;
let nextId = 1;

function clientId(): string {
  return `o${nextId++}`;
}

/** What selling `tokens` against reserves (vq, vt) nets after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const fee = (gross * FEE_BPS + BPS - 1n) / BPS;
  const net = gross - fee;
  return net > 0n ? net : 0n;
}

function freeCash(): bigint {
  let free = cash;
  for (const p of pending.values()) {
    free -= txFee;
    if (p.side === "buy") free -= p.amount;
  }
  return free;
}

function openCount(): number {
  const mints = new Set<string>(positions.keys());
  for (const p of pending.values()) if (p.side === "buy") mints.add(p.mint);
  return mints.size;
}

function hasPendingBuy(mint: string): boolean {
  for (const p of pending.values()) {
    if (p.mint === mint && p.side === "buy") return true;
  }
  return false;
}

function hasPendingSell(mint: string): boolean {
  for (const p of pending.values()) {
    if (p.mint === mint && p.side === "sell") return true;
  }
  return false;
}

/** Size cap on this mint now: 80% of (max_order_bps of real quote reserves). */
function maxBuy(mint: string): bigint {
  const c = curves.get(mint);
  if (c === undefined || c.complete) return 0n;
  if (hello === null) return 0n;
  const cap =
    (c.rq * BigInt(hello.caps.max_order_bps_of_real_reserve)) / BPS;
  return (cap * SIZE_CAP_FRAC_NUM) / SIZE_CAP_FRAC_DEN;
}

function applyFills(batch: Batch): void {
  for (const f of batch.fills) {
    pending.delete(f.client_id);
    if (f.client_id.startsWith("_")) {
      // Harness close (complete / flatten / writeoff): position is gone.
      if (held.has(f.mint)) {
        held.delete(f.mint);
        selling.delete(f.mint);
        roundTrips += 1;
      }
      continue;
    }
    const h = held.get(f.mint);
    if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
    if (f.side === "buy" && f.status === "filled" && h === undefined) {
      const c = coins.get(f.mint);
      held.set(f.mint, {
        openedSlot: f.slot,
        openedTrades: c !== undefined ? c.trades : 0,
        best: 0n,
        txPaid: BigInt(f.tx_fee_lamports),
        devSoldAtOpen: c !== undefined ? c.devSold : false,
      });
    }
    if (f.side === "sell" && f.status === "filled") {
      // A filled sell closes the round trip when no tokens remain; the
      // account in this batch already reflects the fill.
      const stillHeld = batch.account.positions.some(
        (p) => p.mint === f.mint && BigInt(p.token_amount) > 0n,
      );
      if (!stillHeld && held.has(f.mint)) {
        held.delete(f.mint);
        selling.delete(f.mint);
        roundTrips += 1;
        const c = coins.get(f.mint);
        if (c !== undefined) c.done = true;
      }
    }
  }
}

function applyAccount(batch: Batch): void {
  cash = BigInt(batch.account.cash_lamports);
  positions.clear();
  for (const p of batch.account.positions) {
    const tokens = BigInt(p.token_amount);
    if (tokens > 0n) {
      positions.set(p.mint, {
        tokens,
        cost: BigInt(p.cost_lamports),
      });
    }
  }
}

function applyEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const mint = e.mint;
      coins.set(mint, {
        mint,
        creator: String(e.creator),
        createSlot: e.slot,
        vq0: BigInt(String(e.virtual_quote_reserves)),
        vt0: BigInt(String(e.virtual_token_reserves)),
        trades: 0,
        last3: [],
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        devSold: false,
        lastTradeSlot: e.slot,
        attempted: false,
        done: false,
      });
      curves.set(mint, {
        vq: BigInt(String(e.virtual_quote_reserves)),
        vt: BigInt(String(e.virtual_token_reserves)),
        rq: 0n,
        rt: BigInt(String(e.real_token_reserves)),
        complete: false,
      });
    } else if (e.event === "TradeEvent") {
      const mint = e.mint;
      let curve = curves.get(mint);
      if (curve === undefined) {
        curve = { vq: 0n, vt: 0n, rq: 0n, rt: 0n, complete: false };
        curves.set(mint, curve);
      }
      curve.vq = BigInt(String(e.virtual_quote_reserves));
      curve.vt = BigInt(String(e.virtual_token_reserves));
      curve.rq = BigInt(String(e.real_quote_reserves));
      curve.rt = BigInt(String(e.real_token_reserves));
      const c = coins.get(mint);
      if (c === undefined) continue;
      const sol = BigInt(String(e.sol_amount));
      const isBuy = e.is_buy === true;
      c.trades += 1;
      c.lastTradeSlot = e.slot;
      c.last3.push(isBuy);
      if (c.last3.length > 3) c.last3.shift();
      const isDev = e.user === c.creator;
      if (isBuy) {
        c.bought += sol;
        if (!isDev) c.buyers.add(String(e.user));
      } else if (isDev) {
        c.devSold = true;
      } else {
        c.soldByOthers += sol;
      }
    } else if (e.event === "CompleteEvent") {
      const curve = curves.get(e.mint);
      if (curve !== undefined) curve.complete = true;
      const c = coins.get(e.mint);
      if (c !== undefined) c.done = true;
    }
  }
}

function decide(batch: Batch): Order[] {
  const orders: Order[] = [];
  if (hello === null) return orders;
  const cap = hello.caps.max_orders_per_batch;
  const slot = batch.slot;

  // Drop stale "selling" flags whose sell already resolved.
  for (const mint of [...selling]) {
    if (!hasPendingSell(mint)) selling.delete(mint);
  }
  // Drop held records for positions that vanished without a fill we saw.
  for (const mint of [...held.keys()]) {
    if (
      !positions.has(mint) &&
      !selling.has(mint) &&
      !hasPendingBuy(mint)
    ) {
      held.delete(mint);
    }
  }

  // ---- exits first ----
  for (const [mint, pos] of positions) {
    if (orders.length >= cap) break;
    if (selling.has(mint)) continue;
    const curve = curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    let h = held.get(mint);
    if (h === undefined) {
      const c = coins.get(mint);
      h = {
        openedSlot: slot,
        openedTrades: c !== undefined ? c.trades : 0,
        best: 0n,
        txPaid: txFee,
        devSoldAtOpen: c !== undefined ? c.devSold : false,
      };
      held.set(mint, h);
    }
    const value = sellValue(pos.tokens, curve.vq, curve.vt) - txFee;
    const basis = pos.cost + h.txPaid;
    if (basis <= 0n) continue;
    if (value > h.best) h.best = value;
    const c = coins.get(mint);
    let exit = false;
    const tp = BigInt(TP_BPS);
    const sl = BigInt(SL_BPS);
    const trailArm = BigInt(TRAIL_ARM_BPS);
    const trail = BigInt(TRAIL_BPS);
    const staleGain = BigInt(STALE_GAIN_BPS);
    if (value * BPS >= basis * (BPS + tp)) exit = true;
    if (value * BPS <= basis * (BPS - sl)) exit = true;
    if (
      h.best * BPS >= basis * (BPS + trailArm) &&
      value * BPS <= h.best * (BPS - trail)
    ) {
      exit = true;
    }
    if (slot - h.openedSlot >= MAX_HOLD_SLOTS) exit = true;
    if (c !== undefined) {
      if (DEV_SELL_EXIT && c.devSold && !h.devSoldAtOpen) exit = true;
      if (
        c.trades - h.openedTrades >= STALE_TRADES &&
        value * BPS < basis * (BPS + staleGain)
      ) {
        exit = true;
      }
    }
    if (!exit) continue;
    const id = clientId();
    orders.push({
      side: "sell",
      client_id: id,
      mint,
      token_amount: pos.tokens.toString(),
      max_slippage_bps: SELL_SLIPPAGE_BPS,
    });
    pending.set(id, { side: "sell", mint, amount: pos.tokens });
    selling.add(mint);
  }

  // ---- entries ----
  if (roundTrips >= MAX_ROUND_TRIPS) return orders;
  let free = freeCash() - txFee * BigInt(orders.length);
  let open = openCount();
  for (const c of coins.values()) {
    if (orders.length >= cap) break;
    if (c.done || c.attempted || c.complete) continue;
    if (c.trades > ENTRY_MAX_TRADES) {
      c.done = true;
      continue;
    }
    if (c.trades < ENTRY_MIN_TRADES) continue;
    if (open >= hello.caps.max_open_positions) break;
    if (positions.has(c.mint) || hasPendingBuy(c.mint)) continue;
    const curve = curves.get(c.mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.rq < MIN_REAL_SOL) continue;
    if (c.devSold) {
      c.done = true;
      continue;
    }
    const buysLast3 = c.last3.filter(Boolean).length;
    if (buysLast3 < ENTRY_MIN_BUYS_LAST3) continue;
    const room = maxBuy(c.mint);
    const amount = STAKE_LAMPORTS < room ? STAKE_LAMPORTS : room;
    if (amount < MIN_BUY_LAMPORTS) continue;
    if (free < amount + txFee) continue;
    const id = clientId();
    orders.push({
      side: "buy",
      client_id: id,
      mint: c.mint,
      quote_lamports: amount.toString(),
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    pending.set(id, { side: "buy", mint: c.mint, amount });
    free -= amount + txFee;
    c.attempted = true;
    open += 1;
  }
  return orders;
}

async function main(): Promise<void> {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== "") handleLine(line);
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.trim() !== "") handleLine(buffer);
}

function handleLine(line: string): void {
  const msg = JSON.parse(line) as Hello | Batch | Done;
  if (msg.type === "hello") {
    hello = msg as Hello;
    cash = BigInt(msg.capital.lamports);
    txFee =
      BigInt(msg.fees.base_fee_lamports) +
      BigInt(msg.fees.priority_fee_lamports);
  } else if (msg.type === "batch") {
    const batch = msg as Batch;
    // Marks first (latest reserves for held/pending mints), then events.
    for (const m of batch.marks) {
      const curve = curves.get(m.mint);
      if (curve === undefined) continue;
      curve.vq = BigInt(m.virtual_quote_reserves);
      curve.vt = BigInt(m.virtual_token_reserves);
      curve.rq = BigInt(m.real_quote_reserves);
      curve.rt = BigInt(m.real_token_reserves);
    }
    applyFills(batch);
    applyAccount(batch);
    applyEvents(batch);
    const orders = decide(batch);
    process.stdout.write(
      JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n",
    );
  } else if (msg.type === "done") {
    // Final account already flattened by the harness; nothing to send.
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
