/* =============================================================================
 * verify_http.js —— 通过真实 HTTP 服务验证「股海练兵」可运行
 * -----------------------------------------------------------------------------
 * 与 render_test.js 的区别：
 *   render_test.js  从磁盘读文件后用 win.eval 注入，验证的是「代码逻辑」
 *   本脚本          通过 HTTP 抓取 index.html，解析出真实的 <script src> 顺序，
 *                   再按该顺序经 HTTP 下载并注入，验证的是「HTTP 传输 + 加载顺序」
 *
 * 为什么不直接用 jsdom 的 resources:'usable'：
 *   jsdom 30 的内置资源加载在并发请求同一服务器时会随机报
 *   "Could not load script"（每次失败的文件还不一样），且 jsdom 30 已移除
 *   旧版 ResourceLoader 扩展点。这是 jsdom 网络栈的局限——同一批 URL 用 curl
 *   逐一下载全部 200 且字节数正确，真实浏览器亦不受影响。本脚本因此自行下载。
 *
 * 运行：
 *   NODE_PATH=<workspace>/node_modules node tools/verify_http.js [url]
 * ========================================================================== */
'use strict';

const { JSDOM } = require('jsdom');

const BASE = process.argv[2] || 'http://127.0.0.1:8321/index.html';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ? '  → ' + extra : ''}`); }
};

async function main() {
  console.log(`=== 通过 HTTP 验证：${BASE} ===`);

  /* ---------- 1. 下载 index.html ---------- */
  const resHtml = await fetch(BASE);
  if (!resHtml.ok) throw new Error(`index.html 下载失败：HTTP ${resHtml.status}`);
  const html = await resHtml.text();
  console.log(`  index.html  ${resHtml.status}  ${html.length} bytes`);

  /* ---------- 2. 解析 <script src> 顺序 ---------- */
  const srcs = [...html.matchAll(/<script\s+[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  const csss = [...html.matchAll(/<link\s+[^>]*href="([^"]+\.css)"/g)].map((m) => m[1]);
  check('index.html 解析到 12 个 <script src>', srcs.length === 12, srcs.length);
  check('index.html 解析到 1 个样式表', csss.length === 1, csss.join(','));

  /* ---------- 3. 经 HTTP 下载全部资源 ---------- */
  const files = [];
  for (const rel of csss.concat(srcs)) {
    const u = new URL(rel, BASE).href;
    const r = await fetch(u);
    const body = r.ok ? await r.text() : '';
    files.push({ rel, url: u, status: r.status, size: body.length, body });
    if (!r.ok) console.log(`  ✗ ${rel}  HTTP ${r.status}`);
  }
  check('全部 13 个资源 HTTP 200', files.every((f) => f.status === 200),
    files.filter((f) => f.status !== 200).map((f) => `${f.rel}:${f.status}`).join(' '));
  check('行情数据集完整（> 1 MB）',
    files.some((f) => f.rel.endsWith('market-data.js') && f.size > 1000000),
    files.find((f) => f.rel.endsWith('market-data.js') || {}).size);

  /* ---------- 4. 建 DOM 并按真实顺序注入 ---------- */
  const shell = html.replace(/<script\s+[^>]*><\/script>/g, '');
  const dom = new JSDOM(shell, { url: BASE, runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  const errors = [];
  win.addEventListener('error', (e) => errors.push(e.message || String(e.error)));

  await new Promise((resolve) => {
    if (doc.readyState === 'complete') return resolve();
    win.addEventListener('load', () => resolve());
    setTimeout(resolve, 15000);
  });

  for (const f of files.filter((x) => x.rel.endsWith('.js'))) {
    try {
      win.eval(f.body);
    } catch (e) {
      errors.push(`${f.rel}: ${e.message}`);
    }
  }

  const page = () => doc.querySelector('#page').textContent;

  console.log('\n=== 模块挂载（按 index.html 的 script 顺序注入）===');
  check('MARKET_DATA 已加载', !!win.MARKET_DATA && win.MARKET_DATA.stocks.length === 38,
    win.MARKET_DATA ? `${win.MARKET_DATA.stocks.length} 只` : 'undefined');
  ['PRNG', 'Market', 'Account', 'Rank', 'Teach', 'Report', 'Store', 'Game', 'Chart', 'UI']
    .forEach((m) => check(`${m} 已挂载`, !!win[m]));

  console.log('\n=== 首屏渲染 ===');
  check('页面已渲染（非加载态）', page().indexOf('总资产') >= 0, page().slice(0, 60));
  check('显示初始资金 100,000.00', page().indexOf('100,000.00') >= 0);
  check('欢迎弹层已展示', doc.querySelector('#modal-root').innerHTML.indexOf('欢迎来到股海练兵') >= 0);
  check('段位显示为倔强青铜', page().indexOf('倔强青铜') >= 0);
  check('净值曲线 SVG 已生成', doc.querySelector('#page svg') !== null);
  check('顶部导航显示交易日', doc.querySelector('#nav-date').textContent.length >= 8,
    doc.querySelector('#nav-date').textContent);

  console.log('\n=== 交互冒烟 ===');
  const click = (sel) => {
    const el = doc.querySelector(sel);
    if (!el) throw new Error('未找到元素: ' + sel);
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    return el;
  };
  click('[data-act="close-modal"]');
  check('弹层可关闭', doc.querySelector('#modal-root').innerHTML === '');

  click('[data-tab="market"]');
  check('行情页 38 只标的', doc.querySelectorAll('#page .list-item').length === 38,
    doc.querySelectorAll('#page .list-item').length);

  click('[data-tab="trade"]');
  const selCode = doc.querySelector('[data-input="buy-code"]');
  selCode.value = '601398';
  selCode.dispatchEvent(new win.Event('input', { bubbles: true }));
  check('交易页报价可用', page().indexOf('1 手（100股）需') >= 0);

  click('[data-tab="academy"]');
  check('学院页渲染', page().indexOf('全部课程') >= 0);

  click('[data-tab="home"]');
  click('[data-act="skip-week"]');
  check('生成第 1 周周报', win.Game.state.reports.length === 1, win.Game.state.reports.length);
  click('[data-tab="report"]');
  check('周报列表渲染', page().indexOf('第 1 周复盘') >= 0);

  console.log('\n=== 持久化 ===');
  check('localStorage 写入成功', !!win.localStorage.getItem('stocksim.state.v1'));

  console.log('\n=== 控制台 ===');
  check('无 JS 异常', errors.length === 0, errors.join(' | '));

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  dom.window.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n验证失败:', e.message);
  console.error('请确认已启动服务：python tools/serve.py --port 8321');
  process.exit(1);
});
