# VRadio Web UI 全面升级方案（ui-redesign）

> **历史参考，非现行实施规格（2026-11-15）**：现行方案统一见 [UI升级实施方案](ui-redesign-plan-2026-11.md)。本文保留早期审计证据；四段式保留、移动专项重做、维护不纳入本期、色值通过声明和旧骨架均不得越过主文档执行。现行决定为桌面侧栏与大幅续听、窄屏保留日常布局并共用新筛选和维护规则、完整重做维护；以主文档Q1–Q31与最终确认记录为准。

> 定位：**可交接的实施蓝图**——接手人读完 §3-§5 即可开工，不必重走调研。
> 基准：feat/r4-b0 @ `7ceb15c`（2026-11-15），审计基准 = 本轮真实运行取证 + 全源码通读。
> 与前轮关系：docs/ui-audit.md（2026-10-12）的 A-E 批次已全部落地（对比度/图标 sprite/密度/键盘/焦点管理），
> 本方案**不重复任何已修项**，从「修错收敛」升级到「设计语言系统化」。模式判定沿用 **Redesign - Preserve**：
> 品牌绿/克制基调/a11y 骨架/紧凑代码风格全部保留，升级的是中性面层级、信息编码、组件地位与细节完成度。
> 取证截图：`docs/ui-redesign-assets/01-06*.png`（本轮新拍，含两处回归实锤）；对比度脚本：`docs/ui-redesign-assets/contrast-check.js`。
> **硬约束不动摇**：零 npm 依赖、零构建、经典 script、无外部字体/图标库、file:// 降级可用、新增 radio.\* 持久键需三侧同步（本方案零新增键）。

---

## 一、项目背景

### 1.1 产品与它的界面

VRadio 是单用户自用的本地网络电台播放器（1600+ 台、双上游同步、Web/安卓双端共数据契约）。Web 界面 = `index.html`
单文件结构壳（DOM+全部 CSS 内联）+ 五个经典 script 模块，界面形态是「header（搜索/视图/低频操作）+ 分类条 +
列表区（网格/列表双视图）+ footer 播放条」的四段式，深浅双主题 CSS 变量驱动。

### 1.2 UI 演进到哪了

| 轮次 | 内容 | 状态 |
|---|---|---|
| 2026-10-12 ui-audit.md | P1×3 正确性 + P2×7 信息设计 + P3×9 精致度，A-E 五批全落地 | ✅ 已修完（ sprite/对比度/键盘/焦点/密度） |
| 本轮（本方案） | 视觉取证发现的 **2 处回归** + 系统性设计升级 | 本文档 |

上轮解决了「看得清、找得到、点得准」；这轮回答「**作为一个电台播放器，它有没有自己的样子；作为每天用的面板，
它的层级和地位对不对**」。

### 1.3 本轮取证方式（可复跑）

- 真实运行取证：`npm start` + 浏览器实测，双主题 × 双视图 × 播放态（DOM 模拟）× 移动端 390px × 维护面板 × 欧美台分类，共 6 张（`docs/ui-redesign-assets/`）。
- 布局实测：playwright evaluate 读 getBoundingClientRect（§2 R-1 的 259px/890px 数据即实测）。
- 对比度实测：`node docs/ui-redesign-assets/contrast-check.js`（全部 PASS，§4 色值主张与脚本一一对应——上轮二审曾因荐色未实测翻车，本轮纪律：**色值主张必须先过脚本**）。
- 修复实证：R-1 的修法已注入真实页面验证（259px → 890px，截图留档流程同上）。

---

## 二、本轮发现（R-1 ~ R-9）

编号带截图/数据实锤。R-1/R-2 是**上轮修复引入的回归**，属 P0 先行修复；其余按价值排序。

### R-1【P0·回归】列表视图容器收缩成内容宽，桌面列表视图不可用

- 实测（1280×800，列表视图）：`#list` 宽 **259px**、居中（x=505.5），行宽 231px，meta 折行到台名下方，右侧 3/4 视口全空（截图 03）。
- 根因：index.html:125 `#list:not(.grid) { max-width:900px; margin:0 auto; }`。`body` 是 `flex-direction:column`（index.html:13），`#list` 是 flex 子项——**交叉轴 auto margin 会阻断 stretch**，子项收缩为 fit-content 再居中，`max-width` 只封顶不撑开。上轮 P2-4 修这行时引入，网格视图（display:grid，无此规则）幸免。
- 修法（已注入真实页面实证：`#list` 259→890px、行 862px、x=190 正确居中，见 `07/08-fix-verify-*.png`）：
  ```css
  #list:not(.grid) { width:100%; max-width:900px; margin:0 auto; }
  ```
- 次生问题（修完后仍在，非 bug）：900px 限宽下两行式行的右侧 ~60% 恒空——批次 4 把健康标记/源数右对齐解决。

### R-2【P0·回归】移动端 header 折三行，主题钮独占一行

- 实测（390×844）：header 折三行（logo+搜索 / seg+⋯+无效源+维护 / **主题钮独占第三行**），合计 ~135px 才见分类条（截图 06）。上轮 P2-6 的「≤640px 压回两行」目标已破——`#lowfreq` 收纳组只收了四个低频钮，deadBtn（出现死台后常驻）与 themeBtn 留在外面，390px 下放不下。
- 修法（批次 0）：把 `deadBtn`/`themeBtn` 的 DOM 挪进 `#lowfreq` span 内（index.html:254-263）。桌面侧 `#lowfreq{display:contents}`（index.html:179）使其原地渲染、视觉零变化；移动端自动进「⋯ 更多」菜单，header 稳回两行。themeBtn 补一个可见文字 `<span>主题</span>`（菜单里 icon-only 不可达——上轮 P2-6 补充观察②），桌面隐藏该 span。JS 零改动（按钮按 id 绑定）。

### R-3 首字母色块「彩虹噪音」+ 黄相白字对比度 2.80:1 不达标

- 现状 `hsl(hash%360, 42%, 44%)`（logos.js:37-41）全谱随机色相。实测网格：相邻卡片红/紫/绿/橙/蓝随机撞色，浅色主题下尤甚（截图 01/04）；且白字对黄相块（h≈60°）对比度仅 **2.80:1**（脚本 §⑤，上轮 AIbot P3-4 以「装饰性 aria-hidden」驳回，机制成立但观感/合规双输）。
- 设计判断：hash 色相**不携带任何信息**（同名永远同色但色相与台无关），色彩这个通道被浪费了。方案见批次 2：**色相 = 分类身份**（信息编码），精选 11 色调色板（白字全检 ≥4.5:1）。

### R-4 桌面 header「按钮汤」：8 个同级描边钮无层级

- 1280px 下 header 一行塞了：视图 seg + 同步源/体检/导入列表/导出收藏 + 无效源 + 维护 + 主题，全部 `.btn` 同描边同权重（截图 01）。视觉上「7 个等地位开关」，主动作（无）与低频动作（导入/导出）无法区分。上轮已把移动端收进 ⋯ 菜单，桌面仍是平铺。
- 方案见批次 4：ghost 分层 + 视图 seg 改 tonal，导入/导出收进 ⋯（开放决策 D3）。

### R-5 footer 信息平权：播放键没有主动作地位，播放中「活体感」弱

- footer（index.html:269-292）播放/刷新/睡眠/静音四钮同款 30px 描边钮；播放中唯一的活体指示是 3 根 14px 均衡器短杆，距离两米外能看出「在播」还差得远。电台产品的灵魂状态是「ON AIR」，当前界面没有这个时刻。
- 方案见批次 3（签名元素）：实心绿圆形播放钮 + LIVE 红点 + 5 杆频谱动画 + 台名/曲讯两行精排。

### R-6 网格卡片中段空洞

- 卡片 `min-height:100px`（index.html:112），内容 = 头行（logo 40px）+ 底行 meta，flex column + `margin-top:auto` 把空洞全挤在中段（截图 01/04）。上轮放大单元后头行 40px logo 撑不住 100px 高度。
- 方案见批次 2：logo 提到 44px、行距重排、playing 卡加 ON AIR 红点徽标补右上视觉锚。

### R-7 toast 常驻时遮挡右下卡片区（轻微）

- `#toast` 定位 right:14px bottom:76px（index.html:199），带按钮的常驻 toast（基线确认）盖住右下角一张卡（截图 02）。可接受但能更好：批次 6 给 toast 上移一行 + 出入场动画统一，不做堆叠系统（单实例够用）。

### R-8 空态只有文字

- 四分支空态文案（app.js:405-411）质量好，但视觉上是一行灰字。批次 6 加一个内嵌 SVG 小收音机插画（~12 行 path，零依赖），空态从「报错感」变「邀请感」。

### R-9 维护面板原生 prompt()/confirm() 与整体视觉割裂（记录不在本期）

- `askName()`（app.js:712-715）与各 confirm 走浏览器原生弹窗，样式不可控。替换为面板内联编辑涉及按键流/焦点管理重做，**本期不做**（开放决策 D6 挂账），先做批次 6 的面板样式收敛。

---

## 三、设计方向（Design Read）

### 3.1 概念：深夜调频 · ON AIR 控制台

不引入任何新依赖的前提下，让界面「像一台收音机」而不是「像一个后台表格」：

- **主题词**：ON AIR。电台产品唯一值得放大的时刻是「正在播」——批次 3 把 footer 升级为有直播红点、频谱、实心播放钮的控制台；批次 2 给播放卡加同语言红点。其余区域一律保持安静。
- **信息编码**：色相通道从「随机装饰」改为「分类身份」（批次 2）——结构承载信息，装饰让位信息（frontend-design 纪律）。
- **数字的仪表感**：计数/倒计时/码率统一 `ui-monospace` 等宽数字（上轮已开 tabular-nums 头，本轮把「仪表数字」立为规则）。

### 3.2 三拨盘（对 ui-audit.md §一的滚动更新）

| 拨盘 | 上轮目标 | 本轮 | 理由 |
|---|---|---|---|
| DESIGN_VARIANCE | 4 | **4** | 产品 UI 维持对称；「呼吸感」由批次 2 卡片重排解决，不加艺术化偏移 |
| MOTION_INTENSITY | 3 | **3** | 只做状态反馈（播放活体/收藏弹跳/toast 入场），全部 reduced-motion 降级 |
| VISUAL_DENSITY | 5.5 | **6** | 卡片放大后空洞证明密度矫枉过正，批次 2 收回半档：min-height 100→96、meta 行收紧 |

### 3.3 品牌资产保留清单（Preserve，动 = 违约）

品牌绿 `#4fc08d`（含浅色档 `#1f7a54`）· 警示橙 `#e07a5f`/`#b5431a` · 收藏金 `#f5c542`/`#8a6508` ·
Tabler sprite 全套 · focus-visible/reduced-motion/aria 全套纪律 · 紧凑中文注释风格 · 圆角规则
（容器 10/交互件 8/pill/badge 4）· 全部既有交互语义（双击收藏/长按/键盘链路）。

### 3.4 反模板自查（frontend-design 第 2 轮校验）

- 「near-black + acid green」是 AI 模板三俗之一：本方案保留绿是**品牌存量**（favicon/安卓端一致），差异化动作在中性面三层分离与 ON AIR 语言，不在强调色上冒险——成立。
- 不做玻璃拟态/渐变堆砌/大面积 blur（国内低配 WebView 性能红线）。
- 字体不引外部字体（零依赖），个性由**字重层级 + 等宽数字 + 色彩信息编码**承担——这三样在系统字体下依然成立。

---

## 四、设计 token 体系（批次 1 的落地内容，全部色值已过 contrast-check.js）

### 4.1 新 `:root` 全量变量表（index.html:9-10 替换）

```css
:root {
  /* 面：三层中性面分离（bg 画布 / surface 面板卡 / surface2 悬停浮起） */
  --bg:#0e1216; --surface:#161b21; --surface2:#1c232b;
  --line:#262e37; --line2:#313b46;            /* line2 = hover 边框/分隔强化，装饰性豁免 3:1 */
  /* 文字：两档收敛（原 --dim 并入 --tx2；三档尝试因 surface2 底 4.48:1 不达标砍掉） */
  --tx:#e9edf2; --tx2:#9aa7b4;
  /* 强调：品牌色全保留 + 两个 soft 底（tonal 激活态/徽标底用，实色不用 alpha 保证可测） */
  --acc:#4fc08d; --acc-soft:#14352a;
  --warn:#e07a5f; --warn-soft:#2e1d18;
  --gold:#f5c542; --live:#ff6b6b;             /* live = ON AIR 直播红（图形 ≥3:1） */
  /* 阴影三档（浅色侧换深色投影基调，同变量名） */
  --sh1:0 1px 2px rgba(0,0,0,.30); --sh2:0 4px 16px rgba(0,0,0,.35); --sh3:0 10px 30px rgba(0,0,0,.45);
  /* 动效两档（§6 规范的落点） */
  --t:.16s; --tf:.10s; --ease:cubic-bezier(.2,.7,.3,1);
  color-scheme:dark;
}
:root[data-theme="light"] {
  --bg:#f3f5f7; --surface:#ffffff; --surface2:#eef1f4;
  --line:#d5dbe1; --line2:#b9c2ca;
  --tx:#1f2733; --tx2:#55636f;
  --acc:#1f7a54; --acc-soft:#e2f1ea;
  --warn:#b5431a; --warn-soft:#f7e9e2;
  --gold:#8a6508; --live:#b3362b;
  --sh1:0 1px 2px rgba(31,39,51,.08); --sh2:0 4px 16px rgba(31,39,51,.10); --sh3:0 10px 30px rgba(31,39,51,.14);
  color-scheme:light;
}
```

**实测对比度**（`contrast-check.js` §①②③，此处只录结论）：tx 15.99/14.73 · tx2 7.67/7.06/6.46(surface2) ·
acc 8.29/7.63 · acc on acc-soft 5.89 · 播放钮字 on acc 实心 8.29 · warn on warn-soft 5.45 ·
live 红点图形 6.24 —— 浅色侧 tx 13.76/15.04 · tx2 6.18/5.65 · acc 5.29/4.84/4.53(acc-soft) ·
warn-soft 上 4.68 · live 6.04。**全绿。**

### 4.2 旧变量 → 新变量机械替换对照表（实施者按此 grep 全量替换）

```bash
# 在 index.html 内执行逐个替换，改完 grep 旧名应为 0 命中：
#   var(--panel) → var(--surface)      （17 处：btn/input/chip 激活底/footer/浮层/面板…）
#   var(--dim)   → var(--tx2)          （30+ 处）
#   var(--tx)    → var(--tx)           （不变）
#   var(--line)  → var(--line)         （不变；hover 边框统一升 --line2）
#   --acc/--warn/--bg 三名不变，只换值
grep -n 'var(--panel)\|var(--dim)' index.html   # 迁移自检：应为 0 行
```

### 4.3 字阶/字重/数字

- 字号五档维持（11/12/13/14/16，上轮结论「不必加档」仍成立）。
- 字重四档立规：**650 = 品牌/台名播放态**（h1、footer 台名）、**600 = 播放态列表台名**（已有）、**500 = 台名常态**（已有）、**400 = 正文**。系统字体下 `font-weight:650` 由可变字重的系统栈消化，不可变时回退 700，无害。
- 仪表数字规则：`.cnt/.srcs/.health/.badge/#sleepLab/#song` 统一 `font-family:ui-monospace,SFMono-Regular,Consolas,monospace` + 既有 `tabular-nums`。徽标类字号 11px 保持。

### 4.4 形状/间距

- 圆角规则沿用上轮（容器 10 / 交互件 8 / chip pill / badge 4）不立变量（改动无感知收益）。
- 间距不立 scale（紧凑风格是存量资产，批量动间距风险大收益小）；卡片内部间距在批次 2 局部调。

---

## 五、分批实施（每批独立可合可回退，批次内给出代码骨架）

> 通用流程：改前跑 `npm test` 留绿 → 改 → `node docs/ui-redesign-assets/contrast-check.js` 全绿 →
> 浏览器双主题截图对照 → `npm test` 复绿 → 独立 commit（信息格式 `style(ui): 批次 N —— <内容>`）。

### 批次 0【P0 回归修复，先行单独合】~12 行，零行为变更

**改动 1 —— R-1 列表视图收缩**（index.html:125）：

```css
/* 列表视图限宽居中（UI 审计 P2-4）。width:100% 必须显式：body 是 column flex，
   交叉轴 auto margin 会阻断 stretch，子项收缩成 fit-content（实测 259px）——
   auto margin 只负责居中，撑开必须靠 width（ui-redesign R-1 实证） */
#list:not(.grid) { width:100%; max-width:900px; margin:0 auto; }
```

**改动 2 —— R-2 移动端 header 三行**（index.html:254-263 DOM 挪位 + CSS 两处）：

```html
<!-- deadBtn/themeBtn 挪进 #lowfreq（桌面 display:contents 原地渲染零变化；≤640px 自动进 ⋯ 菜单，header 稳回两行） -->
<span id="lowfreq">
  ...原有四钮...
  <button class="btn" id="deadBtn" aria-pressed="false" hidden title="..."><svg class="ic"><use href="#i-x"/></svg><span>无效源</span></button>
  <button class="btn" id="themeBtn" aria-label="主题：跟随系统，点击切换" title="..."><svg class="ic"><use href="#i-auto"/></svg><span>主题</span></button>
</span>
```

```css
@media (min-width:641px) { #themeBtn span { display:none; } } /* 桌面主题钮保持 icon-only（宽度预算） */
/* ≤640px 块（index.html:202）无需新规则——#lowfreq .btn 已有菜单项样式（无边框/hover 底色），
   deadBtn/themeBtn 作为菜单项自然继承；themeBtn 的 <span>主题</span> 在菜单里提供可见文案 */
```

**验收**：1280px 桌面 header 视觉零变化（截图对照 01）；390px header 恰两行（截图对照 06）；列表视图 #list 宽 890px、行 862px 居中；主题循环三态可点；npm test 绿。
> 本批次两个修法均已在审计时点页面完成注入实证（DOM 层预演）：R-1 见 `08-fix-verify-desktop-list.png`（列表铺满 900px 居中）；R-2 见 `07-fix-verify-mobile-390.png`（header 两行、⋯ 菜单含主题/无效源、桌面零变化）——正式实施只需把验证过的改法落进源码。

### 批次 1【token 基建】~90 行 diff，纯换值零布局变更

内容 = §4.1 变量表替换 index.html:9-10 + §4.2 对照表全量替换旧变量名 + §4.3 字重/仪表数字三行规则。
组件 CSS 本体一律**不动选择器只换 token**（凡必须动选择器的推迟到对应批次）。

**改动骨架**（仅列需要新写的，替换项按对照表机械执行）：

```css
/* 字重层级（§4.3）：品牌位 650 */
header h1 { font-weight:650; }
footer #nowline.canfind { font-weight:650; }        /* 播放中台名（footer 主标识） */
/* 仪表数字（§4.3）：在既有 .srcs,.cnt,.health,.badge 规则上追加字族 */
.srcs, .cnt, .health, .badge, #sleepLab, #song { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
```

**验收**：双主题全页截图与改前并排对照——观感变化仅限「更深一档的画布 + 面板从画布里浮出来 + hover 面」；
contrast-check.js 全绿；grep 旧变量 0 命中；file:// 抽查正常。

### 批次 2【色块系统 + 网格卡片重排】~85 行（logos.js ~30 + CSS ~40 + app.js 模板 ~15）

**改动 1 —— 分类色相制**（logos.js:36-41 重写 `phd`，新增映射表）：

```js
/* 分类→色相映射（ui-redesign R-3）：色相通道从「名 hash 随机」改「分类身份」——扫读「全部」时
   色彩即分组；同分类内以名 hash 做明度抖动（只向更暗抖，白字对比度只增不减）区分相邻台。
   cfg 重命名后的分类查不到映射时落 PAL hash 兜底，观感仍成立 */
  CAT_HUE: { '华语音乐':45, '欧美音乐':205, '国际新闻·谈话':4, '新闻资讯':4, '交通广播':25,
             '文艺生活':280, '财经':172, '亚洲·港台':330, '综合·其他':235, '常听':145, '未分类':-1 },
  /* 精选 11 色板 [h,s,l]：白字全检 ≥4.5:1（contrast-check.js §④），石板灰兜底未收录分类 */
  PAL: [[4,.42,.42],[25,.45,.40],[45,.50,.33],[80,.45,.33],[145,.38,.34],[172,.40,.33],
        [205,.42,.38],[235,.38,.46],[280,.38,.45],[330,.45,.40],[215,.14,.44]],
  phd(s) {
    const n = s.n.replace(/\s*\[[^\]]+\]\s*$/, '');
    let h = 0; for (const c of s.c + '|' + s.n) h = (h * 31 + c.charCodeAt(0)) | 0;
    const hue = this.CAT_HUE[s.c] !== undefined ? this.CAT_HUE[s.c] : null;
    const p = hue !== null && hue >= 0 ? this.PAL.find(x => x[0] === hue)
      : this.PAL[((h % 10) + 10) % 10];                       // 未收录分类：hash 从色板取（确定性不变）
    const dark = Math.abs(h) % 3;                             // 同分类明度抖动：0 / -1.5% / -3%，只向暗抖
    return { ch: ([...n][0] || '?').toUpperCase(), bg: `hsl(${p[0]} ${p[1] * 100}% ${Math.max(20, p[2] * 100 - dark * 1.5)}%)` };
  },
```

（`phf`/`img`/`visual` 同步把 `data-hue` 换成 `data-bg` 整串传递，`hsl(...)` 直接进 style.background；~8 行随改。）

**改动 2 —— 卡片重排**（index.html:112-123 CSS + app.js:436 模板微调）：

```css
.card { ... min-height:96px; padding:12px; gap:6px; }        /* 100→96：批次3 亲测空洞主因是 logo 高度不足 */
.card .logo { width:44px; height:44px; border-radius:10px; }  /* 40→44：头行撑起来，中段空洞收半档 */
.card .logo.ph { font-size:19px; }
.card:hover { border-color:var(--line2); box-shadow:var(--sh1); } /* 悬停 = 面+影双层反馈（此前只有底色） */
/* ON AIR 红点：playing 卡台名前（与 footer LIVE 同语言；呼吸条保留，两者分工=近看呼吸条/扫读红点） */
.card.playing .cname::before, .row.playing .name::before { content:''; display:inline-block; width:7px; height:7px;
  border-radius:999px; background:var(--live); margin-right:6px; vertical-align:1px; animation:pulse 1.6s infinite; }
/* 旧 '▶ ' 前缀删除（内容伪元素换成红点，连playing态文字色保持 acc 不变） */
```

```js
// app.js render() 卡片模板（:436）不变——红点走 CSS 伪元素，JS 零改动；.dead 卡增加：
// .card.dead { background:var(--warn-soft); border-color:transparent; }  停运徽标底已有 warn-soft 配对（对比度 §②）
```

**验收**：华语音乐分类视图全 amber 系（抖动三档可辨）、欧美全蓝系、「全部」视图色彩成组；白字色块
contrast-check §④ 全绿；playing 卡红点双主题可见（图形 3:1 过）；卡片空洞对照截图收窄；reduced-motion 下红点静止。

### 批次 3【footer 播放台——签名元素】~120 行（index.html DOM+CSS ~90 + app.js ~10）

**DOM 重排**（index.html:269-292，id 全保留，app.js 接线零变化）：

```html
<footer>
  <div id="prog" hidden><i></i></div>
  <button class="play" id="pp" aria-label="播放 / 暂停"><svg class="ic"><use href="#i-play"/></svg></button>
  <button class="btn ghost icobtn" id="refreshBtn" aria-label="刷新，回到直播最新处" title="..."><svg class="ic"><use href="#i-sync"/></svg></button>
  <div id="now" aria-live="polite">
    <div id="nowline" role="button" tabindex="0">未在播放</div>
    <div id="song" role="button" tabindex="0" hidden></div>
  </div>
  <span id="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span> <!-- 3→5 杆 -->
  <span id="status" role="status" aria-live="polite"></span>
  <span class="fspacer"></span>
  <span id="sleepWrap">...</span>
  <span id="srcWrap" hidden>...</span>
  <button class="btn ghost icobtn" id="muteBtn" aria-label="静音" title="...">...</button>
  <input type="range" id="vol" min="0" max="100" value="90" aria-label="音量">
</footer>
```

**CSS 骨架**：

```css
footer { ... background:var(--surface); border-top:1px solid var(--line); box-shadow:0 -4px 16px rgba(0,0,0,.18); } /* 控制台上浮 */
.play { width:40px; height:40px; border-radius:999px; border:none; background:var(--acc); color:#0e1216;
        cursor:pointer; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto;
        transition:transform var(--tf) var(--ease), filter var(--t); }
.play:hover { filter:brightness(1.08); } .play:active { transform:scale(.96); }
.play .ic { width:18px; height:18px; }
#eq { height:16px; gap:2px; } #eq i { width:3px; height:5px; }
#eq.on i { animation:eq .9s ease-in-out infinite; }  /* 5 杆 delay 0/.18/.36/.54/.72（i:nth-child 逐杆） */
#nowline { font-weight:650; }  /* 播放台主标识（§4.3）；#pp.icon 从 innerHTML 切换逻辑不变 */
.icobtn { width:34px; height:34px; padding:0; justify-content:center; }
.fspacer { flex:1; }
```

**app.js 唯一配套**：`playerNow()`（:558-574）的 `$('pp').innerHTML` 切换逻辑不变（id 没动）；
`#eq` 由 3 杆变 5 杆是静态 HTML，`eq.on` 的 toggle 不变。

**验收**：未播态 = 绿色空心感不变（实心钮 + ▶ 深色字 8.29:1）；播放态 = LIVE 感「两米可辨」；
footer 高度桌面 56px±4、双主题截图对照；睡眠/选源浮层锚点不错位（都相对各自 wrap 定位）；移动端见批次 5。

### 批次 4【header 层级 + 分类条】~70 行（CSS 为主 + app.js 一处模板）

```css
/* ghost 分层（R-4）：低频操作退后，视图 seg 与 维护 保持描边 */
.btn.ghost { border-color:transparent; background:transparent; color:var(--tx2); }
.btn.ghost:hover { background:var(--surface2); color:var(--tx); border-color:transparent; }
#syncBtn,#healthBtn,#importBtn,#exportBtn { ... }  /* 挂 ghost 类（index.html DOM 加 class） */
/* 视图 seg 激活态 tonal 化 */
.seg .btn.on { color:var(--acc); border-color:var(--acc); background:var(--acc-soft); }
/* chip 激活态 tonal 化 + 计数仪表数字 */
.chip.on { color:var(--acc); border-color:transparent; background:var(--acc-soft); }
.chip .n { font-family:ui-monospace,monospace; }
/* 列表行右端信息右对齐（R-1 次生）：健康标记/源数靠右，行右侧不再是死空白 */
.row .meta { ... } .row .health { margin-left:auto; } .row .l1 .health { margin-left:auto; }
/* 搜索框：内嵌放大镜（span 包裹 + data-URI-free：直接用 sprite #i-search 新增 1 个 symbol，Tabler search path） */
.srch { position:relative; flex:1; min-width:140px; }
.srch .ic { position:absolute; left:10px; top:50%; translate:0 -50%; color:var(--tx2); width:14px; height:14px; }
.srch input { width:100%; padding-left:32px; ... }  /* 原 #q 样式随行 */
```

（app.js 改动仅 2 处：导入/导出若按 D3 收进 `#lowfreq` 则是 index.html DOM 挪位；搜索框包 `.srch` span 后 `$('q')` id 不变零改动。）

**验收**：1280px header 三层可辨（seg/维护 > 同步/体检 > ghost 低频）；「全部」chip 激活态为绿底 tonal；
键盘焦点环在 ghost 钮上仍清晰（outline acc 不受透明边框影响）；双主题截图对照。

### 批次 5【移动端专项】~50 行（全在 @media 块）

```css
@media (max-width:640px) {
  /* footer 单行化（开放决策 D2 默认档）：音量滑杆退场（触屏惯例=硬件音量键），静音键保留 */
  #vol { display:none; }
  footer { gap:10px; padding:8px 10px; }
  /* 触控命中区复核：fav 已 37px；icobtn 34px 达标（WCAG 2.5.8 ≥24）；chip min-height 30 保持 */
  /* 更多菜单项可见文案：ghost 化的导入/导出在菜单里保留文字 span（桌面若有隐藏则媒体查询反向恢复） */
}
```

**验收**：390px header 两行、footer 单行 ~52px；更多菜单可达全部低频操作 + 主题/无效源；
横屏 844×390 不破版；触屏长按收藏/双击播放回归正常。

### 批次 6【面板/浮层/空态/微动效收尾】~80 行

```css
/* 浮层统一 .pop 语言（sleepMenu/srcMenu/songhist/keys/toast 五处收 sh3 + 统一 padding） */
#sleepMenu,#srcMenu,#songhist,#keys,#toast { box-shadow:var(--sh3); }
/* 维护面板（R-9 本期只做样式收敛）：遮罩加深 + 卡片浮起 */
#manage { background:rgba(8,10,13,.62); }
.mbox { box-shadow:var(--sh3); }
/* toast 入出场（R-7）：入场滑升，出场直接隐（无 JS 改动，hidden 机制保持） */
@media (prefers-reduced-motion: no-preference) { #toast:not([hidden]) { animation:toastin .18s var(--ease); } }
@keyframes toastin { from { opacity:0; transform:translateY(6px); } }
/* 收藏星弹跳（E 批追加）：toggleFav 后由 CSS :active 之外补一次性动画（类挂 300ms 自清，app.js toggleFav +2 行） */
.fav.pop svg { animation:favpop .3s var(--ease); }
@keyframes favpop { 40% { transform:scale(1.25); } }
/* 空态插画（R-8）：emptyHtml() 追加内嵌小收音机 SVG（12 行 path，currentColor 描边，随主题） */
```

```js
// app.js emptyHtml()（:405）骨架：
emptyHtml() {
  const msg = ...原有四分支...;
  return `<div class="empty"><svg class="empty-ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M6 7l10-4"/><circle cx="9" cy="14" r="2.5"/><path d="M15 12h4M15 16h4"/></svg><div>${msg}</div></div>`;
}
// toggleFav()（:267）骨架：新收藏分支 push 后给按钮挂 pop 类（重渲后按 data-fav 找回挂 300ms 自清）
```

**验收**：浮层阴影统一；面板/浮层 Esc/焦点链路回归（上轮 P2-7 逻辑零改动）；空态插画双主题清晰；
reduced-motion 全部静止；`npm test` 绿。

---

## 六、交互与动效规范

| 项 | 值 | 适用 |
|---|---|---|
| 快过渡 `--tf` | .10s | 按压 scale、图标微变 |
| 标准过渡 `--t` | .16s | hover 面/边框/颜色 |
| 缓动 `--ease` | cubic-bezier(.2,.7,.3,1) | 位移类（toast 入场/fav 弹跳） |
| 呼吸/脉冲 | 1.6s / 1s（既有） | playing 卡呼吸条、LIVE 红点、connecting |
| 频谱 | .9s 交错（既有 eq 节奏拉 5 杆） | 播放中 |

**动效白名单纪律**（新增动画仅限上表；一切新动画必须落入既有
`@media (prefers-reduced-motion: reduce)` 闸门——index.html:48 的全局 `*{transition:none!important}` +
逐项 `animation:none`）。**不做**：入场级联、滚动视差、marquee 跑马灯（曲名溢出维持 ellipsis+title）。

---

## 七、可访问性与验收基准（全批次总闸门）

1. **对比度**：`node docs/ui-redesign-assets/contrast-check.js` 全绿（任何改色先进脚本）。装饰性边框不作 3:1 主张（WCAG 1.4.11 豁免），但 focus 环（acc）、LIVE 红点、播放钮字等**功能性图形/文字全检**。
2. **键盘链路**（每批收尾跑一遍）：`/` 聚焦搜索 → 输入过滤 → `↓` 进列表 → `↑↓/Home/End` 导航 → `Enter` 播放 → `Space` 暂停 → `R` 刷新 → `Esc` 关浮层 → `?` 帮助 → `Tab` 只在 roving 落点停靠。
3. **触屏**：fav 37px / icobtn 34px / chip 30px 达标；双击播放并收藏、长按收藏、防误触（stamp 作废）行为不变。
4. **读屏**：`#now` aria-live 单点播报、chip aria-current、视图钮 aria-pressed、面板 focus-trap + 焦点归还——全部既有语义零回归。
5. **截图回归矩阵**（每批 + 收尾全量）：{深,浅} × {网格,列表} × {空闲,播放中} + 390px 移动端 + 维护面板 + 欧美分类，对照 `docs/ui-redesign-assets/` 基线。主题切换后等 ≥300ms 再截（上轮教训：compositor 黑块假象，以 computed style 复核）。
6. **file:// 抽查**：双击 index.html 打开——列表直出、直流台可播、维护面板/主题/视图开关可用（本方案全部为 CSS/DOM 层，无后端依赖点）。
7. `npm test` 全绿（本轮零 JS 行为变更项 = smoke 不受影响；批次 2 动 logos.js 属纯函数改动，现有 fixture 口径不涉台标色块）。

---

## 八、契约与风险

- **零新增 radio.\* 持久键**（已核 §5 各批：全部 UI 态复用既有 view/showdead/theme 三键或纯 DOM）——
  store.js KEYS / server.js STORE_KEYS / android C.KEYS / contracts/radio-keys.json / test/contracts.js **全部不动**。
- **服务器零改动**（server.js/update-sources.js 不涉）；**Android 零改动**（分类色相映射是 Web 显示层，不进契约；
  安卓侧若日后想要同款色块，映射表可从本文档 §批次 2 抄，属各自实现）。
- **风险清单**：
  - R1（低）：token 全量替换漏改某处 → grep 旧变量名 0 命中自检兜住。
  - R2（低）：`phd` 分类映射漏新分类 → PAL hash 兜底已内建，观感不塌。
  - R3（中）：批次 3 footer DOM 重排 → 浮层锚点/sleepWrap/srcWrap 相对定位全保留原 id 与嵌套关系，
    回归点在「睡眠菜单/选源菜单弹出方向」，验收单列。
  - R4（低）：`width:100%` 修法与未来 `#list` 上其他 margin 规则冲突 → 已注释根因。
- **回滚**：每批独立 commit，任意批 revert 不牵连其他批（批次 1 token 是后续批次的地基，若回滚批次 1 则 2-6 需同回滚）。

---

## 九、开放决策点（owner 拍板后开工；默认档 = 推荐档）

| # | 决策 | 选项 | 推荐 | 影响 |
|---|---|---|---|---|
| D1 | 色块信息编码 | a 分类色相制（本方案）/ b 精选色板+名hash（无语义）/ c 单色品牌化 | **a** | 批次 2 |
| D2 | 移动端音量滑杆 | a 隐藏（硬件音量惯例）/ b 保留现双行 footer | **a** | 批次 5 |
| D3 | 桌面导入/导出是否收进 ⋯ 菜单 | a 收（header 减 2 钮）/ b 不收（保持一键直达） | **a**（低频 × 有 ⋯ 惯性） | 批次 4 |
| D4 | 播放钮形态 | a 实心绿圆钮 / b 维持描边方钮 | **a** | 批次 3（签名元素核心，动它才算动） |
| D5 | 空态插画 | a 加内嵌 SVG / b 纯文字 | **a**（~12 行） | 批次 6 |
| D6 | 维护面板 prompt()/confirm() 替换 | a 本期不做（样式收敛即可）/ b 内联编辑重做 | **a**（牵焦点/键盘流，另立项） | 挂账 |

---

## 十、附录

### 10.1 取证资产索引

| 文件 | 内容 |
|---|---|
| `docs/ui-redesign-assets/01-desktop-dark-grid.png` | 桌面深色网格（R-3 色块噪音/R-6 卡片空洞/R-4 按钮汤） |
| `02-desktop-light-grid-toast.png` | 桌面浅色 + 基线 toast 遮挡（R-7） |
| `03-desktop-light-list-broken.png` | **R-1 回归实锤**：列表视图收缩 259px 居中 |
| `04-eu-light-grid.png` | 欧美分类浅色（国别剥 meta 后的卡片观感） |
| `05-manage-panel.png` | 维护面板分类页 |
| `06-mobile-390-dark.png` | **R-2 回归实锤**：390px header 三行 |
| `07-fix-verify-mobile-390.png` | 批次 0 修法实证：390px header 压回两行 |
| `08-fix-verify-desktop-list.png` | 批次 0 修法实证：桌面列表视图 900px 铺满居中 |
| `contrast-check.js` | 色值单一事实源（§4/§5 全部主张可复跑） |

### 10.2 关键代码锚点（实施时以符号定位为准，行号随实现漂移）

| 锚点 | 位置 |
|---|---|
| `:root` token | index.html:9-10 |
| `#list:not(.grid)` 限宽 | index.html:125 |
| header DOM / `#lowfreq` | index.html:246-265 / 254 |
| footer DOM | index.html:269-292 |
| ≤640px 媒体块 | index.html:202-210 |
| reduced-motion 闸门 | index.html:48 |
| `Logos.phd`（色块参数） | logos.js:37-41（批次 2 重写） |
| `Logos.visual/img/phf` | logos.js:44-64（批次 2 随行 data-bg） |
| `App.render()` 行/卡模板 | app.js:412-448（批次 2 微调） |
| `App.playerNow()` footer 刷新 | app.js:558-574（批次 3 核对 id） |
| `App.emptyHtml()` | app.js:405-411（批次 6） |
| `App.toggleFav()` | app.js:267-272（批次 6 pop 类） |

### 10.3 实施顺序与估量汇总

```
批次 0（~12 行，P0 回归，先行单独合）
  → 批次 1（~90 行 diff，token 地基）
  → 批次 2（~85 行，色块+卡片）
  → 批次 3（~120 行，footer 签名件）
  → 批次 4（~70 行，header+chip）
  → 批次 5（~50 行，移动端）
  → 批次 6（~80 行，收尾+回归）
合计 ~500 行 diff，六个独立 commit；每批 ≈ 半天含回归。
```

---

*本方案由 2026-11-15 全面取证产出：真实运行多状态截图 + 布局 rect 实测 + WCAG 脚本全检 + P0 修法页面实证；
两处回归（R-1/R-2）有截图与数值双实锤。证据文件随实施批一起提交（沿用 ui-audit-assets 惯例）。*
