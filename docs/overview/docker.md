---
title: Docker 部署
description: 使用 Docker Compose 部署无限画布
---

# Docker 部署

如果你希望在自己的机器或服务器上运行项目，可以直接使用 Docker Compose。

## 使用发布镜像

日常本地试用可以使用默认 Compose；生产或共享服务器不要直接执行 `docker compose up`。默认入口使用可变标签，旧容器和新容器也可能因为固定容器名或网络别名发生冲突。

生产发布请使用 `docker-compose.release.yml`，明确传入不可变镜像引用、独立数据目录和经过隔离校准的资源额度：

```bash
export WORKBENCH_IMAGE='ghcr.io/tigerowo/infinite-canvas@sha256:<已核验的多架构 manifest digest>'
export WORKBENCH_DATA_DIR='/srv/infinite-canvas/data'
export WORKBENCH_ENV_FILE='/srv/infinite-canvas/.env'
export WORKBENCH_CPUS='<维护窗口前在隔离副本校准>'
export WORKBENCH_MEM_LIMIT='<维护窗口前在隔离副本校准>'
export WORKBENCH_PIDS_LIMIT='<维护窗口前在隔离副本校准>'
docker compose -p infinite-canvas-release -f docker-compose.release.yml up -d
```

发布前应确认 `docker compose config` 展开的镜像不是 `latest`。Compose healthcheck 只验证 `3000 -> Next -> Go API` 的存活代理链路，不代表 SQLite、迁移或素材存储已经 ready；切流前仍必须完成独立数据恢复、登录、数据数量和素材读取冒烟。回滚时先停止新实例，再恢复旧的不可变镜像；旧实例重新接入业务网络前必须确认线上只有一个 `infinite-canvas` upstream。

启动后访问：

```text
http://localhost:3000
```

默认管理员账号：

```text
用户名：admin
密码：.env 中的 ADMIN_PASSWORD
```

## 本地构建镜像

如果需要基于当前源码构建镜像：

```bash
cp .env.example .env
docker compose -f docker-compose.local.yml up -d --build
```

## 数据目录

`docker-compose.yml` 会把本地 `./data` 挂载到容器内 `/app/data`，用于保存 SQLite 数据库、提示词数据和上传素材。

Docker 部署时建议把 `.env` 中的 SQLite 路径设置为：

```text
DATABASE_DSN=/app/data/infinite-canvas.db
```

如果需要让火山方舟拉取本地上传的 Seedance 参考素材，还需要把 `PUBLIC_BASE_URL` 设置为公网可访问的站点地址。

## 数据备份与恢复演练

`data/` 同时保存 SQLite、提示词和上传素材。不要对正在写入的 SQLite 文件直接普通复制。维护窗口或停写后执行一致性备份：

```bash
scripts/backup-data.sh /srv/infinite-canvas/data /srv/infinite-canvas/backups
```

恢复必须进入新的空目录，脚本会拒绝覆盖已有内容并执行 SQLite `integrity_check`：

```bash
scripts/restore-data.sh /srv/infinite-canvas/backups/infinite-canvas-data-<UTC>.tar.gz /srv/infinite-canvas/restore-smoke
```

恢复目录应使用独立 Compose project、端口和环境文件做 `/api/health`、登录、数据数量和素材读取冒烟。备份默认不包含 `logs/`、`*.log` 和 `*.pid`，运行日志如需留存应走单独的受控归档。脚本不会读取或输出环境变量中的密钥，也不会自动连接生产服务。
