#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve.py —— 启动本地静态服务器（多线程）用于运行「股海练兵」

为什么不用 `python -m http.server`：
    标准库 http.server 默认是**单线程**的，一次只能处理一个请求。
    浏览器（以及 jsdom）会并发请求 index.html 引用的 12 个 JS 文件，
    单线程服务器下并发请求会被排队甚至超时，表现为部分脚本加载失败
    （典型现象：game.js / ui.js 报 "Could not load script"，页面卡在加载态）。
    ThreadingHTTPServer 为每个请求开一个线程，可正确处理并发。

用法：
    python tools/serve.py                 # 默认 http://127.0.0.1:8321/
    python tools/serve.py --port 9000
    python tools/serve.py --dir ./app --open
"""
import argparse
import os
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.join(os.path.dirname(HERE), 'app')


class Handler(SimpleHTTPRequestHandler):
    """在默认处理器基础上：禁用缓存（便于开发调试）+ 精简日志"""

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 仅打印失败响应，避免刷屏
        code = args[1] if len(args) > 1 else ''
        if str(code).startswith(('4', '5')):
            sys.stderr.write('  [%s] %s\n' % (code, args[0] if args else ''))


def main():
    ap = argparse.ArgumentParser(description='股海练兵 本地静态服务器')
    ap.add_argument('--port', type=int, default=8321, help='监听端口，默认 8321')
    ap.add_argument('--host', default='127.0.0.1', help='监听地址，默认 127.0.0.1')
    ap.add_argument('--dir', default=DEFAULT_ROOT, help='静态根目录，默认项目 app/')
    ap.add_argument('--open', action='store_true', help='启动后自动打开浏览器')
    args = ap.parse_args()

    root = os.path.abspath(args.dir)
    if not os.path.isdir(root):
        sys.stderr.write('错误：静态根目录不存在 -> %s\n' % root)
        return 2
    if not os.path.isfile(os.path.join(root, 'index.html')):
        sys.stderr.write('错误：%s 下未找到 index.html\n' % root)
        return 2

    handler = partial(Handler, directory=root)
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer.allow_reuse_address = True

    try:
        httpd = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as e:
        sys.stderr.write('错误：无法监听 %s:%s —— %s\n' % (args.host, args.port, e))
        sys.stderr.write('请换一个端口，例如：python tools/serve.py --port 9000\n')
        return 1

    url = 'http://%s:%d/' % (args.host, args.port)
    print('=' * 62)
    print('  股海练兵 · 股票模拟交易与复盘')
    print('=' * 62)
    print('  服务目录 : %s' % root)
    print('  访问地址 : %s' % url)
    print('  行情数据 : %d 个交易日' % _trading_days(root))
    print('  停止服务 : Ctrl + C')
    print('=' * 62)

    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')
    finally:
        httpd.server_close()
    return 0


def _trading_days(root):
    """读一下数据集的交易日数量，仅用于启动横幅展示"""
    import json
    p = os.path.join(root, 'data', 'market-data.json')
    try:
        with open(p, 'r', encoding='utf-8') as f:
            return len(json.load(f).get('dates', []))
    except Exception:
        return 0


if __name__ == '__main__':
    sys.exit(main())
