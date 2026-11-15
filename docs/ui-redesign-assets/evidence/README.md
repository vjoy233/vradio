# evidence/ 采证目录与 head 元数据不变式（AIbot 四轮可追溯性意见的处置说明）

每期 `evidence.json` 的 `head` 字段 = **采证时刻的代码提交**（`git rev-parse --short HEAD`，由脚本的提交态门保证采证只发生在已提交状态）。

承载 `evidence.json`/截图的那次 **产物提交本身会移动分支 head**——采证文件无法记录"包含自己的提交"的哈希（自指悖论），因此 `head` 与 PR 最新 head 之间恒差一个**仅改产物的提交**。这是结构性不变式，不是证据过期：

## 验证方法（任一 PR）

```bash
git log -1 --format='%h %P' <产物提交>   # 父提交应 === evidence.json 的 head
git show --stat <产物提交>                # diff 应仅 docs/ui-redesign-assets/evidence/** 文件
```

两条都满足 ⇒ evidence.json 精确对应 PR head 的代码态（产物提交零代码/脚本改动）。

若产物提交还混入了代码/脚本改动，则该证据作废，须在该 head 重新采证（脚本提交态门会拦截脏工作区）。

## 结论口径

- "某 head 已验收" 的准确表述 = 该 head 的代码态被证据覆盖（按上述不变式验证成立即成立）。
- 合并链尾的最终验收仍按 AIbot 建议在最终 head 重跑一次本目录脚本刷新证据。
