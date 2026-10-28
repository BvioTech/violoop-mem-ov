# VioLoop Memory + OpenViking

一个仓库、一个 Memory 服务：Node.js 提供 Device/PC 兼容接口、模型网关、迁移及图谱索引，自动管理本仓库的 Python OpenViking 子进程。OpenViking 保留原有 C++ 向量引擎、Rust RAGFS 和 CLI 源码。

## 目录

- `service/`：必要的 JavaScript 服务及回归测试；没有旧 GraphStore 引擎。
- `engine/`：OpenViking 核心及必要运行、构建源码；已裁剪上游示例、文档网站、Web Studio、基准测试和独立发布部署文件。
- `scripts/`：安装、测试、构建和打包入口。
- `deploy/`：兼容现有设备的 systemd/config 文件。
- `SOURCE_MANIFEST.json`：来源提交和导入前逐文件 SHA-256。
- `engine/VIOLOOP_ENGINE_VERSION`：引擎版本，不随根仓库标签变化。

## 安装

需要 Node.js 24、uv、C/C++ 编译工具（macOS Xcode Command Line Tools；Linux 的编译器和开发头文件）。Rust 可以使用本机版本（>=1.91.1），或仅安装到本目录的忽略目录：

```sh
npm run setup -- --bootstrap-rust
```

默认使用 Python 3.12；Debian 12 设备包使用 `npm run setup -- --python 3.11 --bootstrap-rust`。依赖来自 `package-lock.json` 和 `engine/uv.lock`，原生组件从当前源码编译。初次安装需要网络；不复制其他源码仓库的虚拟环境或二进制。

`npm ci` 仅安装 Node 依赖，不能代替上述完整安装。

## 启动

生产环境仍使用 `/run/violoop-mem/violoop-mem.sock`、`/var/lib/violoop-mem` 和 `violoop-mem.service`。源码启动会自动选择本仓库的 `.venv` 和 `engine`。

本地独立试验必须使用单独的数据目录、socket、端口：

```sh
OPENVIKING_URL=http://127.0.0.1:1934 \
OPENVIKING_RUNTIME_DIR="$PWD/.local/run" \
QMD_MODELS_DIR=/absolute/path/to/bge-model-directory \
npm start -- --data-dir "$PWD/.local/data" --socket "$PWD/.local/mem.sock"
```

模型目录需含 `bge-m3-q8_0.gguf`；也可用 `--embedding-model /path/to/model.gguf`。模型不随 Git 导入。正式模型调用仍使用 Device 的 `/internal/memory/chat/completions`（默认 `127.0.0.1:9090`），可通过 `OPENVIKING_DEVICE_MODEL_URL` 指定另一个本机 Device 地址。独立测试入口会提供本地确定性模型响应，无需连接真实 Device 或云服务。

普通向量请求保持本地 BGE；迁移向量请求经 Device 的 `/internal/memory/embeddings`，使用当前登录用户自动领取、续期的模型网关凭证调用云端 `bge-m3`。无需单独配置迁移 URL 或密钥文件。

## 验证和构建

```sh
npm test
npm run test:integration
npm run build
python3 scripts/build-openviking-runtime.py --replace
npm run test:package
# Linux ARM64 构建后自动执行，也可独立检查已有包：
bash scripts/check-deb.sh dist/violoop-mem_<version>_arm64.deb
```

单元/契约测试覆盖迁移、失败重试、提交结果未确认按失败处理、任务恢复、图谱增量更新、记忆 CRUD、检索与模型网关。原生集成测试启动真实 Python/C++/Rust 引擎，使用确定性模型替身；它验证工程链路，不评估模型质量。所有测试数据都在临时目录，测试结束清理，不访问当前模拟器数据。

构建生成 OpenViking wheel 与完整服务源码归档。设备 `.deb` 必须在 Debian 12 ARM64 + Node 24 + Python 3.11 环境执行 `npm run build:deb`；不在 Mac 上生成冒充 ARM64 Linux 的包。所有构建产物均忽略，无自动发布。

## 旧记忆保护

默认只读读取数据目录内的 `graph.db`，也可显式指定 `VIOLOOP_LEGACY_MEMORY_DB`。新记忆写入 `openviking/`，迁移进度写入 `legacy-migration/`，可重建图谱写入 `openviking-graph.db`。迁移不会删除旧文件或旧数据库，成功后也不自动清理。卸载或 purge 同样保留记忆数据。

首次就绪自动迁移。失败最多自动重试三轮（10/30/60 秒）；已成功批次不会重放。提交结果未确认、任务及归档结果缺失的批次统一按 failed 处理，共用三轮自动重试额度；每次手动重试只补跑一轮。手动入口及 Device/PC HTTP 协议保持兼容。Identity/Soul 模板由运行配置禁用；不会自动删除历史文件。

详细接口见 `docs/agent-memory.md`、`docs/legacy-memory-migration.md`。来源及许可见 `NOTICE.md` 和 `engine/LICENSE`。

VikingBot is omitted from this service: no Bot channels, interactive chat command, Bot proxy, or Bot feedback collector is packaged. Memory extraction, retrieval, graph projection, and native memory consolidation remain available.

This service omits standalone HTML graph export, RAGAS evaluation, Gemini embeddings, NVIDIA cuVS, and Ollama integration. CPU vector storage, OpenAI-compatible model endpoints, persistent memory links, and Agent Evolution remain supported.

## 设备待机

支持 Device 的 `GET/POST /runtime/background`，POST 请求体为 `{"paused": true|false}`。暂停状态保存在数据目录的 `background-state.json`，重启后继续生效。先停止接收新的模型请求和记忆写入、暂停提交后续迁移批次，再等待已接受的提交及 OpenViking 全部队列完成，最后释放本地 BGE 上下文与模型。排空或恢复期间 `busy: true`；完成后 `busy: false`。已提交任务不会因待机取消，不会重放成功的迁移批次；失败批次仅按迁移重试额度补跑。

待机时仍可浏览记忆、图谱、任务状态和健康接口；新检索、写入、整理等需要模型的请求返回 503 `background_paused`。唤醒重新加载本地 BGE，恢复迁移调度。外部 OpenViking 模式无法管理模型生命周期，控制接口明确返回 503。

`.deb` 构建完成后必须通过解包运行检查：启动包内 CLI 与 Python 引擎，验证健康接口及正常退出，再用确定性模型替身验证迁移、记忆读写、检索、图谱、待机恢复和旧数据保留。只使用临时目录，不安装软件包、不运行维护脚本、不访问现有用户数据。
