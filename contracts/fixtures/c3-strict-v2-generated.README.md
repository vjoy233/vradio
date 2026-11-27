# C3 v2 离线共享样本

基于 `docs/c3-strict-v2-proposal-2026-11.md` 的**待评审**提案，不是冻结契约；没有实现或验证 JS/Kotlin v2 解析器，也不授权联网或生产发布。原有概念草案 `c3-strict-v2-cases.json` 保留，新增 `c3-strict-v2-generated.json` 为字节级材料。所有地址为合成示例，格式通过不代表连接安全。

- `sidecar[].rawBase64` 精确解码为原始字节，不可解析后再序列化；`sha256` 和 `bytes` 针对解码字节。`accept` 是期望，接受时 `output` 是完整 JSON 值，并非规定消费者 API 返回形态。
- `pointer[]` 含 pointer 原始字节、以 pointer 引用 id 为键的 generation，以及各代 manifest/sidecar 原始字节。`expected` 指定选用状态和可用时完整内容。刻意失配的样本不能被生成一致性测试当作合法协议接受。
- 旧 `cross-commit` 样本及其 `binding.currentCommit/previousCommit` 易混淆上游 S 与投递 D，已弃用并替换。`deliveryBinding` 的 `pointerRevision/currentRevision/previousRevision` 仅为环境提供的投递 revision 情景，不是线上字段或来源可信证据；generation 内 `commit` 为 sidecar 上游 S，不是投递 revision。同一投递 revision 可含不同 S；跨投递 previous 不可冒充同次投递。取得并认证 D 的接口、错误分类、previous 回退是否标降级、本地缓存撤销策略、冲突错误优先级均未定义。无效 pointer 的远端不可用不等于禁止 Android 的独立本地回退。
- `node test/c3-v2-fixtures.js` 检验固定生成器字节、摘要、长度和预期输出的基础一致性；**不验证拒绝行为、网络、防 SSRF、生产者或任何平台解析器**。重新生成：`node test/fixtures/c3-v2-generator.js > contracts/fixtures/c3-strict-v2-generated.json`（重定向须保持原始 UTF-8 无 BOM 和 LF；Windows PowerShell 推荐 Node `writeFileSync` 写入子进程字节）。生成器位于 test 子目录，避免被测试入口当作独立测试执行。
- `controls` 提供 manifest/pointer 的 4096/4097 字节边界；`localFallback` 模拟无效 pointer 下独立的本地回退，撤销策略结果由环境注入，不定义策略或错误优先级。
- 这些样本不穷尽所有边界；更多 UTF-8/URL 对抗、两端实际消费、独立评审及设备验证均未完成。
