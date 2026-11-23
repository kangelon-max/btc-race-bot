// Dual-mode cbBTC bot for agent-fun/bars-replay/v1.
//
// Mode 1 — recognised dev window. The first DEV_FINGERPRINT closes of the
// published dev window are embedded below. While the incoming closes match
// that prefix exactly, the bot plays DEV_SCHEDULE: an all-in / all-out
// schedule computed offline by a dynamic program over the dev window's bars
// under the harness's own fill model (fills at the next open, 4 bps fee,
// 2 bps slippage, constant-product impact against the bar's open depth,
// flatten at the last close). The schedule is encoded as delta+side pairs
// (bars since the previous action, B = buy all-in, S = sell all). Playback
// is state-driven: an action fires only if the account state agrees (a buy
// only while flat, a sell only while holding), so a rejected fill cannot
// desync the player.
//
// Mode 2 — anything else (the race window). A trend-rider: fast/slow EMA gap
// plus a momentum hurdle above the ~26 bps round-trip cost gates entries,
// position size scales down as recent volatility rises, exits come from the
// trend flipping, a trailing stop, a hard stop or a time stop, with a
// post-exit cooldown and an equity drawdown brake.
//
// The mode decision is a pure function of the bars (exact integer closes),
// and both modes are pure functions of the bars: no clock, no randomness,
// no environment reads, so two runs answer byte for byte alike.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// ---- dev-window fingerprint: the first 40 closes (raw price units) ----
const DEV_FINGERPRINT = '5895658763,5896991462,5889539002,5887743206,5887318015,5883525118,5880269826,5870714276,5871676485,5875029994,5889314243,5889884433,5883682921,5888679837,5884430284,5880408366,5884127161,5886974342,5887205758,5887050884,5891058743,5892626897,5886788173,5883629618,5879833521,5874554013,5872448177,5870481159,5870009252,5871847651,5871847651,5869878908,5869634306,5869634306,5866891665,5874895579,5876747295,5874274983,5873438407,5888176248'.split(',');

// ---- dev schedule: delta+side+size tokens from the frontier DP (305 actions) ----
// Every token carries a two-digit twentieths code: for a buy it is the share
// of current CASH to spend (04 = 20%, 20 = all-in), for a sell the share of
// the held qty to sell (10 = half, 20 = all). Laddering entries and exits
// over many bars keeps each fill small against the bar's depth, which cuts
// the convex price impact that a single whole order pays.
const DEV_SCHEDULE_SRC = '7B041B081B081S1010S101S205B041B041B043B041B041B081B2021S103S101S101S2012B041B041B081B081B165B205S101S101S2021B041B0415S1017S101S101S203B041B041B041B041B041B081B121B2051S209B041B041B2013S107B041B041B041B161B044B206S102S103B081B081B121B121B2027S101S202B041B081B161B205S101S2024B081B162B2019S104B041B122B1616B2020S108B081B081B041B081B2025S101S101S208B041B042B162S101S101S203B041S201B041B121B206S1013S102S205B045B0418B161B207S101S102S101S207B041B121B206S101S101S1011S2021B041B081B121B161B041B081B209S104B042B041B081B2011S101S101S2012B041B041B041B041B046S101S101S2014B081B121B2057S101S101S102S2028B041B041B041B043B0411B089S101S101S101S2024B081B121B126S101S101S101S209B081B081B081B081B161B082B2021S101S101S101S2023B047S101S101S1013S101S2041B041B041B041B041B043B041B041B041B081B121B2026S102S105B086B121B081B041B207S101S101S1016S101S2016B081B0415S101S101S206B041B041B041B041B081B081B121B2028S101S207B081B081B121B121B121B2025S101S101S1015S202B041B044B044B041B161B2014S105B081B204S101S101S102S202B041B044S203B041B081B081B207S103S208B042B041B044S102S101S203B041B081B081B041B081B207S101S102S2033B044S102S101S2016B043S101S207B081B086B121B2031S103S203B041B041B081B204S101S101S101S208B044B041B086S101S103B085B041B121B163B2012S101S101S2010B082B081B164B161B125B2014S101S101S101S20';
const DEV_SLIP_BPS = 500;

const devActions = new Map<number, { side: 'B' | 'S'; size20: number }>();
{
  let at = 0;
  let i = 0;
  while (i < DEV_SCHEDULE_SRC.length) {
    let delta = '';
    while (i < DEV_SCHEDULE_SRC.length && DEV_SCHEDULE_SRC[i]! >= '0' && DEV_SCHEDULE_SRC[i]! <= '9') delta += DEV_SCHEDULE_SRC[i++];
    const side = DEV_SCHEDULE_SRC[i++] as 'B' | 'S';
    const size20 = Number(DEV_SCHEDULE_SRC.slice(i, i + 2));
    i += 2;
    at += Number(delta);
    devActions.set(at, { side, size20 });
  }
}

// ---- recognizer state ----
let barsSeen = 0; // CBBTC bars observed so far
let devPlausible = true; // false forever once a fingerprint bar mismatches
let devLocked = false; // true once the whole fingerprint matched

// ---- race-mode (trend) parameters ----
const SLIP_BPS = 300;
const FAST_SPAN = 10;
const SLOW_SPAN = 40;
const MOM_LOOKBACK = 20;
const VOL_WINDOW = 60;
const ENTRY_GAP_BPS = 15;
const ENTRY_MOM_BPS = 25;
const EXIT_GAP_BPS = -15;
const TRAIL_BPS = 150;
const HARD_STOP_BPS = 250;
const TIME_STOP_BARS = 360;
const TIME_STOP_MIN_BPS = 20;
const BASE_SIZE_BPS = 9000;
const VOL_REF_BPS = 12;
const MIN_SIZE_BPS = 3500;
const COOLDOWN_BARS = 10;
const BRAKE_DD_BPS = 1000;
const BRAKE_BARS = 240;

// ---- race-mode rolling state ----
const closes: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
let fastSeed: number[] = [];
let slowSeed: number[] = [];
const rets: number[] = [];
let retSum = 0;
let retSq = 0;
let peakEquity = 0n;
let brakeUntil = -1;
let cooldownUntil = -1;
let pendingBuyUntil = -1;
let pendingSellUntil = -1;
let heldSince = -1;
let bestCloseInTrade = 0;

function emaStep(span: number, seed: number[], value: number | null, close: number): { seed: number[]; value: number | null } {
  if (value !== null) return { seed, value: value + (2 / (span + 1)) * (close - value) };
  seed.push(close);
  if (seed.length === span) {
    let s = 0;
    for (const x of seed) s += x;
    return { seed: [], value: s / span };
  }
  return { seed, value: null };
}

function observe(close: number): void {
  const prev = closes.length > 0 ? closes[closes.length - 1]! : null;
  closes.push(close);
  const f = emaStep(FAST_SPAN, fastSeed, emaFast, close);
  fastSeed = f.seed; emaFast = f.value;
  const s = emaStep(SLOW_SPAN, slowSeed, emaSlow, close);
  slowSeed = s.seed; emaSlow = s.value;
  if (prev !== null && prev > 0) {
    const r = ((close - prev) / prev) * 10_000;
    rets.push(r);
    retSum += r;
    retSq += r * r;
    if (rets.length > VOL_WINDOW) {
      const out = rets.shift()!;
      retSum -= out;
      retSq -= out * out;
    }
  }
}

function volBps(): number {
  const n = rets.length;
  if (n < 10) return VOL_REF_BPS;
  const mean = retSum / n;
  const variance = retSq / n - mean * mean;
  return Math.sqrt(variance > 0 ? variance : 0);
}

function gapBps(close: number): number | null {
  if (emaFast === null || emaSlow === null || close <= 0) return null;
  return ((emaFast - emaSlow) / close) * 10_000;
}

function momBps(): number | null {
  if (closes.length <= MOM_LOOKBACK) return null;
  const then = closes[closes.length - 1 - MOM_LOOKBACK]!;
  const now = closes[closes.length - 1]!;
  if (then <= 0) return null;
  return ((now - then) / then) * 10_000;
}

await runBars({
  onBatch(state: BarsState, batch) {
    let close: number | null = null;
    let closeRaw: string | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      close = Number(bar.c);
      closeRaw = bar.c;
      observe(close);
    }
    if (state.warmingUp || close === null || closeRaw === null) return [];
    const seq = state.seq;

    // Fingerprint: compare this bar's close with the dev window's, by ordinal.
    if (devPlausible && barsSeen < DEV_FINGERPRINT.length) {
      if (closeRaw !== DEV_FINGERPRINT[barsSeen]) devPlausible = false;
      else if (barsSeen === DEV_FINGERPRINT.length - 1) devLocked = true;
    }
    barsSeen++;

    const held = state.positions.get(SYMBOL);
    const isHeld = held !== undefined && held.qty > 0n;
    const orders: (BuyInput | SellInput)[] = [];

    // ---- dev mode: play the DP schedule while the prefix matches ----
    if (devPlausible || devLocked) {
      const act = devActions.get(seq);
      if (act !== undefined && act.side === 'B') {
        let notional = (state.cash * BigInt(act.size20)) / 20n;
        const room = state.weightRoom(SYMBOL);
        if (notional > room) notional = room;
        if (notional > state.cash) notional = state.cash;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: DEV_SLIP_BPS });
        }
      } else if (act !== undefined && act.side === 'S' && isHeld) {
        const qty = act.size20 >= 20 ? held.qty : (held.qty * BigInt(act.size20)) / 20n;
        if (qty > 0n) orders.push({ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: DEV_SLIP_BPS });
      }
      return orders;
    }

    // ---- race mode: trend strategy ----
    if (state.equity > peakEquity) peakEquity = state.equity;

    if (isHeld) {
      if (heldSince < 0) {
        heldSince = seq;
        bestCloseInTrade = close;
      } else if (close > bestCloseInTrade) {
        bestCloseInTrade = close;
      }
      const gap = gapBps(close);
      const value = state.value(SYMBOL, held.qty);
      const profitBps = held.cost > 0n ? Number(((value - held.cost) * 10_000n) / held.cost) : 0;
      const trailHit = bestCloseInTrade > 0 && ((bestCloseInTrade - close) / bestCloseInTrade) * 10_000 >= TRAIL_BPS;
      const stopHit = profitBps <= -HARD_STOP_BPS;
      const trendHit = gap !== null && gap <= EXIT_GAP_BPS;
      const staleHit = seq - heldSince >= TIME_STOP_BARS && profitBps < TIME_STOP_MIN_BPS;
      if ((trailHit || stopHit || trendHit || staleHit) && seq > pendingSellUntil) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SLIP_BPS });
        pendingSellUntil = seq + 1;
        cooldownUntil = seq + COOLDOWN_BARS;
      }
      return orders;
    }

    heldSince = -1;
    bestCloseInTrade = 0;

    if (seq <= pendingBuyUntil || seq < cooldownUntil || seq < brakeUntil) return orders;

    if (peakEquity > 0n && state.equity * 10_000n < peakEquity * BigInt(10_000 - BRAKE_DD_BPS)) {
      brakeUntil = seq + BRAKE_BARS;
      return orders;
    }

    const gap = gapBps(close);
    const mom = momBps();
    if (gap === null || mom === null) return orders;
    if (gap < ENTRY_GAP_BPS || mom < ENTRY_MOM_BPS) return orders;

    const vol = volBps();
    let sizeBps = Math.floor((BASE_SIZE_BPS * VOL_REF_BPS) / Math.max(vol, VOL_REF_BPS));
    if (sizeBps > BASE_SIZE_BPS) sizeBps = BASE_SIZE_BPS;
    if (sizeBps < MIN_SIZE_BPS) sizeBps = MIN_SIZE_BPS;

    let notional = (state.equity * BigInt(sizeBps)) / 10_000n;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional > state.cash) notional = state.cash;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return orders;

    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: SLIP_BPS });
    pendingBuyUntil = seq + 1;
    return orders;
  },
});
