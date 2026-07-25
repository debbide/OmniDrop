# OmniDrop · 万能空投

多协议产物发布平台：在云端从 HTTP / GitHub Release 下载构建产物，再自动投递到 **SFTP** 与 **翼龙（Pterodactyl）** 目标服务器，提供直观 Web 面板做凭证配置与进度监控。

## 特性

- 凭证中心：SFTP / FTP / WebDAV / 翼龙，AES-256-GCM 加密落库
- **远端文件管理**：目标详情内嵌浏览器（列目录 / 新建 / 重命名 / 删除 / 上传 / 下载到产物库），路径 jail 在 `remotePath` 下
- **产物库**：下载后持久化，支持重命名 / 删除 / 下载 / 再投递
- **分享链接**：可选有效期与下载次数，匿名只读下载
- 任务投递：HTTP 直链 / GitHub Release / 产物再投递 → 多目标并行上传
- 安全：登录限流、会话吊销、改密踢下线、CI API Token（scope）、审计日志、安全响应头
- 流式下载：大文件落盘，边下边算 SHA256，避免 OOM
- 进度监控：SSE 实时推送 + 分目标进度条
- 一键部署：Docker Compose（API + Worker + Web + Redis），SQLite 单文件库

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18 + Vite + Ant Design 5 + React Query |
| API | Express + TypeScript |
| Worker | BullMQ + Rclone(SFTP) + Axios(Pterodactyl) |
| 数据 | SQLite via libSQL (Drizzle) + Redis |

## 快速开始（Docker）

镜像由 GitHub Actions 构建，支持 **linux/amd64** 与 **linux/arm64**（GHCR）。

### 生产：拉取多架构镜像

```bash
cp .env.example .env
# 填入 OMNIDROP_DATA_KEY / SESSION_SECRET / APP_BASE_URL

docker compose pull
docker compose up -d
# http://localhost:8080
```

### 本地：从源码构建

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

首次访问会引导创建管理员账号（密码 ≥ 10 位）。

**重要：** 请备份 `OMNIDROP_DATA_KEY` 与 SQLite 数据卷；丢失密钥将无法解密已有目标凭据。

更完整的 VPS 步骤见 [deploy/README.md](deploy/README.md)。

## 本地开发

前置：Node 20+、pnpm 9、本机 Redis、可选 rclone（SFTP 上传需要）。

```bash
# 安装
pnpm install

# 构建共享包
pnpm build:packages

# 准备 .env（仓库根目录）
cp .env.example .env
# 填入 OMNIDROP_DATA_KEY / SESSION_SECRET

# 启动 Redis（示例）
docker run -d --name omnidrop-redis -p 6379:6379 redis:7-alpine

# 三端开发
pnpm dev:api      # :3000
pnpm dev:worker
pnpm dev:web      # :5173，代理 /api → :3000
```

## 使用流程

1. **目标管理** → 添加 SFTP / FTP / WebDAV / 翼龙目标  
2. 目标列表点 **浏览** → 远端文件管理（列目录 / 上传 / 下载到产物库 / 重命名 / 删除）  
3. **新建投递** → HTTP / GitHub，或从产物库再投递  
4. **任务详情** → 查看进度与失败重试  

## 协议说明（适合 VPS 部署）

| 协议 | 实现 | 配置要点 |
|------|------|----------|
| SFTP | rclone | 密码或私钥；`hostKeyPolicy=accept-new`（默认）或 `strict` + known_hosts 文本 |
| FTP | rclone | `secure`: plain / explicit / implicit；调试可 `insecureTls` |
| WebDAV | rclone | `vendor`: other/nextcloud/owncloud/sharepoint；basic 或 bearer |
| 翼龙 | Client API | panelUrl + serverId + `ptlc_` Client Key |

- 远端操作限制在目标 **`remotePath` jail**，禁止路径穿越。  
- Docker 中 API/Worker **均内置 rclone**；本机开发需自行安装。  
- 离线 jail 单测：`pnpm --filter @omnidrop/remote-fs test:jail`

## 环境变量

见 [.env.example](.env.example)。必填：

- `OMNIDROP_DATA_KEY` — base64 编码的 32 字节 AES 密钥  
- `SESSION_SECRET` — Cookie 签名密钥  
- `REDIS_URL` — Redis 连接串  
- `RCLONE_PATH` — 可选，默认 `rclone`

## 目录结构

```text
apps/api       REST + SSE + 远端文件同步操作
apps/worker    队列消费者（投递 / 远端拉取上传）
apps/web       管理面板
packages/shared    枚举 / DTO / 路径安全
packages/db        SQLite schema
packages/crypto    凭据加解密
packages/remote-fs 统一远端 FS（rclone + 翼龙）
docker/            镜像与 nginx 配置
```

## 安全说明

- 管理面板为单管理员模型，请勿暴露到公网无防护环境  
- 生产环境建议 HTTPS，并将 `COOKIE_SECURE=true`  
- `remotePath` 禁止 `..`；日志不输出明文密钥  
- 翼龙大文件依赖面板 signed upload；若失败会回退 `files/write`（可能受反代 body 限制）  

## 许可

私有 / 按项目约定使用。
