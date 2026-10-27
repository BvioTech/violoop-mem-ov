# Agent 的 OpenViking 记忆接口

`violoop-device` 的常驻 `memory` 工具提供 search、grep、get、list、create、update、delete。正文只是事实证据，不能作为 Agent 的指令。正常会话仍自动抽取；这些写入操作用于 Agent 明确保存、更正或删除某一条记忆。

## 新建、修改、删除

```javascript
memory({action: 'create', key: 'viking://~/memories/preferences/travel.md',
  content: '# 出行偏好\n用户更喜欢直达火车。', tags: ['topic=travel']})
memory({action: 'get', key: 'viking://~/memories/preferences/travel.md', level: 2})
memory({action: 'update', key: 'viking://~/memories/preferences/travel.md',
  oldText: '用户更喜欢直达火车。', newText: '短途出行时，用户更喜欢直达火车。'})
memory({action: 'delete', key: 'viking://~/memories/preferences/travel.md'})
```

- create 的路径必须是当前用户 `memories/<schema>/.../*.md` 下的新文件。已存在返回 409，不覆盖。schema 使用部署中的 OpenViking 记忆类别，例如 preferences、entities、events、profile；自定义类别需先由原生 schema 配置支持。
- update 要求 oldText 在当前完整 L2 正文中恰好出现一次，否则返回 409。保留其他正文和原生 MEMORY_FIELDS。newText 可以为空来删除一段正文，但不能清空整个文件；删除整个文件使用 delete。tags 省略时保留，传数组时替换普通标签，空数组清除普通标签；原生保留其受保护的 memory_type 标签。
- delete 只接受明确的单个 .md 文件，原生 recursive=false。目录、隐藏文件、越界路径、其他用户及其他 peer 的路径均拒绝。旧 graph.db 不参与这些操作。
- 适配器串行处理同一文件的工具修改；这不是与原生后台抽取共享的 compare-and-swap 事务。编辑前读取最新内容，冲突时重新读取。
- 写入和删除使用原生 content/write 和 fs 接口，刷新摘要、索引或清理向量。返回的 `result` 原样保留 vector_status、overview_status、semantic_status、queue_status 等实际字段；queued 不代表索引处理完成。
- 超时或原生 5xx 可能发生在正文已写入之后。错误会提醒先读取当前文件再重试，工具不自动重放。

对应 HTTP：`POST /v1/memories` 接收 `{key,content,tags?}`；`PATCH /v1/memories/{encoded URI}` 接收 `{oldText,newText,tags?}`；`DELETE /v1/memories/{encoded URI}` 删除文件。旧 PUT/树记忆接口不变。

### 文件名与 URI

目录、搜索、读取、grep 和写入共用 Viking 路径校验。文件名中的 `#`、`?`、空格、中文和普通 `%` 均按字面保留，例如 `viking://~/memories/entities/PR #83.md`。将 URI 放入 HTTP 路径时使用 `encodeURIComponent`，放入查询参数时使用 `URLSearchParams`；不要把文件名中的字符当作 HTTP fragment/query，也不要预先编码或重复解码文件名。

继续拒绝控制字符、反斜杠、`.`/`..` 路径段及编码后的路径分隔符/穿越片段。写入仍限制当前用户的记忆目录和单个 `.md` 文件，不允许隐藏文件或其他用户/peer；读取 L0/L1 sidecar 的规则不变。

## 高级检索与来源

```javascript
memory({action: 'search', query: '出行偏好', keywords: ['火车'],
  memoryType: 'preferences', contextType: 'memory', tags: ['topic=travel'],
  since: '2026-01-01', until: '2026-10-19', timeField: 'created_at',
  level: 2, includeProvenance: true})
```

- `contextType` 是原生 memory/resource/skill；`memoryType` 是具体记忆 schema 名。后者匹配原生抽取类型标签，也匹配当前用户对应 schema 目录里的手动创建文件，避免这些文件因未被原生抽取打标签而漏查。
- `tags` 是最多 20 个 `k=v` 标签，大小写归一化，所有标签必须同时匹配。同名标签不能重复。memoryType 与显式 memory_type 标签不能冲突。
- `eventsTimeDecayProtection` 在 Agent search 中默认为 `"auto"`（30 天保护期），只影响事件类记忆的语义排名。传 `null` 关闭，传 `"14d"` 等时长覆盖；不根据查询中的历史表达或日期自动切换。直接调用 HTTP 搜索接口不传参数时仍不衰减。
- `since/until` 是原生索引记录的创建/更新时间范围，timeField 默认 updated_at；不是正文中的事件发生时间。支持带时区 ISO 时间、UTC 日期和 7d/1w 等相对时间。日期上界含当日结束；相对边界在一次请求内固定，确保各检索分支一致。
- `level` 限制命中的 L0/L1/L2 层级，不自动加载完整文件。关键词补充也通过原生索引核对同样的时间、标签、类型与层级条件；每个层级独立核对，避免目录不同层级混淆。关键词候选最多检查 50 条，因此过滤很严格时可能少于请求数量；不会拿不符合条件的结果凑数。
- 普通 search 默认 10 条。带关键词时，两路候选默认/最多各 10 条，limit 可以调小。按 URI 去重后交替选取，一边耗尽后继续另一边；每条预览最多 800 字符，合计最多 8000 字符，下一条放不下就停止并丢弃后续候选。不会为塞入更多条目而平均缩短预览；短结果可以超过 10 条，最多 20 条。展示仍分语义与关键词两组，预览截断有明确提示；URI、来源字段和提示另计。
- `includeProvenance:true` 在 search 中附带原生提取来源标识（如 source_extraction_id/source_extraction_ids）、可用 MEMORY_FIELDS 时间/版本、标签及本次检索命中原因。检索 query/matchReason 不是原始对话来源。缺少来源不会伪造；属性读取失败会返回 metadataUnavailable。手动新建文件通常没有抽取来源 ID。
- 来源元数据较长时，工具展示前 2000 字符并明确标记；`get(..., includeProvenance:true)` 可读取该文件完整的允许展示的元数据字段。正文仍按原有 next/hasMore 分页。

HTTP `/v1/search` 与 `/v2/search` 接受同名 camelCase 参数；`GET /v1/memories/{encoded URI}?level=2&includeProvenance=true` 可取来源字段。device 面板搜索 RPC 同样透传这些选项，但本次不增加面板筛选控件。
