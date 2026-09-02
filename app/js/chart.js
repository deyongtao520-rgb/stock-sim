/* =============================================================================
 * chart.js —— 零依赖 SVG 图表
 * -----------------------------------------------------------------------------
 * 全部为纯 SVG 字符串生成，无外部库，可离线运行。
 * 配色遵循 A 股习惯：涨/正贡献 = 红色，跌/负贡献 = 绿色。
 * ========================================================================== */
(function (global) {
  'use strict';

  const UP = '#e0483b';      // 涨 / 正贡献
  const DOWN = '#12a05c';    // 跌 / 负贡献
  const FLAT = '#9aa3ad';
  const AXIS = '#e3e7ec';
  const TEXT = '#8a939e';

  const Chart = { UP, DOWN, FLAT };

  function colorOf(v) { return v > 0 ? UP : (v < 0 ? DOWN : FLAT); }
  function sign(v, d) { return (v > 0 ? '+' : '') + v.toFixed(d === undefined ? 2 : d); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function scaleY(v, min, max, h, pad) {
    const range = (max - min) || 1;
    return pad + (1 - (v - min) / range) * (h - pad * 2);
  }

  /* ---------------------------------------------------------------------
   * 分时图
   * ------------------------------------------------------------------- */
  Chart.intraday = function (code) {
    const M = global.Market;
    const q = M.quote(code);
    if (!q || !q.listed || q.suspended) {
      return '<div class="chart-empty">该标的当日停牌 / 未上市，无分时数据</div>';
    }
    const p = M.getPath(code, M.dayIdx);
    const path = p.path.slice(0, M.tick + 1);
    const vols = p.vols.slice(0, M.tick + 1);
    const T = M.TICKS_PER_DAY;

    const W = 340, H = 190, PAD = 6;
    const bodyH = 140, volH = 34, volTop = 152;

    const vals = path.concat([q.prevClose]);
    let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    const mid = q.prevClose;
    const span = Math.max(Math.abs(max - mid), Math.abs(mid - min)) * 1.08 || mid * 0.01;
    min = mid - span; max = mid + span;

    const n = Math.max(path.length, 2);
    const x = (i) => PAD + (i / (T - 1)) * (W - PAD * 2);
    const y = (v) => scaleY(v, min, max, bodyH, PAD);

    // 累计均价线（VWAP 近似）
    let cumAmt = 0, cumVol = 0;
    const avg = [];
    for (let i = 0; i < n; i++) {
      cumAmt += path[i] * vols[i];
      cumVol += vols[i];
      avg.push(cumVol ? cumAmt / cumVol : path[i]);
    }

    const linePts = path.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const avgPts = avg.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const areaPts = `${x(0).toFixed(1)},${(bodyH - PAD).toFixed(1)} ` + linePts + ` ${x(n - 1).toFixed(1)},${(bodyH - PAD).toFixed(1)}`;

    const c = q.pct >= 0 ? UP : DOWN;
    const yPrev = y(q.prevClose);

    let bars = '';
    const maxVol = Math.max.apply(null, vols.concat([1]));
    vols.forEach((v, i) => {
      const bh = Math.max(1, (v / maxVol) * (volH - 4));
      const col = i === 0 ? c : (path[i] >= path[i - 1] ? UP : DOWN);
      bars += `<rect x="${(x(i) - 3.2).toFixed(1)}" y="${(volTop + volH - bh).toFixed(1)}" width="6.4" height="${bh.toFixed(1)}" fill="${col}" opacity="0.75"/>`;
    });

    return `
<svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="none">
  <defs>
    <linearGradient id="grad-${code}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${c}" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <line x1="${PAD}" y1="${yPrev.toFixed(1)}" x2="${W - PAD}" y2="${yPrev.toFixed(1)}" stroke="#c8ced6" stroke-width="1" stroke-dasharray="3 3"/>
  <line x1="${PAD}" y1="${y(max).toFixed(1)}" x2="${W - PAD}" y2="${y(max).toFixed(1)}" stroke="${AXIS}" stroke-width="1"/>
  <line x1="${PAD}" y1="${y(min).toFixed(1)}" x2="${W - PAD}" y2="${y(min).toFixed(1)}" stroke="${AXIS}" stroke-width="1"/>
  <polygon points="${areaPts}" fill="url(#grad-${code})"/>
  <polyline points="${linePts}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"/>
  <polyline points="${avgPts}" fill="none" stroke="#f0a020" stroke-width="1.2" stroke-dasharray="0" opacity="0.9"/>
  ${bars}
  <text x="${W - PAD}" y="${y(max).toFixed(1) - 3}" text-anchor="end" font-size="10" fill="${TEXT}">${max.toFixed(2)}</text>
  <text x="${W - PAD}" y="${y(min).toFixed(1) + 10}" text-anchor="end" font-size="10" fill="${TEXT}">${min.toFixed(2)}</text>
  <text x="${PAD}" y="${H - 2}" font-size="9" fill="${TEXT}">09:30</text>
  <text x="${W / 2}" y="${H - 2}" text-anchor="middle" font-size="9" fill="${TEXT}">11:30 / 13:00</text>
  <text x="${W - PAD}" y="${H - 2}" text-anchor="end" font-size="9" fill="${TEXT}">15:00</text>
</svg>`;
  };

  /* ---------------------------------------------------------------------
   * 日 K 线图
   * ------------------------------------------------------------------- */
  Chart.kline = function (code, n) {
    const M = global.Market;
    n = n || 60;
    const bars = M.recentBars(code, n);
    if (!bars.length) return '<div class="chart-empty">暂无 K 线数据</div>';

    const W = 340, H = 180, PAD = 6, volH = 30, bodyH = 132, volTop = 146;
    const highs = bars.map((b) => b.high), lows = bars.map((b) => b.low);
    const min = Math.min.apply(null, lows), max = Math.max.apply(null, highs);
    const range = (max - min) || 1;
    const bw = (W - PAD * 2) / bars.length;
    const x = (i) => PAD + i * bw + bw / 2;
    const y = (v) => PAD + (1 - (v - min) / range) * (bodyH - PAD * 2);

    let g = '';
    const maxVol = Math.max.apply(null, bars.map((b) => b.volume).concat([1]));
    bars.forEach((b, i) => {
      const up = b.close >= b.open;
      const col = up ? UP : DOWN;
      const yh = y(b.high), yl = y(b.low);
      const yo = y(b.open), yc = y(b.close);
      const top = Math.min(yo, yc);
      const h = Math.max(1.2, Math.abs(yc - yo));
      const cx = x(i);
      g += `<line x1="${cx.toFixed(1)}" y1="${yh.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yl.toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
      g += `<rect x="${(cx - bw * 0.34).toFixed(1)}" y="${top.toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? col : col}" opacity="${up ? 0.9 : 0.9}"/>`;
      const vh = Math.max(1, (b.volume / maxVol) * (volH - 4));
      g += `<rect x="${(cx - bw * 0.34).toFixed(1)}" y="${(volTop + volH - vh).toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${vh.toFixed(1)}" fill="${col}" opacity="0.6"/>`;
    });

    [0.25, 0.5, 0.75].forEach((f) => {
      const yy = PAD + f * (bodyH - PAD * 2);
      g = `<line x1="${PAD}" y1="${yy}" x2="${W - PAD}" y2="${yy}" stroke="${AXIS}" stroke-width="0.8" stroke-dasharray="2 3"/>` + g;
    });

    return `
<svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="none">
  ${g}
  <text x="${PAD}" y="${H - 2}" font-size="9" fill="${TEXT}">${bars[0].date}</text>
  <text x="${W - PAD}" y="${H - 2}" text-anchor="end" font-size="9" fill="${TEXT}">${bars[bars.length - 1].date}</text>
  <text x="${W - PAD}" y="${PAD + 9}" text-anchor="end" font-size="10" fill="${TEXT}">${max.toFixed(2)}</text>
  <text x="${W - PAD}" y="${bodyH - PAD + 2}" text-anchor="end" font-size="10" fill="${TEXT}">${min.toFixed(2)}</text>
</svg>`;
  };

  /* ---------------------------------------------------------------------
   * 净值曲线（账户 vs 基准）
   * ------------------------------------------------------------------- */
  Chart.equityCurve = function (points) {
    const W = 340, H = 150, PAD = 8;
    if (!points.length) return '<div class="chart-empty">暂无净值数据</div>';
    const vals = points.map((p) => p.v).concat(points.map((p) => p.b));
    let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max - min < 0.02) { const c = (max + min) / 2; min = c - 0.02; max = c + 0.02; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;
    const n = points.length;
    const x = (i) => PAD + (n === 1 ? (W - PAD * 2) / 2 : (i / (n - 1)) * (W - PAD * 2));
    const y = (v) => PAD + (1 - (v - min) / (max - min)) * (H - PAD * 2);

    const p1 = points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const p2 = points.map((p, i) => `${x(i).toFixed(1)},${y(p.b).toFixed(1)}`).join(' ');
    const last = points[n - 1];
    const col = last.v >= 1 ? UP : DOWN;

    // 基准 1.0 参考线
    const y1 = y(1);
    return `
<svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="none">
  <line x1="${PAD}" y1="${y1.toFixed(1)}" x2="${W - PAD}" y2="${y1.toFixed(1)}" stroke="#c8ced6" stroke-width="1" stroke-dasharray="3 3"/>
  <polyline points="${p2}" fill="none" stroke="#b6bec8" stroke-width="1.4" stroke-dasharray="4 3"/>
  <polyline points="${p1}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="${x(n - 1).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.8" fill="${col}"/>
  <text x="${PAD}" y="${H - 2}" font-size="9" fill="${TEXT}">${points[0].date}</text>
  <text x="${W - PAD}" y="${H - 2}" text-anchor="end" font-size="9" fill="${TEXT}">${points[n - 1].date}</text>
</svg>
<div class="chart-legend">
  <span><i style="background:${col}"></i>我的账户 ${sign((last.v - 1) * 100, 2)}%</span>
  <span><i style="background:#b6bec8"></i>${(global.Market.data.meta.benchmark.name)} ${sign((last.b - 1) * 100, 2)}%</span>
</div>`;
  };

  /* ---------------------------------------------------------------------
   * 归因条形图（横向，正负分色）
   * ------------------------------------------------------------------- */
  Chart.attributionBars = function (items) {
    if (!items || !items.length) return '<div class="chart-empty">本期无持仓，无归因数据</div>';
    const maxAbs = Math.max.apply(null, items.map((i) => Math.abs(i.value)).concat([0.01]));
    return `<div class="attr-bars">` + items.map((it) => {
      const w = (Math.abs(it.value) / maxAbs) * 100;
      const col = colorOf(it.value);
      return `
      <div class="attr-row">
        <div class="attr-label">${esc(it.label)}</div>
        <div class="attr-track">
          <div class="attr-fill" style="width:${w.toFixed(1)}%;background:${col}"></div>
        </div>
        <div class="attr-value" style="color:${col}">${sign(it.value, 2)}%</div>
      </div>`;
    }).join('') + `</div>`;
  };

  /* ---------------------------------------------------------------------
   * 段位星级
   * ------------------------------------------------------------------- */
  Chart.stars = function (cur, total, color) {
    let s = '';
    for (let i = 0; i < total; i++) {
      s += `<span class="star ${i < cur ? 'on' : ''}" style="${i < cur ? `color:${color}` : ''}">★</span>`;
    }
    return `<span class="stars">${s}</span>`;
  };

  /** 段位进度条：展示 7 大段的位置 */
  Chart.rankProgress = function (rank) {
    const R = global.Rank;
    const d = R.display(rank);
    const p = R.globalProgress(rank);
    return `
      <div class="rank-progress">
        <div class="rank-progress-bar"><div class="rank-progress-fill" style="width:${p.toFixed(1)}%;background:${d.color}"></div></div>
        <div class="rank-progress-meta">
          <span style="color:${d.color};font-weight:600">${d.icon} ${d.full}</span>
          <span class="muted">${d.starsText}</span>
        </div>
      </div>`;
  };

  global.Chart = Chart;
  global.Chart.colorOf = colorOf;
  global.Chart.sign = sign;
  global.Chart.esc = esc;
})(typeof window !== 'undefined' ? window : globalThis);
