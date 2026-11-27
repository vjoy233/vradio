# C3 跨端严格格式 v2：待评审提案

本提案基于 Web #73 的 86f29d8、Android #75 的 253267f，并参考 #85 的 d59afe0 设计及后续 previous 边界讨论；不是已冻结契约或生产发布许可。v1 实验解析器在跳过、强制类型、去重和限长上不同，不能当作 v2 消费器；不改 radio.txt、用户备份或四资产。C3 继续默认关闭，未接入任何实现。共享样本仅是离线合成测试，不是来源、许可、真实试听或安全证据。

## 推荐规范（评审通过并双端实现后才冻结）

- v2 是独立协议，不原位重新解释 v1；新建独立路径和版本字段，不双读、不自动迁移。若需要旧快照，必须经受控生产者重新生成并通过新校验；不对历史内容静默修复。不得改正式资产。
- JSON 为严格 UTF-8，拒 BOM、无效编码、重复对象键、尾随内容和非标准 JSON；各对象只允许列出的字段，所有字段必填，严格检查类型，不做 String/数字强制。超限读取时立即中止，不先无界缓冲。sidecar 原始字节最大 524288，manifest/pointer 各 4096，items 最多 300。空 items 是合法空快照，不触发 previous 回退；无效一律整代失败，不跳项、不截断。
- sidecar 字段：整数 `v`=2；`source` 固定 `recommended-radio-streams`；`license` 固定 `CC0-1.0`；`commit` 为 40 位小写十六进制；`generatedAt` 必须是严格有效 UTC `YYYY-MM-DDTHH:mm:ss.SSSZ`，不接受闰秒或 24:00；`items` 是数组。每项必有字符串 `name`、`url`、`genre`、`upstream`、`commit`；后两者分别严格等于 source 和顶层 commit。名称非空、最多 200 个 UTF-8 字节，genre 可空、最多 120 个 UTF-8 字节；两者拒绝 C0/C1 控制字符、不自动裁剪或截断。拒绝不成对代理字符；URL 最多 2048 UTF-8 字节。
- URL 用双方共同实现的保守 ASCII 子集：必须为小写 `http://` 或 `https://`，无用户信息、空白、反斜线、片段、非 ASCII 或控制字符；host 必须为 ASCII DNS 名称（标签字母数字及内嵌连字符，首尾字母数字）或 IPv4 十进制四段（不允许前导零，每段 0–255），可选十进制端口 1–65535；路径和查询只能使用 RFC 3986 非保留字符、保留字符及合法 `%HH` 转义。仅由数字和点组成的 host、以及任何以数字开头的末尾标签（包括十进制、八进制和 0x 十六进制形式）均不得按 DNS 名称接受：只允许严格四段十进制 IPv4，防止 WHATWG 或系统解析器将数字域名归一为 IP；此限制按 ASCII 不区分大小写匹配，禁止末尾点；非末尾 DNS 标签可以数字开头。DNS 标签最长 63 字节、整个 host 最长 253 字节。禁止 IPv6 和 IDN 原样输入；生产端可自行提供合规 ASCII 地址但消费端不得改写。以上是格式约束，不是 SSRF 防护或联网许可，后续联网必须另行实现连接级防护。
- URL 按原始字符串逐字节比较；重复 URL 整代失败。保持输入顺序，不执行排序或分类映射；生产者需要稳定排序时明确按 UTF-8 字节升序生成，不改变消费者身份。未知字段也失败，以防不同端忽视同名扩展。
- manifest 为 `{v:2,sha256,bytes}`；sha256 是 sidecar 原始字节的 64 位小写十六进制 SHA-256，bytes 是 1–524288 的整数；每代必须满足 pointer 中该代的 id = manifest.sha256 = sidecar 原始字节 SHA-256，且 manifest.bytes 必须完全匹配原始字节长度；不得仅验证 manifest 与内容而忽略 pointer id。hash 只证明字节一致，不证明来源或许可。pointer 为 `{v:2,current,previous}`；current 必须为 64 位小写 hash，previous 可为 null（首次）或 64 位小写 hash，非空时不得等于 current。路径只拼接经过严格校验的 hash。
- 区分两个独立身份域：`deliveryRepository` 是可信投递仓库，`deliveryRevision`（D）是该仓库中预先确定且不可变、经可信策略验证的修订；sidecar 顶层 `commit` 和每项 `commit` 表示被采集的上游修订 `upstreamCommit`（U），不是投递修订。D 与 U 属于不同仓库或历史，D≠U 完全合法，不得直接比较。`deliveryRepository`、`deliveryRevision` 是受控投递上下文，不是此处新增的 sidecar 字段；`upstreamCommit` 是既有 `commit` 字段的语义名称。可由可信策略提供可选 `expectedUpstreamCommit`：提供时，每个准备采用的代之 U 必须严格等于该值；不提供时只检查 U 格式与顶层/条目一致，不能声称已验证来源。previous 可有不同 U；若配置 expected 值则 previous 同样必须匹配，不能绕过该策略。
- 固定可信的 (`deliveryRepository`, `deliveryRevision`) 后，pointer 与其引用的每代 manifest 和 sidecar 都必须从这个相同可信 tree 的指定路径获取；不得通过可变分支或独立读取的 HEAD 混代。每个被使用的文件必须在该 tree 中存在，且按前述 id/manifest/原始字节校验。投递修订、仓库信任、tree 成员及可选上游期望的真实性必须由未来单独审查的受控机制验证；JSON 自报、hash 与纯 fixture 不能证明来源、许可或 tree 成员关系。
- pointer 自身无效则远端失败关闭，不猜测远端代；仍可尝试下述经重新验证的 Android 本地旧代，必须标明本地回退。有效 pointer 的 current 有效时使用 current；previous 非空但在同一 tree 中缺失或校验无效时使用 current 并标记降级。current 无效时仅在 previous 存在于同一可信 tree 且满足上述全部校验与可选上游期望时回退 previous；否则远端快照不可用。Android 可在明确区分来源与状态的前提下回退到本地已验证的跨 deliveryRevision 旧代；使用前须按当前可信策略重新验证哈希、schema、投递来源、可选上游期望和撤销策略，本地回退不能冒充同 tree 远端 previous，也不影响主库。上述机制尚未实现，本提案不授权联网。空代有效且不回退。

## 交付与验证顺序

1. 独立评审上述取舍（包含 URI、重复键、空代及回退）；不得把本草案当作既有 v1 的冻结结论。
2. 分别基于 #73、#75 构建 v2 纯解析器，不启用开关、无网络/文件/UI/资产接线；共同读取 `contracts/fixtures/c3-strict-v2-cases.json`，断言完整输出、拒绝行为和指针状态；原始字节案例须避免重新序列化。补充 300/301 项、多字节边界、重复键、UTF-8 非法字节、大小写、hash/长度及跨 commit 对抗。不得为通过 fixture 复制对端实现而漏掉自己的真实入口。
3. 对生产者及两端消费者、已存在实验快照、空代和回滚单独做兼容评估；完整离线、设备和安全验证后另行决定是否合并或发布。不得以单端单测替代跨端真实运行，不以 fixture 冒充测量、许可或人工试听。开关继续关闭，C3 总体 No-Go。
