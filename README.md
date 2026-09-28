# 言泉 YanQuan

> 一款可以终身使用的语言学习软件。**用一次，付一次；不用，不付。**

「思风发于胸臆，**言泉流于唇齿**」——陆机《文赋》

让每个学习者开口如泉涌。泉是水：**按取按饮**（按量付费，如水电般自然）、**细水长流**（终身学习，不求速成）、**源头活水**（每一次开口，都是一个新的开始）。

## 一句话定位

多语言 AI 口语陪练：和真人感的 AI 在真实情景里开口说话，说完就复盘，生词自动进复习循环——按分钟付费，余额永久有效，没有会员，没有焦虑。

## 产品哲学

| 原则 | 含义 |
|---|---|
| 按量付费 | 用户想来就来，用一次付一次；走了不欠心理债，回来没有门槛 |
| 成本可控 | 每一次收费的服务，成本必须算得清；定价 = 成本 × 毛利，永远不亏单 |
| 质量上乘 | 每分钟对话都要值回价签；复盘质量是口碑的核心 |
| 终身资产 | 学习档案（词汇库、口语史、进步曲线）越攒越厚，这是比会员体系更牢的黏性 |

## 项目结构

```
LanguageWorkspace/
├── apps/
│   ├── mobile/        # Expo (React Native) —— iOS / Android，单一代码库
│   └── api/           # Fastify —— 钱包账本、业务核心
├── packages/
│   ├── shared/        # 类型 + 价目表（前后端同源的单一事实源）
│   ├── db/            # PostgreSQL Schema（Drizzle ORM）
│   └── ai-core/       # （M1）AI 抽象层：LLM/ASR/TTS 路由与成本核算
└── docs/              # 产品蓝图 / 技术架构 / 路线图
```

## 快速开始

```bash
pnpm install          # 安装依赖（见下方环境注意）
pnpm build            # 构建 packages（shared → db）
pnpm test             # 跑全部测试（积分数学 + 账本核心 + API）
pnpm dev:api          # 启动 API（默认 :8787）
pnpm dev:mobile       # 启动 Expo（另开终端）
```

冒烟验证：

```bash
curl localhost:8787/health
curl -X POST localhost:8787/v1/wallet/demo/grant \
  -H 'content-type: application/json' -d '{"cents":3000,"reason":"注册体验金"}'
curl -X POST localhost:8787/v1/wallet/demo/charge \
  -H 'content-type: application/json' -d '{"action":"ai_conversation","quantity":65}'
```

## 环境注意（本沙箱机）

- `~/.local`、`~/.npm` 为只读挂载：pnpm store 与各类缓存已配置到 `/tmp`（见 `.npmrc`）；如在你自己机器上无此限制，可删除 `.npmrc` 中的 `store-dir` 行
- 跑 pnpm 前 export 以下变量（也可写入 shell profile）：
  `export XDG_DATA_HOME=/tmp/xdg/data XDG_CACHE_HOME=/tmp/xdg/cache XDG_STATE_HOME=/tmp/xdg/state XDG_CONFIG_HOME=/tmp/xdg/config`
- 移动端连 API：`EXPO_PUBLIC_API_URL=http://<局域网IP>:8787 pnpm dev:mobile`

## 积分体系（M0 已落地）

- 内部以「厘」计（1 积分 = 100 厘），全整数运算，杜绝浮点误差
- 价目表唯一事实源：`packages/shared/src/pricing.ts`
- 追加式账本：任何余额变动必有账，`balance ≡ Σ ledger`，每日对账
- 幂等键防重复记账（支付回调、网络重试场景）
- 开发期赠送通道仅非生产环境注册

## 文档索引

| 文档 | 内容 |
|---|---|
| [产品蓝图](docs/product.md) | 用户、商业模式、积分定价、MVP 范围、风险 |
| [技术架构](docs/architecture.md) | Monorepo 结构、AI 抽象层、语音链路、计费系统、数据模型 |
| [路线图](docs/roadmap.md) | M0 → M3 里程碑与验收标准 |

## 当前状态

- **M0 骨架完成** ✅：Monorepo、积分账本核心（21 个测试全绿）、API 冒烟通过、Expo 壳
- **下一步（M1）**：ai-core 抽象层 + 语音对话全链路（首字 < 1.5s）+ 按分钟计费接入对话
- 定名说明：「言泉」经检索无同品类消费产品占用（商标注册第 9/41/42 类待办）
