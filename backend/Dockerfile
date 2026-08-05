# 1. 使用轻量级且稳定的 Python 3.11 镜像
FROM python:3.11-slim

# 2. 设置工作目录
WORKDIR /app

# 3. 设置环境变量：防止 Python 产生 .pyc 编译文件，并开启无缓冲输出（实时看 log）
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# 4. 安装基础系统依赖（如 PostgreSQL 链接和网络请求所需的基础库）
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 5. 先复制依赖文件（充分利用 Docker 缓存机制，加快后续重新 build 的速度）
COPY requirements.txt .

# 6. 安装 Python 依赖包
RUN pip install --no-cache-dir -r requirements.txt

# 7. 复制你的 FastAPI 后端所有源码到容器内
COPY . .

# 8. 暴露 FastAPI 运行的 8000 端口
EXPOSE 8000

# 9. 启动命令：使用 uvicorn 运行主程序（假设你的主入口是 main.py 里的 app）
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]