# VRadio UI参考原型与截图

本目录为隔离视觉/交互参考，不是正式播放器实现。唯一实施规格见 [实施方案](../docs/ui-redesign-plan-2026-11.md)。

## 查看

在仓库根运行 `npm start`，浏览器打开 `http://127.0.0.1:8137/ui-demo.html`。

样例只在内存中运行：不读写Store、不访问/api、不修改my-radio、不播放真实音频。刷新页面会恢复样例。

可操作：范围/分类/搜索、搜全部、网格/列表、收藏、模拟点播/刷新/来源/睡眠/音量、三态主题、维护名称/分类/隐藏、保存/取消、离开确认、模拟冲突、隐藏撤销。完整备份恢复只是静态预览，源生命周期只给层级参考，正式能力按B1/B4接入。

窄屏维护用于说明共用新流程；原型窄屏电台库/播放器不是正式手机UI替换稿。正式版保留已有紧凑日常布局。

## 截图和验证

交付截图已直接附在 `docs/ui-redesign-assets/reference-v2/`，没有开发工具也能查看。

`capture.cjs` 是可选的开发截图脚本，**不是项目运行/测试依赖**。仅在开发机已有Playwright与Chromium时复现，不向package.json添加依赖：

```powershell
# 另一个终端先在仓库根 npm start
# 路径指向开发机现成Playwright包目录；未设置时按标准Node模块解析
$env:VRADIO_PLAYWRIGHT = 'C:/path/to/existing/playwright'
node ui-demo/capture.cjs
```

脚本仅访问隔离demo；覆盖55项浏览器断言、10种宽度，生成15张PNG和validation.json。固定deviceScaleFactor=1、reduced-motion=reduce以稳定截图。`VRADIO_DEMO_URL`可覆盖默认本地预览地址。

文档控制器助手验证（只用Node内置模块，无需Playwright）：

```powershell
node docs/ui-redesign-assets/verify-handoff.cjs
```

正式项目回归仍运行 `npm test`；原型通过不能替代真实播放、Store对账、B4恢复和跨浏览器验收。