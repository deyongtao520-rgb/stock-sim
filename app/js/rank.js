/* =============================================================================
 * rank.js —— 王者荣耀式段位评级体系
 * -----------------------------------------------------------------------------
 * 一局排位 = 一个交易周（5 个交易日）。每周结算一次，按"胜负 + 表现分"升降星。
 *
 * 段位结构（与王者荣耀一致）：
 *   倔强青铜 Ⅲ/Ⅱ/Ⅰ（每段 3 星）
 *   秩序白银 Ⅲ/Ⅱ/Ⅰ（每段 3 星）
 *   荣耀黄金 Ⅳ/Ⅲ/Ⅱ/Ⅰ（每段 4 星）
 *   尊贵铂金 Ⅳ/Ⅲ/Ⅱ/Ⅰ（每段 4 星）
 *   永恒钻石 Ⅴ/Ⅳ/Ⅲ/Ⅱ/Ⅰ（每段 5 星）
 *   至尊星耀 Ⅴ/Ⅳ/Ⅲ/Ⅱ/Ⅰ（每段 5 星）
 *   最强王者 0–9 星 → 无双王者 10–24 → 荣耀王者 25–49 → 传奇王者 50+
 *
 * 升降级规则：
 *   胜（周收益跑赢沪深300）        → +1 星
 *   MVP（跑赢 ≥2% 且无严重违规）   → 额外 +1 星
 *   连胜每满 3 场                  → 额外 +1 星
 *   负（跑输基准）                 → −1 星
 *   勇者积分 ≥ 60                  → 失败时自动消耗 60 分抵扣掉星（保星）
 *   当前小段零星时再负             → 掉到上一小段（星数 = 满星 − 1）
 *   青铜Ⅲ 零星为地板，不再下掉
 * ========================================================================== */
(function (global) {
  'use strict';

  const KING = 6;

  const TIERS = [
    { key: 'bronze', name: '倔强青铜', short: '青铜', subs: ['Ⅲ', 'Ⅱ', 'Ⅰ'], starsPerSub: 3, color: '#b07a4b', icon: '🥉' },
    { key: 'silver', name: '秩序白银', short: '白银', subs: ['Ⅲ', 'Ⅱ', 'Ⅰ'], starsPerSub: 3, color: '#8d99a8', icon: '🥈' },
    { key: 'gold', name: '荣耀黄金', short: '黄金', subs: ['Ⅳ', 'Ⅲ', 'Ⅱ', 'Ⅰ'], starsPerSub: 4, color: '#d8a326', icon: '🥇' },
    { key: 'plat', name: '尊贵铂金', short: '铂金', subs: ['Ⅳ', 'Ⅲ', 'Ⅱ', 'Ⅰ'], starsPerSub: 4, color: '#3fb8b0', icon: '💠' },
    { key: 'diamond', name: '永恒钻石', short: '钻石', subs: ['Ⅴ', 'Ⅳ', 'Ⅲ', 'Ⅱ', 'Ⅰ'], starsPerSub: 5, color: '#4c7ef3', icon: '💎' },
    { key: 'star', name: '至尊星耀', short: '星耀', subs: ['Ⅴ', 'Ⅳ', 'Ⅲ', 'Ⅱ', 'Ⅰ'], starsPerSub: 5, color: '#9b5de5', icon: '✨' },
    { key: 'king', name: '最强王者', short: '王者', subs: [], starsPerSub: 0, color: '#d9463c', icon: '👑' },
  ];

  /** 王者段位的细分称号 */
  const KING_LEVELS = [
    { min: 50, name: '传奇王者' },
    { min: 25, name: '荣耀王者' },
    { min: 10, name: '无双王者' },
    { min: 0, name: '最强王者' },
  ];

  const BRAVE_PROTECT_COST = 60;
  const BRAVE_CAP = 120;

  const Rank = { TIERS, KING_LEVELS, KING, BRAVE_PROTECT_COST };

  /* ---------------------------------------------------------------------
   * 工具：分段线性插值
   *   table 必须按 x 降序排列，且 x 越大 y 越高（"越大越好"型指标）。
   *   对"越小越好"型指标（回撤、集中度），传入 -x 并把表项 x 取负即可复用。
   * ------------------------------------------------------------------- */
  function interp(x, table) {
    if (x >= table[0][0]) return table[0][1];
    for (let i = 0; i < table.length - 1; i++) {
      const x1 = table[i][0], y1 = table[i][1];
      const x2 = table[i + 1][0], y2 = table[i + 1][1];
      if (x <= x1 && x >= x2) {
        const w = (x - x2) / ((x1 - x2) || 1);
        return y2 + (y1 - y2) * w;
      }
    }
    return table[table.length - 1][1];
  }

  /* ---------------------------------------------------------------------
   * 表现分（0–100）：收益 / 风险 / 纪律 / 学习 四维加权
   * ------------------------------------------------------------------- */
  // 超额收益（越大越好）
  const RETURN_TABLE = [[5, 100], [3, 88], [2, 80], [1, 72], [0.3, 62], [0, 55], [-0.5, 48], [-1, 42], [-2, 34], [-3, 26], [-5, 15], [-8, 6], [-999, 0]];
  // 最大回撤（越小越好）→ 表项 x 取负
  const DD_TABLE = [[-0.5, 100], [-1, 95], [-2, 85], [-3, 76], [-5, 62], [-8, 45], [-12, 25], [-20, 8], [-999, 0]];
  // 最大单一持仓权重（越小越好）→ 表项 x 取负
  const CONC_TABLE = [[-20, 100], [-30, 92], [-40, 80], [-50, 65], [-60, 50], [-80, 30], [-100, 15]];

  function scoreReturn(excessPct) { return interp(excessPct, RETURN_TABLE); }

  function scoreRisk(maxDDPct, topWeightPct) {
    const dd = interp(-Math.abs(maxDDPct), DD_TABLE);
    const conc = interp(-Math.abs(topWeightPct), CONC_TABLE);
    return 0.65 * dd + 0.35 * conc;
  }

  function scoreDiscipline(violations) {
    let s = 100;
    (violations || []).forEach((v) => {
      s -= v.severity === 'high' ? 25 : (v.severity === 'mid' ? 12 : 5);
    });
    return Math.max(0, Math.min(100, s));
  }

  function scoreLearning(coursesDone, reportReviewed) {
    let s = Math.min(100, (coursesDone || 0) * 50);
    if (!reportReviewed) s = Math.max(0, s - 25);
    return s;
  }

  /**
   * 综合表现分
   * @param {Object} m 指标：{excessPct, maxDDPct, topWeightPct, violations, coursesDone, reportReviewed}
   */
  Rank.performance = function (m) {
    const sr = scoreReturn(m.excessPct);
    const sk = scoreRisk(m.maxDDPct, m.topWeightPct);
    const sd = scoreDiscipline(m.violations);
    const sl = scoreLearning(m.coursesDone, m.reportReviewed);
    const total = 0.35 * sr + 0.25 * sk + 0.30 * sd + 0.10 * sl;
    return {
      total: Math.round(total),
      ret: Math.round(sr), risk: Math.round(sk), disc: Math.round(sd), learn: Math.round(sl),
    };
  };

  /* ---------------------------------------------------------------------
   * 段位状态
   * ------------------------------------------------------------------- */
  Rank.create = function () {
    return { tier: 0, sub: 0, stars: 0, brave: 0, winStreak: 0, loseStreak: 0, wins: 0, losses: 0, mvp: 0, history: [] };
  };

  Rank.load = function (s) {
    const d = Rank.create();
    return Object.assign(d, s || {});
  };

  /** 段位展示信息 */
  Rank.display = function (r) {
    if (r.tier >= KING) {
      const lv = KING_LEVELS.find((x) => r.stars >= x.min) || KING_LEVELS[KING_LEVELS.length - 1];
      const t = TIERS[KING];
      return {
        title: lv.name,
        sub: '',
        full: `${lv.name} ${r.stars} 星`,
        starsText: `${r.stars} 星`,
        color: t.color, icon: t.icon,
        tierName: t.name, short: '王者',
        progress: null,
      };
    }
    const t = TIERS[r.tier];
    const sub = t.subs[r.sub];
    return {
      title: t.name,
      sub,
      full: `${t.name}${sub}`,
      starsText: `${r.stars}/${t.starsPerSub} 星`,
      color: t.color, icon: t.icon,
      tierName: t.name, short: t.short,
      progress: (r.stars / t.starsPerSub) * 100,
      starsPerSub: t.starsPerSub,
    };
  };

  /** 全段位进度（用于进度条）：把 7 个大段 + 小段折算成 0–100 */
  Rank.globalProgress = function (r) {
    if (r.tier >= KING) return 100;
    let before = 0, total = 0;
    TIERS.forEach((t, i) => {
      const units = i === KING ? 0 : t.subs.length * t.starsPerSub;
      if (i < r.tier) before += units;
      total += units;
    });
    const cur = r.sub * TIERS[r.tier].starsPerSub + r.stars;
    return Math.min(100, ((before + cur) / total) * 100);
  };

  /* ---------------------------------------------------------------------
   * 星数应用（处理进位 / 借位 / 掉段）
   * ------------------------------------------------------------------- */
  function applyDelta(r, delta) {
    let t = r.tier, s = r.sub, st = r.stars + delta;
    const before = { tier: t, sub: s, stars: r.stars };

    if (t >= KING) {
      if (st < 0) {
        // 王者 0 星再负 → 掉回星耀Ⅰ（满星 −1）
        t = KING - 1;
        s = TIERS[t].subs.length - 1;
        st = TIERS[t].starsPerSub - 1;
      }
    } else {
      // 进位
      let guard = 0;
      while (st >= TIERS[t].starsPerSub && guard++ < 100) {
        st -= TIERS[t].starsPerSub;
        if (s + 1 < TIERS[t].subs.length) {
          s += 1;
        } else if (t + 1 < KING) {
          t += 1; s = 0;
        } else {
          // 晋升王者：剩余星数带入王者段
          t = KING; s = 0;
          break;
        }
      }
      // 借位
      guard = 0;
      while (st < 0 && guard++ < 100) {
        if (s > 0) { s -= 1; st += TIERS[t].starsPerSub; }
        else if (t > 0) { t -= 1; s = TIERS[t].subs.length - 1; st += TIERS[t].starsPerSub; }
        else { st = 0; break; }  // 青铜Ⅲ 0 星为地板
      }
      if (t >= KING) { s = 0; }
    }

    // 若晋升到王者，星数直接累计
    r.tier = t; r.sub = s; r.stars = Math.max(0, st);
    return before;
  }

  /* ---------------------------------------------------------------------
   * 每周排位结算
   * @param r        段位状态
   * @param week     {excessPct, retPct, maxDDPct, topWeightPct, violations, coursesDone, reportReviewed, weekIndex, startDate, endDate}
   * @returns {win, mvp, delta, protected, before, after, perf, brave, reasons[]}
   * ------------------------------------------------------------------- */
  Rank.settle = function (r, week) {
    const perf = Rank.performance(week);
    const win = week.excessPct > 0;
    const severe = (week.violations || []).filter((v) => v.severity === 'high').length;
    const mvp = win && week.excessPct >= 2 && severe === 0;

    const reasons = [];
    let delta = 0;
    let protectedByBrave = false;

    if (win) {
      r.winStreak += 1; r.loseStreak = 0; r.wins += 1;
      delta = 1;
      reasons.push(`跑赢基准 ${week.excessPct >= 0 ? '+' : ''}${week.excessPct.toFixed(2)}%，本周排位胜利 +1 星`);
      if (mvp) { delta += 1; r.mvp += 1; reasons.push('超额收益 ≥ 2% 且无严重纪律问题，评定 MVP，额外 +1 星'); }
      if (r.winStreak > 0 && r.winStreak % 3 === 0) { delta += 1; reasons.push(`达成 ${r.winStreak} 连胜，连胜奖励 +1 星`); }
    } else {
      r.loseStreak += 1; r.winStreak = 0; r.losses += 1;
      if (r.brave >= BRAVE_PROTECT_COST) {
        r.brave -= BRAVE_PROTECT_COST;
        protectedByBrave = true;
        delta = 0;
        reasons.push(`本周跑输基准 ${week.excessPct.toFixed(2)}%，触发勇者积分保护，消耗 ${BRAVE_PROTECT_COST} 分，本局不掉星`);
      } else {
        delta = -1;
        reasons.push(`跑输基准 ${week.excessPct.toFixed(2)}%，本周排位失败 −1 星`);
      }
    }

    // 勇者积分累积
    const gain = perf.total >= 75 ? 25 : (perf.total >= 60 ? 15 : (perf.total >= 45 ? 8 : 3));
    r.brave = Math.min(BRAVE_CAP, r.brave + gain);

    const before = Rank.display(r);
    applyDelta(r, delta);
    const after = Rank.display(r);

    const rec = {
      weekIndex: week.weekIndex,
      startDate: week.startDate, endDate: week.endDate,
      retPct: week.retPct, excessPct: week.excessPct,
      win, mvp, delta, protectedByBrave,
      perf: perf.total,
      beforeText: before.full + ' ' + before.starsText,
      afterText: after.full + ' ' + after.starsText,
      reasons,
    };
    r.history = r.history || [];
    r.history.unshift(rec);
    if (r.history.length > 200) r.history.length = 200;

    // 注意：先展开 rec，再用显示对象覆盖同名键，避免字符串覆盖对象
    return Object.assign({}, rec, {
      before, after, perf: perf.total, win, mvp, delta, protectedByBrave,
      perfDetail: { ret: perf.ret, risk: perf.risk, disc: perf.disc, learn: perf.learn },
    });
  };

  /** 段位解锁的教学内容等级（0=入门 1=进阶 2=高阶） */
  Rank.unlockedLevel = function (r) {
    if (r.tier >= 5) return 2;   // 星耀及以上
    if (r.tier >= 3) return 1;   // 铂金及以上
    return 0;
  };

  global.Rank = Rank;
})(typeof window !== 'undefined' ? window : globalThis);
