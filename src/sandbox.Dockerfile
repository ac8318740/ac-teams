# Image for enforced ac-teams members. Host code, grants, and Pi packages are mounted at run time.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ARG PI_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && npm cache clean --force
