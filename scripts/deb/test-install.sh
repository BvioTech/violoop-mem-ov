#!/bin/bash
# test-install.sh —— 在**没有运行中 systemd** 的环境里验证 maintainer script。
#
# 为什么需要它:0.11.0 之前 postinst 把 enable 和 start 一起圈在
# `[ -d /run/systemd/system ]` 里。那个目录只在 systemd 正在跑的时候存在,
# 镜像构建 chroot 里没有,于是 enable 整块被跳过 —— unit 落了地却从来没
# enable,刷出来的盒子开机不起记忆服务(dev11 / dev20 两块 RK3576 实测)。
# 这类回归在真机上要等刷完机才看得见,所以在这里钉住。
#
# 跑法(容器就是最方便的"没有 systemd 的 chroot"):
#   docker run --rm -v "$PWD":/src:ro debian:bookworm bash /src/scripts/deb/test-install.sh
# 或者在 debootstrap 出来的 chroot 里直接 bash scripts/deb/test-install.sh。
#
# 装的是一个只含 unit + 默认配置的最小包(payload 无关,要验的是脚本本身),
# 所以不需要 node、不需要 npm ci、不需要 aarch64。
set -u
# This test deliberately installs/removes packages and systemd state. It is only
# for a disposable Debian container, never a developer machine or real device.
if [ "${VIOLOOP_DISPOSABLE_INSTALL_TEST:-}" != "1" ]; then
  echo "Run only in a disposable container with VIOLOOP_DISPOSABLE_INSTALL_TEST=1" >&2
  exit 2
fi

SRC="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WANTS=/etc/systemd/system/multi-user.target.wants/violoop-mem.service
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
check(){ if eval "$2"; then ok "$1"; else no "$1"; fi; }

echo "== 前提 =="
check "/run/systemd/system 不存在(与镜像构建 chroot 同条件)" '[ ! -d /run/systemd/system ]'
check "deb-systemd-helper 在(init-system-helpers)" '[ -x /usr/bin/deb-systemd-helper ]'
if [ -d /run/systemd/system ]; then
  echo "!! 这台机器上 systemd 正在跑,测不出 chroot 那条路径。换容器或 chroot 再跑。" >&2
  exit 2
fi

build_deb() {  # $1=版本 $2=输出路径
  rm -rf /tmp/pkg && mkdir -p /tmp/pkg/DEBIAN /tmp/pkg/lib/systemd/system /tmp/pkg/opt/violoop-mem
  cp "$SRC/deploy/violoop-mem.service" /tmp/pkg/lib/systemd/system/
  cp "$SRC/deploy/qmd.yaml.default"    /tmp/pkg/opt/violoop-mem/
  cat > /tmp/pkg/DEBIAN/control <<CTL
Package: violoop-mem
Version: $1
Architecture: all
Maintainer: violoop <josley@bvio.ai>
Description: violoop-mem maintainer-script harness (payload trimmed)
CTL
  for s in preinst postinst prerm postrm; do
    cp "$SRC/scripts/deb/$s.sh" "/tmp/pkg/DEBIAN/$s"; chmod 0755 "/tmp/pkg/DEBIAN/$s"
  done
  dpkg-deb --build -Znone /tmp/pkg "$2" >/dev/null
}

reset_box() {
  dpkg --purge violoop-mem >/dev/null 2>&1
  rm -rf /etc/systemd/system/multi-user.target.wants /var/lib/systemd/deb-systemd-helper-enabled
  rm -f /etc/systemd/system/violoop-mem.service
}

build_deb 0.0.1 /tmp/v1.deb
build_deb 0.0.2 /tmp/v2.deb

echo
echo "== A 全新安装(chroot) =="
reset_box
dpkg -i /tmp/v1.deb >/tmp/a.log 2>&1
check "dpkg -i 成功" '! grep -q "^dpkg: error" /tmp/a.log'
check "wants symlink 生成了" '[ -L "$WANTS" ]'
check "指向 /lib 里的 unit" '[ "$(readlink "$WANTS")" = /lib/systemd/system/violoop-mem.service ]'
check "没试图连 D-Bus / 报 systemd 离线" '! grep -Eqi "Failed to connect to (bus|system scope)|D-Bus" /tmp/a.log'
check "输出无 error" '! grep -qi "error" /tmp/a.log'

echo
echo "== B 升级:已 enable 的机器不能被降回 disabled =="
dpkg -i /tmp/v2.deb >/tmp/b.log 2>&1
check "升级后 symlink 还在" '[ -L "$WANTS" ]'
check "升级无 error" '! grep -qi "error" /tmp/b.log'

echo
echo "== C 管理员关掉过的机器,升级不能被重新打开 =="
# 模拟 `systemctl disable`:它做的就是删掉 wants symlink。不能直接调
# deb-systemd-helper —— 它发现不是 dpkg 在调就直接退出,什么也不做。
rm -f "$WANTS"
dpkg -i /tmp/v1.deb >/tmp/c.log 2>&1
check "升级后仍然 disabled(尊重管理员)" '[ ! -e "$WANTS" ]'

echo
echo "== D 卸载清干净,重装又能自启 =="
reset_box; dpkg -i /tmp/v1.deb >/dev/null 2>&1
check "装完 symlink 在" '[ -L "$WANTS" ]'
dpkg --purge violoop-mem >/tmp/d.log 2>&1
check "purge 后 symlink 清掉了" '[ ! -e "$WANTS" ]'
check "purge 无 error" '! grep -qi "error" /tmp/d.log'
dpkg -i /tmp/v1.deb >/dev/null 2>&1
check "重装后自启恢复(状态没被 disable 污染)" '[ -L "$WANTS" ]'

echo
echo "== E 陈旧 /etc/systemd/system 副本(rsync 时代遗留) =="
reset_box
mkdir -p /etc/systemd/system && echo "# 旧的手装 unit" > /etc/systemd/system/violoop-mem.service
dpkg -i /tmp/v1.deb >/tmp/e.log 2>&1
check "内容不同的陈旧副本被清掉" '[ ! -e /etc/systemd/system/violoop-mem.service ]'
check "同时 wants symlink 也建了" '[ -L "$WANTS" ]'

echo
echo "== F 存量盒子:wants symlink 悬空指向 /etc(.44 真机就是这样) =="
reset_box
mkdir -p /etc/systemd/system/multi-user.target.wants
ln -s /etc/systemd/system/violoop-mem.service "$WANTS"
check "前提:symlink 悬空" '[ -L "$WANTS" ] && [ ! -e "$WANTS" ]'
dpkg -i /tmp/v1.deb >/tmp/f.log 2>&1
check "装完不再悬空" '[ -e "$WANTS" ]'
check "改指向 /lib 里的 unit" '[ "$(readlink "$WANTS")" = /lib/systemd/system/violoop-mem.service ]'

echo
echo "──────────── $PASS passed, $FAIL failed ────────────"
[ "$FAIL" -eq 0 ]
