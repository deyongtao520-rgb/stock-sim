/* =============================================================================
 * game.js —— 游戏主控：时钟推进、周结算、状态持久化
 * -----------------------------------------------------------------------------
 * 唯一对外入口。UI 层只调用 Game 的方法，不直接操作 Account / Market。
 * ========================================================================== */
(function (global) {
  'use strict';

  const Game = {
    state: null,
    listeners: {},
    timer: null,
  };

  const SPEEDS = [
    { label: '慢速', ms: 800 },
    { label: '常速', ms: 400 },
    { label: '快速', ms: 150 },
    { label: '极速', ms: 40 },
  ];
  Game.SPEEDS = SPEEDS;

  /* ---------------------------------------------------------------------
   * 事件（极简发布订阅，供 UI 局部刷新）
   * ------------------------------------------------------------------- */
  Game.on = function (evt, fn) {
    (Game.listeners[evt] = Game.listeners[evt] || []).push(fn);
  };
  Game.emit = function (evt, payload) {
    (Game.listeners[evt] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  };

  /* ---------------------------------------------------------------------
   * 初始化
   * ------------------------------------------------------------------- */
  /**
   * 初始化
   * 交易日 0 作为"锚点日"（账户成立的基准时刻，不可交易），
   * 实际交易从第 1 个交易日开盘开始；每 5 个交易日（1–5、6–10 …）结算一周。
   */
  Game.init = function (data, saved, opts) {
    opts = opts || {};
    const startIdx = Math.max(1, opts.startDayIdx === undefined ? 1 : opts.startDayIdx);
    global.Market.init(data, 0);
    Market.weekAnchor = 0;

    if (saved) {
      Game.state = saved;
      global.Market.init(data, saved.market.dayIdx);
      Market.dayIdx = saved.market.dayIdx;
      Market.tick = saved.market.tick;
      Market.weekAnchor = saved.market.weekAnchor || 0;
      global.Account.load(saved.account);
    } else {
      global.Account.create({ initialCash: 100000, startDayIdx: 0 });
      Market.dayIdx = startIdx;
      Market.tick = 0;
      Market.weekAnchor = 0;
      // 锚点日（第 0 交易日收盘 = 账户成立时刻）净值快照
      Account.state.equityHistory.push({
        dayIdx: 0, date: data.dates[0],
        equity: 100000, cash: 100000, posValue: 0,
        bench: data.benchmark[0], benchNorm: 1, equityNorm: 1,
      });
      Game.state = {
        version: 1,
        createdAt: Date.now(),
        market: { dayIdx: Market.dayIdx, tick: Market.tick, weekAnchor: 0 },
        account: Account.state,
        rank: global.Rank.create(),
        weekAnchor: {
          dayIdx: 0, date: data.dates[0],
          equity: 100000, cash: 100000,
          bench: data.benchmark[0], positions: {},
        },
        reports: [],
        courses: {},
        settings: { speed: 1, autoPlay: false },
      };
    }

    // 为 report 提供全局引用（课程进度 / 段位）
    global.__rankState = Game.state.rank;
    global.__courseProgress = Game.state.courses;

    Game.save(true);
    return Game.state;
  };

  Game.save = function (immediate) {
    Game.state.market.dayIdx = global.Market.dayIdx;
    Game.state.market.tick = global.Market.tick;
    Game.state.market.weekAnchor = global.Market.weekAnchor;
    Game.state.account = global.Account.state;
    return global.Store.save(Game.state, immediate);
  };

  Game.reset = function (startDayIdx) {
    global.Store.clear();
    return Game.init(global.Market.data, null, { startDayIdx: startDayIdx === undefined ? 1 : startDayIdx });
  };

  /* ---------------------------------------------------------------------
   * 交易
   * ------------------------------------------------------------------- */
  Game.buy = function (code, qty) {
    const r = global.Account.buy(code, qty);
    if (r.ok) { Game.save(); Game.emit('trade', r); Game.emit('update'); }
    return r;
  };
  Game.sell = function (code, qty) {
    const r = global.Account.sell(code, qty);
    if (r.ok) { Game.save(); Game.emit('trade', r); Game.emit('update'); }
    return r;
  };

  /* ---------------------------------------------------------------------
   * 时钟推进
   * ------------------------------------------------------------------- */
  const onDayEnd = function () { global.Account.endOfDay(); };

  Game.tick = function () {
    const r = global.Market.step(onDayEnd);
    if (r.weekEnded) Game.settleWeek();
    if (r.exhausted) {
      Game.pause();
      Game.emit('exhausted');
    }
    Game.save();
    Game.emit('update');
    return r;
  };

  Game.skipDay = function () {
    const r = global.Market.skipDay(onDayEnd);
    if (r.weekEnded) Game.settleWeek();
    if (r.exhausted) { Game.pause(); Game.emit('exhausted'); }
    Game.save(true);
    Game.emit('dayEnd', r);
    Game.emit('update');
    return r;
  };

  Game.skipWeek = function () {
    let guard = 0;
    while (guard++ < 10) {
      const r = Game.skipDay();
      if (r.weekEnded || r.exhausted) break;
    }
  };

  /* ---------------------------------------------------------------------
   * 周结算：生成周报 → 段位升降 → 更新锚点
   * ------------------------------------------------------------------- */
  Game.settleWeek = function () {
    const M = global.Market;
    const anchor = Game.state.weekAnchor;
    const endDayIdx = M.dayIdx;
    const startDayIdx = anchor.dayIdx;
    const weekIndex = Game.state.reports.length + 1;

    const report = global.Report.generate(anchor, weekIndex, startDayIdx, endDayIdx);

    // 本周完成的课程数（用于学习分）
    const coursesDone = Object.values(Game.state.courses)
      .filter((c) => c.done && c.dayIdx > startDayIdx && c.dayIdx <= endDayIdx).length;

    const settle = global.Rank.settle(Game.state.rank, {
      weekIndex,
      startDate: report.startDate,
      endDate: report.endDate,
      retPct: report.retPct,
      excessPct: report.excessPct,
      maxDDPct: Math.abs(report.weekMaxDD),
      topWeightPct: report.topWeight,
      violations: report.diagnostics,
      coursesDone,
      reportReviewed: true,
    });

    report.rank = {
      win: settle.win, mvp: settle.mvp, delta: settle.delta,
      protectedByBrave: settle.protectedByBrave,
      before: settle.before.full + ' ' + settle.before.starsText,
      after: settle.after.full + ' ' + settle.after.starsText,
      perf: settle.perf,
      perfDetail: settle.perf,
      reasons: settle.reasons,
      brave: Game.state.rank.brave,
    };

    Game.state.reports.unshift(report);
    if (Game.state.reports.length > 300) Game.state.reports.length = 300;
    Game.state.weekAnchor = global.Report.makeAnchor();
    Game.save(true);
    Game.emit('weekSettled', report);
    return report;
  };

  /** 手动触发一次周结算（用于测试 / 提前复盘） */
  Game.forceSettle = function () {
    if (global.Market.dayIdx <= Game.state.weekAnchor.dayIdx) return null;
    return Game.settleWeek();
  };

  /* ---------------------------------------------------------------------
   * 自动播放
   * ------------------------------------------------------------------- */
  Game.play = function () {
    Game.pause();
    Game.state.settings.autoPlay = true;
    const tick = () => {
      const ms = (SPEEDS[Game.state.settings.speed] || SPEEDS[1]).ms;
      Game.tick();
      if (Game.state.settings.autoPlay) Game.timer = setTimeout(tick, ms);
    };
    Game.timer = setTimeout(tick, 10);
    Game.emit('playState');
  };
  Game.pause = function () {
    Game.state.settings.autoPlay = false;
    if (Game.timer) { clearTimeout(Game.timer); Game.timer = null; }
    Game.emit('playState');
  };
  Game.toggle = function () {
    if (Game.state.settings.autoPlay) Game.pause(); else Game.play();
  };
  Game.setSpeed = function (i) {
    Game.state.settings.speed = i;
    if (Game.state.settings.autoPlay) Game.play();
    Game.save();
    Game.emit('playState');
  };

  /* ---------------------------------------------------------------------
   * 课程打卡
   * ------------------------------------------------------------------- */
  Game.finishCourse = function (id, quizPass) {
    Game.state.courses[id] = { done: true, dayIdx: global.Market.dayIdx, quizPass: !!quizPass, at: Date.now() };
    Game.save();
    Game.emit('update');
  };
  Game.courseProgress = function () { return Game.state.courses; };
  Game.coursesDoneCount = function () {
    return Object.values(Game.state.courses).filter((c) => c.done).length;
  };

  /* ---------------------------------------------------------------------
   * 派生指标（供 UI 直接渲染）
   * ------------------------------------------------------------------- */
  Game.summary = function () {
    const M = global.Market;
    const v = global.Account.valuation();
    const bench = M.benchmark();
    const initBench = M.data.benchmark[Account.state.startDayIdx] || M.data.benchmark[0];
    const last = Account.lastSnapshot();
    const dayPnl = last ? v.equity - last.equity : 0;
    return {
      date: M.currentDate(),
      tick: M.tick,
      equity: v.equity,
      cash: v.cash,
      positionValue: v.positionValue,
      totalPnl: v.totalPnl,
      totalPnlPct: v.totalPnlPct,
      dayPnl,
      dayPnlPct: last && last.equity ? (dayPnl / last.equity) * 100 : 0,
      positionWeight: v.positionWeight * 100,
      benchValue: bench.value,
      benchPct: (bench.value / initBench - 1) * 100,
      excessPct: v.totalPnlPct - (bench.value / initBench - 1) * 100,
      maxDrawdown: Account.state.maxDrawdown * 100,
      progress: M.progress(),
      dayIndex: M.dayIdx,
      totalDays: M.data.dates.length,
    };
  };

  global.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);
