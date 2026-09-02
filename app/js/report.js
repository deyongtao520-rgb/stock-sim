/* =============================================================================
 * report.js —— 每周总结与复盘引擎
 * -----------------------------------------------------------------------------
 * 一个"交易周" = 5 个交易日。每周末自动生成一份复盘报告，包含：
 *   1. 账户与基准表现（绝对收益 / 超额收益 / 最大回撤 / 仓位）
 *   2. 本周操作明细 与 持仓变动
 *   3. 收益归因：把周收益率拆成 市场β + 选股α + 交易择时 + 残差
 *   4. 行为诊断：13 条可量化规则，每条给出证据、影响与改进动作
 *   5. 经验教训 与 下周行动建议（可量化、可执行）
 *
 * 归因口径（可加总、可对账）：
 *   R_周 = 市场β贡献 + 选股α贡献 + 交易贡献 + 残差
 *   市场β = W0 × R_bench                       W0 = 期初股票仓位权重
 *   选股α = Σ w_i0 × (r_i − R_bench)           w_i0 = 期初个股权重
 *   交易  = Σ买 wb×(P末/P买−1) − Σ卖 ws×(P末/P卖−1) − 费用率
 *   残差  = 实际周收益率 − 上述三项之和（正常应接近 0，用于校验归因精度）
 * ========================================================================== */
(function (global) {
  'use strict';

  const Report = {};

  /* ---------------------------------------------------------------------
   * 工具
   * ------------------------------------------------------------------- */
  function r2(x) { return Math.round(x * 100) / 100; }
  function r4(x) { return Math.round(x * 10000) / 10000; }
  function pct(x, d) { const p = d === undefined ? 2 : d; return (x * 100).toFixed(p); }

  /** 某标的在指定交易日的收盘价（停牌则向前回溯） */
  function closeOn(code, dayIdx) {
    const M = global.Market;
    for (let i = dayIdx; i >= 0; i--) {
      const b = M.bar(code, i);
      if (b) return b[3];
    }
    return 0;
  }

  /** 该股从 dayA 收盘到 dayB 收盘的收益率 */
  function retBetween(code, dayA, dayB) {
    const a = closeOn(code, dayA), b = closeOn(code, dayB);
    if (!a || !b) return 0;
    return b / a - 1;
  }

  /** 某日 VWAP（当日成交均价） */
  function vwapOn(code, dayIdx) {
    const b = global.Market.bar(code, dayIdx);
    if (!b || !b[4]) return 0;
    return (b[5] * 10000) / (b[4] * 100);
  }

  function dayPctOn(code, dayIdx) {
    const b = global.Market.bar(code, dayIdx);
    return b ? b[6] : 0;
  }

  /* ---------------------------------------------------------------------
   * 生成周报
   * @param ctx {anchor, weekIndex, startDayIdx, endDayIdx, violationsExtra}
   *   anchor: 期初快照 {dayIdx, date, equity, cash, bench, positions}
   * ------------------------------------------------------------------- */
  Report.generate = function (anchor, weekIndex, startDayIdx, endDayIdx) {
    const M = global.Market;
    const A = global.Account;
    const st = A.state;

    const startEquity = anchor.equity;
    const v = A.valuation();
    const endEquity = v.equity;
    const retPct = startEquity ? (endEquity / startEquity - 1) * 100 : 0;

    const benchStart = anchor.bench;
    const benchEnd = M.data.benchmark[endDayIdx];
    const benchPct = benchStart ? (benchEnd / benchStart - 1) * 100 : 0;
    const excessPct = retPct - benchPct;

    const startDate = M.dates()[startDayIdx];
    const endDate = M.dates()[endDayIdx];

    /* ---------- 1. 本周交易 ---------- */
    const trades = st.trades.filter((t) => t.dayIdx > startDayIdx && t.dayIdx <= endDayIdx)
      .map((t) => Object.assign({}, t, {
        dayPct: dayPctOn(t.code, t.dayIdx),
        vwap: vwapOn(t.code, t.dayIdx),
      }));
    const buyTrades = trades.filter((t) => t.side === 'buy');
    const sellTrades = trades.filter((t) => t.side === 'sell');
    const weekFee = trades.reduce((s, t) => s + t.fee, 0);
    const weekRealized = sellTrades.reduce((s, t) => s + t.realized, 0);

    /* ---------- 2. 持仓变动 ---------- */
    const startPos = anchor.positions || {};
    const endPosMap = {};
    v.positions.forEach((p) => {
      endPosMap[p.code] = { qty: p.qty, cost: p.cost, price: p.price, name: p.name, sector: p.sector };
    });
    const codes = Array.from(new Set(Object.keys(startPos).concat(Object.keys(endPosMap))));
    const positionChanges = codes.map((c) => {
      const s0 = startPos[c];
      const s1 = endPosMap[c];
      const q0 = s0 ? s0.qty : 0;
      const q1 = s1 ? s1.qty : 0;
      let change = 'hold';
      if (q0 === 0 && q1 > 0) change = 'new';
      else if (q0 > 0 && q1 === 0) change = 'clear';
      else if (q1 > q0) change = 'add';
      else if (q1 < q0) change = 'reduce';
      const name = (s1 && s1.name) || (s0 && s0.name) || (M.stock(c) ? M.stock(c).name : c);
      const sector = (s1 && s1.sector) || (s0 && s0.sector) || (M.stock(c) ? M.stock(c).sector : '');
      const priceEnd = closeOn(c, endDayIdx);
      return {
        code: c, name, sector, change,
        qtyStart: q0, qtyEnd: q1, qtyDelta: q1 - q0,
        priceEnd,
        retPct: retBetween(c, startDayIdx, endDayIdx) * 100,
        weightEnd: endEquity ? (q1 * priceEnd) / endEquity * 100 : 0,
      };
    }).filter((x) => x.qtyStart > 0 || x.qtyEnd > 0)
      .sort((a, b) => b.weightEnd - a.weightEnd);

    /* ---------- 3. 收益归因 ---------- */
    const attrib = { market: 0, selection: 0, trading: 0, fee: 0, residual: 0, items: {} };

    // 期初股票仓位权重
    let W0 = 0;
    Object.keys(startPos).forEach((c) => {
      const p0 = closeOn(c, startDayIdx);
      W0 += (startPos[c].qty * p0);
    });
    W0 = startEquity ? W0 / startEquity : 0;

    attrib.market = W0 * (benchPct / 100);

    let selection = 0;
    const contrib = [];   // 个股权重贡献明细
    Object.keys(startPos).forEach((c) => {
      const p0 = closeOn(c, startDayIdx);
      const w = startEquity ? (startPos[c].qty * p0) / startEquity : 0;
      const ri = retBetween(c, startDayIdx, endDayIdx);
      selection += w * (ri - benchPct / 100);
      contrib.push({
        code: c, name: (M.stock(c) ? M.stock(c).name : c),
        weight: w * 100, ret: ri * 100,
        excess: (ri - benchPct / 100) * 100,
        contribution: w * ri * 100,
      });
    });
    attrib.selection = selection;

    // 交易贡献（逐笔）
    let tradeContrib = 0;
    const tradeAttrib = [];
    buyTrades.forEach((t) => {
      const pEnd = closeOn(t.code, endDayIdx);
      const r = t.price ? pEnd / t.price - 1 : 0;
      const w = startEquity ? t.amount / startEquity : 0;
      const c = w * r;
      tradeContrib += c;
      tradeAttrib.push({ id: t.id, code: t.code, name: t.name, side: 'buy', date: t.date, price: t.price, weight: w * 100, ret: r * 100, contribution: c * 100, qty: t.qty });
    });
    sellTrades.forEach((t) => {
      const pEnd = closeOn(t.code, endDayIdx);
      const r = t.price ? pEnd / t.price - 1 : 0;
      const w = startEquity ? t.amount / startEquity : 0;
      const c = -w * r;
      tradeContrib += c;
      tradeAttrib.push({ id: t.id, code: t.code, name: t.name, side: 'sell', date: t.date, price: t.price, weight: w * 100, ret: r * 100, contribution: c * 100, qty: t.qty, realized: t.realized });
    });
    const feeRate = startEquity ? weekFee / startEquity : 0;
    attrib.fee = -feeRate;
    attrib.trading = tradeContrib - feeRate;

    const sumParts = attrib.market + attrib.selection + attrib.trading;
    attrib.residual = retPct / 100 - sumParts;
    attrib.items = {
      marketPct: attrib.market * 100,
      selectionPct: attrib.selection * 100,
      tradeGrossPct: tradeContrib * 100,
      feePct: -feeRate * 100,
      tradingPct: attrib.trading * 100,
      residualPct: attrib.residual * 100,
    };

    // 单列参考项：现金的机会成本（不进入加总等式）
    const avgCashWeight = (v.cashWeight + (anchor.cash / (anchor.equity || 1))) / 2;
    const cashDrag = -avgCashWeight * (benchPct / 100) * 100;

    contrib.sort((a, b) => b.contribution - a.contribution);
    const topGainers = contrib.slice(0, 3).filter((x) => x.contribution > 0);
    const topLosers = contrib.slice(-3).reverse().filter((x) => x.contribution < 0);

    /* ---------- 4. 行为诊断 ---------- */
    const diagnostics = diagnose({
      startEquity, endEquity, startDayIdx, endDayIdx,
      buyTrades, sellTrades, weekFee, tradeCount: trades.length,
      v, positionChanges, benchPct, retPct, startPos,
    });

    /* ---------- 5. 风险指标 ---------- */
    const weekSnaps = st.equityHistory.filter((x) => x.dayIdx > startDayIdx && x.dayIdx <= endDayIdx);
    let peak = startEquity, weekMaxDD = 0;
    [startEquity].concat(weekSnaps.map((x) => x.equity)).forEach((eq) => {
      if (eq > peak) peak = eq;
      const dd = eq / peak - 1;
      if (dd < weekMaxDD) weekMaxDD = dd;
    });

    const topWeight = v.positions.length ? Math.max.apply(null, v.positions.map((p) => p.marketValue / endEquity * 100)) : 0;
    const sectorWeights = {};
    v.positions.forEach((p) => {
      sectorWeights[p.sector] = (sectorWeights[p.sector] || 0) + p.marketValue / endEquity * 100;
    });
    const topSector = Object.keys(sectorWeights).sort((a, b) => sectorWeights[b] - sectorWeights[a])[0] || '';
    const topSectorWeight = topSector ? sectorWeights[topSector] : 0;

    /* ---------- 6. 经验教训 与 建议 ---------- */
    const lessons = buildLessons({
      retPct, benchPct, excessPct, attrib, contrib, topGainers, topLosers,
      diagnostics, v, weekFee, startEquity, weekRealized, tradeCount: trades.length,
    });
    const actions = buildActions(diagnostics, v, excessPct);
    const courseRecs = global.Teach.recommend(diagnostics, global.__rankState || { tier: 0 }, global.__courseProgress || {}, 3);

    /* ---------- 7. 组装 ---------- */
    return {
      weekIndex,
      startDate, endDate,
      startDayIdx, endDayIdx,
      tradingDays: endDayIdx - startDayIdx,
      startEquity: r2(startEquity),
      endEquity: r2(endEquity),
      retPct: r2(retPct),
      benchStart: r2(benchStart), benchEnd: r2(benchEnd),
      benchPct: r2(benchPct),
      excessPct: r2(excessPct),
      weekMaxDD: r2(weekMaxDD * 100),
      cumRetPct: r2((endEquity / st.initialCash - 1) * 100),
      cumBenchPct: r2((benchEnd / M.data.benchmark[st.startDayIdx] - 1) * 100),
      positionWeight: r2(v.positionWeight * 100),
      cashWeight: r2(v.cashWeight * 100),
      topWeight: r2(topWeight),
      topSector, topSectorWeight: r2(topSectorWeight),
      weekFee: r2(weekFee),
      feeRatePct: r2(feeRate * 100),
      weekRealized: r2(weekRealized),
      trades: trades.map((t) => ({
        id: t.id, date: t.date, code: t.code, name: t.name, side: t.side,
        price: r2(t.price), qty: t.qty, amount: r2(t.amount), fee: r2(t.fee),
        realized: r2(t.realized), dayPct: r2(t.dayPct), vwap: r2(t.vwap),
        avgHoldDays: t.avgHoldDays,
      })),
      tradeCount: trades.length,
      buyCount: buyTrades.length,
      sellCount: sellTrades.length,
      positionChanges: positionChanges.map((x) => Object.assign({}, x, {
        retPct: r2(x.retPct), weightEnd: r2(x.weightEnd),
      })),
      holdings: v.positions.map((p) => ({
        code: p.code, name: p.name, sector: p.sector, qty: p.qty,
        cost: r2(p.cost), price: r2(p.price),
        marketValue: r2(p.marketValue),
        pnl: r2(p.pnl), pnlPct: r2(p.pnlPct),
        weight: r2(p.marketValue / endEquity * 100),
        holdDays: p.holdDays,
      })),
      attribution: {
        market: r2(attrib.market * 100),
        selection: r2(attrib.selection * 100),
        trading: r2(attrib.trading * 100),
        tradeGross: r2(tradeContrib * 100),
        fee: r2(-feeRate * 100),
        residual: r2(attrib.residual * 100),
        W0: r2(W0 * 100),
        cashDrag: r2(cashDrag),
        avgCashWeight: r2(avgCashWeight * 100),
        items: tradeAttrib.map((x) => Object.assign({}, x, {
          weight: r2(x.weight), ret: r2(x.ret), contribution: r2(x.contribution),
        })),
        holdings: contrib.map((x) => ({
          code: x.code, name: x.name, weight: r2(x.weight), ret: r2(x.ret),
          excess: r2(x.excess), contribution: r2(x.contribution),
        })),
      },
      topGainers: topGainers.map((x) => ({ code: x.code, name: x.name, contribution: r2(x.contribution), ret: r2(x.ret) })),
      topLosers: topLosers.map((x) => ({ code: x.code, name: x.name, contribution: r2(x.contribution), ret: r2(x.ret) })),
      diagnostics,
      lessons,
      actions,
      courseRecs: courseRecs.map((x) => ({ id: x.course.id, title: x.course.title, level: x.course.level, reason: x.matched.length ? '针对本周诊断出的问题' : (x.locked ? '段位提升后解锁' : '基础能力建设') })),
      generatedAt: Date.now(),
    };
  };

  /* =========================================================================
   * 行为诊断规则引擎
   * ======================================================================= */
  function diagnose(ctx) {
    const out = [];
    const push = (id, title, severity, evidence, impact, action) => {
      out.push({ id, title, severity, evidence, impact, action });
    };

    const { startEquity, endEquity, buyTrades, sellTrades, weekFee, tradeCount, v, positionChanges, benchPct } = ctx;

    /* R01 追高买入 ---------------------------------------------------- */
    const chase = buyTrades.filter((t) => (t.dayPct >= 4 && t.price > t.vwap) || t.price >= t.vwap * 1.03);
    if (chase.length) {
      const worst = chase.sort((a, b) => b.dayPct - a.dayPct)[0];
      const sev = chase.length >= 2 || worst.dayPct >= 7 ? 'high' : 'mid';
      push('R01', '追高买入', sev,
        `${chase.length} 笔买在情绪高位：${worst.name}（${worst.date}）当日涨幅 ${worst.dayPct.toFixed(2)}%，成交价 ${worst.price.toFixed(2)} 元，高于当日均价 ${worst.vwap.toFixed(2)} 元 ${(((worst.price / worst.vwap) - 1) * 100).toFixed(2)}%。`,
        '在情绪高位以高于均价的价格成交，等于为他人的情绪溢价买单，建仓即处于不利的成本位置，且一旦反转没有成本缓冲。',
        '买入前必须给出一条与"最近涨了多少"无关的理由；个股当日涨幅 > 4% 时禁止市价追入，改用分批限价。');
    }

    /* R02 恐慌杀跌 ---------------------------------------------------- */
    const panic = sellTrades.filter((t) => t.dayPct <= -4);
    if (panic.length) {
      const worst = panic.sort((a, b) => a.dayPct - b.dayPct)[0];
      const pEnd = closeOn(worst.code, ctx.endDayIdx);
      const rebound = worst.price ? (pEnd / worst.price - 1) * 100 : 0;
      const sev = rebound > 3 ? 'high' : 'mid';
      push('R02', '恐慌杀跌', sev,
        `${panic.length} 笔卖在当日大跌中：${worst.name}（${worst.date}）当日 ${worst.dayPct.toFixed(2)}%，卖出价 ${worst.price.toFixed(2)} 元。` +
        (rebound > 0 ? `该股至周末反弹 ${rebound.toFixed(2)}%，说明卖点接近阶段低点。` : `该股至周末继续下跌 ${rebound.toFixed(2)}%，卖出方向正确但执行时点不佳。`),
        '下跌本身不是卖出理由，逻辑证伪才是。在放量杀跌中卖出，往往成交在最差的流动性位置。',
        '把"跌了所以要卖"替换为预设的止损条件；若必须卖出，避免在个股当日跌幅 > 4% 时以市价单成交。');
    }

    /* R03 过度交易 ---------------------------------------------------- */
    if (tradeCount >= 5) {
      const sev = tradeCount >= 8 ? 'high' : 'mid';
      push('R03', '过度交易', sev,
        `本周成交 ${tradeCount} 笔（买入 ${buyTrades.length} 笔 / 卖出 ${sellTrades.length} 笔），累计费用 ${weekFee.toFixed(2)} 元，占期初总资产 ${((weekFee / startEquity) * 100).toFixed(2)}%。`,
        '交易频率与收益不相关，但与成本严格正相关。频繁交易还会放大择时误差，把系统性收益消耗成噪声。',
        '设定每周交易笔数上限 3 笔；每笔交易前写下一句话的书面理由，写不出就不交易。');
    }

    /* R04 持仓过短 ---------------------------------------------------- */
    if (sellTrades.length >= 2) {
      const avg = sellTrades.reduce((s, t) => s + (t.avgHoldDays || 0), 0) / sellTrades.length;
      if (avg <= 3) {
        push('R04', '持仓周期过短', 'mid',
          `本周 ${sellTrades.length} 笔卖出的平均持有天数为 ${avg.toFixed(1)} 个交易日。`,
          '几个交易日的持有周期不足以让任何基本面逻辑兑现，收益来源退化为纯粹的价差博弈，胜率与盈亏比都难以稳定。',
          '为每笔交易设定最短持有周期（建议 ≥ 10 个交易日）与时间止损条件，避免被日内噪声驱动决策。');
      }
    }

    /* R05 处置效应 ---------------------------------------------------- */
    const winSells = sellTrades.filter((t) => t.realized > 0);
    const lossSells = sellTrades.filter((t) => t.realized < 0);
    if (winSells.length && lossSells.length) {
      const wd = winSells.reduce((s, t) => s + (t.avgHoldDays || 0), 0) / winSells.length;
      const ld = lossSells.reduce((s, t) => s + (t.avgHoldDays || 0), 0) / lossSells.length;
      if (wd < ld * 0.6) {
        push('R05', '处置效应（截断利润、让亏损奔跑）', 'high',
          `盈利单平均持有 ${wd.toFixed(1)} 个交易日，亏损单平均持有 ${ld.toFixed(1)} 个交易日，比值 ${(wd / (ld || 1)).toFixed(2)}。`,
          '这是前景理论中损失厌恶的典型表现：急于兑现盈利以获得确定感，却对浮亏抱持"等回本"的侥幸，长期会系统性地降低组合收益。',
          '卖出决策只用一句话回答："如果我今天空仓，会不会以现价买入它？"把成本价从决策变量中彻底移除。');
      }
    }

    /* R06 缺乏止损 ---------------------------------------------------- */
    const deepLoss = v.positions.filter((p) => p.pnlPct <= -12);
    if (deepLoss.length) {
      const worst = deepLoss.sort((a, b) => a.pnlPct - b.pnlPct)[0];
      push('R06', '缺乏止损纪律', 'high',
        `期末存在 ${deepLoss.length} 个浮亏超 12% 的持仓：${worst.name} 浮亏 ${worst.pnlPct.toFixed(2)}%，已持有 ${worst.holdDays} 个交易日。`,
        '亏损 50% 需要上涨 100% 才能回本。不设止损等于把"判断错误"的成本设为无限大，且资金被套牢在最低效的标的上。',
        '为每一笔持仓写下止损条件（价格或逻辑），并立即处理浮亏超 12% 且逻辑已证伪的仓位。');
    }

    /* R07 仓位过度集中 ------------------------------------------------ */
    if (v.positions.length && endEquity) {
      const top = v.positions.slice().sort((a, b) => b.marketValue - a.marketValue)[0];
      const w = (top.marketValue / endEquity) * 100;
      if (w > 40) {
        const sev = w > 60 ? 'high' : 'mid';
        push('R07', '单一标的仓位过重', sev,
          `${top.name} 占总资产 ${w.toFixed(2)}%，持仓数量为 ${v.positions.length} 只。`,
          '单标的权重过高使组合风险从"分散的系统性风险"退化为"集中的个股特有风险"，而个股特有风险不提供任何风险溢价补偿。',
          '把单一标的权重压到 30% 以内；若确信度高，用分批建仓而不是一次性重仓来表达观点。');
      }
    }

    /* R08 极端仓位 ---------------------------------------------------- */
    const cw = v.cashWeight * 100;
    if (cw > 70) {
      push('R08', '现金比例过高（踏空风险）', 'mid',
        `期末现金占总资产 ${cw.toFixed(2)}%，持仓 ${v.positions.length} 只，本周基准 ${benchPct >= 0 ? '+' : ''}${benchPct.toFixed(2)}%。`,
        '长期高比例现金会显著拖累组合长期收益率。若这是主动的择时判断，需要明确的回补条件；若是犹豫不决，则是决策瘫痪。',
        '明确写下加仓触发条件（如"指数回踩 XX 水平"或"个股回调至目标价位"），把空仓从默认状态改为主动决策。');
    } else if (cw < 5 && v.positions.length) {
      push('R08', '接近满仓（缺乏机动性）', 'mid',
        `期末现金仅占 ${cw.toFixed(2)}%，几乎无机动资金。`,
        '满仓剥夺了选择权：更好的机会出现时无弹药，且遇到突发回撤时只能被动承受，无法通过加仓摊薄成本。',
        '保留至少 10% 的现金缓冲；把"是否留有现金"列为每次下单前的强制检查项。');
    }

    /* R09 逆势补亏 ---------------------------------------------------- */
    if (buyTrades.length) {
      const adding = [];
      buyTrades.forEach((t) => {
        const pos = positionChanges.find((x) => x.code === t.code);
        // 该股本周收益为负但仍买入，或买入后仍处浮亏
        const p = v.positions.find((x) => x.code === t.code);
        if (p && p.pnlPct < -5) adding.push({ name: t.name, pnlPct: p.pnlPct, date: t.date });
        else if (pos && pos.retPct < -5) adding.push({ name: t.name, pnlPct: pos.retPct, date: t.date });
      });
      if (adding.length) {
        push('R09', '向亏损仓位加仓（向下摊平）', 'mid',
          `${adding.map((x) => `${x.name}（${x.date}，当前 ${x.pnlPct.toFixed(2)}%）`).join('；')} 期间仍在买入。`,
          '向下摊平在没有止损约束时会变成"用更多资金去证明自己没错"，把小错放大成大错。它只有在一个前提下成立：买入逻辑不仅未变，反而更强。',
          '加仓前回答："如果这笔钱是全新的，我还会买它吗？"；向下摊平必须同时设定总仓位上限与止损位。');
      }
    }

    /* R10 同标的频繁进出 ---------------------------------------------- */
    const roundTrip = {};
    sellTrades.forEach((t) => { roundTrip[t.code] = (roundTrip[t.code] || 0) + 1; });
    const churn = Object.keys(roundTrip).filter((c) => {
      const buys = buyTrades.filter((t) => t.code === c).length;
      return buys > 0 && roundTrip[c] > 0;
    });
    if (churn.length) {
      push('R10', '同一标的周内反复进出', 'low',
        `${churn.map((c) => (global.Market.stock(c) ? global.Market.stock(c).name : c)).join('、')} 本周同时出现买入与卖出。`,
        '周内反向操作若来自明确的交易计划（如做 T）是合理的；若来自盘中情绪波动，则属于无计划交易，只会贡献费用与误差。',
        '为反向操作预设明确的价差目标与最大次数；无法说清交易目的的反向操作一律不做。');
    }

    /* R11 费用侵蚀 ---------------------------------------------------- */
    const feeRatio = weekFee / startEquity * 100;
    if (feeRatio > 0.3) {
      push('R11', '交易费用显著侵蚀收益', 'mid',
        `本周费用 ${weekFee.toFixed(2)} 元，占期初总资产 ${feeRatio.toFixed(2)}%（超过 0.30% 警戒线）。`,
        '费用是交易前就已 100% 确定的成本，而收益不确定。当费用占比达到这个量级时，策略必须拥有极高的胜率才能覆盖。',
        '把单笔委托金额提高到 5000 元以上，摊薄 5 元最低佣金的影响；并降低交易频次。');
    }

    /* R12 行业过度集中 ------------------------------------------------ */
    if (endEquity) {
      const sw = {};
      v.positions.forEach((p) => { sw[p.sector] = (sw[p.sector] || 0) + p.marketValue / endEquity * 100; });
      const top = Object.keys(sw).sort((a, b) => sw[b] - sw[a])[0];
      if (top && sw[top] > 60) {
        push('R12', '行业暴露过度集中', 'mid',
          `${top} 板块占组合 ${sw[top].toFixed(2)}%。`,
          '分散化降低风险的前提是持有低相关资产。同一行业的标的对同一风险因子高度暴露，组合波动不会被真正削减，却承担了行业政策与景气的集中风险。',
          `把 ${top} 板块权重降至 60% 以内，引入与之相关性较低的行业（可从个股页查看 β 与年化波动率辅助判断）。`);
      }
    }

    /* R13 空仓错过上涨 ------------------------------------------------ */
    if (!v.positions.length && benchPct > 2) {
      push('R13', '空仓错过市场上涨', 'low',
        `本周基准上涨 ${benchPct.toFixed(2)}%，而账户保持空仓，收益为 0。`,
        '空仓本身是一种主动判断（认为市场要跌），但没有写下判断依据与回补条件的空仓，本质是决策延迟而非风控。',
        '给空仓设定明确的回补条件与时间上限，避免长期无理由空仓。');
    }

    /* R14 过早兑现大幅盈利 -------------------------------------------- */
    const quickWin = sellTrades.filter((t) => t.realized > 0 && (t.avgHoldDays || 0) <= 5 && t.price / (t.costBasis || t.price) - 1 > 0.08);
    if (quickWin.length) {
      push('R14', '过早兑现盈利', 'low',
        `${quickWin.map((t) => `${t.name}（持有 ${t.avgHoldDays} 天，收益 ${(((t.price / (t.costBasis || t.price)) - 1) * 100).toFixed(2)}%）`).join('；')}。`,
        '在没有估值或逻辑兑现依据的情况下快速了结盈利仓位，会让组合的盈亏比结构恶化：赢的单子赚得少，输的单子亏得多。',
        '为盈利仓位设置移动止盈（如回撤 8% 离场），让利润奔跑，而不是用固定天数或固定涨幅作为卖出触发。');
    }

    const order = { high: 0, mid: 1, low: 2 };
    return out.sort((a, b) => order[a.severity] - order[b.severity]);
  }

  /* =========================================================================
   * 经验教训：由数据驱动，而非模板套话
   * ======================================================================= */
  function buildLessons(ctx) {
    const L = [];
    const { retPct, benchPct, excessPct, attrib, topGainers, topLosers, v, weekFee, startEquity, weekRealized, tradeCount } = ctx;

    // 1) 收益来源结构
    const total = Math.abs(attrib.market) + Math.abs(attrib.selection) + Math.abs(attrib.trading);
    const mShare = total ? Math.abs(attrib.market) / total * 100 : 0;
    const sShare = total ? Math.abs(attrib.selection) / total * 100 : 0;
    const tShare = total ? Math.abs(attrib.trading) / total * 100 : 0;

    if (mShare > 70) {
      L.push(`本周 ${retPct >= 0 ? '盈利' : '亏损'}中，市场 β 贡献占 ${mShare.toFixed(0)}%（${attrib.market >= 0 ? '+' : ''}${attrib.market.toFixed(2)}%），个股选择贡献仅 ${attrib.selection.toFixed(2)}%。这说明收益主要来自"市场给了"，而非"选得准"。判断能力时应以超额收益 ${excessPct >= 0 ? '+' : ''}${excessPct.toFixed(2)}% 为准，而不是绝对收益。`);
    } else if (sShare > 50 && attrib.selection > 0) {
      L.push(`本周选股 α 贡献 ${attrib.selection >= 0 ? '+' : ''}${attrib.selection.toFixed(2)}%，占总波动贡献的 ${sShare.toFixed(0)}%，是个股选择真正创造了价值的一周。应回看本期持仓的共同特征（行业、β、估值逻辑），把它固化为可重复的筛选条件，而不是归因为"运气好"。`);
    } else if (attrib.selection < -0.5) {
      L.push(`本周选股 α 为负（${attrib.selection.toFixed(2)}%），即在同样的市场环境下，所选标的整体跑输了基准。需要检查选股标准：是买入了高 β 进攻品种在震荡市被放大波动，还是选了景气度下行的行业。`);
    }

    // 2) 交易动作的有效性
    if (attrib.trading < -0.3) {
      L.push(`本周调仓操作的净贡献为 ${attrib.trading.toFixed(2)}%（其中费用 ${attrib.fee.toFixed(2)}%）。这意味着"动手"不但没有创造价值，反而侵蚀了收益——在 ${tradeCount} 笔交易之后，最优策略很可能是"什么都不做"。下次遇到类似的调仓冲动，先问：这次操作的预期收益，能否覆盖确定的成本与择时误差？`);
    } else if (attrib.trading > 0.3) {
      L.push(`本周调仓操作净贡献 ${attrib.trading >= 0 ? '+' : ''}${attrib.trading.toFixed(2)}%，择时/换股是正贡献。应记录本次调仓的判断依据（如行业景气变化、个股基本面事件），验证其是否具备可重复性——单次成功的择时无法区分能力与运气，需要至少 10 次以上的样本。`);
    }

    // 3) 个股层面的具体证据
    if (topGainers.length) {
      L.push(`贡献最大的持仓：${topGainers.map((x) => `${x.name}（${x.contribution >= 0 ? '+' : ''}${x.contribution.toFixed(2)}%，区间涨跌 ${x.ret >= 0 ? '+' : ''}${x.ret.toFixed(2)}%）`).join('、')}。注意区分"买对了标的"与"买对了仓位"——贡献大小同时取决于涨跌与权重，权重不足的优质判断同样无法转化为收益。`);
    }
    if (topLosers.length) {
      L.push(`拖累最大的持仓：${topLosers.map((x) => `${x.name}（${x.contribution.toFixed(2)}%，区间涨跌 ${x.ret >= 0 ? '+' : ''}${x.ret.toFixed(2)}%）`).join('、')}。对每个拖累项追问一句：是行业景气变化（系统性），还是公司层面的问题（个体性）？前者需要调整行业配置，后者应该直接纠错离场。`);
    }

    // 4) 成本
    if (weekFee / startEquity * 100 > 0.2) {
      L.push(`本周交易费用 ${weekFee.toFixed(2)} 元（占期初总资产 ${(weekFee / startEquity * 100).toFixed(2)}%）。按此频率推算，一年的成本拖累将非常可观。成本是唯一确定的变量，控制它的难度远低于预测市场。`);
    }

    // 5) 相对基准
    if (excessPct > 0) {
      L.push(`本周跑赢沪深300 ${excessPct.toFixed(2)} 个百分点，累计超额 ${(ctx.retPct - ctx.benchPct).toFixed(2)}%。保持警惕：单周的超额收益样本量极小（5 个交易日），不足以证明策略有效。至少积累 8–10 周数据后，再评估策略是否具备稳定的正期望。`);
    } else {
      L.push(`本周跑输沪深300 ${Math.abs(excessPct).toFixed(2)} 个百分点。若此时账户仍为正收益，要特别警惕"绝对收益带来的虚假安全感"——在普涨行情中跑输基准，说明承担了风险却没有获得相应回报，长期看等价于一笔亏损的交易。`);
    }

    return L;
  }

  /* =========================================================================
   * 下周行动建议（最多 3 条，均需可量化可执行）
   * ======================================================================= */
  function buildActions(diagnostics, v, excessPct) {
    const acts = [];
    const high = diagnostics.filter((d) => d.severity === 'high');
    const mid = diagnostics.filter((d) => d.severity === 'mid');

    if (high.length) {
      acts.push({ priority: 'P0', text: high[0].action, from: high[0].title });
    }
    if (high.length > 1) {
      acts.push({ priority: 'P0', text: high[1].action, from: high[1].title });
    }
    if (mid.length && acts.length < 3) {
      acts.push({ priority: 'P1', text: mid[0].action, from: mid[0].title });
    }
    if (acts.length < 3) {
      acts.push({ priority: 'P1', text: '下周交易前，为每一笔委托写下：买入理由、止损条件、目标仓位上限。三要素缺一不交易。', from: '通用纪律' });
    }
    if (acts.length < 3) {
      acts.push({
        priority: 'P2',
        text: excessPct >= 0
          ? '继续保持当前策略，但记录本周有效的判断依据，检验其可重复性（相同条件下能否再次成立）。'
          : '下周将交易笔数压缩到 2 笔以内，把精力从"择时"转移到"选标的"，观察超额收益是否改善。',
        from: '策略验证',
      });
    }
    return acts.slice(0, 3);
  }

  /* ---------------------------------------------------------------------
   * 生成"期初锚点"快照（每次周结算后调用，作为下一周的起点）
   * ------------------------------------------------------------------- */
  Report.makeAnchor = function () {
    const M = global.Market;
    const A = global.Account;
    const v = A.valuation();
    const positions = {};
    v.positions.forEach((p) => {
      positions[p.code] = { qty: p.qty, cost: p.cost, price: p.price, name: p.name, sector: p.sector };
    });
    return {
      dayIdx: M.dayIdx,
      date: M.currentDate(),
      equity: v.equity,
      cash: v.cash,
      bench: M.data.benchmark[M.dayIdx],
      positions,
    };
  };

  global.Report = Report;
})(typeof window !== 'undefined' ? window : globalThis);
