# 扩展方向调研 —— GitHub 同类项目分析(2026-10-12)

> 用 agent-reach(gh CLI)按多组关键词/topic 扫了 GitHub 电台播放器生态,读头部项目 README 提功能集,对照 VRadio 现状与项目边界,产出候选方向评估。同日经 grill-me 审计(owner 逐项拍板)修订——审计结论见第二节,**本文档只做分析,不改代码**。

## 一、调研方法与范围

搜索词覆盖:`internet radio player` / `radio browser` / `radio-player` topic / `internet-radio` topic / `电台 直播` / `iptv m3u web player` / `listenbrainz scrobble` 等;深入读了 PawTunes、player-shoutcast-html5、RadioDroid、recommended-radio-streams、radiorecorder、musicpod 的 README。中文生态扫过但高星同类稀少(收音机需求在国内被蜻蜓/喜马拉雅 App 垄断,web 端开源基本空白——VRadio 的生态位本身就是空档)。

## 二、审计修订记录(2026-10-12,grill-me + owner 拍板)

原版(纯 GitHub 调研视角)存在四个论证问题,已全部修订:

1. **原 P0「当前歌封面」是从众推理,已撤销**。「三家头部(PawTunes/musicpod/player-shoutcast-html5)都有封面」≠「VRadio 场景需要」:电台是持续流不是 CD 专辑,认台有台标、知歌有曲讯文字、锁屏有 MediaSession 台名,封面是注意力不落在屏幕上的视觉糖;且关键前提(itunes.apple.com 国内可达性)从未实测却排了最高优先级。owner 裁定原话:「这是电台又不是某张 CD 专辑」。唯一保留:把**已解析的台标**填进 MediaSession 的 `artwork` 字段(一行代码、零外部依赖,见 P3 顺手项)。
2. **原 P2「省份筛选」未披露与历史决策的张力,已移入不做清单**。owner 曾撤销「按流派细分子分类」,省份虽非流派但同属「给列表加维度」;裁定同一逻辑收口:维度越多列表越难用,找家乡台靠搜索框可用。
3. **原版整体是「同类功能差集」视角,缺「项目自身痛点直推」视角**——补「编辑电台流地址」(新 P1,最大漏项)与收音机本体心智小功能组,均经代码 grep 验证确无实现。
4. **数字键 1-9 预设台(收藏直达)提出未采纳**,记录在案防重提。

**审计后的总体结论:VRadio 功能面已饱和**——播放/数据装配/维护/曲讯四层齐备,死链三层感知与 URL 身份回绑是同类没有的护城河,不存在值得立 P0 的缺口;剩余项全部是长尾打磨,**克制优先,新想法默认先进不做清单考察**。

## 三、同类项目全景(参考背景)

| 形态 | 项目 | 星 | 对 VRadio 有参考价值的功能 |
|---|---|---|---|
| Web 全栈(PHP) | Jackysi/PawTunes | 69 | 实时曲讯 7+ 种 API;专辑封面 4 源抓取;流历史;动态窗口标题;WebSocket;多码率 |
| Web 轻量 | gsavio/player-shoutcast-html5 | 89 | 曲讯 + 历史歌曲;iTunes API 查当前歌封面;歌词(Vagalume) |
| CLI/TUI | coderholic/pyradio | 1097 | 键盘驱动、vim 键位(VRadio 已有快捷键,无新意) |
| CLI | dpnkrpl/radio-active | 603 | 终端全球电台(VRadio 无 CLI 需求) |
| CLI 录制 | sfuhrm/radiorecorder | 46 | 逐曲录制 + ID3 标签 + 多台并行录 |
| 桌面托盘 | ebruck/radiotray-ng、TheJoeFin/Traydio | 301/196 | 托盘常驻、预设按钮(原生形态,不适用 web) |
| 桌面 GUI | ubuntu-flutter-community/musicpod | 672 | radio + icy 曲讯 + 封面查询 + podcast 组合 |
| 安卓 | segler-alex/RadioDroid | 1075 | Radio Browser 生态头部;录制、Chromecast —— 佐证 roadmap 安卓原生方向 |
| 精选清单 | deroverda/recommended-radio-streams | 386 | 人工精选流派流清单(CC0),per-genre m3u —— 正对 roadmap「第三上游」 |
| 流媒体服务器 | owntone/owntone-server | 2570 | AirPlay/Chromecast 多房间(超边界,仅记录) |

**功能对照结论**(同类常见 × VRadio 现状):曲讯✅(B-6)、歌曲历史✅(B-7)、台标✅、多源切换/断流自愈✅、收藏/最近✅、睡眠定时✅、主题✅、快捷键✅、维护面板✅、死链三层感知✅(后两项同类没有)。

## 四、采纳的扩展方向

### P1-a —— 维护面板「编辑电台流地址」(项目自身痛点直推,最大漏项)

**痛点**:已知坑白纸黑字「流地址天然漂移:某台播不了先怀疑源失效」,但维护面板只能移动/改名/隐藏,用户对失效源**没有任何手动救援手段**,只能干等同步。这是同步实测/体检/播放换源三层韧性之外缺的第四层——用户层手动兜底。

**设计要点(身份公理约束,动手前必读)**:URL = 持久身份,直接改主 URL 会让收藏(`radio.favs`)/最近(`radio.recents`)/成功源记忆(`radio.srcmem`)/健康标记(`radio.health`)全部失绑。因此:
- **首版只做「同名台追加备选源」**:追加不动身份,新源自动进 `variants()` 三级播放策略,`srcmem` 下次点播先行——最稳、收益立得;
- 「替换/删除失效源」要迁移上述四处 URL 映射,成本高,首版不做,失配场景走追加新源 + 隐藏旧台的组合即可;
- 存储走 `radio.cfg` 维护层(加 srcs 覆盖),同步重建后按台身份回绑复用(与移动/改名同机制),并纳入配置导出/导入。

**成本**:约 150~200 行(cfg 层 srcs + 维护面板电台页的源管理 UI + applySrcs 装配)。**定级**:P1(owner 拍板),下一迭代首选。

### P1-b —— 欧美台第三上游:人工精选清单(roadmap 已挂账,本文补数据源)

roadmap 已有「欧美台数据加量(人工精选流清单第三上游,待现有列表洗净后再议)」。调研找到理想候选:**deroverda/recommended-radio-streams(386★,CC0 许可)**——underground electronic / freeform / jazz / ambient / weird 流派的人工精选,每台带直连流 URL + 官网,`playlists/` 目录按流派自动生成 m3u。接入方式与现有 AlonDrilich 镜像同构(api.github.com 拉 m3u,带 gh CLI 回退),同步引擎已是双上游框架,加第三上游是扩展不是重构。

**边界要点**:并入现有「欧美音乐」分类即可(它基本全是音乐台),**不要**为它新开细分流派分类——「按流派细分子分类」已在 roadmap 撤销,省份筛选同逻辑收口(见第二节)。节奏尊重「先洗净再议」,本文档只落候选源与接入要点,不催实现。

### P3 —— 收音机本体心智小功能组(owner 圈定采纳三项,分散顺手带,不单独立项)

均经代码验证无实现,单项几十行量级:

1. **「随机听/电台漫游」**:当前分类(或全库可见台)随机切一台——收音机旋钮乱转遇到惊喜的心智,发现场景。要点:从 `visible()` 口径抽取(不抽死台),避免连续抽中同一台。几个按钮位 + 一次 `Player.play` 调用。
2. **一键复制当前流地址**:底部播放栏小按钮,复制当前**成功源** URL——喂给 VLC/车机/其它设备。`navigator.clipboard.writeText` + 老浏览器降级。
3. **一键全量备份/恢复**:收藏 + 维护配置 + 偏好(主题/视图/无效源开关)合并单 JSON(带版本标记),现状要分别导收藏 m3u 和配置 JSON 两次,搬家场景一次搞定;导入按字段恢复、`normCfg` 校验复用。

### P3(顺手)—— MediaSession artwork 填台标 & PLS/XSPF 导入

- **artwork 填台标**:player.js 播放/`setSong` 处拿 `Logos` 已解析的台标 URL 填 `MediaMetadata` 的 `artwork` 字段(注意 `src/sizes/type` 规格给全)——锁屏/蓝牙设备显示台标大图。一行级改动、零外部依赖,**封面功能撤销后唯一保留的视觉增强**(owner 拍板)。
- **PLS/XSPF 导入**:现导入只认 txt/csv/m3u。PLS(ini 风格 `File1=/Title1=`)是 VLC/RadioDroid 生态常见导出格式,XSPF(xml)次之;手写解析各 30~50 行(零依赖硬约束下手写没问题)。

## 五、明确不做(及理由,避免反复;owner 已逐项拍板)

| 方向 | 来源 | 不做的理由 |
|---|---|---|
| **当前歌封面查询(iTunes 等外部 API)** | PawTunes/musicpod/player-shoutcast-html5 都有 | **owner 裁定:「这是电台又不是某张 CD 专辑」**——认台有台标、知歌有曲讯、锁屏有台名,封面是视觉糖;外部 API 依赖 + 国内可达性风险 + 短期链接缓存复杂度,增量不值。锁屏视觉已由台标填 artwork 覆盖 |
| **国内台按省份筛选** | 原版本文档提出 | **owner 裁定移入不做**:与「按流派细分子分类已撤销」同一逻辑——给列表加维度让列表更难用;找家乡台靠搜索框可用 |
| **数字键 1-9 预设台** | 审计中提出 | owner 圈选小功能组时明确排除,记录在案防重提 |
| **录制(逐曲+ID3)** | radiorecorder、RadioDroid、Shortwave | README 免责声明「不存储、不上传、不转授权任何音频内容」——录流 = 存储音频,版权敏感度直接上一个台阶;且 HLS 台逐曲切分技术成本高 |
| **播客(podcast)** | musicpod | 产品维度漂移:RSS 订阅管理/剧集进度/下载体系是另一个产品。VRadio 边界 = 电台流播放器 |
| **Chromecast/AirPlay 投射** | RadioDroid 等 | Cast SDK 闭源大脚本(违背零依赖),AirPlay 无 web API;国内设备渗透低 |
| **均衡器(EQ)** | (同类罕见) | 架构硬冲突:Web Audio MediaElementSource 一接入,CORS 未授权的流(第①级直流全部优势)直接静音,三级播放策略被毁 |
| **Last.fm/ListenBrainz scrobbling** | ScrobbleRadio 等(0★ 级生态) | 外部账号依赖 + 与「不收集任何数据」气质冲突,Last.fm 国内不稳 |
| **多码率手动选择 / 多语言 UI / WebSocket 曲讯推送** | PawTunes | `variants()` 自动选源已覆盖;单语用户群;15s 轮询+旁路会话已实测达标 |
| 移动端 Web/PWA | —— | owner 已拍板安卓原生路线(roadmap 注明),不翻案 |

## 六、建议路线(审计后重排)

1. **P1-a 编辑流地址先行**:全表唯一的「真痛点」项,长在维护层成熟机制上(cfg 回绑/失配清单/导入导出全套现成)。
2. **P1-b 第三上游等列表洗净后启动**,数据源锁定 recommended-radio-streams(CC0)。
3. **P3 小功能组(漫游/复制/备份 + artwork 填充 + PLS/XSPF)分散在后续迭代顺手带**,不单独立项。
4. 安卓原生 app 维持 roadmap 原位(RadioDroid 1075★ 佐证方向)。
5. **「不做清单」随本文件归档为决策底账,后续 review 不再重议**;新想法默认先进不做清单考察,想清楚了再捞。
