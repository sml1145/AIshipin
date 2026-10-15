# 本地推理轨道（B 轨）说明

本目录存放本地免密钥推理所需的 Python 脚本，随安装包分发（extraResources）。

- v1.0：目录占位，本地轨道在 v1.1 通过软件自身更新机制下发（同时用于验证更新链路）。
- 文件规划：
  - requirements.txt  Python 依赖清单（torch / diffusers / transformers / accelerate / safetensors）
  - infer_ltx.py      LTX-Video 2B 推理入口（t2v / i2v），以 JSON 行向 stdout 汇报进度
  - env_probe.py      运行时自检（torch / CUDA / 显存），供主进程判断可用性

许可证：本目录脚本为 MIT；所引用的模型权重见 models.json 中各模型 license 字段（均为 Apache-2.0）。
