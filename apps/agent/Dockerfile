# Benchy Agent — one container per organization.
#
# Unmodified Hermes (pinned by digest) plus, configured not patched:
#   - the benchy engine, installed into Hermes's own venv, exposed as an MCP server
#   - core benchy skills, root-owned and read-only
#   - a pinned config.yaml and persona, copied over $HERMES_HOME on every boot
#   - a root pre-start that refuses to serve if any of that is not true
#
# Build (llm-client is private; the token is a BuildKit secret, never a layer):
#   docker build --secret id=gh_token,env=GH_TOKEN -t benchy-agent apps/agent
#
# Never override ENTRYPOINT on the host: /init + main-wrapper drop to the
# unprivileged hermes user, which is what keeps the core skills read-only.

FROM ghcr.io/astral-sh/uv:0.11.6 AS uv

FROM nousresearch/hermes-agent@sha256:444b42594e7f467425872fc35e077a227d377f0fe0726bc818706d62175fad8b

ARG BENCHY_ENGINE_REF=8933ec392cd29b6a08d3cede65a0eb8a57dd0650

USER root
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    --mount=type=secret,id=gh_token,required=true \
    git config --global url."https://x-access-token:$(cat /run/secrets/gh_token)@github.com/".insteadOf "https://github.com/" \
 && uv pip install --python /opt/hermes/.venv/bin/python --no-cache \
      "benchy[providers] @ git+https://github.com/surus-lat/benchy.git@${BENCHY_ENGINE_REF}" \
 && git config --global --unset-all url."https://x-access-token:$(cat /run/secrets/gh_token)@github.com/".insteadOf \
 && rm -f /root/.gitconfig

COPY --chown=root:root config.yaml SOUL.md /opt/benchy/
COPY --chown=root:root mcp/ /opt/benchy/mcp/
COPY --chown=root:root skills/ /opt/benchy/skills/
COPY --chown=root:root rootfs/ /
RUN chmod -R a-w,a+rX /opt/benchy \
 && chmod 0755 /etc/cont-init.d/03-benchy-setup \
 && /opt/hermes/.venv/bin/python -c "import benchy, llm_client, mcp.server.mcpserver; print('engine', benchy.__file__)"

# The engine's Bedrock provider builds its endpoint from AWS_REGION.
ENV AWS_REGION=us-east-1 \
    BENCHY_WORKSPACE=/opt/data/workspace \
    API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642

EXPOSE 8642
CMD ["gateway", "run"]
