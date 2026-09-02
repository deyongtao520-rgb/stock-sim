# -*- coding: utf-8 -*-
"""
fetch_market_data.py
--------------------
从东方财富公开历史K线接口抓取 A 股真实日线数据（前复权），
清洗、对齐交易日历、计算标的统计特征，输出前端可直接加载的数据文件。

数据源： https://push2his.eastmoney.com/api/qt/stock/kline/get
字段说明（fields2=f51..f61）：
  f51 日期  f52 开盘  f53 收盘  f54 最高  f55 最低
  f56 成交量(手)  f57 成交额(元)  f58 振幅(%)  f59 涨跌幅(%)  f60 涨跌额  f61 换手率(%)

输出：
  stock-sim/data/market-data.json   结构化数据（便于后端/小程序直接使用）
  stock-sim/app/data/market-data.js window.MARKET_DATA = {...}（便于 file:// 直接打开）

用法：
  python tools/fetch_market_data.py --start 20240101 --end 20260901
"""

import argparse
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.request
import urllib.parse

API = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
TRADING_DAYS_PER_YEAR = 244

# ----------------------------------------------------------------------------
# 股票池：沪深两市各主要行业龙头/代表标的，覆盖 主板 / 创业板 / 科创板
# secid 规则：沪市 1.xxxxxx，深市 0.xxxxxx
# ----------------------------------------------------------------------------
UNIVERSE = [
    # ---- 食品饮料 ----
    ("1.600519", "600519", "贵州茅台", "食品饮料", "主板", "白酒龙头，高毛利、强品牌壁垒"),
    ("0.000858", "000858", "五粮液",   "食品饮料", "主板", "浓香型白酒龙头，消费景气度敏感"),
    ("1.600887", "600887", "伊利股份", "食品饮料", "主板", "乳制品龙头，大众消费品，防御属性"),
    # ---- 家用电器 / 消费 ----
    ("0.000651", "000651", "格力电器", "家用电器", "主板", "空调龙头，高股息、低估值特征明显"),
    ("0.000333", "000333", "美的集团", "家用电器", "主板", "综合家电龙头，ToB与出海业务并行"),
    # ---- 金融 ----
    ("1.601318", "601318", "中国平安", "非银金融", "主板", "综合金融集团，利率与权益市场双敏感"),
    ("1.600030", "600030", "中信证券", "非银金融", "主板", "券商龙头，业绩与市场成交量高度相关"),
    ("0.300059", "300059", "东方财富", "非银金融", "创业板", "互联网券商，β高、弹性大"),
    ("1.601398", "601398", "工商银行", "银行",     "主板", "国有大行，高股息、低波动防御品种"),
    ("1.600036", "600036", "招商银行", "银行",     "主板", "零售银行龙头，资产质量与息差是核心变量"),
    # ---- 医药生物 ----
    ("1.600276", "600276", "恒瑞医药", "医药生物", "主板", "创新药龙头，研发管线与集采政策敏感"),
    ("1.603259", "603259", "药明康德", "医药生物", "主板", "CXO 龙头，海外订单与地缘政策影响大"),
    ("0.300760", "300760", "迈瑞医疗", "医药生物", "创业板", "医疗器械龙头，出海与国内招标双驱动"),
    ("0.300015", "300015", "爱尔眼科", "医药生物", "创业板", "医疗服务连锁，消费医疗属性"),
    # ---- 新能源 / 电力设备 ----
    ("0.300750", "300750", "宁德时代", "电力设备", "创业板", "动力电池全球龙头，产业链议价能力强"),
    ("1.601012", "601012", "隆基绿能", "电力设备", "主板", "光伏一体化，行业产能周期特征强"),
    # ---- 汽车 ----
    ("0.002594", "002594", "比亚迪",   "汽车",     "主板", "新能源整车龙头，销量与价格战是核心变量"),
    ("1.600104", "600104", "上汽集团", "汽车",     "主板", "传统整车集团，合资品牌与自主转型"),
    # ---- 电子 / 半导体 ----
    ("0.002371", "002371", "北方华创", "电子",     "主板", "半导体设备龙头，国产替代主线"),
    ("1.688981", "688981", "中芯国际", "电子",     "科创板", "晶圆代工龙头，资本开支与周期属性强"),
    ("0.002415", "002415", "海康威视", "电子",     "主板", "安防龙头，AI 视觉与海外业务并重"),
    ("0.002475", "002475", "立讯精密", "电子",     "主板", "精密制造，大客户订单依赖度高"),
    ("1.603501", "603501", "韦尔股份", "电子",     "主板", "CIS 图像传感器，消费电子周期敏感"),
    ("1.603986", "603986", "兆易创新", "电子",     "主板", "存储与 MCU，行业景气波动大"),
    ("0.000725", "000725", "京东方A",  "电子",     "主板", "面板龙头，重资产、强周期"),
    # ---- 有色 / 周期 ----
    ("1.601899", "601899", "紫金矿业", "有色金属", "主板", "铜金资源龙头，商品价格与美元指数驱动"),
    ("1.600309", "600309", "万华化学", "基础化工", "主板", "聚氨酯龙头，典型化工周期股"),
    ("1.600585", "600585", "海螺水泥", "建筑材料", "主板", "水泥龙头，需求端受地产基建影响"),
    ("1.600031", "600031", "三一重工", "机械设备", "主板", "工程机械龙头，与基建/地产周期强相关"),
    # ---- 公用事业 / 能源 ----
    ("1.600900", "600900", "长江电力", "公用事业", "主板", "水电龙头，现金流稳定、类债券属性"),
    ("1.601985", "601985", "中国核电", "公用事业", "主板", "核电运营，装机与电价决定盈利"),
    ("1.601857", "601857", "中国石油", "石油石化", "主板", "油气一体化，油价与高股息双主线"),
    ("1.600028", "600028", "中国石化", "石油石化", "主板", "炼化龙头，炼油价差与油价驱动"),
    # ---- 通信 / 传媒 / 计算机 / 交运 / 社服 ----
    ("1.600941", "600941", "中国移动", "通信",     "主板", "运营商龙头，高股息 + 数字化成长"),
    ("0.002230", "002230", "科大讯飞", "计算机",   "主板", "AI 大模型与教育/医疗应用落地"),
    ("0.002027", "002027", "分众传媒", "传媒",     "主板", "梯媒龙头，广告主预算与宏观消费相关"),
    ("0.002352", "002352", "顺丰控股", "交通运输", "主板", "快递物流龙头，单票成本与时效竞争"),
    ("1.601888", "601888", "中国中免", "社会服务", "主板", "免税运营商，客流与消费力驱动"),
]

BENCHMARK = ("1.000300", "000300", "沪深300")


# ----------------------------------------------------------------------------
# 网络请求
# ----------------------------------------------------------------------------
def http_get_json(url, retries=4, timeout=25):
    last_err = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "ignore")
            return json.loads(raw)
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(1.2 * (i + 1))
    raise RuntimeError(f"请求失败: {url} -> {last_err}")


def fetch_kline(secid, start, end):
    params = {
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101",   # 101 = 日线
        "fqt": "1",     # 1 = 前复权
        "beg": start,
        "end": end,
        "lmt": "1000000",
    }
    url = f"{API}?{urllib.parse.urlencode(params)}"
    obj = http_get_json(url)
    if obj.get("rc") != 0 or not obj.get("data"):
        raise RuntimeError(f"无数据: {secid}")
    return obj["data"]


def f(x, default=0.0):
    try:
        v = float(x)
        return v
    except Exception:  # noqa: BLE001
        return default


# ----------------------------------------------------------------------------
# 统计特征（全部由真实行情计算得出，不做任何主观赋值）
# ----------------------------------------------------------------------------
def max_drawdown(closes):
    peak = closes[0]
    mdd = 0.0
    for c in closes:
        if c > peak:
            peak = c
        dd = (c / peak - 1.0) if peak else 0.0
        if dd < mdd:
            mdd = dd
    return mdd


def stats_for(closes, pcts, bench_pcts, turnovers):
    n = len(closes)
    if n < 30:
        return {}
    rets = []
    for i in range(1, n):
        if closes[i - 1] > 0:
            rets.append(math.log(closes[i] / closes[i - 1]))
    if len(rets) < 20:
        return {}
    mu = statistics.fmean(rets)
    sd = statistics.pstdev(rets)
    ann_vol = sd * math.sqrt(TRADING_DAYS_PER_YEAR)

    # beta / alpha vs 沪深300（OLS）
    beta = 1.0
    corr = 0.0
    m = min(len(rets), len(bench_pcts))
    if m > 20:
        xs = [bench_pcts[i] / 100.0 for i in range(m)]
        ys = rets
        mx, my = statistics.fmean(xs), statistics.fmean(ys)
        cov = sum((xs[i] - mx) * (ys[i] - my) for i in range(m)) / m
        varx = sum((x - mx) ** 2 for x in xs) / m
        sdy = statistics.pstdev(ys)
        sdx = statistics.pstdev(xs)
        if varx > 0:
            beta = cov / varx
        if sdx > 0 and sdy > 0:
            corr = cov / (sdx * sdy)

    total_ret = closes[-1] / closes[0] - 1.0 if closes[0] else 0.0
    years = n / TRADING_DAYS_PER_YEAR
    cagr = (closes[-1] / closes[0]) ** (1 / years) - 1.0 if years > 0 and closes[0] > 0 else 0.0
    # 夏普（无风险利率按 2% 年化）
    sharpe = ((mu * TRADING_DAYS_PER_YEAR - 0.02) / ann_vol) if ann_vol > 0 else 0.0
    up_ratio = sum(1 for p in pcts if p > 0) / len(pcts) if pcts else 0.0

    return {
        "days": n,
        "totalRet": round(total_ret * 100, 2),
        "cagr": round(cagr * 100, 2),
        "annVol": round(ann_vol * 100, 2),
        "beta": round(beta, 2),
        "corr": round(corr, 2),
        "sharpe": round(sharpe, 2),
        "maxDD": round(max_drawdown(closes) * 100, 2),
        "upDayRatio": round(up_ratio * 100, 1),
        "bestDay": round(max(pcts), 2) if pcts else 0.0,
        "worstDay": round(min(pcts), 2) if pcts else 0.0,
        "avgTurnover": round(statistics.fmean(turnovers), 2) if turnovers else 0.0,
        "lastClose": round(closes[-1], 2),
    }


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="20240101")
    ap.add_argument("--end", default="20260901")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_json = args.out or os.path.join(root, "data", "market-data.json")
    out_js = os.path.join(root, "app", "data", "market-data.js")
    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    os.makedirs(os.path.dirname(out_js), exist_ok=True)

    print(f"[1/4] 抓取基准指数 {BENCHMARK[2]} ...")
    bdata = fetch_kline(BENCHMARK[0], args.start, args.end)
    dates, bench_close = [], []
    for line in bdata["klines"]:
        p = line.split(",")
        dates.append(p[0])
        bench_close.append(f(p[3]))  # 指数仅返回 f51..f57，索引 3 = 收盘
    print(f"      基准交易日 {len(dates)} 天：{dates[0]} ~ {dates[-1]}")

    # 基准日收益率（供 beta 计算）
    bench_pct = []
    for i in range(1, len(bench_close)):
        bench_pct.append((bench_close[i] / bench_close[i - 1] - 1) * 100 if bench_close[i - 1] else 0.0)

    date_index = {d: i for i, d in enumerate(dates)}

    print(f"[2/4] 抓取 {len(UNIVERSE)} 只个股 ...")
    stocks = []
    for si, (secid, code, name, sector, board, intro) in enumerate(UNIVERSE, 1):
        try:
            d = fetch_kline(secid, args.start, args.end)
        except Exception as e:  # noqa: BLE001
            print(f"      [{si:>2}/{len(UNIVERSE)}] {code} {name} 失败：{e}")
            continue
        raw = {}
        for line in d["klines"]:
            p = line.split(",")
            raw[p[0]] = [f(p[1]), f(p[2]), f(p[3]), f(p[4]), f(p[5]), f(p[6]), f(p[8]), f(p[10])]
            # [open, close, high, low, vol, amt, pct, turnover]

        if not raw:
            print(f"      [{si:>2}/{len(UNIVERSE)}] {code} {name} 无数据，跳过")
            continue

        own_dates = sorted(raw.keys())
        first_date, last_date = own_dates[0], own_dates[-1]
        listed_from = date_index.get(first_date, 0)

        # 按统一交易日历对齐；缺失日标记为停牌（-1 占位）
        k, suspended, closes, pcts, turns = [], [], [], [], []
        prev_close = None
        for i, dt in enumerate(dates):
            if i < listed_from:
                k.append(None)
                continue
            if dt not in raw:
                suspended.append(i)
                k.append(None)
                continue
            o, c, h, l, v, a, pct, tn = raw[dt]
            k.append([round(o, 2), round(h, 2), round(l, 2), round(c, 2),
                      int(v), round(a / 10000.0, 1), round(pct, 2), round(tn, 2)])
            closes.append(c)
            pcts.append(pct)
            turns.append(tn)
            prev_close = c

        # 用 None 填充为紧凑表示：None -> 停牌
        klist = [row if row is not None else None for row in k]

        st = stats_for(closes, pcts, bench_pct, turns)
        stocks.append({
            "code": code,
            "name": name,
            "market": int(secid.split(".")[0]),
            "secid": secid,
            "sector": sector,
            "board": board,
            "intro": intro,
            "listedFrom": listed_from,
            "suspendedDays": suspended,
            "stats": st,
            "k": klist,
        })
        print(f"      [{si:>2}/{len(UNIVERSE)}] {code} {name:<6} "
              f"{len(closes):>4} 天 | 年化波动 {st.get('annVol','-')}% | β {st.get('beta','-')}")

    print("[3/4] 汇总输出 ...")
    payload = {
        "meta": {
            "source": "东方财富公开历史K线接口 (push2his.eastmoney.com)",
            "sourceUrl": API,
            "adjust": "前复权(fqt=1)",
            "period": "日线(klt=101)",
            "startDate": dates[0],
            "endDate": dates[-1],
            "tradingDays": len(dates),
            "benchmark": {"code": BENCHMARK[1], "name": BENCHMARK[2]},
            "stockCount": len(stocks),
            "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "klineFieldOrder": ["open", "high", "low", "close", "volume(手)", "amount(万元)", "pctChg(%)", "turnover(%)"],
        },
        "dates": dates,
        "benchmark": [round(x, 2) for x in bench_close],
        "stocks": stocks,
    }

    with open(out_json, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, separators=(",", ":"))
    with open(out_js, "w", encoding="utf-8") as fp:
        fp.write("/* 自动生成，请勿手工编辑。数据口径：真实 A 股日线（前复权）。 */\n")
        fp.write("window.MARKET_DATA = ")
        json.dump(payload, fp, ensure_ascii=False, separators=(",", ":"))
        fp.write(";\n")

    size_json = os.path.getsize(out_json) / 1024.0
    size_js = os.path.getsize(out_js) / 1024.0
    print(f"[4/4] 完成：{len(stocks)} 只标的 + 基准，{len(dates)} 个交易日")
    print(f"      {out_json}  ({size_json:.0f} KB)")
    print(f"      {out_js}  ({size_js:.0f} KB)")


if __name__ == "__main__":
    sys.exit(main())
