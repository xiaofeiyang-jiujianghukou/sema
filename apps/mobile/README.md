# 说嘛移动端（Android · Expo）

## 运行

```bash
# 1. 先起后端（仓库根目录）
pnpm dev:api        # http://localhost:8787

# 2. 手机上装 Expo Go（应用商店可下），电脑与手机连同一 Wi-Fi
cd apps/mobile
EXPO_PUBLIC_API_URL=http://<电脑局域网IP>:8787 pnpm start
# 然后用 Expo Go 扫终端二维码
```

- **Android 模拟器**：不用配置，默认走 `10.0.2.2:8787`（宿主机回环）
- **真机**：必须注入 `EXPO_PUBLIC_API_URL`（指向电脑局域网 IP）
- 生产打包（APK/AAB）：`eas build -p android`（需要 Expo 账号，沙箱外执行）

## 屏幕结构（expo-router）

| 路由 | 内容 |
|---|---|
| `/` | 品牌启动屏：API 健康检查 + 登录态分流 |
| `/login` | 登录/注册（密码 或 短信验证码，60s 倒计时限流提示） |
| `/scenarios` | 情景目录（英/日/韩过滤），点开即 30 秒开口 |
| `/chat/[id]` | 文字对话：本轮计费与余额实时可见，结束 → 复盘 |
| `/review/[id]` | 复盘报告：纠错/地道说法/生词/教练点评 |
| `/vocab` | 生词本：FSRS 四档打分、AI 精讲（10厘/词）、手动添加 |
| `/profile` | 余额与流水、学习档案（连续天数/14 天柱状图）、充值占位 |

**语音（WS 实时流）尚未接入移动端**——后端 `/v1/realtime` 已就绪，移动端录音与流式播放是下一个里程碑。

## 验证

```bash
pnpm typecheck   # tsc --noEmit
pnpm export      # Metro 打包 Android bundle（无需 Android SDK）
```
