/* =============================================================================
 * smoke_test.js —— 引擎冒烟测试（Node 环境，不依赖浏览器）
 * -----------------------------------------------------------------------------
 * 校验：行情回放可复现性、T+1 约束、费用模型、收益归因对账、段位升降逻辑。
 * 运行： node tools/smoke_test.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
global.window = global;

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

console.log('=== 加载模块与数据 ===');
load('app/data/market-data.js');
['prng', 'market', 'account', 'rank', 'teach', 'report', 'store', 'game'].forEach((m) => {
  load(`app/js/${m}.js`);
});

const meta = window.MARKET_DATA.meta;
console.log(`数据源: ${meta.source}`);
console.log(`区间: ${meta.startDate} ~ ${meta.endDate}, ${meta.tradingDays} 个交易日, ${meta.stockCount} 只标的`);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra || ''}`); }
}

/* -------------------------------------------------------------------------
 * 1. 行情回放可复现性
 * ---------------------------------------------------------------------- */
console.log('\n=== 1. 行情回放可复现性 ===');
Market.init(window.MARKET_DATA, 0);
const p1 = Market.getPath('600519', 100);
const p2 = Market.getPath('600519', 100);
check('同一 (标的, 交易日) 生成相同路径', JSON.stringify(p1.path) === JSON.stringify(p2.path));
check('路径起点 = 真实开盘价', Math.abs(p1.path[0] - p1.bar[0]) < 1e-9, `${p1.path[0]} vs ${p1.bar[0]}`);
check('路径终点 = 真实收盘价', Math.abs(p1.path[23] - p1.bar[3]) < 1e-9, `${p1.path[23]} vs ${p1.bar[3]}`);
const lo = Math.min.apply(null, p1.path), hi = Math.max.apply(null, p1.path);
check('路径不越界于真实最高/最低价', lo >= p1.bar[2] - 1e-9 && hi <= p1.bar[1] + 1e-9, `[${lo},${hi}] vs [${p1.bar[2]},${p1.bar[1]}]`);

// 全市场路径生成不报错
let err = null;
try {
  window.MARKET_DATA.stocks.forEach((s) => {
    for (let d = 0; d < 60; d++) Market.getPath(s.code, d);
  });
} catch (e) { err = e; }
check('全市场 60 日路径生成无异常', !err, err && err.message);

/* -------------------------------------------------------------------------
 * 2. 初始化与交易规则
 * ---------------------------------------------------------------------- */
console.log('\n=== 2. 初始化与交易规则 ===');
Game.init(window.MARKET_DATA, null, { startDayIdx: 0 });
check('初始资金 100,000', Account.state.cash === 100000, Account.state.cash);
check('初始段位为青铜Ⅲ 0 星', Game.state.rank.tier === 0 && Game.state.rank.sub === 0 && Game.state.rank.stars === 0);

let r = Game.buy('600519', 50);
check('非 100 整数倍买入被拒绝', !r.ok);
r = Game.buy('600519', 1000000);
check('超出资金的买入被拒绝', !r.ok);

// 整手约束：茅台一手约 15.5 万元，10 万本金买不起（真实 A 股规则）
const maotai = Market.quote('600519');
check('整手约束：10 万本金无法买入 1 手高价股', Account.maxBuyQty(maotai.price, 100000) === 0,
  `一手需 ${(maotai.price * 100).toFixed(2)} 元`);

const ICBC = Market.quote('601398');
const maxQty = Account.maxBuyQty(ICBC.price, 100000);
check('可买数量计算为正的 100 整数倍', maxQty > 0 && maxQty % 100 === 0, maxQty);
check('可买数量不超出可用资金', maxQty * ICBC.price + Account.buyFees(maxQty * ICBC.price).total <= 100000 + 1e-6, maxQty);

r = Game.buy('601398', 5000);
check('合法买入成功', r.ok, r.msg);
check('买入后可用资金减少且为正', Account.state.cash > 0 && Account.state.cash < 100000, Account.state.cash);
check('T+1：当日买入可卖数量为 0', Account.position('601398').avail === 0);

r = Game.sell('601398', 5000);
check('T+1：当日买入无法当日卖出', !r.ok, r.msg);

// 费用校验
const feeTest = Account.buyFees(100000);
check('买入费用 = 佣金(≥5元) + 过户费', Math.abs(feeTest.total - (Math.max(5, 100000 * 0.00025) + 100000 * 0.00001)) < 0.02, feeTest.total);
const feeSell = Account.sellFees(100000);
check('卖出费用含印花税 0.05%', Math.abs(feeSell.stamp - 50) < 0.02, feeSell.stamp);

/* -------------------------------------------------------------------------
 * 3. 推进 + 周结算 + 归因对账
 * ---------------------------------------------------------------------- */
console.log('\n=== 3. 推进行情与周结算 ===');
Game.reset(0);
Game.buy('601398', 5000);   // 工商银行
Game.buy('000725', 3000);   // 京东方A
Game.buy('600036', 500);    // 招商银行

let settled = 0;
for (let i = 0; i < 20; i++) {
  Game.skipDay();
  if (Game.state.reports.length > settled) {
    settled = Game.state.reports.length;
  }
}
// 中途加仓、减仓
Game.buy('600036', 300);
Game.skipDay();
Game.sell('601398', 2000);
for (let i = 0; i < 30; i++) Game.skipDay();

check('生成了周报', Game.state.reports.length >= 8, Game.state.reports.length);

let maxResid = 0, maxFeeErr = 0;
Game.state.reports.forEach((rep) => {
  const a = rep.attribution;
  const sum = a.market + a.selection + a.trading + a.residual;
  maxResid = Math.max(maxResid, Math.abs(a.residual));
  maxFeeErr = Math.max(maxFeeErr, Math.abs(sum - rep.retPct));
});
check('归因加总 = 实际周收益率（误差 < 0.5pp）', maxFeeErr < 0.5, `最大误差 ${maxFeeErr.toFixed(4)}pp`);
check('归因残差接近 0（< 0.5pp）', maxResid < 0.5, `最大残差 ${maxResid.toFixed(4)}pp`);

const rep0 = Game.state.reports[Game.state.reports.length - 1];
console.log(`\n--- 样例周报（第 ${rep0.weekIndex} 周, ${rep0.startDate} ~ ${rep0.endDate}）---`);
console.log(`周收益率 ${rep0.retPct}% | 基准 ${rep0.benchPct}% | 超额 ${rep0.excessPct}%`);
console.log(`归因: β ${rep0.attribution.market}% / α ${rep0.attribution.selection}% / 交易 ${rep0.attribution.trading}% / 残差 ${rep0.attribution.residual}%`);
console.log(`交易 ${rep0.tradeCount} 笔 | 费用 ${rep0.weekFee} 元 (${rep0.feeRatePct}%)`);
console.log(`行为诊断 ${rep0.diagnostics.length} 项: ${rep0.diagnostics.map((d) => d.title + '(' + d.severity + ')').join(', ') || '无'}`);
console.log(`经验教训 ${rep0.lessons.length} 条 | 行动建议 ${rep0.actions.length} 条 | 推荐课程 ${rep0.courseRecs.length} 门`);
console.log(`段位: ${rep0.rank.before} → ${rep0.rank.after} (${rep0.rank.win ? '胜' : '负'} ${rep0.rank.delta >= 0 ? '+' : ''}${rep0.rank.delta}★, 表现分 ${rep0.rank.perf})`);

/* -------------------------------------------------------------------------
 * 4. 段位升降逻辑
 * ---------------------------------------------------------------------- */
console.log('\n=== 4. 段位升降逻辑 ===');
function mkRank(t, s, st) { return Object.assign(Rank.create(), { tier: t, sub: s, stars: st }); }
let rk = mkRank(0, 0, 0);
// 普通胜利：超额 < 2% → +1 星，不触发 MVP
let rk2 = mkRank(0, 0, 0);
Rank.settle(rk2, { weekIndex: 2, excessPct: 0.5, retPct: 0.5, maxDDPct: 2, topWeightPct: 30, violations: [], coursesDone: 0, reportReviewed: true });
check('普通胜利 +1 星（未达 MVP 不加额外星）', rk2.stars === 1, `stars=${rk2.stars}`);

// 连胜 3 场奖励
let rk3 = mkRank(0, 0, 0);
Rank.settle(rk3, { weekIndex: 1, excessPct: 1, retPct: 1, maxDDPct: 1, topWeightPct: 20, violations: [], coursesDone: 0, reportReviewed: true });
Rank.settle(rk3, { weekIndex: 2, excessPct: 1, retPct: 1, maxDDPct: 1, topWeightPct: 20, violations: [], coursesDone: 0, reportReviewed: true });
const beforeStreak = rk3.stars;
Rank.settle(rk3, { weekIndex: 3, excessPct: 1, retPct: 1, maxDDPct: 1, topWeightPct: 20, violations: [], coursesDone: 0, reportReviewed: true });
check('3 连胜触发额外奖励星', rk3.winStreak === 3, `streak=${rk3.winStreak} before=${beforeStreak}`);

rk = mkRank(0, 0, 0);
Rank.settle(rk, { weekIndex: 1, excessPct: 3, retPct: 3, maxDDPct: 2, topWeightPct: 30, violations: [], coursesDone: 2, reportReviewed: true });
check('MVP 胜利 +2 星', rk.stars === 2, `stars=${rk.stars}`);
Rank.settle(rk, { weekIndex: 2, excessPct: 1, retPct: 1, maxDDPct: 2, topWeightPct: 30, violations: [], coursesDone: 0, reportReviewed: true });
check('青铜Ⅲ 满星后晋升青铜Ⅱ', rk.tier === 0 && rk.sub === 1 && rk.stars === 0, `${rk.tier}-${rk.sub}-${rk.stars}`);

rk = mkRank(0, 2, 0);
Rank.settle(rk, { weekIndex: 3, excessPct: -2, retPct: -2, maxDDPct: 5, topWeightPct: 30, violations: [], coursesDone: 0, reportReviewed: true });
check('零星时失败掉到上一小段（满星-1）', rk.tier === 0 && rk.sub === 1 && rk.stars === 2, `${rk.tier}-${rk.sub}-${rk.stars}`);

rk = mkRank(0, 0, 0);
Rank.settle(rk, { weekIndex: 4, excessPct: -3, retPct: -3, maxDDPct: 6, topWeightPct: 30, violations: [], coursesDone: 0, reportReviewed: true });
check('青铜Ⅲ 0 星为地板不再下掉', rk.tier === 0 && rk.sub === 0 && rk.stars === 0, `${rk.tier}-${rk.sub}-${rk.stars}`);

rk = mkRank(5, 4, 4);  // 星耀Ⅰ 4/5 星
Rank.settle(rk, { weekIndex: 5, excessPct: 4, retPct: 4, maxDDPct: 1, topWeightPct: 25, violations: [], coursesDone: 2, reportReviewed: true });
check('星耀Ⅰ 满星晋升王者', rk.tier === 6, `tier=${rk.tier} stars=${rk.stars}`);
const kd = Rank.display(rk);
console.log(`  王者显示: ${kd.full}`);

rk = mkRank(6, 0, 0);
Rank.settle(rk, { weekIndex: 6, excessPct: -1, retPct: -1, maxDDPct: 4, topWeightPct: 35, violations: [], coursesDone: 0, reportReviewed: true });
check('王者 0 星失败掉回星耀Ⅰ', rk.tier === 5 && rk.sub === 4 && rk.stars === 4, `${rk.tier}-${rk.sub}-${rk.stars}`);

// 勇者积分保护
rk = Object.assign(Rank.create(), { tier: 2, sub: 1, stars: 2, brave: 80 });
const st = Rank.settle(rk, { weekIndex: 7, excessPct: -1, retPct: -1, maxDDPct: 3, topWeightPct: 30, violations: [], coursesDone: 0, reportReviewed: true });
check('勇者积分 ≥60 时抵扣掉星', st.protectedByBrave && rk.stars === 2, `protected=${st.protectedByBrave} stars=${rk.stars}`);

// 表现分：回撤与集中度越大得分应越低（验证插值方向未反转）
const ddSmall = Rank.performance({ excessPct: 0, maxDDPct: 1, topWeightPct: 20, violations: [], coursesDone: 0, reportReviewed: true });
const ddBig = Rank.performance({ excessPct: 0, maxDDPct: 15, topWeightPct: 90, violations: [], coursesDone: 0, reportReviewed: true });
check('回撤/集中度越大，风险分越低', ddSmall.risk > ddBig.risk + 40, `small=${ddSmall.risk} big=${ddBig.risk}`);

const perfGood = Rank.performance({ excessPct: 5, maxDDPct: 0.5, topWeightPct: 20, violations: [], coursesDone: 2, reportReviewed: true });
const perfBad = Rank.performance({ excessPct: -8, maxDDPct: 20, topWeightPct: 90, violations: [{ severity: 'high' }, { severity: 'high' }, { severity: 'mid' }], coursesDone: 0, reportReviewed: false });
check('表现分在 0–100 且区分度合理', perfGood.total >= 90 && perfBad.total <= 25 && perfGood.total - perfBad.total > 50,
  `good=${perfGood.total} bad=${perfBad.total}`);

/* -------------------------------------------------------------------------
 * 5. 长周期随机交易压力测试
 * ---------------------------------------------------------------------- */
console.log('\n=== 5. 长周期压力测试（200 交易日随机交易）===');
Game.reset(0);
let rngSeed = 12345;
function rnd() { rngSeed = (rngSeed * 1103515245 + 12345) & 0x7fffffff; return rngSeed / 0x7fffffff; }

let tradeOk = 0, tradeErr = 0, crash = null;
try {
  const codes = window.MARKET_DATA.stocks.map((s) => s.code);
  for (let d = 0; d < 200; d++) {
    if (rnd() < 0.35) {
      const code = codes[Math.floor(rnd() * codes.length)];
      const qq = Market.quote(code);
      if (qq && !qq.suspended) {
        const qty = Math.floor((1 + rnd() * 10)) * 100;
        const res = Game.buy(code, qty);
        if (res.ok) tradeOk++; else tradeErr++;
      }
    }
    if (rnd() < 0.25) {
      const pos = Account.positionList().filter((p) => p.avail > 0);
      if (pos.length) {
        const p = pos[Math.floor(rnd() * pos.length)];
        const qty = Math.max(100, Math.floor((p.avail / 100)) * 100);
        const res = Game.sell(p.code, Math.min(qty, p.avail));
        if (res.ok) tradeOk++; else tradeErr++;
      }
    }
    Game.skipDay();
  }
} catch (e) { crash = e; }

check('200 日随机交易无异常', !crash, crash && crash.stack);
check('成交笔数合理', tradeOk > 20, `成功 ${tradeOk} / 拒绝 ${tradeErr}`);
const s = Game.summary();
check('总资产为正', s.equity > 0, s.equity);
check('现金不为负', Account.state.cash >= -0.001, Account.state.cash);
check('持仓市值与估值一致', Math.abs(Account.valuation().positionValue - Account.positionList().reduce((a, b) => a + b.marketValue, 0)) < 0.01);
check('生成周报数量 = 200/5', Game.state.reports.length === 40, Game.state.reports.length);
console.log(`  期末: 总资产 ${s.equity.toFixed(2)} (${s.totalPnlPct.toFixed(2)}%) | 基准 ${s.benchPct.toFixed(2)}% | 段位 ${Rank.display(Game.state.rank).full} ${Rank.display(Game.state.rank).starsText}`);

/* -------------------------------------------------------------------------
 * 6. 存档 / 读档
 * ---------------------------------------------------------------------- */
console.log('\n=== 6. 存档一致性 ===');
const before = JSON.stringify(Account.state.positions);
const savedState = JSON.parse(JSON.stringify(Game.state));
Game.init(window.MARKET_DATA, savedState);
const after = JSON.stringify(Account.state.positions);
check('读档后持仓一致', before === after);
check('读档后行情位置一致', Market.dayIdx === savedState.market.dayIdx, `${Market.dayIdx} vs ${savedState.market.dayIdx}`);

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
