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

**一个镜像** `ghcr.io/debbide/omnidrop`（API + Worker + 面板 + rclone）+ Redis。  
GitHub Actions 构建 **linux/amd64 + linux/arm64**。  
数据全部落在 **compose 同目录** `./data/` 下。

### 1. 准备目录与配置

```bash
mkdir -p omnidrop && cd omnidrop
# 写入 docker-compose.yml（见下方示例）与 .env（见下方示例）
```

生成密钥：

```bash
node -e "console.log('OMNIDROP_DATA_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

### 2. 启动

```bash
docker compose pull
docker compose up -d
# 打开 http://服务器IP:8080  首次创建管理员
```

若 GHCR 包为 private，先登录：

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u 你的用户名 --password-stdin
```

### 3. 本地从源码构建（可选）

```bash
# 在仓库根目录
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

请备份 **`OMNIDROP_DATA_KEY`** 与整个 **`./data`** 目录。

---

## docker-compose.yml 示例（最小部署）

与本文件同目录保存为 `docker-compose.yml`：

```yaml
# OmniDrop 最小部署：单应用镜像 + Redis
# 数据持久化在同目录 ./data/

services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--save", "60", "1"]
    volumes:
      - ./data/redis:/data

  omnidrop:
    image: ghcr.io/debbide/omnidrop:latest
    restart: unless-stopped
    ports:
      - "8080:80"
    env_file: .env
    environment:
      NODE_ENV: production
      API_PORT: 3000
      DATABASE_PATH: /data/db/omnidrop.sqlite
      TMP_DIR: /data/tmp
      ARTIFACTS_DIR: /data/artifacts
      REDIS_URL: redis://redis:6379
      APP_BASE_URL: ${APP_BASE_URL:-http://localhost:8080}
      COOKIE_SECURE: ${COOKIE_SECURE:-false}
      RCLONE_PATH: rclone
    volumes:
      - ./data/db:/data/db
      - ./data/tmp:/data/tmp
      - ./data/artifacts:/data/artifacts
    depends_on:
      - redis
```

仓库内完整版见根目录 [docker-compose.yml](docker-compose.yml)（含健康检查、日志轮转等）。

### 启动后目录结构

```text
.
├── docker-compose.yml
├── .env
└── data/
    ├── redis/        # Redis 数据
    ├── db/           # SQLite 数据库
    ├── tmp/          # 下载临时文件
    └── artifacts/    # 产物库
```

---

## .env 示例

同目录创建 `.env`（可复制仓库 [.env.example](.env.example)）：

```env
# 必填：32 字节 AES 密钥（base64）
# node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
OMNIDROP_DATA_KEY=

# 必填：会话签名密钥
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=

# 面板对外访问地址（CORS、分享链接会用到）
APP_BASE_URL=http://localhost:8080

# 宿主机映射端口（对应 compose 的 8080:80）
WEB_PORT=8080

# 使用 HTTPS 时改为 true
COOKIE_SECURE=false

LOG_LEVEL=info
NODE_ENV=production

# 可选
MAX_DOWNLOAD_CONCURRENCY=2
MAX_UPLOAD_CONCURRENCY=3
JOB_TMP_TTL_MINUTES=60
GITHUB_TOKEN=

# 镜像（一般不用改）
OMNIDROP_IMAGE=ghcr.io/debbide/omnidrop:latest
```

| 变量 | 说明 |
|------|------|
| `OMNIDROP_DATA_KEY` | 加密目标凭据，**丢失则旧目标密钥无法解密** |
| `SESSION_SECRET` | Cookie / 会话签名 |
| `APP_BASE_URL` | 浏览器访问本站的完整 URL |
| `WEB_PORT` | 宿主机端口，默认 `8080` |
| `COOKIE_SECURE` | HTTPS 时设 `true` |
| `GITHUB_TOKEN` | 可选，提高 GitHub Release 解析限额 |

---

## 本地开发（pnpm）

前置：Node 20+、pnpm 9、本机 Redis、可选 rclone。

```bash
pnpm install
pnpm build:packages
cp .env.example .env   # 填 OMNIDROP_DATA_KEY / SESSION_SECRET

docker run -d --name omnidrop-redis -p 6379:6379 redis:7-alpine

pnpm dev:api      # :3000
pnpm dev:worker
pnpm dev:web      # :5173，代理 /api → :3000
```

## 使用流程

1. **目标管理** → 添加 SFTP / FTP / WebDAV / 翼龙目标  
2. 目标列表点 **浏览** → 远端文件管理（列目录 / 上传 / 下载到产物库 / 重命名 / 删除）  
3. **新建投递** → HTTP / GitHub，或从产物库再投递  
4. **任务详情** → 查看进度与失败重试  

## 协议说明

| 协议 | 实现 | 配置要点 |
|------|------|----------|
| SFTP | rclone | 密码或私钥；`hostKeyPolicy=accept-new`（默认）或 `strict` + known_hosts |
| FTP | rclone | `secure`: plain / explicit / implicit；调试可 `insecureTls` |
| WebDAV | rclone | `vendor`: other/nextcloud/owncloud/sharepoint；basic 或 bearer |
| 翼龙 | Client API | panelUrl + serverId + `ptlc_` Client Key |

- 远端操作限制在目标 **`remotePath` jail**，禁止路径穿越。  
- Docker 镜像内置 rclone。  
- 离线 jail 单测：`pnpm test:jail`

## 目录结构

```text
apps/api           REST + SSE + 远端文件
apps/worker        队列消费者
apps/web           管理面板
packages/shared    枚举 / DTO
packages/db        SQLite schema
packages/crypto    凭据加解密
packages/remote-fs 统一远端 FS（rclone + 翼龙）
docker/            单镜像 Dockerfile、entrypoint、nginx
docker-compose.yml 生产部署（数据 → ./data）
.env.example       环境变量模板
deploy/            部署说明与最小 compose
```

## 安全说明

- 单管理员模型，勿裸奔公网  
- 生产建议 HTTPS + `COOKIE_SECURE=true`  
- 日志不输出明文密钥；务必备份 `OMNIDROP_DATA_KEY` 与 `./data`  

## 许可

私有 / 按项目约定使用。
