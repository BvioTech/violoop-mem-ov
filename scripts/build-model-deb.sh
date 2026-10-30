#!/usr/bin/env bash
# 构建 violoop-mem-ov-model deb(bge-m3 GGUF)。在有模型文件的 arm64 盒上跑:
#   MODEL_SRC=/usr/local/share/violoop/mem-ov/models/bge-m3-q8_0.gguf \
#     bash scripts/build-model-deb.sh
# md5 钉死:同名 GGUF 不同转换批次的余弦分布可差 0.2(真机踩过),
# 换模型文件必须同步更新 PINNED_MD5 并重锚 embedder.js 的标定常数。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-1.0.0}"
MODEL_SRC="${MODEL_SRC:-/usr/local/share/violoop/mem-ov/models/bge-m3-q8_0.gguf}"
# gpustack/bge-m3-GGUF bge-m3-Q8_0.gguf(2026-07-16 评测选型所用的那份)
PINNED_MD5="72a0035eaed5e12b0a4320d8f3ed68bc"

[ -f "$MODEL_SRC" ] || { echo "模型文件不存在: $MODEL_SRC" >&2; exit 1; }
got=$(md5sum "$MODEL_SRC" | cut -d' ' -f1)
if [ "$got" != "$PINNED_MD5" ]; then
  echo "md5 不匹配: got=$got want=$PINNED_MD5" >&2
  echo "(换模型文件需同步更新 PINNED_MD5 并重锚 embedder.js 标定常数)" >&2
  exit 1
fi

mkdir -p dist/model-stage
cp -f "$MODEL_SRC" dist/model-stage/bge-m3-q8_0.gguf
echo ">> nfpm package (violoop-mem-ov-model $VERSION)"
VERSION="$VERSION" nfpm package -f scripts/nfpm-model.yaml -p deb -t "dist/violoop-mem-ov-model_${VERSION}_arm64.deb"
rm -rf dist/model-stage
echo ">> done: dist/violoop-mem-ov-model_${VERSION}_arm64.deb"
