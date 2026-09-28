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
