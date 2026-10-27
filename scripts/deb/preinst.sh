#!/bin/sh
set -e
# violoop group: shared with sibling violoop packages (socket access).
if ! getent group violoop >/dev/null; then
  addgroup --system violoop
fi
# violoop-mem 自有运行身份(0.8.0 起,不再承袭 qmd 用户):数据目录私有,
# 跨服务共享面只走 violoop 附加组。老盒子上残留的 qmd 用户归 violoop-qmd
# deb 的生命周期管,这里不动(未切换盒/回滚都还需要它)。
if ! getent group violoop-mem >/dev/null; then
  addgroup --system violoop-mem
fi
if ! getent passwd violoop-mem >/dev/null; then
  useradd --system --gid violoop-mem --no-create-home \
    --home-dir /var/lib/violoop-mem --shell /usr/sbin/nologin violoop-mem
fi
if [ ! -d /var/lib/violoop-mem ]; then
  mkdir -p /var/lib/violoop-mem
  chmod 0755 /var/lib/violoop-mem
fi
chown violoop-mem:violoop-mem /var/lib/violoop-mem
if ! id -nG violoop-mem 2>/dev/null | tr ' ' '\n' | grep -qx violoop; then
  adduser violoop-mem violoop >/dev/null 2>&1 || gpasswd -a violoop-mem violoop >/dev/null 2>&1 || true
fi
# 早期手动安装(rsync)把 node_modules symlink 到 /opt/qmd 的 node_modules;
# dpkg 不会用目录覆盖 symlink,先拆掉。
if [ -L /opt/violoop-mem/node_modules ]; then
  rm /opt/violoop-mem/node_modules
fi
