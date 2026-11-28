# 第三上游 C2 测量

- commit: 27dd87329ba9c17248bfaa14467efc27e1ec6cad
- 许可: CC0-1.0；另用 gh API 读取固定 commit 的 LICENSE，blob SHA `0e259d42c996742e9e3cba14c677129b2c1b6311`，正文为 Creative Commons CC0 1.0 Universal。该独立复核发生在本次测量期间；JSON 仍保留当时原始记录。
- 时间: 2026-11-26T00:48:28.461Z
- 文件数: 16
- 上游错误: 无
- 环境: {"platform":"win32","release":"10.0.19045","node":"v24.15.0","githubTransport":"gh api","probeTransport":"Node http/https 直连，不读取代理环境变量；系统路由未知","proxyVariables":[]}
- 网络补充：环境中无标准代理变量；WinHTTP 显示 Direct，Windows 用户代理 ProxyEnable=0（历史 ProxyServer 值存在但未启用）；系统路由/透明代理和地理出口未知，不能称为国内直连。gh CLI 取上游，Node 探流不使用代理环境变量。
- 耗时: 131994 ms，探测 122123 ms（120 秒停止发起新请求，已有请求继续完成）。
- 结论：暂停于测量阶段；不设接受门槛、不宣布达标。URL 排序限时样本不代表全集，未作试听；后续应人工确认阈值，并视网络条件复测。
- 统计: {
  "raw": 469,
  "unique": 469,
  "exactOverlap": 12,
  "exactOverlapRate": 0.0255863539445629,
  "normalizedOverlap": 12,
  "normalizedOverlapRate": 0.0255863539445629,
  "possibleNameOverlap": 3,
  "selected": 300,
  "capTruncated": 169,
  "tested": 231,
  "untestedSelected": 69,
  "ok": 193,
  "survivalRate": 0.8354978354978355,
  "newOk": 185,
  "logoCoverage": 0,
  "genres": {
    "decades-oldies-nostalgia": {
      "tested": 16,
      "ok": 13,
      "rate": 0.8125
    },
    "rock-indie-alternative-country-folk": {
      "tested": 14,
      "ok": 13,
      "rate": 0.9285714285714286
    },
    "reggae-dub": {
      "tested": 6,
      "ok": 5,
      "rate": 0.8333333333333334
    },
    "video-game-chiptune-soundtracks": {
      "tested": 14,
      "ok": 12,
      "rate": 0.8571428571428571
    },
    "electronic": {
      "tested": 26,
      "ok": 20,
      "rate": 0.7692307692307693
    },
    "funk-soul-hip-hop-disco": {
      "tested": 9,
      "ok": 6,
      "rate": 0.6666666666666666
    },
    "classical-opera": {
      "tested": 11,
      "ok": 8,
      "rate": 0.7272727272727273
    },
    "news-spoken-word": {
      "tested": 8,
      "ok": 7,
      "rate": 0.875
    },
    "world-regional": {
      "tested": 9,
      "ok": 6,
      "rate": 0.6666666666666666
    },
    "global-independent-online-communities": {
      "tested": 40,
      "ok": 35,
      "rate": 0.875
    },
    "ambient-lo-fi-chill": {
      "tested": 18,
      "ok": 16,
      "rate": 0.8888888888888888
    },
    "jazz-blues": {
      "tested": 26,
      "ok": 21,
      "rate": 0.8076923076923077
    },
    "metal-heavy": {
      "tested": 9,
      "ok": 9,
      "rate": 1
    },
    "campus-public-radio": {
      "tested": 15,
      "ok": 14,
      "rate": 0.9333333333333333
    },
    "christmas-holiday": {
      "tested": 5,
      "ok": 3,
      "rate": 0.6
    },
    "experimental-nerdy-scanners": {
      "tested": 5,
      "ok": 5,
      "rate": 1
    }
  },
  "codes": {
    "OK": 193,
    "NETWORK": 33,
    "SHORT_BODY": 5
  },
  "errno": {
    "ENOTFOUND": 1
  },
  "exceptions": 0,
  "latencyMs": {
    "min": 130,
    "p50": 1140,
    "p90": 4515,
    "p95": 4896,
    "max": 6006
  }
}
- 限制: URL 确定性排序截取，非随机样本；截止仅阻止启动新请求，已运行请求按默认超时收尾。；checkDetail 不保留独立 errno 字段；仅从 why 提取可见 errno，其他不可得。；OK 仅字节/协议通过，不保证内容正确；未做试听。；未确认量化阈值，不判定达标，不实施 C3。
