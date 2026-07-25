# OmniDrop Docker 部署

镜像由 GitHub Actions 构建并推送到 GHCR，支持 **linux/amd64** 与 **linux/arm64**。

| 镜像 | 说明 |
|------|------|
| `ghcr.io/debbide/omnidrop-api` | API + rclone |
| `ghcr.io/debbide/omnidrop-worker` | Worker + rclone |
| `ghcr.io/debbide/omnidrop-web` | Nginx 静态面板 |

## VPS 快速启动（拉镜像）

```bash
# 1. 准备目录
mkdir -p omnidrop && cd omnidrop
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/debbide/OmniDrop/main/docker-compose.yml
curl -fsSL -o .env.example \
  https://raw.githubusercontent.com/debbide/OmniDrop/main/.env.example
cp .env.example .env

# 2. 生成密钥并写入 .env
echo "OMNIDROP_DATA_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" >> .env
echo "SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env
# 编辑 APP_BASE_URL=http://你的IP或域名:8080

# 3. 若仓库为 private package，需登录 GHCR
# echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# 4. 启动
docker compose pull
docker compose up -d
docker compose ps
```

浏览器打开 `http://服务器:8080`，首次创建管理员。

## 本地源码构建

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## 更新

```bash
docker compose pull
docker compose up -d
```

## 备份

需要备份的 volume：

- `omnidrop_db-data` — SQLite  
- `omnidrop_artifacts-data` — 产物文件  
- `.env` 里的 **`OMNIDROP_DATA_KEY`**（与 DB 同等重要）

## 多架构说明

GitHub Actions 使用 Buildx + QEMU 同时推送 `linux/amd64` 与 `linux/arm64`。  
Docker 在 x86 / ARM VPS 上会自动拉对应架构；rclone 在镜像构建时按 `TARGETARCH` 安装。
