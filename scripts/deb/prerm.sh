#!/bin/sh
set -e

UNIT=violoop-mem-ov.service

case "$1" in
  remove|deconfigure)
    # stop 真的需要 systemd 在跑,守卫留着。disable 不需要,所以搬走了 ——
    # 它现在在 postrm 里用 deb-systemd-helper 做(见那边的注释),和 postinst
    # 的 enable 是同一个教训:只有"跟正在跑的 systemd 说话"才需要这个守卫。
    #
    # 升级走的是 prerm upgrade,不进这个分支:服务不停,由 postinst 的
    # try-restart 换新进程。
    if [ -d /run/systemd/system ]; then
      systemctl stop $UNIT >/dev/null 2>&1 || true
    fi
    ;;
esac
