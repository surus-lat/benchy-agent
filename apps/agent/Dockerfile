# Benchy Agent — one container per organization.
#
# Unmodified Hermes (pinned by digest) plus, configured not patched:
#   - the benchy engine, installed into Hermes's own venv, exposed as an MCP server
#   - core benchy skills, root-owned and read-only
#   - a pinned config.yaml and persona, copied over $HERMES_HOME on every boot
#   - a root pre-start that refuses to serve if any of that is not true
#   - a small proxy as the only public port: read-only workspace routes,
#     everything else forwarded to Hermes on loopback
#
# Build (llm-client is private: vendor its wheel first; no secret in the build):
#   apps/agent/prepare-vendor.sh && docker build -t benchy-agent apps/agent
# Railway: apps/agent/prepare-vendor.sh && railway up apps/agent --path-as-root
#
# Never override ENTRYPOINT on the host: /init + main-wrapper drop to the
# unprivileged hermes user, which is what keeps the core skills read-only.

FROM ghcr.io/astral-sh/uv:0.11.6 AS uv

FROM nousresearch/hermes-agent@sha256:444b42594e7f467425872fc35e077a227d377f0fe0726bc818706d62175fad8b

ARG BENCHY_ENGINE_REF=543104f744732a3e39e5799c9db1996cc6e4aad5

USER root
# Railway's builder supports only cache mounts, so uv is copied in and removed.
COPY --from=uv /uv /usr/local/bin/uv
COPY vendor/ /tmp/vendor/
# pypdfium2: text from the papers researchers add to a benchmark (mcp/benchy_sources.py).
# 5.13.0, not 5.14.0: the image's uv refuses releases newer than its cutoff.
# onnxruntime + tokenizers replace sentence-transformers + torch for embeddings.
RUN uv pip install --python /opt/hermes/.venv/bin/python --no-cache /tmp/vendor/llm_client-*.whl \
      "benchy @ git+https://github.com/surus-lat/benchy.git@${BENCHY_ENGINE_REF}" \
      pypdfium2==5.13.0 \
      onnxruntime \
      tokenizers \
 && rm -rf /tmp/vendor /usr/local/bin/uv

# Download the pre-exported ONNX embedding model from HuggingFace Hub.
# See: https://huggingface.co/surus-ai/embeddinggemma-2-onnx
# Re-export with mcp/export_onnx.py if the source model changes.
RUN /opt/hermes/.venv/bin/python -c "\
from huggingface_hub import hf_hub_download; \
import os; \
d = '/opt/benchy/mcp/embed_model'; os.makedirs(d, exist_ok=True); \
hf_hub_download('surus-ai/embeddinggemma-2-onnx', 'model_q8.onnx', local_dir=d); \
hf_hub_download('surus-ai/embeddinggemma-2-onnx', 'tokenizer.json', local_dir=d); \
print('Downloaded embed model to', d, os.listdir(d))"

COPY --chown=root:root config.yaml SOUL.md /opt/benchy/
COPY --chown=root:root mcp/ /opt/benchy/mcp/
COPY --chown=root:root proxy/ /opt/benchy/proxy/
COPY --chown=root:root skills/ /opt/benchy/skills/
COPY --chown=root:root rootfs/ /
RUN chmod -R a-w,a+rX /opt/benchy \
 && chmod 0755 /etc/cont-init.d/03-benchy-setup /etc/s6-overlay/s6-rc.d/benchy-proxy/run \
 && /opt/hermes/.venv/bin/python -c "import benchy, llm_client, mcp.server.mcpserver, pypdfium2; print('engine', benchy.__file__)"

# The engine's Bedrock provider builds its endpoint from AWS_REGION.
ENV AWS_REGION=us-east-1 \
    BENCHY_WORKSPACE=/opt/data/workspace \
    BENCHY_API_URL=https://getbenchy.lat \
    API_SERVER_ENABLED=true \
    API_SERVER_HOST=127.0.0.1 \
    API_SERVER_PORT=8642 \
    EMBED_MODEL_DIR=/opt/benchy/mcp/embed_model \
    PORT=8080

# Only the proxy is public (benchy_proxy.py); Hermes listens on loopback.
EXPOSE 8080
CMD ["gateway", "run"]
