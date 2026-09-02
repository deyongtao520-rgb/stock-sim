/* =============================================================================
 * store.js —— 本地持久化（localStorage）
 * -----------------------------------------------------------------------------
 * 数据结构（单一状态树，便于整体存档 / 读档 / 迁移到小程序 Storage）：
 * {
 *   version, market:{dayIdx,tick,weekAnchor}, account:{...}, rank:{...},
 *   weekAnchor:{...}, reports:[...], courses:{id:{done,dayIdx,quizPass}},
 *   settings:{speed,autoPlay}, createdAt
 * }
 * ========================================================================== */
(function (global) {
  'use strict';

  const KEY = 'stocksim.state.v1';
  const VERSION = 1;

  const Store = { KEY, VERSION };

  Store.hasStorage = function () {
    try {
      const k = '__t';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  };

  let saveTimer = null;
  Store.save = function (state, immediate) {
    if (!Store.hasStorage()) return false;
    const doSave = () => {
      try {
        global.localStorage.setItem(KEY, JSON.stringify(state));
        return true;
      } catch (e) {
        console.warn('[Store] 保存失败', e);
        return false;
      }
    };
    if (immediate) return doSave();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 400);
    return true;
  };

  Store.load = function () {
    if (!Store.hasStorage()) return null;
    try {
      const raw = global.localStorage.getItem(KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || s.version !== VERSION) return null;
      return s;
    } catch (e) {
      console.warn('[Store] 读取失败', e);
      return null;
    }
  };

  Store.clear = function () {
    if (!Store.hasStorage()) return;
    try { global.localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  };

  /** 导出存档为 JSON 文本 */
  Store.exportText = function (state) { return JSON.stringify(state, null, 2); };

  global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
