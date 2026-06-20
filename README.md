# CFC Web — 浏览器版 cimbar 接收端

零安装的网页接收端：手机浏览器打开 → 授权摄像头 → 扫描屏幕上的 cimbar 动态彩色码 → 还原文件。
编码端用 [cimbar.org](https://cimbar.org)。基于 [libcimbar](https://github.com/sz3/libcimbar)（WASM）。
文件全程走「屏幕 → 镜头」光学链路，端对端，不经过任何服务器（打开网页本身需要联网）。

## 特性
- **中 / EN 一键切换**：右上角药丸按钮，选择存 `localStorage`、两页面共享，首访按浏览器语言。
- **优雅的摄像头异常处理**：权限被拒/无摄像头/被占用/非 HTTPS 等都映射成友好的双语提示卡片 + 重试，不把原始报错糊到页面上。
- **iOS 兼容**：canvas 采集 + `playsinline`，并有相机保活 watchman。

## 目录内容
- `index.html` — 落地页（入口，品牌页 + 用法）
- `recv.html` / `recv.js` / `recv-worker.js` — 接收端 UI 与逻辑（主线程采集 + 4 个 Worker 解码）
- `i18n.js` — 中英文切换的共享语言状态（自动接管 `.lang-toggle` 按钮）
- `cimbar_js.js` / `cimbar_js.wasm` — libcimbar 编译出的 WASM（**构建产物**，见下）
- `recv-sw.js` / `pwa-recv.json` — PWA（可加到主屏、离线；改缓存资源记得给 `_cacheName` 升版本）
- `zstd.js`、`icon-*.png`、`favicon.ico`
- `privacy-policy.html` — 隐私政策（中英双语）
- `CLAUDE.md` — 给 Claude Code 的架构说明

> 注意：`cimbar_js.js` + `cimbar_js.wasm` 是编译产物。若仓库里没有，需先按 libcimbar 的
> `package-wasm.sh` 编出来，复制到本目录后再部署。

## 前提
- **必须 HTTPS**（`getUserMedia` 摄像头权限要求）。GitHub Pages / Cloudflare Pages 都自带 HTTPS。
- 单线程 WASM，**不需要 COOP/COEP 响应头**，普通静态托管即可。
- 所有路径已改为相对路径，根域名或子路径(`/<repo>/`)都能用。

## 方式 A：GitHub Pages（免费）
```bash
cd cfc-web
git init
git add .
git commit -m "CFC web receiver"
git branch -M main
git remote add origin https://github.com/<你的用户名>/cfc-web.git
git push -u origin main
```
然后在 GitHub 仓库 → Settings → Pages → Build and deployment：
- Source 选 **Deploy from a branch**
- Branch 选 **main** / 目录 **/(root)** → Save

几分钟后访问：`https://<你的用户名>.github.io/cfc-web/`
把这个链接发给大家即可（手机浏览器打开就能扫）。

## 方式 B：Cloudflare Pages（免费，国内访问通常更快）
1. 把本目录推到一个 GitHub 仓库（同上）。
2. Cloudflare 控制台 → Workers & Pages → Create → Pages → 连接该仓库。
3. 构建命令留空、输出目录填 `/`（纯静态）→ 部署。
4. 得到 `https://<项目名>.pages.dev`。

## 本地自测
```bash
cd cfc-web
python3 -m http.server 8000
# 浏览器开 http://localhost:8000 （localhost 算安全上下文，摄像头可用）
```
手机自测需 HTTPS，建议直接用上面的托管地址测。

## 打赏支持 ☕

这个小工具**完全免费**。如果它帮到了你，欢迎随意打赏支持一下 ~

| 微信 | 支付宝 |
| :--: | :--: |
| <img src="donate-wechat.jpg" width="200" alt="微信"> | <img src="donate-alipay.jpg" width="200" alt="支付宝"> |

> 收款码图片在仓库根目录：`donate-wechat.jpg`、`donate-alipay.jpg`（首页页脚「打赏支持」弹窗按品牌色 Tab 切换显示这两张）。

## 许可证

- 本仓库的原创代码（`recv.js` / `recv.html` / `i18n.js` / `index.html` 等）采用 **MIT** 协议，见 [LICENSE](LICENSE)。
- 打包的 `cimbar_js.js` / `cimbar_js.wasm` 是 [libcimbar](https://github.com/sz3/libcimbar) 的编译产物，遵循其 **MPL-2.0** 协议，源码见上游仓库。
