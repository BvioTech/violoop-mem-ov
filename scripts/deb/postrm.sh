#!/bin/sh
set -e

UNIT=violoop-mem.service

case "$1" in
  remove|purge)
    # wants symlink 的清理和 postinst 的 enable 同理:不需要 systemd 在跑,
    # 所以不设守卫,chroot 里卸载也能清干净。
    #
    # 用 purge 而不是 disable:disable 会把"被管理员禁用"记进状态文件,将来
    # 重装时 was-enabled 就是假,服务不会自动 enable —— 卸载不该留下这种
    # 后遗症。purge 把符号链接和状态一起清掉,重装按首装处理。
    if [ -x /usr/bin/deb-systemd-helper ]; then
      deb-systemd-helper purge $UNIT >/dev/null || true
      deb-systemd-helper unmask $UNIT >/dev/null || true
    fi
    # postinst 按机型写的内存 drop-in(10-memory.conf)。只删自己那一份,
    # 管理员放的 20-*.conf 留着;目录空了才删,不然会连别人的配置一起带走。
    rm -f /etc/systemd/system/$UNIT.d/10-memory.conf
    rmdir /etc/systemd/system/$UNIT.d 2>/dev/null || true
    ;;
esac

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload || true
fi

case "$1" in
  remove|purge)
    # 回滚通道:接管时 postinst mask 了 qmd.service,卸载必须解除——
    # 否则装回 violoop-qmd 后其 postinst enable/start 均被 mask 挡住,
    # 服务静默起不来。
    if [ -d /run/systemd/system ]; then
      systemctl unmask qmd.service >/dev/null 2>&1 || true
    fi
    ;;
esac

# Memory belongs to the user: even purge retains old graph.db, native memory,
# migration receipts and configuration. Data deletion is a separate explicit action.
