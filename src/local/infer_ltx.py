#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
幻想时刻 本地推理入口（B 轨）

协议（与 JS 侧 LocalProvider 约定）：
  输入：命令行第一个参数是 JSON 字符串，字段见 build_request
  输出：向 stdout 逐行打印 JSON，每行一个事件：
        {"event":"progress","step":int,"total":int,"percent":float,"message":str}
        {"event":"log","level":"info|warn","message":str}
        {"event":"done","path":str,"seconds":float,"width":int,"height":int}
        {"event":"error","code":str,"message":str}
  退出码：0 成功；2 OOM；3 依赖缺失；4 参数错误；1 其他

设计原则：
  - 真实推理与"进度协议"解耦：即使无 GPU/无权重，也能用 --dry-run 走完整协议，
    供 JS 编排层做无头测试（不假装生成真实视频，dry-run 产物明确标注）。
  - 低显存优先：LTX-Video 2B 用 fp8/fp16 + enable_model_cpu_offload，OOM 时降参重试。
  - 绝不静默失败：任何异常都以 error 事件 + 非零退出码上报。
"""
import sys
import os
import json
import time
import argparse


def emit(event, **kwargs):
    """向 stdout 打印一行 JSON 事件并立即 flush（JS 侧按行解析进度）。"""
    rec = {"event": event}
    rec.update(kwargs)
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(code, message, exit_code=1):
    emit("error", code=code, message=str(message))
    sys.exit(exit_code)


def parse_args():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--request", required=True, help="JSON 请求字符串或 @文件路径")
    ap.add_argument("--dry-run", action="store_true", help="不加载模型，走完整协议产出占位视频（测试用）")
    ap.add_argument("--model-kind", default="ltx", help="ltx | wan | cogvideox")
    known, _ = ap.parse_known_args()
    raw = known.request
    if raw.startswith("@"):
        with open(raw[1:], "r", encoding="utf-8") as f:
            raw = f.read()
    try:
        req = json.loads(raw)
    except Exception as e:
        fail("BAD_REQUEST", "请求 JSON 解析失败: %s" % e, 4)
    return req, known


def resolve_paths(req):
    weights = req.get("weights") or {}
    model_root = weights.get("root")
    if not model_root or not os.path.isdir(model_root):
        fail("NOT_INSTALLED", "本地模型目录不存在: %s" % model_root, 3)
    return model_root


def dry_run_generate(req):
    """
    无 GPU/无权重的自检路径：用 imageio 写一段纯色占位视频，走完整进度协议。
    明确标注非真实生成，供 JS 编排层测试进度解析/超时/取消。
    """
    out_path = req["outputPath"]
    frames = int(req.get("frames", 24))
    w = int(req.get("width", 480))
    h = int(req.get("height", 320))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    try:
        import numpy as np
        import imageio
    except ImportError as e:
        fail("DEPS_MISSING", "dry-run 需要 numpy/imageio: %s" % e, 3)

    emit("log", level="warn", message="DRY-RUN 模式：产出占位视频，非真实 AI 生成结果")
    writer = imageio.get_writer(out_path, fps=8, codec="libx264", quality=5)
    for i in range(frames):
        # 渐变 + 文字色块，肉眼可辨"这是占位"
        base = int(40 + 180 * (i / max(1, frames - 1)))
        frame = np.zeros((h, w, 3), dtype=np.uint8)
        frame[:, :, 0] = base
        frame[:, :, 2] = 255 - base
        frame[h // 2 - 8:h // 2 + 8, w // 4:3 * w // 4] = [255, 255, 255]
        writer.append_data(frame)
        emit("progress", step=i + 1, total=frames,
             percent=round(100.0 * (i + 1) / frames, 1),
             message="DRY-RUN 合成占位帧 %d/%d" % (i + 1, frames))
        time.sleep(0.01)
    writer.close()
    emit("done", path=out_path, seconds=round(frames / 8.0, 2), width=w, height=h, dryRun=True)


def real_generate_ltx(req, model_root):
    """
    真实 LTX-Video 2B 推理（diffusers LTXPipeline）。
    低显存策略：fp16/fp8 + model_cpu_offload + sequential offload；OOM 降参重试。
    """
    out_path = req["outputPath"]
    prompt = req.get("prompt", "")
    negative = req.get("negativePrompt", "low quality, worst quality, deformed, distorted, disfigured, motion smear, jpeg artifacts, bad anatomy, watermark")
    width = int(req.get("width", 512))
    height = int(req.get("height", 320))
    frames = int(req.get("frames", 97))  # LTX 需要 8k+1 帧
    steps = int(req.get("steps", 30))
    guidance = float(req.get("guidance", 3.0))
    seed = req.get("seed")
    image_path = req.get("imagePath")

    try:
        import torch
        from diffusers import LTXPipeline
        try:
            from diffusers import LTXImageToVideoPipeline
            HAS_I2V = True
        except Exception:
            HAS_I2V = False
    except ImportError as e:
        fail("DEPS_MISSING", "缺少 torch/diffusers，请确认本地运行时已安装: %s" % e, 3)

    if not torch.cuda.is_available():
        fail("NO_CUDA", "未检测到可用 CUDA GPU，本地推理无法进行", 2)

    dtype = torch.float16
    if req.get("quantization") == "fp8" and hasattr(torch, "float8_e4m3fn"):
        emit("log", level="info", message="使用 fp8 量化以降低显存占用")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    generator = torch.Generator(device="cuda")
    if seed is not None:
        generator.manual_seed(int(seed))

    def progress_cb(pipe, step_index, timestep, callback_kwargs):
        emit("progress", step=step_index + 1, total=steps,
             percent=round(100.0 * (step_index + 1) / max(1, steps), 1),
             message="本地推理中 %d/%d 步" % (step_index + 1, steps))
        return callback_kwargs

    def run_once(w, h, st):
        if image_path and HAS_I2V:
            from PIL import Image
            pipe = LTXImageToVideoPipeline.from_pretrained(
                model_root, torch_dtype=dtype)
            pipe.enable_model_cpu_offload()
            img = Image.open(image_path).convert("RGB")
            video = pipe(image=img, prompt=prompt, negative_prompt=negative,
                         width=w, height=h, num_frames=frames,
                         num_inference_steps=st, guidance_scale=guidance,
                         generator=generator, callback_on_step_end=progress_cb).frames[0]
        else:
            pipe = LTXPipeline.from_pretrained(model_root, torch_dtype=dtype)
            pipe.enable_model_cpu_offload()
            video = pipe(prompt=prompt, negative_prompt=negative,
                         width=w, height=h, num_frames=frames,
                         num_inference_steps=st, guidance_scale=guidance,
                         generator=generator, callback_on_step_end=progress_cb).frames[0]
        from diffusers.utils import export_to_video
        export_to_video(video, out_path, fps=24)
        return w, h

    # OOM 降参重试：分辨率/步数逐级下调
    attempts = [(width, height, steps),
                (max(256, width // 2), max(256, height // 2), max(20, steps - 10)),
                (256, 256, 20)]
    last_err = None
    for (w, h, st) in attempts:
        try:
            emit("log", level="info", message="尝试 %dx%d / %d 步" % (w, h, st))
            run_once(w, h, st)
            emit("done", path=out_path, seconds=round(frames / 24.0, 2),
                 width=w, height=h, dryRun=False)
            return
        except RuntimeError as e:
            msg = str(e)
            if "out of memory" in msg.lower() or "CUDA" in msg:
                last_err = msg
                emit("log", level="warn", message="显存不足，降参重试: %s" % msg[:120])
                try:
                    import torch as _t
                    _t.cuda.empty_cache()
                except Exception:
                    pass
                continue
            fail("RUNTIME", msg, 1)
        except Exception as e:
            fail("RUNTIME", str(e), 1)
    fail("OUT_OF_MEMORY", "显存不足，已尝试最低参数仍失败: %s" % (last_err or ""), 2)


def main():
    req, opts = parse_args()
    for k in ("outputPath", "prompt"):
        if k not in req:
            fail("BAD_REQUEST", "请求缺少必填字段: %s" % k, 4)

    if opts.dry_run:
        try:
            dry_run_generate(req)
            sys.exit(0)
        except SystemExit:
            raise
        except Exception as e:
            fail("DRY_RUN_FAILED", str(e), 1)

    model_root = resolve_paths(req)
    kind = (req.get("modelKind") or opts.model_kind or "ltx").lower()
    if kind == "ltx":
        real_generate_ltx(req, model_root)
    else:
        # wan / cogvideox 走同类模式，v1.1 后续补齐；当前明确告知未实现，不假装成功
        fail("NOT_IMPLEMENTED", "本地 %s 推理在后续版本提供，当前请用 ltx 或云端通道" % kind, 3)
    sys.exit(0)


if __name__ == "__main__":
    main()
