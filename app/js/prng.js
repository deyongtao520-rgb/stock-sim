/* =============================================================================
 * prng.js —— 确定性伪随机数发生器
 * -----------------------------------------------------------------------------
 * 行情回放必须可复现：同一 (标的, 交易日) 在任何时刻都必须生成完全相同的
 * 日内路径，否则存档读档后价格会跳变。因此全系统禁用 Math.random()，
 * 统一使用带种子的 mulberry32。
 * ========================================================================== */
(function (global) {
  'use strict';

  /** 字符串 -> 32 位整数种子（FNV-1a 变体） */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /** mulberry32：快速、周期足够长的 32 位 PRNG */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 便捷函数：给定种子串，返回一个 rand() */
  function rng(seedStr) {
    return mulberry32(hashSeed(String(seedStr)));
  }

  global.PRNG = { hashSeed, mulberry32, rng };
})(typeof window !== 'undefined' ? window : globalThis);
