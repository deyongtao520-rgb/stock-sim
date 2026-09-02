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
    python tools/serve.py                 # 默认 http://127.0.0.1:8321/（仅本机）
    python tools/serve.py --lan           # 局域网模式，手机/平板可通过 Wi-Fi 访问
    python tools/serve.py --lan --port 9000
    python tools/serve.py --dir ./app --open

局域网模式说明：
    --lan 等价于 --host 0.0.0.0（监听所有网卡），并在横幅打印所有可访问的
    局域网地址。手机需与电脑连接**同一个 Wi-Fi**，在浏览器（含微信内置浏览器）
    输入形如 http://192.168.1.23:8321/ 的地址即可。
    若被防火墙拦截，需在 Windows 防火墙放行该端口的入站连接。
"""
import argparse
import os
import socket
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
    ap.add_argument('--host', default=None,
                    help='监听地址，默认 127.0.0.1；加 --lan 则为 0.0.0.0')
    ap.add_argument('--lan', action='store_true',
                    help='局域网模式：监听所有网卡并打印可被手机访问的地址')
    ap.add_argument('--dir', default=DEFAULT_ROOT, help='静态根目录，默认项目 app/')
    ap.add_argument('--open', action='store_true', help='启动后自动打开浏览器')
    args = ap.parse_args()

    host = args.host or ('0.0.0.0' if args.lan else '127.0.0.1')

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
        httpd = ThreadingHTTPServer((host, args.port), handler)
    except OSError as e:
        sys.stderr.write('错误：无法监听 %s:%s —— %s\n' % (host, args.port, e))
        sys.stderr.write('请换一个端口，例如：python tools/serve.py --port 9000\n')
        return 1

    lan_ips = _lan_addresses() if host in ('0.0.0.0', '::') else []
    display_host = '127.0.0.1' if host in ('0.0.0.0', '::') else host
    url = 'http://%s:%d/' % (display_host, args.port)
    print('=' * 62)
    print('  股海练兵 · 股票模拟交易与复盘')
    print('=' * 62)
    print('  服务目录 : %s' % root)
    print('  本机访问 : %s' % url)
    print('  行情数据 : %d 个交易日' % _trading_days(root))
    if lan_ips:
        print('  ' + '-' * 58)
        print('  手机访问（需与电脑连同一个 Wi-Fi）：')
        for ip in lan_ips:
            print('      http://%s:%d/' % (ip, args.port))
        print('  打不开？多半是防火墙拦了入站连接，见 README「局域网访问」。')
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


def _lan_addresses():
    """探测本机在局域网内的 IPv4 地址，用于手机访问。

    两条探测路径合并去重：
      1. UDP connect 到公网地址（不发实际数据包），拿到**出口网卡**的 IP；
      2. 解析本机主机名，拿到**所有网卡**的 IP。
    过滤回环地址，并按 192.168.x > 10.x > 172.16-31.x > 其他 排序，
    把最可能是家用/办公 Wi-Fi 的地址排在最前。
    """
    found = set()

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('223.5.5.5', 80))  # 阿里 DNS，仅用于选路，不发包
        found.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except Exception:
        pass

    def is_private(ip):
        try:
            b = list(map(int, ip.split('.')))
        except Exception:
            return False
        if b[0] == 127 or b[0] == 0:
            return False
        if b[0] == 169 and b[1] == 254:      # link-local，未拿到 DHCP
            return False
        if b[0] == 10:
            return True
        if b[0] == 192 and b[1] == 168:
            return True
        if b[0] == 172 and 16 <= b[1] <= 31:
            return True
        return False

    def rank(ip):
        b = list(map(int, ip.split('.')))
        if b[0] == 192 and b[1] == 168:
            return 0
        if b[0] == 10:
            return 1
        if b[0] == 172:
            return 2
        return 3

    return sorted((ip for ip in found if is_private(ip)), key=rank)


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
