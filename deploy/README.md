# OmniDrop Docker 部署

**一个应用镜像** + Redis：

| 镜像 | 内容 |
|------|------|
| `ghcr.io/debbide/omnidrop` | API + Worker + Nginx 面板 + rclone |
| `redis:7-alpine` | 队列 |

多架构：`linux/amd64`、`linux/arm64`。

## VPS 一键

```bash
mkdir -p omnidrop && cd omnidrop
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/debbide/OmniDrop/main/docker-compose.yml
curl -fsSL -o .env.example \
  https://raw.githubusercontent.com/debbide/OmniDrop/main/.env.example
cp .env.example .env

# 写入密钥
node -e "console.log('OMNIDROP_DATA_KEY='+require('crypto').randomBytes(32).toString('base64'))" >> .env
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('hex'))" >> .env
# 编辑 APP_BASE_URL=http://你的IP:8080

# 私有包需登录：echo TOKEN | docker login ghcr.io -u USER --password-stdin
docker compose pull
docker compose up -d
```

打开 `http://服务器:8080`。

## 本地源码构建

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## 更新

```bash
docker compose pull && docker compose up -d
```

## 备份

- volume：`*_db-data`、`*_artifacts-data`
- `.env` 中的 **`OMNIDROP_DATA_KEY`**
