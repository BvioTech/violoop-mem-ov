# 旧记忆迁移

服务首次启动、获取 socket 所有权并等待 OpenViking 就绪后，自动启动旧记忆迁移。PC 记忆页【记忆迁移】通过 `graph.pipeline.run {target:"migration"}` 独立启动、恢复或重试迁移；它与【立即图化】分开。打开页面本身只查询状态。无旧数据库时跳过，不创建空数据库。

## 输入

默认读取 Memory 数据目录中的 `graph.db`，可用 `VIOLOOP_LEGACY_MEMORY_DB` 指定另一个旧数据库。仅支持本项目旧版 graph.db，不处理 qmd。读取连接使用 readonly 和 query_only，不运行 GraphStore 的建表、迁移或写入逻辑。使用一致性读事务；在线源库应保持原数据库及 WAL 完整，不要只复制正在使用的主文件。

只迁移 memories、entities、relations。episodes 和来源表只读取关联所需字段，不把历史聊天作为迁移输入。首次启动固定清单与批次，此后旧数据视为冻结，不做增量版本扫描。

## 分组和时间

1. 遍历条目，通过与 `provenanceByKey` 相同的 note:<key> / observation hash / relation source 关联，组成条目、其贡献的实体事实和关系的整体。使用条目 created_at。
2. 处理没有关联的条目，使用其 created_at。
3. 处理未覆盖的实体事实和属性，再处理未覆盖关系。关系附带两端 ID、名称、类型、别名，不展开邻接图。使用各源记录 created_at。

实体是否完成按其所有事实及属性的覆盖情况判断，不能因实体名称出现过就完成。共享关系可以出现在不同条目的完整关联组中，但不会再次加入剩余关系集合。原始 ID 和迁移说明标识重复证据。

按 o200k_base 计算正文、时间、来源说明和每消息 8 token 开销，顺序装入目标 5000 token 批次。不拆分条目关联组、单条条目、实体卡片或单条关系。一个整体超出 5000 时单独提交、不截断；模型容量不足将失败，不算完成。5000 不是模型总上下文上限，不包含 OpenViking 系统提示、预取记忆和输出。

每份材料保留独立 created_at 和正文内的记录时间；混合批次不能用迁移当天作为统一时间。原始明确日期保留，实体追加事实沿用实体 created_at 是本版接受的限制。

## 原生抽取与模型

OpenViking 根据 source_message_ids 的 `violoop-legacy-migration:` 前缀识别专用输入，添加迁移说明，仍使用所有正常启用的记忆类型和原生写入/索引流程。正文中的同名字符串不能自行激活迁移。原生 `/ready` 必须报告 `violoop_legacy_migration:1`，旧运行时拒绝启动迁移。

原生提取的系统说明经 Memory 模型桥标记为迁移请求。Device 继续用 memory_graph 的正常模型选择，只对本次调用排除 gemma-4-e4b-it；用户配置的其他模型、其他自建模型、默认模型、tier/current 回退及鉴权/额度逻辑不变。普通聊天记忆抽取不受该排除影响。

### 迁移检索查询

仅旧记忆迁移使用结构化查询提取：程序从原始材料中选择条目标题、标签和正文，实体名称、类型、别名、事实与属性，以及有方向的关系和两端身份。去掉重复迁移说明、JSON 包装、数据库 ID、记录 created_at/updated_at、置信度等内部元数据；正文内的日期、否定、不确定性和关系有效期仍作为事实保留。完整材料及时间参照继续送给抽取模型，批次、来源 ID 和持久化文件不变。

每批仍然只查询一次，总上限保持 **5000 字符**（不是分批时的 5000 token）。各迁移单元均分可用字符，短单元未使用的空间让给长单元；单元内部再在条目、实体卡片和关系之间分配，避免长条目或高连接度实体占满查询。相同完整卡片/关系去重，不把不同实体的同一句事实误合并。查询可能因预算截断，抽取材料不截断。无法识别的输入格式整批回退到原查询构建方式。普通对话继续使用原查询逻辑。

依赖最小化回归测试：在 OpenViking 源码目录运行 `python3 tests/session/memory/test_legacy_migration_query.py`。覆盖 5000 字符上限、迁移单元及关系覆盖、重复内容、日期和否定保留、格式回退和普通对话隔离；不代表检索质量或设备耗时已经实测。

## 迁移使用云端 BGE-M3

托管模式下，带旧记忆迁移标记的向量请求通过本机 Device 的 `/internal/memory/embeddings` 调用模型网关的 `bge-m3`。日常抽取、索引、搜索和召回仍使用本地 BGE。

Device 复用现有 `/llm/key` 流程，用当前登录用户和设备身份领取网关地址及短期 Key，并自动续期。首次使用可等待正在进行的凭证领取；网关返回 401 时重新领取并重试一次。未登录、凭证暂不可用或服务端没有下发直连地址时返回错误，不回退本地向量。请求固定发送 `encoding_format: float` 和 `cache: {"no-cache": true, "no-store": true}`，避免网关混合缓存导致的向量错配。

不再读取 `VIOLOOP_MIGRATION_EMBEDDING_URL`、`VIOLOOP_MIGRATION_EMBEDDING_API_KEY_FILE` 或旧 YAML 中的同名配置，不需要部署共享云端密钥。Memory 与 Device 之间仍使用本机自动生成的 `model-gateway.key`，它不是云端 Key。

`OPENVIKING_DEVICE_MODEL_URL` 指定 Device 本机模型接口（默认 `http://127.0.0.1:9090/internal/memory/chat/completions`），向量路径从它推导。`VIOLOOP_MIGRATION_EMBEDDING_TIMEOUT_MS` 可选，默认 60000 毫秒。

迁移前检索查询、迁移写入的记忆文件和目录摘要均携带专用内部标记，标记随持久向量队列、重启及重试传递；普通写入与迁移分组，不串用模型。迁移使用独立串行队列，不占用本地 BGE 队列。失败交给既有迁移重试/暂停机制处理。

部署需同时更新 Device 和 Memory，并打包支持 `violoop_migration_embedding: 1` 的 OpenViking 运行时；缺少能力的运行时拒绝启动迁移。仅切换向量计算服务，不重建已有索引，不修改迁移检查点，不删除旧数据库或原始记忆。

## 持久化和恢复

`<Memory数据目录>/legacy-migration/state.json` 保存资源覆盖、固定批次索引、任务状态和用户已启动标志，`batches/<hash>.json` 保存每次固定请求。文件 0600，目录 0700；更新用临时文件、fsync、rename。部署与备份保留整个目录以及原生工作区和 `openviking-adapter/ingests`。

accepted 只表示提交。只有原生 completed 才减少未处理数量，零产出也完成。重启后继续已启动的任务；失去响应时通过本次尝试的原请求 hash 查询 journal，确认 not_found/retryable 才重发同一请求。failed 保留错误原因，跳过该批继续后续批次；写入或提交结果未确认、原任务与归档终态都缺失时也统一视为 failed；cancelled 仍暂停整轮。原生任务过期时可从归档 .done / .failed.json 恢复终态。状态文件或原始/补跑输入损坏、目标 scope 改变会拒绝沿用状态，不能删除状态目录作为失败重试手段。

问题批次同时写入进度文件同目录下的 `issues.json`，记录批次编号、批次 ID、尝试序号/触发方式、failed 状态、错误原因、首次记录时间、任务 ID、提交 ID、输入 token 数和来源分组。`batches` 是当前未解决的问题，`history` 保留之前失败的尝试；成功补跑后也不删除历史。轮询和重启不会重复追加同一次失败。先持久化问题记录再保存进度，文件使用与 state.json 相同的 0600 权限和原子写入方式。

### 自动补跑与手动补跑

主迁移处理完所有可继续的批次后，仅将可重试的 `failed` 批次自动补跑，最多 3 轮，即首次执行加最多 3 次补跑。三轮分别等待 10、30、60 秒；等待截止时间和已用轮数持久化，重启不会重置等待或额度，等待期间重复点击返回 busy。批次内部仍沿用原有模型重试，不计入这 3 轮。提交结果未确认的失败与其他可重试失败共用同一份三轮额度，不再使用独立状态；显式重试创建新会话身份，可能与原任务产生重复记忆。明确的认证、权限、请求参数错误（例如 HTTP 400/401/403/422 或对应错误类型）不自动补跑；上游调用直接返回这类错误时暂停当前运行，修复后可手动继续。未知原因的明确失败仍受 3 轮上限约束。补跑结束仍失败时，`running` 为 false，但相关来源仍计入 `pendingCount`，最近一个未解决问题通过 `lastError` 保留可见。

之后点击“重试失败批次”（`POST /v2/migration/start {}`），只为当前 failed 批次创建一轮手动补跑，不再附带新的自动补跑额度。已完成批次不重跑。已有旧版本的结束状态也可以这样补跑，不需要清理状态或产出。升级时仍在主轮的旧迁移可采用新的 3 轮策略；旧版本已安排的自动轮次保留原完成标记，已经结束或暂停的旧迁移不会因升级被擅自启动。

每次补跑复制原始输入到 `retries/<batchId>/<attempt>.json`。仅追加新的 episode.sessionId 后缀 `-retry-<attempt>`；原始 messages（内容、来源 ID、createdAt）、批次边界、token 数和资源覆盖均不变。新提交因此获得独立 ingest ID、原生任务和会话归档，旧 journal 的 failed 结果和原生 `.failed.json` 都保留。OpenViking 的正常检索和合并流程继续生效，但这不是逐写入事务恢复，不能保证部分产出绝无重复。

state.json 中每个批次的 `attempt`（0 为首次）表示当前尝试，`attempts` 保留之前尝试的结果、错误、任务/提交 ID 和起止时间。补跑计划及轮次先原子持久化，再提交；重复点击返回 busy，重启复用已保存的本次请求，不重新创建尝试。迁移状态接口提供 `phase`（primary / automatic-retry / manual-retry）、`automaticRetryDone`、`automaticRetryCount`、`automaticRetryLimit`（3）、`nextRetryAt`、`totalBatches`、`failedBatches`。不修改或删除旧版 graph.db、条目记忆及原始输入。

同一迁移一次只处理一个可继续的未完成批次。页面只显示按旧条目、实体、关系记录计算的未处理数量；实体的部分事实完成不会提前将整个实体记为完成。

## 部署和验证

首次接入迁移需要一起更新 violoop-mem-ov、violoop-device、violoop-pc，以及带迁移输入识别能力的 OpenViking 运行时。上述补跑能力只需更新 violoop-mem-ov，复用现有 Device/PC 的启动入口和 OpenViking 的标准提交接口。Memory 打包清单包含新增模块和 tokenizer，OpenViking 仍通过 scripts/build-openviking-runtime.py 打包选定源码。

`npm run test:openviking` 覆盖数据库只读、来源覆盖、高度节点、完整超大材料、断点恢复、来源计数、journal 终态和 HTTP 按钮入口。Device 包含迁移 RPC 和 Gemma 排除的定向测试。测试使用临时数据库和原生/模型模拟接口，不代表真实用户数据库迁移或模型输出质量验证。
## 分阶段耗时统计

托管 OpenViking 在 `legacy-migration/timings/` 中追加 JSONL 计时记录。仅旧记忆迁移任务启用原生阶段计时；不记录正文、提示词、API 密钥或来源 URI。日志失败不影响迁移，重试用不同 `runId` 区分，`taskId` 对应提交记录。

统计包括旧库只读加载/来源关联、分批与 token 计算、批次持久化/提交、检索及查询向量、大模型调用、更新合并/文件写入、目录摘要、索引入队/写入/等待；网关另记 BGE 排队、每个文本的实际推理调用时间/字符数和实际 LLM 模型、token 用量。`bge.compute` 包含嵌入器首次加载及内部重试；查询/记忆/目录可按 `purpose` 区分。异步索引通过原生 telemetry ID 关联生产它的迁移任务。

只读导出：

```sh
python3 /opt/violoop-mem-ov/scripts/migration-timing-report.py --data-dir /var/lib/violoop-mem-ov > migration-timing-report.json
```

阶段耗时为包含子阶段的累计时间，并发阶段可重叠，不能相加当作批次总耗时。报告保留每次尝试的独立任务/墙钟时间、每阶段次数/累计/最大耗时、失败次数和未结束 span，批次汇总包含历史失败尝试与补跑；崩溃留下的部分记录可定位中断阶段。旧任务没有新计时事件时不会补造数据。报告工具本身没有重置、删除、重新提交迁移或修改旧数据库的操作。

自动启动只针对尚未初始化的迁移；已运行中的任务在重启后续接。已结束的迁移不会因每次重启反复创建重试轮次，失败批次通过独立按钮手动重试。全部完成后按钮置灰，成功批次始终跳过。


## 迁移事件来源展示

新迁移生成的 Events 仍是普通 Markdown 文件，正文结构为：

```markdown
# Summary
现有模型生成的摘要，保持不变。

# 迁移来源
## 旧记忆：原标题
旧记忆的可读原文。
```

程序将该事件引用的消息范围映射回完整源记录，解析 JSON 后排版旧条目、实体观察和有方向的关系，过滤内部 ID 和空属性。
不把 JSON 外壳或运输字段拼进正文，不额外调用模型，也不改抽取提示词。
完整原始材料仍保留在 OpenViking 归档的 `messages.jsonl` 中，事件元数据仅记录归档和消息引用。
普通聊天与屏幕观察 Events 不变；PC 使用现有 Markdown 展示，不新增折叠区域或专用读取接口。
此变更不批量重写已有文件；更新服务后新生成的迁移事件采用该结构。
