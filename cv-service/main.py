"""
CV 智能裁切微服务 - FastAPI 入口

提供两种接入方式:
1. HTTP API (供测试和直接调用)
2. Redis 队列消费 (与 Node.js 后端异步通信)
"""
import asyncio
import json
import os
import traceback
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

import config
from crop_generator import generate_crop_path


# ═══════════════════════════════════════════
# Redis 队列消费者
# ═══════════════════════════════════════════
redis_client: Optional[aioredis.Redis] = None
_consumer_task: Optional[asyncio.Task] = None

QUEUE_KEY = "cv:analyze:queue"      # Node.js 推送分析请求
RESULT_KEY_PREFIX = "cv:analyze:result:"  # 结果写回


async def consume_queue():
    """从 Redis 队列消费分析请求"""
    global redis_client
    print("🔍 CV Queue consumer started, listening on:", QUEUE_KEY)

    while True:
        try:
            # BLPOP 阻塞等待，超时 5 秒
            item = await redis_client.blpop(QUEUE_KEY, timeout=5)
            if item is None:
                continue

            _, raw = item
            request = json.loads(raw)

            video_id = request.get("videoId", "unknown")
            task_id = request.get("taskId", "unknown")
            video_path = request.get("videoPath")
            target_ratio = request.get("targetRatio", "9:16")
            user_keyframes = request.get("keyframes")

            print(f"📥 Received analysis request: video={video_id}, ratio={target_ratio}")

            # 更新状态为 analyzing
            status_key = f"cv:status:{video_id}"
            await redis_client.hset(status_key, mapping={
                "status": "analyzing",
                "progress": "0",
            })

            try:
                # 进度回调
                async def update_progress(pct):
                    await redis_client.hset(status_key, "progress", str(pct))

                # 同步函数用 asyncio 包装
                def sync_progress(pct):
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        asyncio.ensure_future(update_progress(pct))

                result = generate_crop_path(
                    video_path=video_path,
                    target_ratio=target_ratio,
                    user_keyframes=user_keyframes,
                    progress_callback=sync_progress,
                )

                # 写回结果
                result_key = f"{RESULT_KEY_PREFIX}{video_id}"
                await redis_client.set(
                    result_key,
                    json.dumps(result),
                    ex=3600,  # 1 小时过期
                )

                await redis_client.hset(status_key, mapping={
                    "status": "completed",
                    "progress": "100",
                })

                # 通知 Node.js
                await redis_client.publish("cv:analyze:done", json.dumps({
                    "videoId": video_id,
                    "taskId": task_id,
                    "status": "completed",
                    "analysisTime": result["analysis_time"],
                    "dominantScene": result["scene_summary"]["dominant_scene"],
                }))

                print(f"✅ Analysis done: video={video_id}, time={result['analysis_time']}s, scene={result['scene_summary']['dominant_scene']}")

            except Exception as e:
                error_msg = str(e)
                print(f"❌ Analysis failed: video={video_id}, error={error_msg}")
                traceback.print_exc()

                await redis_client.hset(status_key, mapping={
                    "status": "failed",
                    "error": error_msg,
                })

                await redis_client.publish("cv:analyze:done", json.dumps({
                    "videoId": video_id,
                    "taskId": task_id,
                    "status": "failed",
                    "error": error_msg,
                }))

        except asyncio.CancelledError:
            print("🛑 Queue consumer cancelled")
            break
        except Exception as e:
            print(f"❗ Queue consumer error: {e}")
            await asyncio.sleep(1)


# ═══════════════════════════════════════════
# FastAPI App
# ═══════════════════════════════════════════
@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client, _consumer_task

    # 启动
    redis_client = aioredis.Redis(
        host=config.REDIS_HOST,
        port=config.REDIS_PORT,
        decode_responses=True,
    )
    _consumer_task = asyncio.create_task(consume_queue())
    print(f"🚀 CV Service started (Redis: {config.REDIS_HOST}:{config.REDIS_PORT})")

    yield

    # 关闭
    if _consumer_task:
        _consumer_task.cancel()
        try:
            await _consumer_task
        except asyncio.CancelledError:
            pass
    if redis_client:
        await redis_client.close()
    print("🛑 CV Service stopped")


app = FastAPI(
    title="CV 智能裁切微服务",
    version="1.0.0",
    lifespan=lifespan,
)


# ═══════════════════════════════════════════
# HTTP API（测试和直接调用）
# ═══════════════════════════════════════════
class AnalyzeRequest(BaseModel):
    video_path: str
    target_ratio: str = "9:16"
    keyframes: Optional[List[Dict[str, Any]]] = None


class AnalyzeResponse(BaseModel):
    video_info: Dict[str, Any]
    target: Dict[str, Any]
    scene_summary: Dict[str, Any]
    crop_path: List[Dict[str, Any]]
    keyframes: List[Dict[str, Any]]
    analysis_time: float


@app.get("/health")
async def health():
    return {"status": "ok", "service": "cv-smart-crop"}


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_video(req: AnalyzeRequest):
    """
    HTTP 接口 - 分析视频并返回裁切路径

    主要用于测试，生产环境建议走 Redis 队列
    """
    if not os.path.exists(req.video_path):
        raise HTTPException(404, f"视频文件不存在: {req.video_path}")

    try:
        result = generate_crop_path(
            video_path=req.video_path,
            target_ratio=req.target_ratio,
            user_keyframes=req.keyframes,
        )
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/status/{video_id}")
async def get_status(video_id: str):
    """查询分析状态"""
    status_key = f"cv:status:{video_id}"
    data = await redis_client.hgetall(status_key)
    if not data:
        raise HTTPException(404, "未找到分析记录")
    return data


@app.get("/result/{video_id}")
async def get_result(video_id: str):
    """获取分析结果"""
    result_key = f"{RESULT_KEY_PREFIX}{video_id}"
    raw = await redis_client.get(result_key)
    if not raw:
        raise HTTPException(404, "未找到分析结果")
    return json.loads(raw)
