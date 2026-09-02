#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lan_qr.py —— 生成「手机扫码访问」页面

在电脑上跑一次，会产出一个自包含的 HTML 文件（二维码内联为 SVG，不联网也能用），
双击打开后用手机微信「扫一扫」即可访问本机正在运行的「股海练兵」。

依赖：
    pip install segno        # 纯 Python 二维码库，无二进制依赖

用法：
    python tools/lan_qr.py                  # 默认端口 8321
    python tools/lan_qr.py --port 9000      # 自定义端口
    python tools/lan_qr.py --port 8321 --open
"""
import argparse
import os
import re
import socket
import sys
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>股海练兵 · 手机扫码访问</title>
<style>
  :root { --fg:#1a1d21; --muted:#5f6672; --line:#e3e6ea; --bg:#f7f8fa;
          --card:#ffffff; --accent:#1f6feb; }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px 20px 56px; background:var(--bg); color:var(--fg);
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
         line-height:1.7; }
  .wrap { max-width:560px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:.3px; }
  .sub { color:var(--muted); font-size:14px; margin:0 0 24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:24px; margin-bottom:16px; }
  .qr { display:flex; justify-content:center; padding:8px 0 4px; }
  .qr svg { width:240px; height:240px; }
  .qr svg .qrline { stroke-width:1; }
  .addr { text-align:center; margin:14px 0 2px; }
  .addr code { font-size:19px; font-weight:600; color:var(--accent);
               background:#eef4ff; padding:6px 12px; border-radius:6px;
               display:inline-block; word-break:break-all; }
  .copy { display:block; margin:12px auto 0; padding:7px 16px; font-size:13px;
          color:var(--muted); background:#fff; border:1px solid var(--line);
          border-radius:6px; cursor:pointer; }
  .copy:hover { border-color:var(--accent); color:var(--accent); }
  h2 { font-size:15px; margin:0 0 12px; padding-bottom:8px;
       border-bottom:1px solid var(--line); }
  ol { margin:0; padding-left:22px; }
  ol li { margin-bottom:9px; font-size:14.5px; }
  ol li:last-child { margin-bottom:0; }
  .warn { background:#fff8e6; border:1px solid #f0d9a0; border-radius:8px;
          padding:12px 14px; font-size:13.5px; color:#7a5c1e; margin-top:14px; }
  .warn b { color:#5c4310; }
  .meta { margin-top:20px; font-size:12.5px; color:var(--muted); text-align:center; }
  kbd { background:#f0f2f5; border:1px solid var(--line); border-bottom-width:2px;
        border-radius:4px; padding:1px 6px; font-size:12.5px; font-family:inherit; }
</style>
</head>
<body>
<div class="wrap">
  <h1>股海练兵 · 手机扫码访问</h1>
  <p class="sub">用手机微信「扫一扫」下方二维码，即可在手机上体验</p>

  <div class="card">
    <div class="qr">__QR__</div>
    <div class="addr"><code id="u">__URL__</code></div>
    <button class="copy" onclick="navigator.clipboard.writeText(document.getElementById('u').textContent).then(()=>{this.textContent='已复制 ✓';setTimeout(()=>this.textContent='复制地址',1500)})">复制地址</button>
  </div>

  <div class="card">
    <h2>操作步骤</h2>
    <ol>
      <li>确认手机与电脑连接的是<strong>同一个 Wi-Fi</strong>（同一局域网）。</li>
      <li>打开微信 → 右上角 <kbd>+</kbd> → <strong>扫一扫</strong>，扫描上方二维码。</li>
      <li>也可以把地址发到微信「文件传输助手」，直接点击链接打开。</li>
      <li>确认电脑上已用 <code style="font-size:13px">python tools/serve.py --lan</code> 启动服务，
          且该窗口未关闭。</li>
    </ol>
    <div class="warn">
      <b>手机扫完打不开？</b>按顺序排查：<br>
      ① 电脑上的服务窗口是否已关闭；<br>
      ② 手机是否连着别的 Wi-Fi，或用了移动数据；<br>
      ③ 部分公司／校园网开启了「AP 隔离」，禁止设备互访 —— 改用手机热点：
         电脑连手机热点后重新运行 <code style="font-size:12.5px">python tools/lan_qr.py</code>；<br>
      ④ Windows 防火墙拦截时，以管理员身份运行：<br>
         <code style="font-size:12.5px">netsh advfirewall firewall add rule name="股海练兵-__PORT__" dir=in action=allow protocol=TCP localport=__PORT__ remoteip=localsubnet</code>
    </div>
  </div>

  <p class="meta">
    生成时间 __TIME__ ｜ 端口 __PORT__<br>
    换 Wi-Fi 或重启路由器后局域网 IP 会变，重新运行 <code style="font-size:12px">python tools/lan_qr.py</code> 即可刷新本页
  </p>
</div>
</body>
</html>
"""


def lan_addresses():
    """探测局域网 IPv4，与 serve.py 的 _lan_addresses 逻辑一致"""
    found = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('223.5.5.5', 80))
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
        if b[0] in (127, 0):
            return False
        if b[0] == 169 and b[1] == 254:
            return False
        return (b[0] == 10
                or (b[0] == 192 and b[1] == 168)
                or (b[0] == 172 and 16 <= b[1] <= 31))

    def rank(ip):
        b = list(map(int, ip.split('.')))
        return 0 if (b[0] == 192 and b[1] == 168) else 1 if b[0] == 10 else 2 if b[0] == 172 else 3

    return sorted((ip for ip in found if is_private(ip)), key=rank)


def main():
    ap = argparse.ArgumentParser(description='生成手机扫码访问页面')
    ap.add_argument('--port', type=int, default=8321, help='服务端口，默认 8321')
    ap.add_argument('--out', default=os.path.join(ROOT, 'lan-access.html'),
                    help='输出 HTML 路径')
    ap.add_argument('--open', action='store_true', help='生成后自动用浏览器打开')
    args = ap.parse_args()

    try:
        import segno
    except ImportError:
        sys.stderr.write('缺少依赖 segno，请先安装：\n'
                         '    pip install segno\n')
        return 1

    ips = lan_addresses()
    if not ips:
        sys.stderr.write('未探测到局域网 IPv4 地址：请确认已连接 Wi-Fi/网线。\n')
        return 1

    ip = ips[0]
    url = 'http://%s:%d/' % (ip, args.port)

    qr = segno.make(url, error='h')
    svg = qr.svg_inline(scale=9, border=2)
    # segno 的 svg_inline 不输出 viewBox，缺少它时 CSS 缩放会把二维码裁切掉，
    # 这里按 width/height 补一个等尺寸 viewBox。
    svg = re.sub(r'<svg width="(\d+)" height="(\d+)"',
                 lambda m: '<svg viewBox="0 0 %s %s" width="%s" height="%s"'
                           % (m.group(1), m.group(2), m.group(1), m.group(2)),
                 svg, count=1)
    if 'viewBox' not in svg:
        sys.stderr.write('警告：二维码 SVG 未插入 viewBox，可能显示异常。\n')

    import datetime
    html = (HTML.replace('__QR__', svg)
                .replace('__URL__', url)
                .replace('__PORT__', str(args.port))
                .replace('__TIME__', datetime.datetime.now().strftime('%Y-%m-%d %H:%M')))

    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(html)

    print('=' * 58)
    print('  已生成扫码页 : %s' % args.out)
    print('  手机访问地址 : %s' % url)
    if len(ips) > 1:
        print('  其他网卡地址 : %s' % ', '.join(ips[1:]))
    print('=' * 58)

    if args.open:
        webbrowser.open('file:///' + os.path.abspath(args.out).replace('\\', '/'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
