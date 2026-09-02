/* =============================================================================
 * account.js —— 账户、撮合与费用模型
 * -----------------------------------------------------------------------------
 * 交易规则严格对齐 A 股现货规则：
 *   · T+1：当日买入的股票当日不可卖出
 *   · 交易单位：买入必须为 100 股整数倍；卖出亦为 100 股整数倍，
 *     仅当"清仓"时允许一次性卖出不足 100 股的零股
 *   · 涨跌停：以真实日线判断，涨停/跌停时提示但允许排队成交（模拟盘简化）
 *   · 停牌 / 未上市：不可交易
 * 费用模型（2026 年 A 股现行标准，可在 FEES 中调整）：
 *   · 佣金：成交金额 × 0.025%，双向，单笔最低 5 元
 *   · 印花税：成交金额 × 0.05%，仅卖出单边（2023-08-28 起减半征收）
 *   · 过户费：成交金额 × 0.001%，沪深两市双向（2022-04-29 起统一）
 * 成本核算：移动加权平均成本法（含买入费用）。
 * ========================================================================== */
(function (global) {
  'use strict';

  const FEES = {
    commissionRate: 0.00025,   // 佣金费率
    commissionMin: 5,          // 单笔最低佣金（元）
    stampDutyRate: 0.0005,     // 印花税（仅卖出）
    transferRate: 0.00001,     // 过户费（双向）
  };

  const INITIAL_CASH = 100000;

  function round2(x) { return Math.round(x * 100) / 100; }
  function round4(x) { return Math.round(x * 10000) / 10000; }

  const Account = {
    FEES,
    INITIAL_CASH,
    state: null,
  };

  /* ---------------------------------------------------------------------
   * 费用计算
   * ------------------------------------------------------------------- */
  function commission(amount) {
    return round2(Math.max(FEES.commissionMin, amount * FEES.commissionRate));
  }
  function transferFee(amount) { return round2(amount * FEES.transferRate); }
  function stampDuty(amount) { return round2(amount * FEES.stampDutyRate); }

  /** 买入总费用与所需资金 */
  function buyFees(amount) {
    const c = commission(amount), t = transferFee(amount);
    return { commission: c, transfer: t, stamp: 0, total: round2(c + t) };
  }
  /** 卖出总费用与到账资金 */
  function sellFees(amount) {
    const c = commission(amount), t = transferFee(amount), s = stampDuty(amount);
    return { commission: c, transfer: t, stamp: s, total: round2(c + t + s) };
  }
  Account.buyFees = buyFees;
  Account.sellFees = sellFees;

  /** 给定可用资金，返回可买最大股数（100 的整数倍） */
  Account.maxBuyQty = function (price, cash) {
    if (price <= 0 || cash <= 0) return 0;
    // 先按费率解析求解（忽略最低佣金），再向下逐手修正至满足实际费用
    const perLot = price * 100;
    const rate = 1 + FEES.commissionRate + FEES.transferRate;
    let lots = Math.floor(cash / (perLot * rate));
    let guard = 0;
    while (lots > 0 && guard++ < 500) {
      const qty = lots * 100;
      const amt = qty * price;
      if (amt + buyFees(amt).total <= cash + 1e-6) return qty;
      lots -= 1;
    }
    return 0;
  };

  /* ---------------------------------------------------------------------
   * 初始化 / 序列化
   * ------------------------------------------------------------------- */
  Account.create = function (opts) {
    const o = opts || {};
    Account.state = {
      version: 1,
      initialCash: o.initialCash || INITIAL_CASH,
      cash: o.initialCash || INITIAL_CASH,
      positions: {},
      trades: [],
      equityHistory: [],
      totalFee: 0,
      totalBuyAmount: 0,
      totalSellAmount: 0,
      realizedPnl: 0,
      peakEquity: o.initialCash || INITIAL_CASH,
      maxDrawdown: 0,
      tradeSeq: 0,
      startDayIdx: o.startDayIdx || 0,
      createdAt: Date.now(),
    };
    return Account.state;
  };

  Account.load = function (s) {
    Account.state = s;
    if (!Account.state.positions) Account.state.positions = {};
    if (!Account.state.trades) Account.state.trades = [];
    if (!Account.state.equityHistory) Account.state.equityHistory = [];
    return Account.state;
  };

  /* ---------------------------------------------------------------------
   * 持仓查询
   * ------------------------------------------------------------------- */
  Account.position = function (code) {
    return Account.state.positions[code] || null;
  };

  Account.positionList = function () {
    const M = global.Market;
    return Object.keys(Account.state.positions)
      .filter((c) => Account.state.positions[c].qty > 0)
      .map((c) => {
        const p = Account.state.positions[c];
        const q = M.quote(c);
        const price = q ? q.price : 0;
        const mv = p.qty * price;
        return {
          code: c, name: p.name, sector: p.sector,
          qty: p.qty, avail: p.avail, cost: p.cost, price,
          marketValue: mv,
          costValue: p.qty * p.cost,
          pnl: mv - p.qty * p.cost,
          pnlPct: p.cost ? (price / p.cost - 1) * 100 : 0,
          dayPnl: q ? (price - q.prevClose) * p.qty : 0,
          dayPct: q ? q.pct : 0,
          holdDays: M.dayIdx - p.firstOpenDay,
          suspended: q ? q.suspended : false,
        };
      })
      .sort((a, b) => b.marketValue - a.marketValue);
  };

  /** 账户估值 */
  Account.valuation = function () {
    const posList = Account.positionList();
    const posValue = posList.reduce((s, p) => s + p.marketValue, 0);
    const equity = Account.state.cash + posValue;
    const init = Account.state.initialCash;
    return {
      cash: Account.state.cash,
      positionValue: posValue,
      equity,
      totalPnl: equity - init,
      totalPnlPct: init ? (equity / init - 1) * 100 : 0,
      positionWeight: equity ? posValue / equity : 0,
      cashWeight: equity ? Account.state.cash / equity : 0,
      realizedPnl: Account.state.realizedPnl,
      unrealizedPnl: posList.reduce((s, p) => s + p.pnl, 0),
      positions: posList,
    };
  };

  /* ---------------------------------------------------------------------
   * 交易
   * ------------------------------------------------------------------- */
  function fail(msg) { return { ok: false, msg }; }

  /**
   * 买入
   * @returns {ok, msg, trade}
   */
  Account.buy = function (code, qty) {
    const M = global.Market;
    const st = Account.state;
    const q = M.quote(code);
    if (!q) return fail('标的不存在');
    if (!q.listed) return fail('该标的尚未上市，无法交易');
    if (q.suspended) return fail('该标的今日停牌，无法交易');
    qty = Math.floor(qty);
    if (!qty || qty <= 0) return fail('请输入买入数量');
    if (qty % 100 !== 0) return fail('买入数量必须为 100 股的整数倍');

    const price = q.price;
    const amount = round2(price * qty);
    const fee = buyFees(amount);
    const total = round2(amount + fee.total);
    if (total > st.cash + 1e-6) {
      return fail(`资金不足：需 ${total.toFixed(2)} 元，可用 ${st.cash.toFixed(2)} 元`);
    }

    let p = st.positions[code];
    if (!p) {
      p = st.positions[code] = {
        code, name: q.name, sector: q.sector,
        qty: 0, avail: 0, cost: 0,
        totalBuyAmt: 0, realized: 0,
        firstOpenDay: M.dayIdx,
        lots: [],
      };
    }
    // 移动加权平均成本（含买入费用）
    const newQty = p.qty + qty;
    p.cost = round4((p.cost * p.qty + amount + fee.total) / newQty);
    p.qty = newQty;
    p.totalBuyAmt = round2(p.totalBuyAmt + amount);
    p.lots.push({ dayIdx: M.dayIdx, qty, price: price });
    if (p.firstOpenDay === undefined || p.firstOpenDay === null) p.firstOpenDay = M.dayIdx;

    st.cash = round2(st.cash - total);
    st.totalFee = round2(st.totalFee + fee.total);
    st.totalBuyAmount = round2(st.totalBuyAmount + amount);

    const trade = {
      id: ++st.tradeSeq,
      dayIdx: M.dayIdx, date: M.currentDate(), tick: M.tick,
      code, name: q.name, side: 'buy',
      price, qty, amount,
      commission: fee.commission, stamp: 0, transfer: fee.transfer, fee: fee.total,
      realized: 0,
      cashAfter: st.cash,
      limitState: q.limitState,
    };
    st.trades.push(trade);
    return { ok: true, trade, msg: `买入 ${q.name} ${qty} 股 @ ${price.toFixed(2)}` };
  };

  /**
   * 卖出
   */
  Account.sell = function (code, qty) {
    const M = global.Market;
    const st = Account.state;
    const q = M.quote(code);
    if (!q) return fail('标的不存在');
    if (q.suspended) return fail('该标的今日停牌，无法交易');
    const p = st.positions[code];
    if (!p || p.qty <= 0) return fail('当前无该标的持仓');
    qty = Math.floor(qty);
    if (!qty || qty <= 0) return fail('请输入卖出数量');
    if (qty > p.avail) {
      return fail(`可卖数量不足：可卖 ${p.avail} 股（T+1 规则，当日买入不可卖出）`);
    }
    if (qty % 100 !== 0 && qty !== p.qty) {
      return fail('卖出数量须为 100 股的整数倍；不足 100 股的零股只能一次性全部卖出');
    }
    if (qty > p.qty) return fail('卖出数量超过持仓');

    const price = q.price;
    const amount = round2(price * qty);
    const fee = sellFees(amount);
    const proceeds = round2(amount - fee.total);
    // 已实现盈亏（成本已含买入费用，故此处只扣卖出费用）
    const realized = round2((price - p.cost) * qty - fee.total);

    // FIFO 消耗 lot，用于持有天数等分析
    let remain = qty;
    const holdDaysArr = [];
    while (remain > 0 && p.lots.length) {
      const lot = p.lots[0];
      const take = Math.min(remain, lot.qty);
      holdDaysArr.push({ days: M.dayIdx - lot.dayIdx, qty: take, buyPrice: lot.price });
      lot.qty -= take;
      remain -= take;
      if (lot.qty <= 0) p.lots.shift();
    }
    const avgHoldDays = holdDaysArr.length
      ? holdDaysArr.reduce((s, x) => s + x.days * x.qty, 0) / holdDaysArr.reduce((s, x) => s + x.qty, 0)
      : 0;

    p.qty -= qty;
    p.avail -= qty;
    p.realized = round2(p.realized + realized);
    if (p.qty <= 0) {
      // 清仓：重置成本与建仓日
      p.cost = 0; p.firstOpenDay = null; p.lots = [];
    }
    st.cash = round2(st.cash + proceeds);
    st.totalFee = round2(st.totalFee + fee.total);
    st.totalSellAmount = round2(st.totalSellAmount + amount);
    st.realizedPnl = round2(st.realizedPnl + realized);

    const trade = {
      id: ++st.tradeSeq,
      dayIdx: M.dayIdx, date: M.currentDate(), tick: M.tick,
      code, name: q.name, side: 'sell',
      price, qty, amount,
      commission: fee.commission, stamp: fee.stamp, transfer: fee.transfer, fee: fee.total,
      realized, avgHoldDays: Math.round(avgHoldDays * 10) / 10,
      costBasis: p.cost || 0,
      cashAfter: st.cash,
      limitState: q.limitState,
    };
    st.trades.push(trade);
    return { ok: true, trade, msg: `卖出 ${q.name} ${qty} 股 @ ${price.toFixed(2)}，实现盈亏 ${realized >= 0 ? '+' : ''}${realized.toFixed(2)} 元` };
  };

  /* ---------------------------------------------------------------------
   * 日终结算：T+1 解锁 + 记录净值快照
   * ------------------------------------------------------------------- */
  Account.endOfDay = function () {
    const M = global.Market;
    const st = Account.state;
    // T+1：当日买入的股票次日转为可卖
    Object.keys(st.positions).forEach((c) => {
      const p = st.positions[c];
      p.avail = p.qty;
    });
    const v = Account.valuation();
    st.peakEquity = Math.max(st.peakEquity || v.equity, v.equity);
    const dd = st.peakEquity ? v.equity / st.peakEquity - 1 : 0;
    st.maxDrawdown = Math.min(st.maxDrawdown || 0, dd);

    const bench = M.benchmark();
    const initBench = M.data.benchmark[st.startDayIdx] || M.data.benchmark[0];
    st.equityHistory.push({
      dayIdx: M.dayIdx,
      date: M.currentDate(),
      equity: round2(v.equity),
      cash: round2(v.cash),
      posValue: round2(v.positionValue),
      bench: round2(bench.value),
      benchNorm: round4(bench.value / initBench),
      equityNorm: round4(v.equity / st.initialCash),
    });
    return v;
  };

  /** 最近一次净值快照 */
  Account.lastSnapshot = function () {
    const h = Account.state.equityHistory;
    return h.length ? h[h.length - 1] : null;
  };

  /** 净值曲线（用于首页走势图） */
  Account.equityCurve = function (maxPoints) {
    const h = Account.state.equityHistory;
    const initBench = global.Market.data.benchmark[Account.state.startDayIdx] || global.Market.data.benchmark[0];
    let arr = h.map((x) => ({ date: x.date, v: x.equityNorm, b: x.benchNorm, dayIdx: x.dayIdx }));
    if (!arr.length) {
      arr = [{ date: global.Market.currentDate(), v: 1, b: 1, dayIdx: global.Market.dayIdx }];
    }
    if (maxPoints && arr.length > maxPoints) {
      const step = Math.ceil(arr.length / maxPoints);
      const out = arr.filter((_, i) => i % step === 0);
      if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
      return out;
    }
    return arr;
  };

  /** 区间最大回撤（基于净值曲线） */
  Account.curveMaxDrawdown = function (fromDayIdx) {
    const h = Account.state.equityHistory.filter((x) => x.dayIdx >= (fromDayIdx || 0));
    let peak = h.length ? h[0].equity : Account.state.initialCash;
    let mdd = 0;
    h.forEach((x) => {
      if (x.equity > peak) peak = x.equity;
      const dd = x.equity / peak - 1;
      if (dd < mdd) mdd = dd;
    });
    return mdd;
  };

  global.Account = Account;
})(typeof window !== 'undefined' ? window : globalThis);
