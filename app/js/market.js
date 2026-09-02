/* =============================================================================
 * market.js —— 行情回放引擎（真实日线 + 确定性日内路径）
 * -----------------------------------------------------------------------------
 * 设计原则（关键，直接决定"模拟是否可信"）：
 *   1. 日线数据 100% 来自真实市场（东方财富前复权日线），不做任何加工。
 *      开/高/低/收/量/额/换手/涨跌幅 全部是真实发生过的值。
 *   2. 日内分时路径为算法生成，但被严格锚定在真实的 O/H/L/C 四个点上：
 *      路径起点 = 真实开盘价，终点 = 真实收盘价，中途必然触及真实最高/最低价。
 *      生成过程完全确定性（种子 = 代码 + 日期），可复现、可存档。
 *   3. 停牌、未上市、涨跌停均按真实规则处理。
 * ========================================================================== */
(function (global) {
  'use strict';

  const TICKS_PER_DAY = 24;               // 一天 24 个 tick（09:30–11:30 + 13:00–15:00，每 10 分钟一档）
  const TRADING_DAYS_PER_YEAR = 244;

  const Market = {
    TICKS_PER_DAY,
    TRADING_DAYS_PER_YEAR,
    data: null,
    dayIdx: 0,
    tick: 0,
    weekAnchor: 0,          // 周计数锚点（= 账户起始交易日），每 5 个交易日结算一周
    _pathCache: new Map(),
  };

  /* ---------------------------------------------------------------------
   * 初始化
   * ------------------------------------------------------------------- */
  Market.init = function (data, startDayIdx) {
    Market.data = data;
    Market.dayIdx = Math.max(0, Math.min(startDayIdx || 0, data.dates.length - 1));
    Market.tick = 0;
    Market._pathCache.clear();
  };

  Market.dates = () => Market.data.dates;
  Market.totalDays = () => Market.data.dates.length;
  Market.currentDate = () => Market.data.dates[Market.dayIdx];
  Market.stocks = () => Market.data.stocks;

  Market.stockMap = function () {
    if (!Market._map) {
      Market._map = {};
      Market.data.stocks.forEach((s) => { Market._map[s.code] = s; });
    }
    return Market._map;
  };
  Market.stock = (code) => Market.stockMap()[code];

  /** 涨跌停幅度：创业板(300/301)、科创板(688) 为 20%，其余 10% */
  Market.limitPct = function (code) {
    const c = String(code);
    if (/^(300|301|688)/.test(c)) return 0.20;
    return 0.10;
  };

  /** 该标的在指定交易日是否可交易 */
  Market.isTradable = function (code, dayIdx) {
    const s = Market.stock(code);
    if (!s) return false;
    const d = dayIdx === undefined ? Market.dayIdx : dayIdx;
    if (d < s.listedFrom) return false;                 // 未上市
    if (s.suspendedDays && s.suspendedDays.indexOf(d) >= 0) return false; // 停牌
    return true;
  };

  /** 取某标的某日的真实日线；未上市/停牌返回 null */
  Market.bar = function (code, dayIdx) {
    const s = Market.stock(code);
    if (!s) return null;
    const d = dayIdx === undefined ? Market.dayIdx : dayIdx;
    if (d < s.listedFrom) return null;
    const row = s.k[d];
    return row || null;
  };

  /** 前一交易日收盘价（用于计算涨跌幅、涨跌停价） */
  Market.prevClose = function (code, dayIdx) {
    const d = dayIdx === undefined ? Market.dayIdx : dayIdx;
    for (let i = d - 1; i >= 0; i--) {
      const b = Market.bar(code, i);
      if (b) return b[3]; // close
    }
    const b0 = Market.bar(code, d);
    return b0 ? b0[0] : 0; // 上市首日无前收，用开盘价兜底
  };

  /** 该股上市以来到当前（含）的有效交易日数 */
  Market.listedDays = function (code, dayIdx) {
    const d = dayIdx === undefined ? Market.dayIdx : dayIdx;
    const s = Market.stock(code);
    if (!s) return 0;
    return Math.max(0, d - s.listedFrom + 1 - (s.suspendedDays || []).filter((x) => x <= d).length);
  };

  /* ---------------------------------------------------------------------
   * 日内路径生成
   * 锚点序列：0=开盘 → p1 → p2 → T-1=收盘
   * p1/p2 分别对应当日真实最高价 / 最低价，先后顺序由种子决定。
   * 段内用 smoothstep 插值，保证曲线平滑且端点严格等于真实 O/H/L/C。
   * ------------------------------------------------------------------- */
  function smoothstep(t) { return t * t * (3 - 2 * t); }

  Market.getPath = function (code, dayIdx) {
    const d = dayIdx === undefined ? Market.dayIdx : dayIdx;
    const key = code + '|' + d;
    if (Market._pathCache.has(key)) return Market._pathCache.get(key);

    const bar = Market.bar(code, d);
    if (!bar) { Market._pathCache.set(key, null); return null; }

    const [open, high, low, close, , , , ] = bar;
    const T = TICKS_PER_DAY;
    const rand = global.PRNG.rng(code + '#' + d);

    // 极值出现位置：分别落在 [1, T-2] 的两个不同区间
    const p1 = 2 + Math.floor(rand() * (T - 5));            // 2 .. T-4
    const p2 = p1 + 1 + Math.floor(rand() * (T - p1 - 2));  // p1+1 .. T-2
    const highFirst = rand() < 0.5;

    // 锚点：[index, price]
    const anchors = [[0, open]];
    if (highFirst) anchors.push([p1, high], [p2, low]);
    else anchors.push([p1, low], [p2, high]);
    anchors.push([T - 1, close]);

    const path = new Array(T);
    for (let seg = 0; seg < anchors.length - 1; seg++) {
      const [i0, v0] = anchors[seg];
      const [i1, v1] = anchors[seg + 1];
      const span = i1 - i0;
      for (let i = i0; i <= i1; i++) {
        const u = span === 0 ? 1 : (i - i0) / span;
        path[i] = v0 + (v1 - v0) * smoothstep(u);
      }
    }

    // 微量确定性噪声（锚点处为 0，段中部最大），让分时线更自然
    const range = Math.max(high - low, open * 0.001);
    for (let i = 0; i < T; i++) {
      let w = 0;
      for (let seg = 0; seg < anchors.length - 1; seg++) {
        const i0 = anchors[seg][0], i1 = anchors[seg + 1][0];
        if (i >= i0 && i <= i1 && i1 > i0) {
          const u = (i - i0) / (i1 - i0);
          w = Math.sin(Math.PI * u);
          break;
        }
      }
      const noise = ((rand() - 0.5) * range * 0.16) * w;
      let v = path[i] + noise;
      v = Math.max(low, Math.min(high, v));
      path[i] = Math.round(v * 100) / 100;
    }
    path[0] = open;
    path[T - 1] = close;

    // 分时量：U 型分布 + 噪声（总量守恒，等于真实成交量）
    const vol = bar[4];
    const weights = new Array(T);
    let wsum = 0;
    for (let i = 0; i < T; i++) {
      const u = i / (T - 1);
      const uShape = 1.6 - 2.2 * u + 2.0 * u * u;   // 早盘、尾盘放量
      weights[i] = Math.max(0.15, uShape) * (0.7 + rand() * 0.6);
      wsum += weights[i];
    }
    const vols = weights.map((w) => Math.round((w / wsum) * vol));

    const result = { path, vols, bar };
    Market._pathCache.set(key, result);
    return result;
  };

  /* ---------------------------------------------------------------------
   * 行情查询
   * ------------------------------------------------------------------- */
  Market.priceAt = function (code, dayIdx, tick) {
    const p = Market.getPath(code, dayIdx);
    if (!p) return null;
    const t = Math.max(0, Math.min(tick === undefined ? TICKS_PER_DAY - 1 : tick, TICKS_PER_DAY - 1));
    return p.path[t];
  };

  /** 当前实时快照 */
  Market.quote = function (code) {
    const s = Market.stock(code);
    const bar = Market.bar(code, Market.dayIdx);
    if (!s) return null;

    if (!bar) {
      // 未上市或停牌
      const lastBar = (function () {
        for (let i = Market.dayIdx - 1; i >= 0; i--) {
          const b = Market.bar(code, i);
          if (b) return b;
        }
        return null;
      })();
      return {
        code, name: s.name, sector: s.sector, board: s.board, intro: s.intro,
        listed: Market.dayIdx >= s.listedFrom,
        suspended: Market.dayIdx >= s.listedFrom,
        price: lastBar ? lastBar[3] : 0,
        prevClose: lastBar ? lastBar[3] : 0,
        open: 0, high: 0, low: 0, close: 0,
        pct: 0, volume: 0, amount: 0, turnover: 0,
        limitUp: 0, limitDown: 0, limitState: 'none',
        stats: s.stats || {},
      };
    }

    const p = Market.getPath(code, Market.dayIdx);
    const price = p.path[Market.tick];
    const prev = Market.prevClose(code, Market.dayIdx);
    const lim = Market.limitPct(code);
    const limitUp = Math.round(prev * (1 + lim) * 100) / 100;
    const limitDown = Math.round(prev * (1 - lim) * 100) / 100;

    let limitState = 'none';
    if (price >= limitUp - 1e-6) limitState = 'up';
    else if (price <= limitDown + 1e-6) limitState = 'down';

    return {
      code, name: s.name, sector: s.sector, board: s.board, intro: s.intro,
      listed: true, suspended: false,
      price,
      prevClose: prev,
      open: bar[0], high: bar[1], low: bar[2], close: bar[3],
      pct: prev ? (price / prev - 1) * 100 : 0,
      avgPrice: bar[6] ? bar[5] * 10000 / (bar[4] * 100) : price, // 成交额/成交量 = 均价
      volume: bar[4], amount: bar[5], turnover: bar[7],
      limitUp, limitDown, limitState,
      vwap: bar[4] ? (bar[5] * 10000) / (bar[4] * 100) : price,
      stats: s.stats || {},
    };
  };

  /** 全市场快照（用于列表排序） */
  Market.snapshot = function () {
    return Market.data.stocks.map((s) => Market.quote(s.code));
  };

  /** 基准（沪深300）当前点位与涨跌幅 */
  Market.benchmark = function (dayIdx) {
    const d = dayIdx === undefined ? Market.dayIdx : dayIdx;
    const arr = Market.data.benchmark;
    const cur = arr[d];
    const prev = d > 0 ? arr[d - 1] : arr[0];
    return { value: cur, pct: prev ? (cur / prev - 1) * 100 : 0, name: Market.data.meta.benchmark.name, code: Market.data.meta.benchmark.code };
  };

  /** 取截至当前（含）的 N 根日 K（用于 K 线图） */
  Market.recentBars = function (code, n) {
    const out = [];
    const end = Market.dayIdx;
    for (let i = Math.max(0, end - n + 1); i <= end; i++) {
      const b = Market.bar(code, i);
      if (b) out.push({ date: Market.data.dates[i], open: b[0], high: b[1], low: b[2], close: b[3], volume: b[4] });
    }
    return out;
  };

  /** 区间收益率：从 dayA（不含）到 dayB（含） */
  Market.rangeReturn = function (code, dayA, dayB) {
    const a = Market.bar(code, dayA);
    const b = Market.bar(code, dayB);
    if (!a || !b) return 0;
    return a[3] ? b[3] / a[3] - 1 : 0;
  };

  /** 基准区间收益率 */
  Market.benchRangeReturn = function (dayA, dayB) {
    const arr = Market.data.benchmark;
    const a = arr[dayA], b = arr[dayB];
    if (!a || !b) return 0;
    return b / a - 1;
  };

  /* ---------------------------------------------------------------------
   * 时钟推进
   * ------------------------------------------------------------------- */
  /** 是否到达周结算点（自锚点起累计满 5 个交易日） */
  function isWeekEnd(dayIdx) {
    return dayIdx > Market.weekAnchor && (dayIdx - Market.weekAnchor) % 5 === 0;
  }
  Market.isWeekEnd = isWeekEnd;

  /**
   * 推进一个 tick。
   * 当已处于当日最后一档时，先通过 onDayEnd(dayIdx) 回调以"当日收盘价"完成结算，
   * 再进入下一交易日的第一档——确保日终快照记录的是真实收盘，而非次日开盘。
   * @param onDayEnd 可选回调 (dayIdx) => void
   */
  Market.step = function (onDayEnd) {
    if (Market.tick < TICKS_PER_DAY - 1) {
      Market.tick++;
      return { dayEnded: false, weekEnded: false, exhausted: false };
    }
    if (typeof onDayEnd === 'function') onDayEnd(Market.dayIdx);
    if (Market.dayIdx >= Market.data.dates.length - 1) {
      return { dayEnded: true, weekEnded: isWeekEnd(Market.dayIdx), exhausted: true };
    }
    Market.dayIdx++;
    Market.tick = 0;
    return { dayEnded: true, weekEnded: isWeekEnd(Market.dayIdx), exhausted: false };
  };

  /** 直接跳到下一个交易日的收盘 */
  Market.skipDay = function (onDayEnd) {
    Market.tick = TICKS_PER_DAY - 1;              // 先推到当日收盘
    if (typeof onDayEnd === 'function') onDayEnd(Market.dayIdx);
    if (Market.dayIdx >= Market.data.dates.length - 1) {
      return { exhausted: true, dayEnded: true, weekEnded: isWeekEnd(Market.dayIdx) };
    }
    Market.dayIdx++;
    Market.tick = TICKS_PER_DAY - 1;
    return { dayEnded: true, weekEnded: isWeekEnd(Market.dayIdx), exhausted: false };
  };

  /** 跳 N 个交易日 */
  Market.skipDays = function (n) {
    let weekEnded = false, exhausted = false;
    for (let i = 0; i < n; i++) {
      const r = Market.skipDay();
      if (r.weekEnded) weekEnded = true;
      if (r.exhausted) { exhausted = true; break; }
    }
    return { weekEnded, exhausted };
  };

  /** 进度百分比 */
  Market.progress = function () {
    return ((Market.dayIdx * TICKS_PER_DAY + Market.tick) / (Market.data.dates.length * TICKS_PER_DAY)) * 100;
  };

  global.Market = Market;
})(typeof window !== 'undefined' ? window : globalThis);
