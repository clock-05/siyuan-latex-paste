# 发版

集市只从仓库的 **Latest Release** 下载 `package.zip`，而 `.github/workflows/release.yml`
会在推 tag 时自动产出它。所以发版就三件事：改版本号 → 推 `main` → 推 tag，剩下的 CI 全包。

## 1. 同步四处版本号

| 位置 | 改什么 |
| --- | --- |
| `plugin.json` | `version` |
| `package.json` | `version` |
| `package-lock.json` | 顶层 `version` 和 `packages[""].version` |
| tag 名 | `v` + 同一个版本号 |

四处必须一致。锁文件漏改会让 `npm ci` 报版本冲突，CI 直接挂。

## 2. 本地验证

```bash
npm run verify   # 类型检查 + 105 个测试
npm run build    # 构建到 dist/，并同步到 .env 里配的工作区
```

## 3. 推上去

```bash
git add -A && git commit -m "chore: 1.0.2"
git push origin main
git tag -a v1.0.2 -m "1.0.2"
git push origin v1.0.2
```

**只有推 tag 会触发发版**，只推 `main` 什么都不会发生。

## 4. CI 做什么（约 1 分钟）

`npm ci` → `npm run verify` → `npm run build` → 在 Linux 上 `zip` 打 `package.zip`
→ 校验包里有 `index.js`、`index.css`、`plugin.json` → 建 Release（说明由提交信息自动生成）。

去 Actions 看跑绿、去 Releases 看 `package.zip` 在不在，就完事了。

## 5. 集市什么时候更新

每 1~3 小时拉一次索引，思源里**重启**才能刷到新版本。

仓库已经在 `siyuan-note/bazaar` 的 `plugins.txt` 里（`clock-05/siyuan-latex-paste`），
**不用再提 PR**，以后每次都自动读最新 Release。

## 容易踩的坑

- **只推 `main` 不推 tag** —— 没有发版动作。
- **版本号和 tag 对不上** —— 集市认为没更新，索引不动。
- **忘了改 `package-lock.json`** —— `npm ci` 版本冲突。
- **`plugin.json` 里写 `zh_CN`** —— 必须 BCP 47 的 `zh-CN`；`i18n/` 目录名仍是下划线，两者不一样。
- **改 `dist/` 再手动打包** —— CI 会重新构建，本地改动全部作废。
- **Windows 的 `Compress-Archive`** —— 路径分隔符是 `\`，不合规范。要试包就在 Git Bash 里用 `zip`。
- **`icon.png` 超 64 KiB 或不是正方形** —— 集市卡片展示会出问题。
- **`.env` 提交上去** —— 里面有本地工作区路径，`.gitignore` 已挡住，提交前 `git status` 扫一眼。

## 两个不能改的东西

| 东西 | 原因 |
| --- | --- |
| `name`（`siyuan-latex-paste`） | 与仓库名绑定，改了等于变成另一个插件，集市会当成新包 |
| 已发布的 tag | 集市按 tag 找 Release，删了会让线上版本回退 |

`displayName` 是自由的，改名不影响任何东西。
