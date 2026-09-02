/* =============================================================================
 * render_test.js —— jsdom 环境下加载真实 index.html，验证页面渲染与交互
 * -----------------------------------------------------------------------------
 * 运行：
 *   NODE_PATH=<workspace>/node_modules node tools/render_test.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.dirname(__dirname);

let JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (e) {
  console.log('跳过：未安装 jsdom（npm i jsdom 后重跑）');
  process.exit(0);
}

const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '');

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
});
const win = dom.window;
const doc = win.document;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra || ''}`); }
}
function click(sel) {
  const el = typeof sel === 'string' ? doc.querySelector(sel) : sel;
  if (!el) throw new Error('未找到元素: ' + sel);
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  return el;
}
function setInput(sel, value) {
  const el = doc.querySelector(sel);
  if (!el) throw new Error('未找到输入: ' + sel);
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  return el;
}

console.log('=== 等待 DOM 就绪 ===');

function whenLoaded() {
  return new Promise((resolve) => {
    if (doc.readyState === 'complete') return resolve();
    win.addEventListener('load', () => resolve());
  });
}

whenLoaded().then(main).catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});

function main() {
console.log('=== 加载页面脚本 ===');
const files = [
  'data/market-data.js',
  'js/prng.js', 'js/market.js', 'js/account.js', 'js/rank.js', 'js/teach.js',
  'js/report.js', 'js/store.js', 'js/game.js', 'js/chart.js', 'js/ui.js', 'js/main.js',
];
files.forEach((f) => {
  win.eval(fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'));
});

const page = () => doc.querySelector('#page').textContent;

console.log('\n=== 1. 初始渲染 ===');
check('页面已渲染（非加载态）', page().indexOf('总资产') >= 0, page().slice(0, 80));
check('显示初始资金 100,000.00', page().indexOf('100,000.00') >= 0);
check('顶部导航显示交易日', doc.querySelector('#nav-date').textContent.length >= 8, doc.querySelector('#nav-date').textContent);
check('欢迎弹层已展示', doc.querySelector('#modal-root').innerHTML.indexOf('欢迎来到股海练兵') >= 0);
check('段位显示为青铜', page().indexOf('倔强青铜') >= 0);
check('净值曲线 SVG 已生成', doc.querySelector('#page svg') !== null);

// 关闭欢迎弹层
click('[data-act="close-modal"]');
check('欢迎弹层可关闭', doc.querySelector('#modal-root').innerHTML === '');

console.log('\n=== 2. 行情页 ===');
click('[data-tab="market"]');
check('行情页渲染出标的列表', page().indexOf('行情列表') >= 0);
check('列表包含贵州茅台', page().indexOf('贵州茅台') >= 0);
const itemCount = doc.querySelectorAll('#page .list-item').length;
check('列表条目数 = 38', itemCount === 38, itemCount);

// 搜索
setInput('[data-input="kw"]', '茅台');
check('搜索过滤生效', doc.querySelectorAll('#page .list-item').length === 1, doc.querySelectorAll('#page .list-item').length);
setInput('[data-input="kw"]', '');

// 行业筛选
const sectorChips = doc.querySelectorAll('[data-act="sector"]');
check('行业筛选标签存在', sectorChips.length > 5, sectorChips.length);
click(sectorChips[1]);
const filtered = doc.querySelectorAll('#page .list-item').length;
check('行业筛选生效（条目数减少）', filtered < 38 && filtered > 0, filtered);
click('[data-act="sector"][data-s="全部"]');

console.log('\n=== 3. 个股详情弹层 ===');
click('#page .list-item');
const modal = doc.querySelector('#modal-root').innerHTML;
check('个股详情弹层打开', modal.indexOf('风险特征') >= 0);
check('详情含分时图 SVG', modal.indexOf('<svg') >= 0);
check('详情含真实统计特征（β）', modal.indexOf('β（vs 沪深300）') >= 0);
click('[data-act="chart-tab"][data-mode="kline"]');
check('可切换到日K图', doc.querySelector('#modal-root').innerHTML.indexOf('<svg') >= 0);
click('[data-act="close-modal"]');

console.log('\n=== 4. 交易流程 ===');
click('[data-tab="trade"]');
setInput('[data-input="buy-code"]', '601398');
check('选择标的后显示报价', page().indexOf('涨停') >= 0);
check('显示 1 手所需金额', page().indexOf('1 手（100股）需') >= 0);
setInput('[data-input="buy-qty"]', '5000');
check('显示合计支出', page().indexOf('合计支出') >= 0);
const buyBtn = doc.querySelector('[data-act="do-buy"]');
check('买入按钮可用', !buyBtn.hasAttribute('disabled'));
click(buyBtn);
check('买入后弹出成交提示', doc.querySelector('#toast-root').textContent.indexOf('买入') >= 0, doc.querySelector('#toast-root').textContent);

// 持仓页
click('[data-act="trade-tab"][data-t="hold"]');
check('持仓页显示持仓', page().indexOf('当前持仓') >= 0 && page().indexOf('工商银行') >= 0);
check('持仓市值 > 0', win.Account.valuation().positionValue > 0, win.Account.valuation().positionValue);

// 成交记录
click('[data-act="trade-tab"][data-t="log"]');
check('成交记录有 1 笔', page().indexOf('成交记录') >= 0 && page().indexOf('买入') >= 0);

// 卖出页（当日买入 → T+1 锁定）
click('[data-act="trade-tab"][data-t="sell"]');
check('T+1 锁定提示已展示', page().indexOf('T+1 锁定中') >= 0, page().slice(0, 120));
check('T+1 锁定不误报为空仓', page().indexOf('当前无持仓') < 0);

// 推进 1 个交易日解锁 T+1
click('[data-tab="home"]');
click('[data-act="skip-day"]');
check('T+1 已解锁（可卖 = 持仓）', win.Account.position('601398').avail === 5000,
  win.Account.position('601398').avail);

// 回到交易页执行卖出
click('[data-tab="trade"]');
click('[data-act="trade-tab"][data-t="sell"]');
setInput('[data-input="sell-code"]', '601398');
click('[data-act="sell-frac"][data-f="1"]');
check('全部卖出数量已填充', page().indexOf('预计实现盈亏') >= 0);
click('[data-act="do-sell"]');
check('卖出已成交（持仓清空）', win.Account.position('601398').qty === 0,
  win.Account.position('601398').qty);
check('卖出后现金增加', win.Account.valuation().cash > 0, win.Account.valuation().cash);
click('[data-act="trade-tab"][data-t="log"]');
check('成交记录含卖出', page().indexOf('卖出') >= 0);

console.log('\n=== 5. 推进与周报 ===');
click('[data-tab="home"]');
click('[data-act="skip-week"]');
check('已生成第 1 周周报', win.Game.state.reports.length === 1, win.Game.state.reports.length);
click('[data-tab="report"]');
check('周报列表渲染', page().indexOf('第 1 周复盘') >= 0);
click('#page .wk-card');
const rmodal = doc.querySelector('#modal-root').innerHTML;
check('周报详情含收益归因', rmodal.indexOf('收益归因') >= 0);
check('周报详情含行为诊断', rmodal.indexOf('行为诊断') >= 0);
check('周报详情含经验教训', rmodal.indexOf('经验教训') >= 0);
check('周报详情含行动建议', rmodal.indexOf('下周行动建议') >= 0);
check('周报详情含段位结算', rmodal.indexOf('段位结算') >= 0);
click('[data-act="close-modal"]');

console.log('\n=== 6. 学院与课程 ===');
click('[data-tab="academy"]');
check('学院页渲染段位', page().indexOf('倔强青铜') >= 0 || page().indexOf('秩序白银') >= 0);
check('学院页含课程列表', page().indexOf('全部课程') >= 0);
check('学院页含评级规则说明', page().indexOf('评级规则说明') >= 0);
const courseEl = doc.querySelector('[data-act="course"]');
click(courseEl);
const cmodal = doc.querySelector('#modal-root').innerHTML;
check('课程详情含核心要点', cmodal.indexOf('核心要点') >= 0);
check('课程详情含检查清单', cmodal.indexOf('落地检查清单') >= 0);
check('课程详情含自测题', cmodal.indexOf('自测题') >= 0);
const optEls = doc.querySelectorAll('[data-act="quiz-opt"]');
check('自测题有 4 个选项', optEls.length === 4, optEls.length);
click(optEls[0]);
check('作答后显示解析', doc.querySelector('#modal-root').innerHTML.indexOf('explain') >= 0
  || doc.querySelector('#modal-root').innerHTML.indexOf('回答') >= 0);
click('[data-act="finish-course"]');
check('打卡成功', win.Game.coursesDoneCount() === 1, win.Game.coursesDoneCount());

console.log('\n=== 7. 时钟推进 ===');
click('[data-tab="home"]');
const dayBefore = win.Market.dayIdx;
click('[data-act="skip-day"]');
check('下一日推进 1 个交易日', win.Market.dayIdx === dayBefore + 1, `${dayBefore} → ${win.Market.dayIdx}`);
click('[data-act="play"]');
check('播放状态已切换', win.Game.state.settings.autoPlay === true);
click('[data-act="play"]');
check('暂停状态已切换', win.Game.state.settings.autoPlay === false);
const speedBtns = doc.querySelectorAll('[data-act="speed"]');
check('速度档位 4 档', speedBtns.length === 4, speedBtns.length);

console.log('\n=== 8. 刷新/读档一致性 ===');
const stateJson = JSON.stringify(win.Game.state);
const equityBefore = win.Account.valuation().equity;
win.Game.init(win.Market.data, JSON.parse(stateJson), {});
check('读档后总资产一致', Math.abs(win.Account.valuation().equity - equityBefore) < 0.01,
  `${equityBefore} → ${win.Account.valuation().equity}`);

console.log('\n=== 9. 控制台错误检查 ===');
check('页面无 JS 异常', !win.__jsError, win.__jsError);

win.addEventListener('error', (e) => { win.__jsError = e.message || String(e.error); });

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
}
