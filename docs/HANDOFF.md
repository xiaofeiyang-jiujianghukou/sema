# 说嘛 Sema · 会话交接（2026-09-29 晚）

## 当前部署状态
- **build b46** 已上线：API = 后台任务 bash-1228（`cd sema/apps/api && DATABASE_URL="postgres://postgres:sema_dev_2026@127.0.0.1:5432/sema" npx tsx src/main.ts`），Metro = bash-1229（Expo lan:8081，EXPO_OFFLINE=1）。
- 数据库 sema-pg（Docker postgres:16-alpine，127.0.0.1:5432）。sema-pg 曾自行退出过一次，注意检查。
- 测试令牌（用户 15701209440 / u_1c0265d202bf1c66）：`907220a9b6af3d469df548b1fe0f06013a3fd311d636c44dc4f5327bf21d908d`，余额 1462 厘。
- 测试指针：进程和终端的 /tmp 是隔离命名空间，诊断落盘必须写工作区路径（现用 `sema/.diag/`）。

## ⏳ 下个会话待解决（用户最后报告，未修完）
**「对话实战（🗣️）怎么没有进度和星星？而且无法到达下一关」**

已查明/待查：
1. 对话课通关判定：`attemptSession`（modules/challenges/service.ts）要求 `session.userTurns >= requiredTurns`（u1-3=6 轮）且 `c.scenarioId === session.scenarioId`。用户是否真的聊满 6 轮并点了「结束」未确认——先查 API 日志（bash-1228 输出）里 `ASR 出段` 条数和 `sessions` 表。
2. **注意**：DB `sessions` 表是老 M1 结构（scenario_code/duration_seconds），**没有 user_turns 列**；conversation 的 session 存储在 modules/conversation/repo.ts，查那边。
3. 产品缺口：对话课没有**过程进度**显示（词表关有星级，对话关一局定胜负，课程页卡片上完全看不到进度）。用户期望可见进度。可选方案：课程页对话卡显示「本课最佳轮数 X/6」，或聊天页顶栏显示「轮数 X/6 达标即通关」。
4. 「无法到达下一关」：双轨解锁下 u02-dialogue 锁着是符合设计的（u01-dialogue 未过）；但要先确认 u01-dialogue 通关链路端到端好使（聊天结束 → session-attempt → 50厘+3★ → u02 解锁）。
5. 快速复现路径：课程页 → 🗣️ 对话实战 → 开始对话 → 跟 Maya 聊 6 轮 → 结束并复盘 → 应弹「🎉 闯关成功」+50厘。若不弹，查 conversations/end 与 challengeSessionAttempt 调用链。

## 本会话已完成（b35→b46）
- **星级+奖励经济**（服务端权威）：3★=首试全对/2★≥70%/1★=通关；首通奖=基础×首试正确率；**升星奖=新星等级价值的一半**（每星值 base/3：1★→2★ 发 2/3·base 的一半）；平星不发。user_challenges 表有 stars/paid_cents 列。
- **每局随机出题**：种子=challengeId+每局随机数，GET exercises 返回 seed，check/check-pair 回传 seed；判题复现同一局。
- **连线题**：左右谁先选都行；颜色按选择顺序依次变化（第1对蓝→第2对绿…），配对成功两侧同色锁定；配错定点抖动。
- **录音修复（sing 事故）**：根因=短按(<500ms)路径泄漏 Recording 对象占住安卓输入源 → 全零采样（服务端 rmsRaw=0 诊断日志 + sema/.diag 落盘取证确认）。修复：短按也卸载 + 录音前预清理 + 配方对齐 use-voice-mode。
- **对话课实装**：原 8 个对话课 scenarioId 全是 null（点开始对话被扔到自由聊天列表）。现按课程大纲生成 24 个专属场景（`{unit}-scene`，人设 Maya/みさき/지민，opener 按单元手写，本课词+句型进热词）。lessonOnly 不进自由聊天列表。
- **热词崩溃修复**：课程 JSON patterns 是对象数组，热词只取 `p.pattern`（此前 `entry.split is not a function`）。
- **卡片名清理**：课程卡片 `📝 词表跟读` / `🗣️ 对话实战`（分组标题已有单元名，不再重复）。
- 测试 61/61 绿。

## 铁律（勿违背）
- 计费（用户原话）：「开始对话了才会有计费，首次APP输出不计费，后续有交互对话才计费。而无对话期间 不说话 不计费」。语音 5厘/s（按实际说话秒数），文本 10厘/轮，vocab_lookup 1厘（词书内免费），text_translate 2厘，review_report 100厘。
- 不订阅、不广告、注册赠3000厘。
- 「整体积分以首次正确率来算」「奖励每次升星就会重新给，但给的是之前的一半」→ 已细化为：升星发新星等级价值的一半，平星不发。
- 用户要求诚实汇报限制，报错原文要贴给用户看（entry.split 一案证明有效）。
- tsconfig exactOptionalPropertyTypes + noUncheckedIndexedAccess；python str.replace 是全量替换，补丁后必须 grep 验证。
- 部署例程：tsc 双端 + vitest → 重启 API/Metro → warm bundle（curl expo-platform: android 取 bundle URL）→ build tag +1（apps/mobile/app/index.tsx `· build bN`）→ git commit。
- 遗留：用户 u01-u08 词表关 1★（历史补录），u08 2★/31厘；重打 u08 满星可拿 17 厘升星奖。
