/* =============================================================================
 * main.js —— 启动引导
 * ========================================================================== */
(function (global) {
  'use strict';

  function welcomeHtml() {
    const meta = global.Market.data.meta;
    return `
    <div class="card">
      <div class="card-title">欢迎来到股海练兵 👋</div>
      <div class="kv-list">
        <div class="kv"><span class="k">初始本金</span><span class="v mono bold">100,000.00 元</span></div>
        <div class="kv"><span class="k">行情标的</span><span class="v mono">${meta.stockCount} 只 A 股 + ${meta.benchmark.name}</span></div>
        <div class="kv"><span class="k">回放区间</span><span class="v mono">${meta.startDate} ~ ${meta.endDate}</span></div>
        <div class="kv"><span class="k">交易日数</span><span class="v mono">${meta.tradingDays} 天（前复权真实日线）</span></div>
        <div class="kv"><span class="k">起始段位</span><span class="v">🥉 倔强青铜Ⅲ 0 星</span></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">三条核心规则</div>
      <div class="kp"><b>真实数据回放</b>：日线开高低收全部为真实历史行情；日内分时路径由确定性算法生成并锚定真实 OHLC。</div>
      <div class="kp"><b>每周自动复盘</b>：每 5 个交易日生成一份周报，含收益归因（β/α/择时）、行为诊断与下周建议。</div>
      <div class="kp"><b>段位升降</b>：跑赢沪深300 即排位胜利加星，跑输扣星；勇者积分可抵扣掉星。</div>
    </div>
    <div class="card">
      <div class="card-title">怎么开始</div>
      <div class="kp">1. 点「▶ 播放」推进行情，或用「下一日 / 下一周」快速推进</div>
      <div class="kp">2. 到「行情」页选股 → 查看真实风险特征（β / 波动率 / 最大回撤）→ 买入</div>
      <div class="kp">3. 每 5 个交易日后到「周报」页看归因与诊断，到「学院」页完成必修课</div>
    </div>
    <button class="btn primary block lg" data-act="close-modal">开始模拟交易</button>
    <div class="hint" style="margin-top:10px;text-align:center">进度自动保存在本地浏览器，刷新不丢失</div>`;
  }

  function boot() {
    const data = global.MARKET_DATA;
    if (!data) {
      document.getElementById('page').innerHTML =
        '<div class="card"><div class="empty"><div class="ico">⚠️</div><div class="t">行情数据未加载</div>' +
        '<div class="s">请确认 app/data/market-data.js 存在且已加载</div></div></div>';
      return;
    }

    const saved = global.Store.load();
    global.Game.init(data, saved);

    document.querySelectorAll('#tabbar button').forEach((b) => {
      b.addEventListener('click', () => global.UI.setTab(b.dataset.tab));
    });

    global.Game.on('update', () => global.UI.render());
    global.Game.on('playState', () => global.UI.render());
    global.Game.on('exhausted', () => global.UI.toast('行情已回放至最后一个交易日'));
    global.Game.on('weekSettled', (r) => {
      const win = r.rank && r.rank.win;
      global.UI.toast(`第 ${r.weekIndex} 周复盘已生成 · ${win ? '排位胜利' : '排位失败'} · 周收益 ${r.retPct >= 0 ? '+' : ''}${r.retPct.toFixed(2)}%`);
    });

    global.UI.setTab('home');

    if (!saved) {
      document.getElementById('modal-root').innerHTML = `
        <div class="modal-mask">
          <div class="modal-panel" data-stop="1">
            <div class="modal-head"><div class="t">股海练兵 · 使用说明</div></div>
            <div class="modal-body">${welcomeHtml()}</div>
          </div>
        </div>`;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
