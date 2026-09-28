# 技术架构

> 状态：v0.1｜目标：小团队（人 + AI Agent）可维护，成本可观测，供应商可替换。

## 1. 总体形态

TypeScript Monorepo（pnpm workspaces + Turborepo）：

```
LanguageWorkspace/
├── apps/
│   ├── mobile/        # Expo (React Native) —— iOS / Android 原生 App，单一代码库
│   └── api/           # Fastify + TypeScript —— BFF 与业务核心
├── packages/
│   ├── shared/        # 类型契约、价目表常量（前后端同源，杜绝两边价格不一致）
│   ├── ai-core/       # AI 抽象层：LLM / ASR / TTS 供应商路由与成本核算
│   └── db/            # Schema（Drizzle ORM）与迁移
├── docs/              # 产品与架构文档
└── README.md
```

**为什么是 Expo 而不是双端原生**：单人/小团队养不起两条原生线；Expo dev build 支持原生音频模块，语音链路可满足；TypeScript 全栈共享类型，AI 辅助开发效率最高；OTA 更新让小修小补绕过应用商店审核。（若你有 Flutter 强偏好，M0 前提出即可换，架构不变。）

**后端**：Fastify（轻、快、TS 原生）+ Postgres（主库）+ Redis（会话态/限流/缓存）。部署在国内云（火山引擎/阿里云），域名备案。

## 2. AI 抽象层（packages/ai-core）——成本与质量的控制塔

```
调用方 → TaskRouter ──→ LLMProvider 接口 ←── [Volc Ark | Bailian | OpenAI | ...]
        （按任务类型      ASRProvider 接口  ←── [豆包流式ASR | Paraformer | ...]
          和成本档位      TTSProvider 接口  ←── [豆包TTS | CosyVoice | ...]
          选供应商/模型）
```

核心设计：

- **统一接口**：`chatStream()` / `transcribeStream()` / `synthesizeStream()`，供应商实现各自适配器；换供应商 = 换配置，不动业务代码
- **任务分级路由**：
  - 重任务（对话主脑、复盘）→ 旗舰模型
  - 轻任务（生词精讲、情景预生成、分类打标）→ 便宜模型
  - 同一档位内按「实时单价 + 当前健康度」动态选择
- **成本埋点是一等公民**：每次调用记录 `task_type / provider / model / tokens / 估算成本(¥) / latency` 落库 → 按「动作 × 供应商」聚合出单位经济学报表，驱动路由策略和定价校准
- **护栏**：单请求 token 预算上限、供应商故障自动降级切换、成本异常熔断告警

## 3. 语音对话链路（MVP 全流式）

```
Mic → 分片上行(WS) → 流式ASR ─┐
                              ├→ 对话状态机 → LLM 流式 → 流式TTS → 下行播放
VAD 断句 → 打断检测(barge-in)─┘
```

- 目标端到端延迟：**首字回复 < 1.5s**；超 2.5s 触发体验告警
- 对话状态机管理：当前情景、角色人设、难度档位、已用时长（计费依据）、打断处理
- 计费以「对话时长」为准，断线重连保留会话；**每满 1 分钟落一次账**，中断不整分钟按秒折算

## 4. 积分计费系统（商业模式的技术底座）

**钱包 + 追加式账本（append-only ledger）**，任何余额变动必有账：

```
wallets:   user_id, balance_credits, version(乐观锁)
ledger:    id, user_id, type(topup|charge|refund|grant),
           action_code, quantity, unit_price, amount_credits,
           related_id, balance_after, created_at
pricing:   action_code, unit_price_credits, pricing_unit, active
cost_events: (ai-core 埋点) action_code ↔ 真实成本(¥) 关联 → 毛利报表
```

铁律：

- 账本只追加不修改，退款是新条目
- 扣费与消费动作同一事务语义；对账任务每日核对 `balance = Σ ledger`
- 价目表只存在于 `packages/shared`，前端展示、后端扣费、账单明细三处同源

## 5. 学习档案（终身资产）数据模型

```
users / language_pairs(user, source, target, level)
vocab_items(user, pair_id, term, definition, context_utterance_id, status)
srs_cards(user, vocab_item_id, fsrs_state, due_at, stability, difficulty)
sessions(pair_id, scenario_id, started_at, duration_s, credits_charged)
utterances(session_id, speaker, text, audio_ref?, corrected?, tags[])
reviews(session_id, errors[], upgrades[], new_vocab[])   # 复盘报告
```

- SRS 用 **FSRS 算法**（开源、效果优于 SM-2）
- 复盘产物结构化存储 → 支撑「弱点画像」「进步曲线」等长期功能
- 数据可导出（JSON/CSV）从第一天支持——终身产品必须让用户信「数据是我的」

## 6. 安全与合规要点

- 语音数据：默认处理完不留存原始音频（用户可选保留用于回听），明示并可一键删除
- 内容安全：ASR/LLM 输出过审核接口（供应商自带或自接）
- 支付：iOS IAP 服务端收据校验；微信/支付宝异步回调验签 + 幂等
- 上线前：ICP 备案、（如需）增值电信业务许可评估、隐私政策与个人信息保护合规自查

## 7. M1 实施记录（已落地）

### 7.1 按秒累进计费（水表模型）

不是「结束才结算」，而是像水表一样在每个计费点（每次 turn、end）把**自上次结算以来的秒数**结清：

- 用户中途退出，欠账最多不超过一个 turn 的时长——按量付费模式下资金风险趋近于零
- 每个秒段一笔账，幂等键 = `sessionId:seq`，重试不重复扣
- 余额不足在任何一次计费点即时拦截（409），充值后原样续聊
- 会话对象带成本计量器（CostMeter）：每次 LLM 调用记录 `model × usage × ¥`（分析口径），对话结束即得单次会话真实成本 → 驱动定价校准

### 7.2 供应商接入（ai-core）

- 统一接口 `LLMProvider.chat() → { chunks, usage }`，业务代码零供应商耦合
- `OpenAICompatProvider` 一个适配器通吃方舟 Ark / 百炼 compatible-mode / OpenAI（换 baseUrl/model 即切）
- 成本表（`MODEL_COSTS`，¥/1M tokens）为分析锚点，上线前用真实账单校准
- mock 供应商零成本跑通全链路；配置 `SEMA_LLM_PROVIDER=openai-compat` + `SEMA_LLM_API_KEY` 即切真实模型

### 7.3 实时语音传输协议（M1.5 已实现）

WebSocket `/v1/realtime`，双通道帧设计：

```
上行控制帧(JSON): { type: "start", userId, scenarioId } | { type: "end" }
上行音频帧(binary): 用户 PCM 16k mono s16le（任意分片，服务端内部按 20ms 帧切 VAD）
下行事件帧(JSON): ready / user-utterance / reply-start / reply / audio-end / ended / error
下行音频帧(binary): AI PCM 16k mono s16le（TTS 分片，可直接喂播放器）
```

- 上行：能量 VAD 断句（阈值 700 RMS，开口 160ms，静音 700ms 出段，单段上限 15s）
  → ASR 整段识别 → 复用 ConversationService.turn()（计费/对话/成本计量与文本模式完全一致）
- 下行：turn 回复全文 → TTS 流式分片；开场白同样以语音下发
- Barge-in：AI 播报中用户开口即 abort TTS（AbortError 静默，不回错误帧），新语音段立即接管

**方舟语音通道实测要点**（openspeech.bytedance.com，X-Api-Key 鉴权，X-Api-Resource-Id 标识资源）：

| 事项 | 实测结论 |
|---|---|
| TTS 端点 | `/api/v3/plan/tts/unidirectional/stream`（seed-tts-2.0），单请求全量文本，流式收音频帧 |
| TTS 音色 | 必须与 resource 匹配：`zh_female_gaolengyujie_uranus_bigtts` 可用；`*_mars_*` 报 55000000 |
| ASR 端点 | `/api/v3/plan/sauc/bigmodel_async`（volc.seedasr.sauc.duration） |
| ASR 配置 | **配置请求带 POS_SEQUENCE(seq=1)**，音频从 seq=2 起；schema 键是 `audio`（非 audio_config）+ `channel`（非 channels） |
| ASR 音频 | 引擎按内容嗅探：声明 `format:"wav", codec:"raw"` 并给裸 PCM 前置 44B RIFF 头 |
| 识别语言 | `request.language: "en-US"` 提示显著提升英文准确率（latte 不再误识别） |
| 结果语义 | 响应为**累积快照**（全量文本），只在流结束时取终稿，不可逐帧拼接 |
| 权益 | 需 Agent Plan 订阅 + 控制台开启抵扣，否则 401/403（`AgentPlanDeductNotEnabled`） |
| 计费 | 套餐 AFP 抵扣，实测 5厘/秒（TTS 与 ASR 各计音频时长） |

语音供应商抽象：`TTSProvider.synthesize(text, opts) → AsyncIterable<Buffer>`、
`ASRProvider.createRecognizer() → StreamingRecognizer`；方舟适配器
`ArkPlanTTSProvider` / `ArkPlanASRProvider`（ai-core），Mock 实现零成本开发测试。

## 8. M2 实施记录（学习闭环，已落地领域层）

### 8.1 学习闭环三件套

- **复盘报告** `ReviewService`（modules/review）：会话结束后把完整转写交给
  旗舰模型，产出结构化 JSON（纠错/更地道说法/生词/亮点与重点），zod 严格
  校验（REVIEW_PARSE_ERROR 诚实失败不造假绿）；一次会话一份报告，幂等计费
  （`review:sessionId`，review_report 100厘/次）。报告中的生词自动入生词本。
- **生词本** `VocabBookService`（modules/vocab）：FSRS-5 间隔复习。调度封装在
  `@sema/shared/src/srs.ts`（ts-fsrs 5.x，请求保留率 0.9，禁用短期学习步——
  首次打分即入天级间隔，适合每日复习节奏）。卡片来源：复盘提取 + 手动添加，
  按 userId+term 去重；打分 1=忘了 2=费劲 3=顺利 4=轻松；到期队列按 due 升序。
- **生词 AI 精讲** `LectureService`（modules/vocab/lecture）：复习时按需触发，
  廉价档模型产出释义/地道例句/近义辨析/记忆钩子/常见搭配；**每词一生成缓存
  终身**，幂等计费 `lecture:cardId`（vocab_lecture 10厘/词），先生成后扣费
  （解析失败不扣钱）。真实冒烟质量达标（innit 的辨析与记忆钩子可用）。
- **学习档案** `StatsService`（modules/stats）：纯聚合视角——会话数/时长/
  开口次数/累计消费、词汇总量与 7 天新增与到期数、连续学习天数、近 14 天
  活动曲线；不引入新的事实来源。`GET /v1/users/:id/export` 全量导出（终身可携）。

### 8.2 供应商通道矩阵（实测沉淀）

| 通道 | Base URL / 端点 | Key | 计费 |
|---|---|---|---|
| 平台聊天 | `https://ark.cn-beijing.volces.com/api/v3` | 控制台 Key | token 后付费 |
| Agent Plan 聊天 | `https://ark.cn-beijing.volces.com/api/plan/v3` | 套餐专属 Key | AFP 抵扣 |
| Agent Plan 语音 | `wss://openspeech.bytedance.com/api/v3/plan/*` | 同套餐专属 Key | AFP 抵扣（5厘/秒） |

注意：Coding Plan Key 与 Agent Plan Key **互不通用**（跨用即 401）；
套餐通道模型名以 `plans model-list` 为准（如 doubao-seed-2-0-mini-260428）。

### 9. M3 实施记录（进行中）

### 9.1 认证体系（已落地）

- **登录方式**：手机号 + 密码（scrypt 哈希，timingSafeEqual 比对）或
  手机号 + 6 位短信验证码（5 分钟有效、一次性、60s 冷却 + 每小时 5 条限流）
- **会话**：不透明随机令牌（32B hex，30 天），服务端 Map 可撤销（比 JWT 简单且能踢下线）；
  移动端存 SecureStore（Android Keystore）
- **短信通道**：`SmsSender` 接口抽象——dev/test 用固定码/控制台实现，
  生产接阿里云或腾讯云短信（待用户提供云短信凭证）
- **鉴权**：conversations/vocab/review/stats/wallet 全部从 `Authorization: Bearer` 取
  userId（不再信任请求参数）；WS realtime start 帧携带 token
- wallet grant/topup 保留为**开发通道**（NODE_ENV=production 不注册）；
  生产充值走微信支付回调（商户号开通后接入）

### 9.2 移动端语音（Expo Go 可行路径，已落地）

- **按住说话**：expo-av 录 AAC 16k（Expo Go 的 Android 无 PCM 输出），
  整段 base64 经 WS `audio-aac` 帧上行 → 服务端 ffmpeg 转 16k mono PCM
  → 现有 VAD/barge-in 管线（整段上传自动补 300ms 静音尾巴出段）
- **会话复用**：WS start 支持可选 sessionId——语音与文字共用一个会话，
  计费与复盘不分叉；归属/状态校验（CONVERSATION_FORBIDDEN/ENDED）
- **TTS 回放**：下行 PCM 分片攒齐 → 加 WAV 头 → expo-av 播放
- 诚实边界：真流式（边说边转、即时 barge-in）需要 dev-client + 原生录音
  模块（react-native-live-audio-stream 一类），是 EAS 构建后的里程碑；
  服务端 VAD/barge-in 已就绪，届时客户端只换录音采集层

### 9.3 合规：账户注销与数据删除（已落地）

- `DELETE /v1/auth/me`（需登录）：级联删除对话/复盘/生词/钱包，
  撤销全部会话令牌，删除用户记录
- **账本去标识留存**：ledger_entries.user_id 改写为 `deleted:<id>`——
  满足财务记录留存与个人信息删除义务的平衡（architecture §4 铁律的例外
  规则，只改归属字段不改金额）
- 语音音频后端从不落盘（实时流式处理即弃），无可删项
- 移动端「我的 → 注销账号」双重确认入口

### 9.4 Postgres 仓储（钱包/用户已落地，pg-mem 单测）

- `DATABASE_URL` 配置后自动切换 PG 账本；缺省内存实现（开发/测试）
- DrizzleWalletRepo：单事务 + 乐观锁（`UPDATE ... WHERE balance_cents=期望前值`，
  影响行数 0 → BalanceConflictError 409）+ 幂等键唯一索引兜底——
  账本铁律（余额=Σ账本）落到 SQL 层；DrizzleUserRepo：手机号唯一约束
- 建表迁移由 drizzle-kit 生成（packages/db/drizzle/0000_*.sql），
  运行时不依赖 ORM（pg 原生参数化 SQL）
- **诚实边界**：pg-mem 是 SQL 逻辑模拟——部署前必须用真实 PostgreSQL
  跑迁移与冒烟；会话表（auth sessions）仍在内存（重启掉线，MVP 可接受）

### 9.5 移动端壳 · Android（Expo SDK 54 + expo-router，已落地）

- `apps/mobile`：七屏（启动分流/登录注册/情景目录/文字对话/复盘报告/
  生词本/我的），深色品牌视觉
- 对话屏把计费做透明：每轮显示"本轮 X 厘 · 余额 Y 积分"
- 生词本四档打分（忘了/费劲/顺利/轻松）+ AI 精讲弹层（每词一次 10厘）
- 充值按钮为占位（微信支付商户号申请中）
- 验证：`tsc --noEmit` 全绿 + `expo export` Metro 打包成功（2.58MB Hermes bundle）
- 真机路径：Expo Go 扫码 + `EXPO_PUBLIC_API_URL=http://<局域网IP>:8787`
- **语音未接入移动端**：录音 + WS 流式播放是下一个里程碑（后端已就绪）

## 10. M3 前置实施记录（内容扩容 + 多语言对，已落地）

- **情景库 3 → 12**：10 个手写打磨的中→英情景（点餐/面试/问路/餐厅/酒店/
  药店/退货/值机/寒暄/看房，A2-B1 全覆盖）+ 中→日、中→韩咖啡馆试点各 1。
- **语言对抽象**：`TargetLang = en | ja | ko`；各语言语域约定进 system prompt
  （日语 です/ます、韩语 해요체）；复盘与精讲提示词按目标语言参数化
  （学习内容用目标语言、解释保持中文）；生词卡携带 `lang` 字段。
- **语音多语言**：`RecognizerOptions.language`（BCP-47，方舟 SAUC
  `request.language`）+ 每情景音色映射（`SEMA_TTS_SPEAKER_EN/JA/KO`，
  未配置回落默认音色——日/韩音色 ID 待真机联调验证）。
- **目录接口**：`GET /v1/conversations/scenarios?targetLang=ja` 支持按语言过滤。
- **冒烟**：日文全链路真实通过（さくら 店员对话 → 日语教练复盘 →
  いらっしゃいませ 精讲，敬语辨析质量达标）。
- 后续情景以 scenario_pack 付费内容包扩容（价目已预留），AI 预生成 + 人工打磨。

### 8.3 路由一览（M2/M3）

```
GET  /v1/conversations/scenarios             情景目录（?targetLang=en|ja|ko）
POST /v1/conversations/:sessionId/review   生成复盘（幂等）+ 生词自动入本
GET  /v1/conversations/:sessionId/review   拉取报告
GET  /v1/vocab?userId=                     生词列表（按到期排序）
GET  /v1/vocab/due?userId=                 到期复习队列
POST /v1/vocab                             手动添加生词
POST /v1/vocab/:cardId/review              打分推进 FSRS
POST /v1/vocab/:cardId/lecture             AI 精讲（每词一次，10厘/词）
GET  /v1/stats/:userId                     学习档案
GET  /v1/users/:userId/export              全量数据导出
```
