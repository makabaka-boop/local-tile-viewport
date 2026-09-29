# syntax=docker/dockerfile:1

# ---- 依赖层：利用缓存先装依赖 ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# ---- verify：一次性测试服务（vue-tsc 类型检查 + vitest） ----
FROM node:20-alpine AS verify
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 默认命令即验收：失败则容器退出码非 0
CMD ["sh", "-c", "npm run typecheck && npm run test"]

# ---- 构建：产出 dist ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- web：静态托管工作台 ----
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
