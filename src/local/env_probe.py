#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
幻想时刻 本地推理环境探针（B 轨自检用）

作用：如实报告本地推理链路的每一项就绪状态，绝不假装"能用"。
输出：stdout 一行 JSON（供 JS 侧 LocalProvider/自检模块解析）
      {"event":"probe", "python":..., "torch":..., "cuda":..., "vramGB":...,
       "deps":{...}, "weights":{...}, "ready":bool, "problems":[...], "warnings":[...]}
退出码：0（探针本身成功执行，无论环境是否就绪）；1（探针自身异常）

设计原则：每个依赖/权重单独检查并给可读原因，缺失就是缺失，不猜测、不美化。
"""
import sys
import os
import json
import importlib.util


def emit_probe(payload):
    sys.stdout.write(json.dumps({"event": "probe", **payload}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def check_module(name):
    try:
        spec = importlib.util.find_spec(name)
        return spec is not None
    except Exception:
        return False


def check_weights(model_root, required_files):
    """逐个检查权重文件是否真实存在，返回 {present, missing[], totalBytes}"""
    present = []
    missing = []
    total = 0
    for rel in required_files:
        p = os.path.join(model_root, rel) if model_root else rel
        if os.path.isfile(p):
            present.append(rel)
            try:
                total += os.path.getsize(p)
            except OSError:
                pass
        else:
            missing.append(rel)
    return {"present": present, "missing": missing, "totalBytes": total}


def main():
    problems = []
    warnings = []

    # 1. Python 自身版本
    py_version = "%d.%d.%d" % (sys.version_info[0], sys.version_info[1], sys.version_info[2])

    # 2. 核心依赖
    deps = {}
    for mod in ["torch", "diffusers", "transformers", "accelerate", "safetensors", "numpy", "imageio"]:
        deps[mod] = check_module(mod)
    for critical in ["torch", "diffusers", "transformers", "safetensors"]:
        if not deps[critical]:
            problems.append("缺少关键依赖 %s（请确认已在应用内安装本地运行时）" % critical)
    if not deps["numpy"] or not deps["imageio"]:
        warnings.append("缺少 numpy/imageio：dry-run 自检与部分导出功能不可用")

    # 3. CUDA 可用性（torch 装了才能查）
    cuda_available = False
    vram_gb = None
    torch_version = None
    if deps["torch"]:
        try:
            import torch  # noqa
            torch_version = getattr(torch, "__version__", None)
            cuda_available = bool(torch.cuda.is_available())
            if cuda_available:
                try:
                    props = torch.cuda.get_device_properties(0)
                    vram_gb = round(props.total_memory / (1024 ** 3), 2)
                except Exception:
                    vram_gb = None
            else:
                problems.append("torch 未检测到可用 CUDA GPU：本地 GPU 推理无法进行（可用云端通道，或用 dry-run 验证链路）")
        except Exception as e:
            problems.append("torch 导入失败：%s" % e)
    else:
        problems.append("未安装 torch，无法检查 CUDA")

    # 4. 权重就绪（可选：由 --model-root 与 --weights 传入）
    weights_report = {"modelRoot": None, "present": [], "missing": [], "totalBytes": 0}
    model_root = None
    required_files = []
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--model-root" and i + 1 < len(args):
            model_root = args[i + 1]; i += 2
        elif args[i] == "--weights" and i + 1 < len(args):
            # 逗号分隔的相对路径清单
            required_files = [x for x in args[i + 1].split(",") if x]; i += 2
        else:
            i += 1
    if model_root and required_files:
        weights_report = check_weights(model_root, required_files)
        weights_report["modelRoot"] = model_root
        if weights_report["missing"]:
            problems.append("模型权重缺失 %d 个文件：%s（请在「本地模型」页下载）" % (len(weights_report["missing"]), ", ".join(weights_report["missing"])))

    # 5. 综合就绪判定：GPU 推理就绪 = torch+CUDA+关键依赖+权重齐全
    gpu_ready = (deps["torch"] and cuda_available and not problems)
    # dry-run 就绪 = numpy+imageio（不需 GPU/权重）
    dry_run_ready = deps["numpy"] and deps["imageio"]

    emit_probe({
        "python": py_version,
        "torch": torch_version,
        "cuda": cuda_available,
        "vramGB": vram_gb,
        "deps": deps,
        "weights": weights_report,
        "gpuReady": gpu_ready,
        "dryRunReady": dry_run_ready,
        "ready": gpu_ready,
        "problems": problems,
        "warnings": warnings
    })
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        # 探针自身异常也要以结构化 JSON 报告，不让 JS 侧拿到空输出而误判
        try:
            emit_probe({"python": None, "torch": None, "cuda": False, "vramGB": None,
                        "deps": {}, "weights": {}, "gpuReady": False, "dryRunReady": False,
                        "ready": False, "problems": ["环境探针自身异常：%s" % e], "warnings": []})
        except Exception:
            pass
        sys.exit(1)
