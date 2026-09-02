/* =============================================================================
 * ui.js —— 视图层（小程序风格页面渲染 + 事件委托）
 * -----------------------------------------------------------------------------
 * 全部视图为纯字符串渲染 + 事件委托，无框架依赖。
 * 自动播放时只刷新无输入框的页面，交易页做局部更新，避免打断输入。
 * ========================================================================== */
(function (global) {
  'use strict';

  const UI = {
    tab: 'home',
    market: { sector: '全部', sort: 'pct', kw: '', asc: false },
    trade: { tab: 'buy', code: '', qty: 0, sellCode: '', sellQty: 0 },
    detail: { code: null, chart: 'intraday' },
    reportIdx: -1,
    quiz: { id: null, pick: -1, checked: false },
    _lastRender: 0,
  };

  /* =====================================================================
   * 工具
   * =================================================================== */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  function money(n, d) {
    const dd = d === undefined ? 2 : d;
    if (n === null || n === undefined || isNaN(n)) return '--';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: dd, maximumFractionDigits: dd });
  }
  function pctStr(v, d) { const s = (v > 0 ? '+' : '') + Number(v).toFixed(d === undefined ? 2 : d); return s + '%'; }
  function cls(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
  function col(v) { return v > 0 ? 'var(--up)' : (v < 0 ? 'var(--down)' : 'var(--text-2)'); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function badge(v) { return `<span class="badge ${v > 0 ? 'up' : (v < 0 ? 'down' : 'flat')}">${pctStr(v)}</span>`; }

  UI.money = money;

  function toast(msg) {
    const root = $('#toast-root');
    root.innerHTML = `<div class="toast">${esc(msg)}</div>`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { root.innerHTML = ''; }, 2400);
  }
  UI.toast = toast;

  function openModal(title, bodyHtml) {
    $('#modal-root').innerHTML = `
      <div class="modal-mask" data-act="close-modal">
        <div class="modal-panel" data-stop="1">
          <div class="modal-head">
            <div class="t">${title}</div>
            <button class="x" data-act="close-modal">✕</button>
          </div>
          <div class="modal-body">${bodyHtml}</div>
        </div>
      </div>`;
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  UI.closeModal = closeModal;

  /* =====================================================================
   * 顶部导航
   * =================================================================== */
  function renderNav() {
    const M = global.Market;
    const s = global.Game.summary();
    const t = M.tick;
    const T = M.TICKS_PER_DAY;
    // tick -> 时间：0..11 对应 09:30-11:30（每 10 分钟），12..23 对应 13:00-15:00
    let hh, mm;
    if (t < 12) { const m = 9 * 60 + 30 + t * 10; hh = Math.floor(m / 60); mm = m % 60; }
    else { const m = 13 * 60 + (t - 12) * 10; hh = Math.floor(m / 60); mm = m % 60; }
    const timeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    $('#nav-date').textContent = s.date;
    $('#nav-tick').innerHTML = `${timeStr} · 第 ${s.dayIndex + 1}/${s.totalDays} 交易日`;
  }

  /* =====================================================================
   * 首页
   * =================================================================== */
  function renderHome() {
    const G = global.Game, M = global.Market, A = global.Account, R = global.Rank;
    const s = G.summary();
    const v = A.valuation();
    const rank = G.state.rank;
    const rd = R.display(rank);
    const curve = A.equityCurve(120);

    const posHtml = v.positions.length ? v.positions.slice(0, 3).map((p) => `
      <div class="list-item" data-act="stock" data-code="${p.code}">
        <div class="li-main">
          <div class="li-title">${esc(p.name)} <span class="tag">${p.qty}股</span></div>
          <div class="li-sub">成本 ${money(p.cost)} · 现价 ${money(p.price)}</div>
        </div>
        <div class="li-right">
          <div class="li-price mono" style="color:${col(p.pnlPct)}">${pctStr(p.pnlPct)}</div>
          <div class="li-pct mono" style="color:${col(p.pnl)}">${p.pnl >= 0 ? '+' : ''}${money(p.pnl, 0)}</div>
        </div>
      </div>`).join('')
      : `<div class="empty" style="padding:22px 0"><div class="ico">📭</div><div class="t">当前空仓</div><div class="s">到「行情」页选股，或直接去「交易」页买入</div></div>`;

    // 本周进度
    const anchor = G.state.weekAnchor;
    const doneDays = M.dayIdx - anchor.dayIdx;
    const weekNo = G.state.reports.length + 1;

    return `
    <div class="card">
      <div class="equity-hero">
        <div class="label">总资产（元）</div>
        <div class="value mono">${money(s.equity)}</div>
        <div class="pnl ${cls(s.totalPnl)}">累计 ${s.totalPnl >= 0 ? '+' : ''}${money(s.totalPnl)}（${pctStr(s.totalPnlPct)}） · 今日 <span class="${cls(s.dayPnl)}">${s.dayPnl >= 0 ? '+' : ''}${money(s.dayPnl)}</span></div>
      </div>
      <div class="stat-grid">
        <div class="stat-item"><div class="k">持仓市值</div><div class="v mono">${money(s.positionValue, 0)}</div></div>
        <div class="stat-item"><div class="k">可用资金</div><div class="v mono">${money(s.cash, 0)}</div></div>
        <div class="stat-item"><div class="k">仓位</div><div class="v mono">${s.positionWeight.toFixed(1)}%</div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">账户净值 vs ${M.data.meta.benchmark.name}
        <span class="sub">超额 <b class="${cls(s.excessPct)}">${pctStr(s.excessPct)}</b></span>
      </div>
      ${global.Chart.equityCurve(curve)}
    </div>

    <div class="card rank-card">
      <div class="rank-head">
        <div class="rank-badge" style="background:${rd.color}1a;border:2px solid ${rd.color}">${rd.icon}</div>
        <div class="f1">
          <div class="rank-name" style="color:${rd.color}">${rd.full}</div>
          <div class="rank-sub">${rd.starsText} · 胜 ${rank.wins} 负 ${rank.losses} · MVP ${rank.mvp} 次</div>
        </div>
        <div style="text-align:right">
          <div class="tiny muted">勇者积分</div>
          <div class="bold mono">${rank.brave}</div>
        </div>
      </div>
      ${global.Chart.rankProgress(rank)}
      <div class="brave-bar"><div class="brave-fill" style="width:${Math.min(100, rank.brave / 120 * 100).toFixed(0)}%"></div></div>
      <div class="tiny muted" style="margin-top:4px">积分达 60 可在失败时自动抵扣一次掉星（保星）</div>
      ${rank.winStreak >= 2 ? `<div class="tag warn" style="margin-top:6px">🔥 ${rank.winStreak} 连胜中</div>` : ''}
    </div>

    <div class="card">
      <div class="card-title">行情时钟
        <span class="sub">${s.date}</span>
      </div>
      <div class="clock-bar">
        <button class="btn ${G.state.settings.autoPlay ? '' : 'primary'}" data-act="play">
          ${G.state.settings.autoPlay ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button class="btn" data-act="skip-day">⇥ 下一日</button>
        <button class="btn" data-act="skip-week">⇥⇥ 下一周</button>
        <button class="btn" data-act="settle">📋 立即复盘</button>
      </div>
      <div class="clock-bar" style="margin-top:8px">
        ${G.SPEEDS.map((sp, i) => `<button class="btn sm ${G.state.settings.speed === i ? 'on' : ''}" data-act="speed" data-i="${i}">${sp.label}</button>`).join('')}
      </div>
      <div class="progress-thin"><div style="width:${s.progress.toFixed(2)}%"></div></div>
      <div class="kv-list" style="margin-top:10px">
        <div class="kv"><span class="k">${M.data.meta.benchmark.name}</span><span class="v mono ${cls((s.benchValue / M.data.benchmark[G.state.account.startDayIdx] - 1) * 100)}">${money(s.benchValue)}（${pctStr(s.benchPct)}）</span></div>
        <div class="kv"><span class="k">回放进度</span><span class="v mono">第 ${s.dayIndex + 1} / ${s.totalDays} 交易日（${s.progress.toFixed(1)}%）</span></div>
        <div class="kv"><span class="k">本周进度</span><span class="v mono">第 ${weekNo} 周：${doneDays} / 5 个交易日</span></div>
        <div class="kv"><span class="k">历史最大回撤</span><span class="v mono down">${s.maxDrawdown.toFixed(2)}%</span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">持仓速览
        <span class="sub">共 ${v.positions.length} 只</span>
      </div>
      <div class="list">${posHtml}</div>
    </div>

    <div class="card">
      <div class="card-title">数据说明</div>
      <div class="hint">
        日线行情为真实 A 股历史数据（前复权，${M.data.meta.startDate} ~ ${M.data.meta.endDate}，共 ${M.data.meta.tradingDays} 个交易日，${M.data.meta.stockCount} 只标的）。
        日内分时路径由确定性算法生成，并严格锚定于真实的开 / 高 / 低 / 收四个价位。
      </div>
    </div>`;
  }

  /* =====================================================================
   * 行情页
   * =================================================================== */
  function renderMarket() {
    const M = global.Market;
    const f = UI.market;
    const sectors = ['全部'].concat(Array.from(new Set(M.stocks().map((s) => s.sector))));

    let list = M.snapshot().filter((q) => q.listed);
    if (f.sector !== '全部') list = list.filter((q) => q.sector === f.sector);
    if (f.kw) {
      const k = f.kw.trim().toLowerCase();
      list = list.filter((q) => q.name.toLowerCase().indexOf(k) >= 0 || q.code.indexOf(k) >= 0);
    }
    const sorters = {
      pct: (a, b) => b.pct - a.pct,
      price: (a, b) => b.price - a.price,
      vol: (a, b) => (b.stats.annVol || 0) - (a.stats.annVol || 0),
      beta: (a, b) => (b.stats.beta || 0) - (a.stats.beta || 0),
      turn: (a, b) => b.turnover - a.turnover,
    };
    list.sort(sorters[f.sort] || sorters.pct);
    if (f.asc) list.reverse();

    const sortChips = [
      ['pct', '涨跌幅'], ['price', '价格'], ['vol', '年化波动'], ['beta', 'β'], ['turn', '换手'],
    ];

    return `
    <div class="card">
      <input class="input" placeholder="搜索股票名称或代码" value="${esc(f.kw)}" data-input="kw">
      <div class="chips" style="margin-top:9px">
        ${sectors.map((s) => `<div class="chip ${f.sector === s ? 'on' : ''}" data-act="sector" data-s="${esc(s)}">${esc(s)}</div>`).join('')}
      </div>
      <div class="chips" style="margin-top:6px">
        ${sortChips.map(([k, t]) => `<div class="chip ${f.sort === k ? 'on' : ''}" data-act="sort" data-by="${k}">${t}${f.sort === k ? (f.asc ? ' ↑' : ' ↓') : ''}</div>`).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-title">行情列表 <span class="sub">${list.length} 只 · 点击查看详情与交易</span></div>
      <div class="list">
        ${list.map((q) => {
      const held = global.Account.position(q.code);
      return `
        <div class="list-item" data-act="stock" data-code="${q.code}">
          <div class="li-main">
            <div class="li-title">${esc(q.name)}
              <span class="tag board">${esc(q.board)}</span>
              ${held && held.qty > 0 ? '<span class="tag ok">持仓</span>' : ''}
              ${q.suspended ? '<span class="tag stop">停牌</span>' : ''}
            </div>
            <div class="li-sub">${q.code} · ${esc(q.sector)} · β ${q.stats.beta} · 波动 ${q.stats.annVol}%</div>
          </div>
          <div class="li-right">
            <div class="li-price mono" style="color:${col(q.pct)}">${money(q.price)}</div>
            ${q.suspended ? '<div class="li-pct muted">停牌</div>' : badge(q.pct)}
          </div>
        </div>`;
    }).join('')}
      </div>
    </div>`;
  }

  /* =====================================================================
   * 交易页
   * =================================================================== */
  function renderTrade() {
    const A = global.Account, M = global.Market;
    const t = UI.trade;
    const v = A.valuation();

    const tabs = [['buy', '买入'], ['sell', '卖出'], ['hold', '持仓'], ['log', '成交']];
    let body = '';

    if (t.tab === 'buy') {
      const q = t.code ? M.quote(t.code) : null;
      const qty = t.qty || 0;
      const amount = q && qty ? qty * q.price : 0;
      const fee = amount ? A.buyFees(amount) : { commission: 0, transfer: 0, total: 0 };
      const total = amount + (fee.total || 0);
      const options = M.stocks().filter((s) => M.isTradable(s.code)).map((s) => {
        const qq = M.quote(s.code);
        return `<option value="${s.code}" ${t.code === s.code ? 'selected' : ''}>${s.code} ${s.name} ¥${money(qq.price)}</option>`;
      }).join('');

      body = `
      <div class="card">
        <div class="field">
          <div class="field-label">选择标的</div>
          <select class="select" data-input="buy-code">
            <option value="">-- 请选择 --</option>
            ${options}
          </select>
        </div>
        ${q ? `
        <div class="kv-list">
          <div class="kv"><span class="k">现价</span><span class="v mono bold" style="color:${col(q.pct)}" id="buy-price">${money(q.price)}</span> <span class="${cls(q.pct)}">${pctStr(q.pct)}</span></div>
          <div class="kv"><span class="k">今开 / 昨收</span><span class="v mono">${money(q.open)} / ${money(q.prevClose)}</span></div>
          <div class="kv"><span class="k">涨停 / 跌停</span><span class="v mono"><span class="up">${money(q.limitUp)}</span> / <span class="down">${money(q.limitDown)}</span></span></div>
          <div class="kv"><span class="k">板块 / β</span><span class="v">${esc(q.board)} · ${esc(q.sector)} · β ${q.stats.beta}</span></div>
        </div>
        <div class="divider"></div>
        <div class="field">
          <div class="field-label">买入数量（股，100 的整数倍）</div>
          <input class="input mono" type="number" inputmode="numeric" value="${qty || ''}" placeholder="0" data-input="buy-qty">
          <div class="qty-row">
            <button class="btn sm" data-act="qty-set" data-v="100">100</button>
            <button class="btn sm" data-act="qty-set" data-v="500">500</button>
            <button class="btn sm" data-act="qty-frac" data-f="0.25">1/4仓</button>
            <button class="btn sm" data-act="qty-frac" data-f="0.5">1/2仓</button>
            <button class="btn sm" data-act="qty-frac" data-f="1">全仓</button>
          </div>
        </div>
        <div class="kv-list">
          <div class="kv"><span class="k">成交金额</span><span class="v mono">${money(amount)}</span></div>
          <div class="kv"><span class="k">佣金</span><span class="v mono">${money(fee.commission)}</span></div>
          <div class="kv"><span class="k">过户费</span><span class="v mono">${money(fee.transfer)}</span></div>
          <div class="kv"><span class="k">合计支出</span><span class="v mono bold">${money(total)}</span></div>
          <div class="kv"><span class="k">可用资金</span><span class="v mono">${money(v.cash)}</span></div>
          <div class="kv"><span class="k">买入后现金</span><span class="v mono ${total > v.cash ? 'down' : ''}">${money(v.cash - total)}</span></div>
          <div class="kv"><span class="k">1 手（100股）需</span><span class="v mono ${q.price * 100 > v.cash ? 'down' : ''}">${money(q.price * 100)}</span></div>
        </div>
        ${A.maxBuyQty(q.price, v.cash) === 0 ? '<div class="hint" style="margin-top:8px;color:var(--up)">可用资金不足 1 手。这是真实 A 股的整手交易约束——资金规模决定了可选标的范围，可选择价格更低的标的。</div>' : ''}
        <div style="margin-top:12px">
          <button class="btn primary block lg" data-act="do-buy" ${(!qty || qty % 100 || total > v.cash) ? 'disabled' : ''}>确认买入</button>
        </div>
        <div class="hint" style="margin-top:8px">T+1 规则：当日买入的股票当日不可卖出。费率：佣金 0.025%（最低 5 元）+ 过户费 0.001%，买入无印花税。</div>
        ` : `<div class="empty" style="padding:26px 0"><div class="ico">🔍</div><div class="t">请先选择标的</div></div>`}
      </div>`;
    }

    if (t.tab === 'sell') {
      const allPos = A.positionList();
      const posList = allPos.filter((p) => p.avail > 0);
      const p = t.sellCode ? posList.find((x) => x.code === t.sellCode) : null;
      const qty = t.sellQty || 0;
      const q = p ? M.quote(p.code) : null;
      const amount = q && qty ? qty * q.price : 0;
      const fee = amount ? A.sellFees(amount) : { commission: 0, stamp: 0, transfer: 0, total: 0 };
      const proceeds = amount - (fee.total || 0);
      const realized = q && qty ? (q.price - (p ? p.cost : 0)) * qty - (fee.total || 0) : 0;

      body = `
      <div class="card">
        ${posList.length ? `
        <div class="field">
          <div class="field-label">选择持仓</div>
          <select class="select" data-input="sell-code">
            <option value="">-- 请选择 --</option>
            ${posList.map((pp) => `<option value="${pp.code}" ${t.sellCode === pp.code ? 'selected' : ''}>${pp.code} ${pp.name} 可卖${pp.avail}股 成本${money(pp.cost)}</option>`).join('')}
          </select>
        </div>
        ${p ? `
        <div class="kv-list">
          <div class="kv"><span class="k">持仓 / 可卖</span><span class="v mono">${p.qty} / ${p.avail} 股</span></div>
          <div class="kv"><span class="k">成本价</span><span class="v mono">${money(p.cost)}</span></div>
          <div class="kv"><span class="k">现价</span><span class="v mono bold" style="color:${col(q.pct)}">${money(q.price)} <span class="${cls(p.pnlPct)}">${pctStr(p.pnlPct)}</span></span></div>
        </div>
        <div class="divider"></div>
        <div class="field">
          <div class="field-label">卖出数量（股）</div>
          <input class="input mono" type="number" inputmode="numeric" value="${qty || ''}" placeholder="0" data-input="sell-qty">
          <div class="qty-row">
            <button class="btn sm" data-act="sell-frac" data-f="0.5">卖一半</button>
            <button class="btn sm" data-act="sell-frac" data-f="1">全部卖出</button>
          </div>
        </div>
        <div class="kv-list">
          <div class="kv"><span class="k">成交金额</span><span class="v mono">${money(amount)}</span></div>
          <div class="kv"><span class="k">印花税(0.05%)</span><span class="v mono">${money(fee.stamp)}</span></div>
          <div class="kv"><span class="k">佣金 + 过户费</span><span class="v mono">${money(fee.commission + fee.transfer)}</span></div>
          <div class="kv"><span class="k">实际到账</span><span class="v mono bold">${money(proceeds)}</span></div>
          <div class="kv"><span class="k">预计实现盈亏</span><span class="v mono bold" style="color:${col(realized)}">${realized >= 0 ? '+' : ''}${money(realized)}</span></div>
        </div>
        <div style="margin-top:12px">
          <button class="btn success block lg" data-act="do-sell" ${(!qty || qty > p.avail) ? 'disabled' : ''}>确认卖出</button>
        </div>
        <div class="hint" style="margin-top:8px">T+1 规则：当日买入的股票当日不可卖出（可卖数量已自动扣除）。</div>
        ` : `<div class="empty" style="padding:26px 0"><div class="ico">🔍</div><div class="t">请选择要卖出的持仓</div></div>`}
        ` : (allPos.length ? `<div class="empty" style="padding:26px 0">
             <div class="ico">🔒</div>
             <div class="t">持仓全部处于 T+1 锁定中</div>
             <div class="s">当日买入的股票当日不可卖出，下一交易日开盘后自动解锁（当前 ${allPos.length} 只持仓共 ${allPos.reduce((s, x) => s + x.qty, 0)} 股）</div>
           </div>`
          : `<div class="empty"><div class="ico">📭</div><div class="t">当前无持仓</div><div class="s">先去买入股票吧</div></div>`)}
      </div>`;
    }

    if (t.tab === 'hold') {
      const list = A.positionList();
      body = `
      <div class="card">
        <div class="card-title">当前持仓 <span class="sub">市值 ${money(v.positionValue)} · 占比 ${(v.positionWeight * 100).toFixed(1)}%</span></div>
        ${list.length ? `<div class="list">${list.map((p) => `
          <div class="list-item" data-act="stock" data-code="${p.code}">
            <div class="li-main">
              <div class="li-title">${esc(p.name)} <span class="tag">${p.qty}股 / 可卖${p.avail}</span></div>
              <div class="li-sub">成本 ${money(p.cost)} · 现价 ${money(p.price)} · 市值 ${money(p.marketValue, 0)}</div>
            </div>
            <div class="li-right">
              <div class="li-price mono" style="color:${col(p.pnlPct)}">${pctStr(p.pnlPct)}</div>
              <div class="li-pct mono" style="color:${col(p.pnl)}">${p.pnl >= 0 ? '+' : ''}${money(p.pnl, 0)}</div>
            </div>
          </div>`).join('')}</div>`
          : `<div class="empty" style="padding:26px 0"><div class="ico">📭</div><div class="t">当前空仓</div></div>`}
      </div>
      ${list.length ? `<div class="card">
        <div class="card-title">行业分布</div>
        ${sectorBars(list, v.equity)}
      </div>` : ''}`;
    }

    if (t.tab === 'log') {
      const trades = A.state.trades.slice().reverse().slice(0, 120);
      body = `
      <div class="card">
        <div class="card-title">成交记录 <span class="sub">累计 ${A.state.trades.length} 笔 · 费用 ${money(A.state.totalFee)}</span></div>
        ${trades.length ? `
        <table class="mini">
          <thead><tr><th>日期</th><th>标的</th><th>方向</th><th class="num">价格</th><th class="num">数量</th><th class="num">费用</th><th class="num">实现盈亏</th></tr></thead>
          <tbody>
          ${trades.map((t) => `
            <tr>
              <td class="tiny muted">${t.date.slice(5)}</td>
              <td>${esc(t.name)}</td>
              <td><span class="tag ${t.side === 'buy' ? 'warn' : 'ok'}">${t.side === 'buy' ? '买入' : '卖出'}</span></td>
              <td class="num mono">${money(t.price)}</td>
              <td class="num mono">${t.qty}</td>
              <td class="num mono muted">${money(t.fee)}</td>
              <td class="num mono" style="color:${t.side === 'sell' ? col(t.realized) : 'var(--muted)'}">${t.side === 'sell' ? (t.realized >= 0 ? '+' : '') + money(t.realized) : '--'}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<div class="empty" style="padding:26px 0"><div class="ico">📝</div><div class="t">暂无成交记录</div></div>`}
      </div>`;
    }

    return `
    <div class="card" style="padding:6px">
      <div class="seg">
        ${tabs.map(([k, label]) => `<button class="${t.tab === k ? 'on' : ''}" data-act="trade-tab" data-t="${k}">${label}</button>`).join('')}
      </div>
    </div>
    ${body}`;
  }

  function sectorBars(list, equity) {
    const sw = {};
    list.forEach((p) => { sw[p.sector] = (sw[p.sector] || 0) + p.marketValue; });
    const items = Object.keys(sw).map((k) => ({ label: k, value: (sw[k] / equity) * 100 })).sort((a, b) => b.value - a.value);
    return global.Chart.attributionBars(items.map((x) => ({ label: x.label, value: x.value })));
  }

  /* =====================================================================
   * 周报页
   * =================================================================== */
  function renderReport() {
    const G = global.Game;
    const reports = G.state.reports;
    if (!reports.length) {
      const done = global.Market.dayIdx - G.state.weekAnchor.dayIdx;
      return `
      <div class="card">
        <div class="empty">
          <div class="ico">📋</div>
          <div class="t">还没有周报</div>
          <div class="s">每完成 5 个交易日会自动生成一份复盘周报<br>当前本周已进行 ${done} / 5 个交易日</div>
        </div>
        <div style="margin-top:6px">
          <button class="btn primary block" data-act="settle" ${done <= 0 ? 'disabled' : ''}>立即生成本周复盘</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">周报包含什么</div>
        <div class="kp">本周操作明细：每一笔买入 / 卖出的价格、数量、费用与实现盈亏</div>
        <div class="kp">持仓变动：新增 / 清仓 / 加仓 / 减仓 与期末权重</div>
        <div class="kp">收益归因：把周收益率拆成 市场 β + 选股 α + 交易择时 + 残差</div>
        <div class="kp">行为诊断：13 条量化规则，给出证据、影响与改进动作</div>
        <div class="kp">段位结算：按跑赢/跑输基准升降星，并计入勇者积分保护</div>
      </div>`;
    }

    return reports.map((r, i) => `
      <div class="card wk-card" data-act="report" data-i="${i}">
        <div class="wk-head">
          <div>
            <div class="wk-title">第 ${r.weekIndex} 周复盘</div>
            <div class="wk-date">${r.startDate} ~ ${r.endDate}（${r.tradingDays} 个交易日）</div>
          </div>
          <div>
            <div class="wk-ret mono" style="color:${col(r.retPct)}">${pctStr(r.retPct)}</div>
            <div class="tiny muted right">超额 <span class="${cls(r.excessPct)}">${pctStr(r.excessPct)}</span></div>
          </div>
        </div>
        <div class="kv-list" style="margin-top:9px">
          <div class="kv"><span class="k">期末资产</span><span class="v mono">${money(r.endEquity)}</span></div>
          <div class="kv"><span class="k">基准同期</span><span class="v mono ${cls(r.benchPct)}">${pctStr(r.benchPct)}</span></div>
          <div class="kv"><span class="k">归因拆解</span><span class="v mono tiny">β ${pctStr(r.attribution.market)} · α ${pctStr(r.attribution.selection)} · 交易 ${pctStr(r.attribution.trading)}</span></div>
        </div>
        <div class="wk-tags">
          ${r.rank ? `<span class="tag ${r.rank.win ? 'ok' : 'stop'}">${r.rank.win ? '排位胜利' : '排位失败'} ${r.rank.delta >= 0 ? '+' : ''}${r.rank.delta}★</span>` : ''}
          <span class="tag">${r.tradeCount} 笔交易</span>
          <span class="tag">费用 ${money(r.weekFee)}</span>
          ${r.diagnostics.length ? `<span class="tag warn">${r.diagnostics.length} 项待改进</span>` : '<span class="tag ok">纪律良好</span>'}
        </div>
      </div>`).join('');
  }

  function renderReportDetail(r) {
    const C = global.Chart;
    const attr = r.attribution;

    const attrItems = [
      { label: '市场 β', value: attr.market },
      { label: '选股 α', value: attr.selection },
      { label: '交易择时', value: attr.trading },
      { label: '归因残差', value: attr.residual },
    ];

    const tradeTable = r.trades.length ? `
      <table class="mini">
        <thead><tr><th>日期</th><th>标的</th><th>方向</th><th class="num">价格</th><th class="num">数量</th><th class="num">当日涨跌</th><th class="num">费用</th><th class="num">实现盈亏</th></tr></thead>
        <tbody>
        ${r.trades.map((t) => `
          <tr>
            <td class="tiny muted">${t.date.slice(5)}</td>
            <td>${esc(t.name)}</td>
            <td><span class="tag ${t.side === 'buy' ? 'warn' : 'ok'}">${t.side === 'buy' ? '买入' : '卖出'}</span></td>
            <td class="num mono">${money(t.price)}</td>
            <td class="num mono">${t.qty}</td>
            <td class="num mono ${cls(t.dayPct)}">${pctStr(t.dayPct)}</td>
            <td class="num mono muted">${money(t.fee)}</td>
            <td class="num mono" style="color:${t.side === 'sell' ? col(t.realized) : 'var(--muted)'}">${t.side === 'sell' ? (t.realized >= 0 ? '+' : '') + money(t.realized) : '--'}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="hint">本周没有发生任何交易。</div>`;

    const chgLabel = { new: '新建仓', clear: '清仓', add: '加仓', reduce: '减仓', hold: '持有不动' };
    const chgTag = { new: 'ok', clear: 'stop', add: 'ok', reduce: 'warn', hold: '' };
    const posTable = r.positionChanges.length ? `
      <table class="mini">
        <thead><tr><th>标的</th><th>变动</th><th class="num">期初</th><th class="num">期末</th><th class="num">区间涨跌</th><th class="num">期末权重</th></tr></thead>
        <tbody>
        ${r.positionChanges.map((p) => `
          <tr>
            <td>${esc(p.name)}<div class="tiny muted">${esc(p.sector)}</div></td>
            <td><span class="tag ${chgTag[p.change]}">${chgLabel[p.change]}</span></td>
            <td class="num mono">${p.qtyStart}</td>
            <td class="num mono">${p.qtyEnd}</td>
            <td class="num mono ${cls(p.retPct)}">${pctStr(p.retPct)}</td>
            <td class="num mono">${p.weightEnd.toFixed(2)}%</td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="hint">本周无持仓。</div>`;

    const holdTable = r.holdings.length ? `
      <table class="mini">
        <thead><tr><th>标的</th><th class="num">成本</th><th class="num">现价</th><th class="num">盈亏</th><th class="num">权重</th><th class="num">持有</th></tr></thead>
        <tbody>
        ${r.holdings.map((h) => `
          <tr>
            <td>${esc(h.name)}</td>
            <td class="num mono">${money(h.cost)}</td>
            <td class="num mono">${money(h.price)}</td>
            <td class="num mono ${cls(h.pnlPct)}">${pctStr(h.pnlPct)}</td>
            <td class="num mono">${h.weight.toFixed(2)}%</td>
            <td class="num mono muted">${h.holdDays}日</td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="hint">期末空仓。</div>`;

    const sevLabel = { high: '严重', mid: '中等', low: '轻微' };

    return `
    <div class="card">
      <div class="card-title">第 ${r.weekIndex} 周复盘
        <span class="sub">${r.startDate} ~ ${r.endDate}</span>
      </div>
      <div class="stat-grid">
        <div class="stat-item"><div class="k">周收益率</div><div class="v mono" style="color:${col(r.retPct)}">${pctStr(r.retPct)}</div></div>
        <div class="stat-item"><div class="k">基准同期</div><div class="v mono" style="color:${col(r.benchPct)}">${pctStr(r.benchPct)}</div></div>
        <div class="stat-item"><div class="k">超额收益</div><div class="v mono" style="color:${col(r.excessPct)}">${pctStr(r.excessPct)}</div></div>
      </div>
      <div class="divider"></div>
      <div class="kv-list">
        <div class="kv"><span class="k">期初 / 期末资产</span><span class="v mono">${money(r.startEquity)} → ${money(r.endEquity)}</span></div>
        <div class="kv"><span class="k">本周最大回撤</span><span class="v mono down">${r.weekMaxDD.toFixed(2)}%</span></div>
        <div class="kv"><span class="k">期末仓位 / 现金</span><span class="v mono">${r.positionWeight.toFixed(1)}% / ${r.cashWeight.toFixed(1)}%</span></div>
        <div class="kv"><span class="k">最大单一持仓</span><span class="v mono ${r.topWeight > 40 ? 'down' : ''}">${r.topWeight.toFixed(2)}%</span></div>
        <div class="kv"><span class="k">最大单一行业</span><span class="v mono ${r.topSectorWeight > 60 ? 'down' : ''}">${esc(r.topSector || '--')} ${r.topSectorWeight.toFixed(2)}%</span></div>
        <div class="kv"><span class="k">交易笔数 / 费用</span><span class="v mono">${r.tradeCount} 笔 · ${money(r.weekFee)}（${r.feeRatePct.toFixed(3)}%）</span></div>
        <div class="kv"><span class="k">已实现盈亏</span><span class="v mono" style="color:${col(r.weekRealized)}">${r.weekRealized >= 0 ? '+' : ''}${money(r.weekRealized)}</span></div>
        <div class="kv"><span class="k">累计收益 / 基准</span><span class="v mono"><span class="${cls(r.cumRetPct)}">${pctStr(r.cumRetPct)}</span> / <span class="${cls(r.cumBenchPct)}">${pctStr(r.cumBenchPct)}</span></span></div>
      </div>
    </div>

    ${r.rank ? `
    <div class="card rank-card">
      <div class="card-title">段位结算</div>
      <div class="kv-list">
        <div class="kv"><span class="k">本周结果</span><span class="v"><span class="tag ${r.rank.win ? 'ok' : 'stop'}">${r.rank.win ? '胜利' : '失败'}</span> ${r.rank.mvp ? '<span class="tag warn">MVP</span>' : ''} ${r.rank.protectedByBrave ? '<span class="tag board">勇者积分保星</span>' : ''}</span></div>
        <div class="kv"><span class="k">段位变化</span><span class="v">${esc(r.rank.before)} → <b>${esc(r.rank.after)}</b></span></div>
        <div class="kv"><span class="k">综合表现分</span><span class="v mono bold">${r.rank.perf} / 100</span></div>
        <div class="kv"><span class="k">结算依据</span><span class="v small">${r.rank.reasons.map(esc).join('<br>')}</span></div>
      </div>
    </div>` : ''}

    <div class="section">
      <div class="section-title">一、收益归因（可加总核对）</div>
      <div class="card">
        ${C.attributionBars(attrItems)}
        <div class="divider"></div>
        <div class="kv-list">
          <div class="kv"><span class="k">期初股票仓位 W₀</span><span class="v mono">${attr.W0.toFixed(2)}%</span></div>
          <div class="kv"><span class="k">交易毛贡献</span><span class="v mono" style="color:${col(attr.tradeGross)}">${pctStr(attr.tradeGross)}</span></div>
          <div class="kv"><span class="k">费用拖累</span><span class="v mono down">${attr.fee.toFixed(3)}%</span></div>
          <div class="kv"><span class="k">现金机会成本（参考）</span><span class="v mono muted">${pctStr(attr.cashDrag)}（平均现金 ${attr.avgCashWeight.toFixed(1)}%，不进入加总）</span></div>
        </div>
        <div class="hint" style="margin-top:8px">
          口径：市场β = W₀ × 基准周涨跌；选股α = Σ w₀×(rᵢ − r_bench)；交易 = Σ买 权重×(P末/P买−1) − Σ卖 权重×(P末/P卖−1) − 费用率。三项加残差应等于实际周收益率 ${pctStr(r.retPct)}。
        </div>
      </div>
    </div>

    ${attr.holdings.length ? `
    <div class="section">
      <div class="section-title">持仓个股贡献分解</div>
      <div class="card">
        <table class="mini">
          <thead><tr><th>标的</th><th class="num">期初权重</th><th class="num">区间涨跌</th><th class="num">vs 基准</th><th class="num">贡献</th></tr></thead>
          <tbody>
          ${attr.holdings.map((h) => `
            <tr>
              <td>${esc(h.name)}</td>
              <td class="num mono">${h.weight.toFixed(2)}%</td>
              <td class="num mono ${cls(h.ret)}">${pctStr(h.ret)}</td>
              <td class="num mono ${cls(h.excess)}">${pctStr(h.excess)}</td>
              <td class="num mono" style="color:${col(h.contribution)}">${pctStr(h.contribution)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    ${attr.items.length ? `
    <div class="section">
      <div class="section-title">交易逐笔贡献</div>
      <div class="card">
        <table class="mini">
          <thead><tr><th>日期/方向</th><th>标的</th><th class="num">成交价</th><th class="num">权重</th><th class="num">至周末</th><th class="num">贡献</th></tr></thead>
          <tbody>
          ${attr.items.map((it) => `
            <tr>
              <td class="tiny">${it.date.slice(5)}<br><span class="tag ${it.side === 'buy' ? 'warn' : 'ok'}">${it.side === 'buy' ? '买' : '卖'}</span></td>
              <td>${esc(it.name)}</td>
              <td class="num mono">${money(it.price)}</td>
              <td class="num mono">${it.weight.toFixed(2)}%</td>
              <td class="num mono ${cls(it.ret)}">${pctStr(it.ret)}</td>
              <td class="num mono" style="color:${col(it.contribution)}">${pctStr(it.contribution)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <div class="section">
      <div class="section-title">二、本周操作明细（${r.tradeCount} 笔）</div>
      <div class="card">${tradeTable}</div>
    </div>

    <div class="section">
      <div class="section-title">三、持仓变动</div>
      <div class="card">${posTable}</div>
    </div>

    <div class="section">
      <div class="section-title">四、期末持仓</div>
      <div class="card">${holdTable}</div>
    </div>

    <div class="section">
      <div class="section-title">五、行为诊断（${r.diagnostics.length} 项）</div>
      ${r.diagnostics.length ? r.diagnostics.map((d) => `
        <div class="diag ${d.severity}">
          <div class="diag-t">${esc(d.title)} <span class="tag ${d.severity === 'high' ? 'stop' : (d.severity === 'mid' ? 'warn' : '')}">${sevLabel[d.severity]}</span></div>
          <div class="diag-body"><b>证据：</b>${esc(d.evidence)}</div>
          <div class="diag-body"><b>影响：</b>${esc(d.impact)}</div>
          <div class="diag-body"><b>改进：</b>${esc(d.action)}</div>
        </div>`).join('')
        : `<div class="card"><div class="hint">本周未发现明显的行为问题，纪律执行良好。继续保持，并注意单周样本量极小，不足以证明策略长期有效。</div></div>`}
    </div>

    <div class="section">
      <div class="section-title">六、经验教训</div>
      <div class="card">
        ${r.lessons.map((l) => `<div class="lesson">${esc(l)}</div>`).join('')}
      </div>
    </div>

    <div class="section">
      <div class="section-title">七、下周行动建议</div>
      <div class="card">
        ${r.actions.map((a) => `
          <div class="action">
            <span class="p ${a.priority}">${a.priority}</span>
            <div><div>${esc(a.text)}</div><div class="tiny muted" style="margin-top:2px">来源：${esc(a.from)}</div></div>
          </div>`).join('')}
      </div>
    </div>

    ${r.courseRecs.length ? `
    <div class="section">
      <div class="section-title">八、本周必修课程</div>
      <div class="card">
        ${r.courseRecs.map((c) => `
          <div class="course-item rec" data-act="course" data-id="${c.id}">
            <div class="ci-t">📖 ${esc(c.title)} <span class="tag">${['入门', '进阶', '高阶'][c.level]}</span></div>
            <div class="ci-s">${esc(c.reason)}</div>
          </div>`).join('')}
      </div>
    </div>` : ''}`;
  }

  /* =====================================================================
   * 学院页
   * =================================================================== */
  function renderAcademy() {
    const G = global.Game, R = global.Rank, T = global.Teach;
    const rank = G.state.rank;
    const rd = R.display(rank);
    const progress = G.state.courses;
    const doneCount = Object.values(progress).filter((c) => c.done).length;
    const lastReport = G.state.reports[0];
    const recs = T.recommend(lastReport ? lastReport.diagnostics : [], rank, progress, 3);

    const all = T.COURSES.slice().sort((a, b) => a.level - b.level);
    const levelLabel = ['入门', '进阶', '高阶'];
    const maxLevel = R.unlockedLevel(rank);

    return `
    <div class="card rank-card">
      <div class="rank-head">
        <div class="rank-badge" style="background:${rd.color}1a;border:2px solid ${rd.color}">${rd.icon}</div>
        <div class="f1">
          <div class="rank-name" style="color:${rd.color}">${rd.full}</div>
          <div class="rank-sub">${rd.starsText} · 勇者积分 ${rank.brave}</div>
        </div>
        <div style="text-align:right">
          <div class="tiny muted">排位战绩</div>
          <div class="bold mono">${rank.wins}胜 ${rank.losses}负</div>
        </div>
      </div>
      ${R.globalProgress(rank) >= 100 ? '' : global.Chart.rankProgress(rank)}
      <div class="divider"></div>
      <div class="kv-list">
        <div class="kv"><span class="k">连胜 / MVP</span><span class="v mono">${rank.winStreak} 连胜 · ${rank.mvp} 次 MVP</span></div>
        <div class="kv"><span class="k">课程解锁</span><span class="v">${T.unlockText(rank)}</span></div>
        <div class="kv"><span class="k">学习进度</span><span class="v mono">${doneCount} / ${T.COURSES.length} 门</span></div>
      </div>
    </div>

    ${rank.history.length ? `
    <div class="card">
      <div class="card-title">段位升降记录</div>
      <table class="mini">
        <thead><tr><th>周</th><th>收益</th><th>超额</th><th>结果</th><th class="num">表现分</th></tr></thead>
        <tbody>
        ${rank.history.slice(0, 12).map((h) => `
          <tr>
            <td class="tiny muted">W${h.weekIndex}</td>
            <td class="num mono ${cls(h.retPct)}">${pctStr(h.retPct)}</td>
            <td class="num mono ${cls(h.excessPct)}">${pctStr(h.excessPct)}</td>
            <td><span class="tag ${h.win ? 'ok' : 'stop'}">${h.win ? '胜' : '负'} ${h.delta >= 0 ? '+' : ''}${h.delta}★</span></td>
            <td class="num mono">${h.perf}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}

    <div class="section">
      <div class="section-title">${lastReport ? '本周必修（针对你的问题）' : '推荐先修'}</div>
      ${recs.map((x) => `
        <div class="course-item rec" data-act="course" data-id="${x.course.id}">
          <div class="ci-t">📖 ${esc(x.course.title)}
            <span class="tag">${levelLabel[x.course.level]}</span>
            ${x.locked ? '<span class="tag warn">未解锁</span>' : ''}
            ${x.done ? '<span class="tag ok">已学</span>' : ''}
          </div>
          <div class="ci-s">${esc(x.course.summary)}</div>
          <div class="ci-s" style="margin-top:5px">
            ${x.matched.length ? `<span class="tag warn">针对性推荐</span>` : ''}
            <span class="muted">${x.course.minutes} 分钟 · ${x.course.tags.join(' / ')}</span>
          </div>
        </div>`).join('')}
    </div>

    <div class="section">
      <div class="section-title">全部课程（${T.COURSES.length} 门）</div>
      ${all.map((c) => {
      const done = progress[c.id] && progress[c.id].done;
      const locked = c.level > maxLevel;
      return `
        <div class="course-item ${done ? 'done' : ''}" data-act="course" data-id="${c.id}">
          <div class="ci-t">${done ? '✅' : (locked ? '🔒' : '📘')} ${esc(c.title)}
            <span class="tag">${levelLabel[c.level]}</span>
          </div>
          <div class="ci-s">${esc(c.summary)}</div>
          <div class="ci-s" style="margin-top:4px"><span class="muted">${c.minutes} 分钟 · ${c.tags.join(' / ')}</span></div>
        </div>`;
    }).join('')}
    </div>

    <div class="card">
      <div class="card-title">评级规则说明</div>
      <div class="kp">一局排位 = 一个交易周（5 个交易日），周末自动结算</div>
      <div class="kp">胜利（跑赢沪深300）→ +1 星；MVP（超额 ≥ 2% 且无严重违规）额外 +1 星；每 3 连胜额外 +1 星</div>
      <div class="kp">失败（跑输基准）→ −1 星；勇者积分 ≥ 60 时自动消耗 60 分保星</div>
      <div class="kp">综合表现分 = 35% 收益 + 25% 风险（回撤/集中度）+ 30% 纪律（违规扣分）+ 10% 学习</div>
      <div class="kp">段位：青铜 → 白银 → 黄金 → 铂金 → 钻石 → 星耀 → 王者（10 星无双 / 25 星荣耀 / 50 星传奇）</div>
    </div>

    <div class="card">
      <div class="card-title">账户管理</div>
      <button class="btn block" data-act="reset">重置账户与全部进度</button>
      <div class="hint" style="margin-top:8px">重置后初始资金恢复为 100,000 元，段位、周报与课程进度清空。</div>
    </div>`;
  }

  /* =====================================================================
   * 个股详情
   * =================================================================== */
  function renderStockDetail(code) {
    const M = global.Market, A = global.Account;
    const q = M.quote(code);
    if (!q) return '<div class="hint">标的不存在</div>';
    const pos = A.position(code);
    const st = q.stats || {};

    const chart = UI.detail.chart === 'intraday' ? global.Chart.intraday(code) : global.Chart.kline(code, 60);

    return `
    <div class="card">
      <div class="row between">
        <div>
          <div style="font-size:17px;font-weight:700">${esc(q.name)}</div>
          <div class="tiny muted">${q.code} · ${esc(q.sector)} <span class="tag board">${esc(q.board)}</span></div>
        </div>
        <div class="right">
          <div class="mono bold" style="font-size:24px;color:${col(q.pct)}">${money(q.price)}</div>
          <div class="${cls(q.pct)} mono" style="font-size:13px;font-weight:600">${pctStr(q.pct)}　${(q.price - q.prevClose) >= 0 ? '+' : ''}${money(q.price - q.prevClose)}</div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="stat-grid">
        <div class="stat-item"><div class="k">今开</div><div class="v mono ${cls(q.open - q.prevClose)}">${money(q.open)}</div></div>
        <div class="stat-item"><div class="k">昨收</div><div class="v mono">${money(q.prevClose)}</div></div>
        <div class="stat-item"><div class="k">最高</div><div class="v mono up">${money(q.high)}</div></div>
      </div>
      <div class="stat-grid" style="margin-top:8px">
        <div class="stat-item"><div class="k">最低</div><div class="v mono down">${money(q.low)}</div></div>
        <div class="stat-item"><div class="k">均价</div><div class="v mono">${money(q.vwap)}</div></div>
        <div class="stat-item"><div class="k">换手</div><div class="v mono">${q.turnover.toFixed(2)}%</div></div>
      </div>
      <div class="divider"></div>
      <div class="kv-list">
        <div class="kv"><span class="k">涨停 / 跌停</span><span class="v mono"><span class="up">${money(q.limitUp)}</span> / <span class="down">${money(q.limitDown)}</span>${q.limitState !== 'none' ? `<span class="tag ${q.limitState === 'up' ? 'stop' : 'ok'}">${q.limitState === 'up' ? '涨停' : '跌停'}</span>` : ''}</span></div>
        <div class="kv"><span class="k">成交量 / 成交额</span><span class="v mono">${(q.volume / 10000).toFixed(2)} 万手 / ${(q.amount / 10000).toFixed(2)} 亿元</span></div>
        <div class="kv"><span class="k">当前持仓</span><span class="v mono">${pos && pos.qty > 0 ? `${pos.qty} 股（可卖 ${pos.avail}）成本 ${money(pos.cost)}` : '无'}</span></div>
      </div>
    </div>

    <div class="card" style="padding:6px">
      <div class="seg">
        <button class="${UI.detail.chart === 'intraday' ? 'on' : ''}" data-act="chart-tab" data-mode="intraday">分时</button>
        <button class="${UI.detail.chart === 'kline' ? 'on' : ''}" data-act="chart-tab" data-mode="kline">日K</button>
      </div>
      <div style="padding:0 8px 8px">${chart}</div>
    </div>

    <div class="card">
      <div class="card-title">风险特征 <span class="sub">由真实行情计算</span></div>
      <div class="stat-grid">
        <div class="stat-item"><div class="k">年化波动率</div><div class="v mono">${st.annVol}%</div></div>
        <div class="stat-item"><div class="k">β（vs 沪深300）</div><div class="v mono">${st.beta}</div></div>
        <div class="stat-item"><div class="k">夏普比率</div><div class="v mono">${st.sharpe}</div></div>
      </div>
      <div class="stat-grid" style="margin-top:8px">
        <div class="stat-item"><div class="k">历史最大回撤</div><div class="v mono down">${st.maxDD}%</div></div>
        <div class="stat-item"><div class="k">区间涨跌</div><div class="v mono ${cls(st.totalRet)}">${pctStr(st.totalRet, 1)}</div></div>
        <div class="stat-item"><div class="k">上涨天数占比</div><div class="v mono">${st.upDayRatio}%</div></div>
      </div>
      <div class="divider"></div>
      <div class="kv-list">
        <div class="kv"><span class="k">单日最大涨 / 跌</span><span class="v mono"><span class="up">${pctStr(st.bestDay)}</span> / <span class="down">${pctStr(st.worstDay)}</span></span></div>
        <div class="kv"><span class="k">平均换手率</span><span class="v mono">${st.avgTurnover}%</span></div>
        <div class="kv"><span class="k">与基准相关性</span><span class="v mono">${st.corr}</span></div>
      </div>
      <div class="hint" style="margin-top:8px">${esc(q.intro || '')}</div>
      <div class="hint" style="margin-top:6px">统计区间：${M.data.meta.startDate} ~ ${M.data.meta.endDate}（前复权）。β 与相关性由日收益率对沪深300 回归得到。</div>
    </div>

    <div class="card">
      <div class="row gap8">
        <button class="btn primary f1" data-act="goto-buy" data-code="${code}">买入</button>
        <button class="btn ${pos && pos.qty > 0 ? 'success' : ''} f1" data-act="goto-sell" data-code="${code}" ${(!pos || pos.qty <= 0) ? 'disabled' : ''}>卖出</button>
      </div>
      ${q.suspended ? '<div class="hint" style="margin-top:8px;color:var(--up)">该标的当日停牌，无法交易。</div>' : ''}
    </div>`;
  }

  /* =====================================================================
   * 课程详情
   * =================================================================== */
  function renderCourseDetail(id) {
    const c = global.Teach.byId(id);
    if (!c) return '<div class="hint">课程不存在</div>';
    const prog = global.Game.state.courses[id] || {};
    const qz = UI.quiz;
    const levelLabel = ['入门', '进阶', '高阶'];

    let quizHtml = '';
    if (c.quiz) {
      quizHtml = `
      <div class="section">
        <div class="section-title">自测题</div>
        <div class="card">
          <div class="bold" style="font-size:13px;margin-bottom:9px">${esc(c.quiz.q)}</div>
          ${c.quiz.options.map((o, i) => {
        let clsx = '';
        if (qz.checked && qz.pick === i) clsx = i === c.quiz.answer ? 'correct' : 'wrong';
        else if (qz.checked && i === c.quiz.answer) clsx = 'correct';
        else if (qz.pick === i) clsx = 'on';
        return `<div class="quiz-opt ${clsx}" data-act="quiz-opt" data-i="${i}">${String.fromCharCode(65 + i)}. ${esc(o)}</div>`;
      }).join('')}
          ${qz.checked ? `<div class="explain">${qz.pick === c.quiz.answer ? '✅ 回答正确。' : '❌ 回答错误。'} ${esc(c.quiz.explain)}</div>` : ''}
        </div>
      </div>`;
    }

    return `
    <div class="card">
      <div class="card-title">${esc(c.title)}
        <span class="tag">${levelLabel[c.level]}</span>
      </div>
      <div class="hint" style="font-size:12.5px;line-height:1.7">${esc(c.summary)}</div>
      <div class="tiny muted" style="margin-top:8px">约 ${c.minutes} 分钟 · ${c.tags.join(' / ')}${prog.done ? ' · 已于第 ' + (prog.dayIdx + 1) + ' 交易日完成' : ''}</div>
    </div>

    <div class="section">
      <div class="section-title">核心要点</div>
      <div class="card">${c.keypoints.map((k) => `<div class="kp">${esc(k)}</div>`).join('')}</div>
    </div>

    <div class="section">
      <div class="section-title">落地检查清单</div>
      <div class="card">${c.checklist.map((k) => `<div class="check-item"><span class="box">☐</span><span>${esc(k)}</span></div>`).join('')}</div>
    </div>

    ${quizHtml}

    <div class="card">
      <button class="btn primary block lg" data-act="finish-course" data-id="${id}">${prog.done ? '已完成学习（点击重复打卡）' : '完成学习并打卡'}</button>
      <div class="hint" style="margin-top:8px">打卡会计入本周段位结算的"学习分"（占综合表现分 10%）。</div>
    </div>`;
  }

  /* =====================================================================
   * 主渲染
   * =================================================================== */
  UI.render = function () {
    const page = $('#page');
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT');
    if (isInput && UI.tab === 'trade') { updateTradeNums(); return; }

    let html = '';
    if (UI.tab === 'home') html = renderHome();
    else if (UI.tab === 'market') html = renderMarket();
    else if (UI.tab === 'trade') html = renderTrade();
    else if (UI.tab === 'report') html = renderReport();
    else if (UI.tab === 'academy') html = renderAcademy();
    page.innerHTML = html;
    renderNav();

    // 若个股详情弹层打开，同步刷新
    if (UI.detail.code && $('#modal-root').innerHTML) {
      openModal(`${UI.detail.code}`, renderStockDetail(UI.detail.code));
    }
  };

  /** 交易页局部更新（避免打断输入） */
  function updateTradeNums() {
    const M = global.Market;
    if (UI.trade.tab === 'buy' && UI.trade.code) {
      const q = M.quote(UI.trade.code);
      const el = $('#buy-price');
      if (el && q) el.textContent = money(q.price);
    }
  }

  UI.setTab = function (t) {
    UI.tab = t;
    $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    UI.render();
    try { window.scrollTo(0, 0); } catch (err) { /* 环境不支持滚动时忽略 */ }
  };

  UI.openStock = function (code) {
    UI.detail.code = code;
    UI.detail.chart = 'intraday';
    const s = global.Market.stock(code);
    openModal(`${s.name} ${code}`, renderStockDetail(code));
  };

  UI.openReport = function (i) {
    const r = global.Game.state.reports[i];
    if (!r) return;
    openModal(`第 ${r.weekIndex} 周复盘`, renderReportDetail(r));
  };

  UI.openCourse = function (id) {
    UI.quiz = { id, pick: -1, checked: false };
    openModal('课程学习', renderCourseDetail(id));
  };

  /* =====================================================================
   * 事件委托
   * =================================================================== */
  document.addEventListener('click', function (e) {
    // 点击任何元素都会使输入控件失焦（对齐真实浏览器行为，避免输入框持有焦点时页面不刷新）
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT') && ae !== e.target) ae.blur();

    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const G = global.Game, M = global.Market, A = global.Account;

    switch (act) {
      case 'close-modal':
        // 点击落在面板内部（冒泡到遮罩）时不关闭，只有点遮罩本身或显式关闭按钮才关闭
        if (el.classList.contains('modal-mask') && e.target.closest('[data-stop]')) return;
        UI.detail.code = null;
        closeModal();
        break;

      case 'play': G.toggle(); UI.render(); break;
      case 'speed': G.setSpeed(parseInt(el.dataset.i, 10)); UI.render(); break;
      case 'skip-day': G.skipDay(); UI.render(); break;
      case 'skip-week': G.skipWeek(); UI.render(); break;
      case 'settle': {
        const r = G.forceSettle();
        if (r) { UI.setTab('report'); toast(`第 ${r.weekIndex} 周复盘已生成`); }
        else toast('本周还没有交易数据');
        UI.render();
        break;
      }

      case 'stock': UI.openStock(el.dataset.code); break;
      case 'chart-tab': UI.detail.chart = el.dataset.mode; UI.render(); break;

      case 'goto-buy':
        UI.trade.tab = 'buy'; UI.trade.code = el.dataset.code; UI.trade.qty = 0;
        UI.detail.code = null; closeModal(); UI.setTab('trade');
        break;
      case 'goto-sell':
        UI.trade.tab = 'sell'; UI.trade.sellCode = el.dataset.code; UI.trade.sellQty = 0;
        UI.detail.code = null; closeModal(); UI.setTab('trade');
        break;

      case 'trade-tab': UI.trade.tab = el.dataset.t; UI.render(); break;

      case 'qty-set': UI.trade.qty = parseInt(el.dataset.v, 10); UI.render(); break;
      case 'qty-frac': {
        const code = UI.trade.code;
        if (!code) break;
        const q = M.quote(code);
        const v = A.valuation();
        const target = v.cash * parseFloat(el.dataset.f);
        UI.trade.qty = A.maxBuyQty(q.price, target);
        UI.render();
        break;
      }
      case 'sell-frac': {
        if (!UI.trade.sellCode) break;
        const p = A.position(UI.trade.sellCode);
        const f = parseFloat(el.dataset.f);
        if (f >= 1) UI.trade.sellQty = p.avail;
        else UI.trade.sellQty = Math.floor((p.avail * f) / 100) * 100;
        UI.render();
        break;
      }
      case 'do-buy': {
        const r = G.buy(UI.trade.code, UI.trade.qty);
        toast(r.msg);
        if (r.ok) UI.trade.qty = 0;
        UI.render();
        break;
      }
      case 'do-sell': {
        const r = G.sell(UI.trade.sellCode, UI.trade.sellQty);
        toast(r.msg);
        if (r.ok) { UI.trade.sellQty = 0; UI.trade.sellCode = ''; }
        UI.render();
        break;
      }

      case 'sector': UI.market.sector = el.dataset.s; UI.render(); break;
      case 'sort': {
        const by = el.dataset.by;
        if (UI.market.sort === by) UI.market.asc = !UI.market.asc;
        else { UI.market.sort = by; UI.market.asc = false; }
        UI.render();
        break;
      }

      case 'report': UI.openReport(parseInt(el.dataset.i, 10)); break;
      case 'course': UI.openCourse(el.dataset.id); break;

      case 'quiz-opt': {
        if (UI.quiz.checked) break;
        UI.quiz.pick = parseInt(el.dataset.i, 10);
        UI.quiz.checked = true;
        openModal('课程学习', renderCourseDetail(UI.quiz.id));
        break;
      }
      case 'finish-course': {
        const id = el.dataset.id;
        const c = global.Teach.byId(id);
        const pass = !c.quiz || UI.quiz.pick === c.quiz.answer;
        G.finishCourse(id, pass);
        toast(pass ? '打卡成功，已计入本周学习分' : '已打卡（自测题未通过，建议重看要点）');
        closeModal();
        UI.render();
        break;
      }

      case 'reset':
        if (window.confirm('确定重置？初始资金、持仓、段位、周报与课程进度将全部清空。')) {
          G.reset(0);
          UI.trade = { tab: 'buy', code: '', qty: 0, sellCode: '', sellQty: 0 };
          UI.setTab('home');
          toast('账户已重置');
        }
        break;
    }
  });

  /* 输入事件 */
  document.addEventListener('input', function (e) {
    const el = e.target;
    const key = el.dataset.input;
    if (!key) return;
    if (key === 'kw') { UI.market.kw = el.value; UI.render(); const i = $('[data-input="kw"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
    else if (key === 'buy-code') { UI.trade.code = el.value; UI.trade.qty = 0; UI.render(); }
    else if (key === 'buy-qty') { UI.trade.qty = parseInt(el.value, 10) || 0; UI.render(); const i = $('[data-input="buy-qty"]'); if (i) i.focus(); }
    else if (key === 'sell-code') { UI.trade.sellCode = el.value; UI.trade.sellQty = 0; UI.render(); }
    else if (key === 'sell-qty') { UI.trade.sellQty = parseInt(el.value, 10) || 0; UI.render(); const i = $('[data-input="sell-qty"]'); if (i) i.focus(); }
  });

  global.UI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
