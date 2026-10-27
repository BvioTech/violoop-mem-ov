#!/bin/sh
set -e

UNIT=violoop-mem.service

case "$1" in
  configure)
    # Seed operator config on first install only (fresh boxes without the
    # old violoop-qmd deb). Never overwrites operator edits.
    if [ ! -f /etc/qmd/qmd.yaml ]; then
      mkdir -p /etc/qmd
      cp /opt/violoop-mem/qmd.yaml.default /etc/qmd/qmd.yaml
      chmod 0644 /etc/qmd/qmd.yaml
    fi
    if [ -d /var/lib/violoop-mem ]; then
      # 0.8.0 起自有身份;从 0.7.x(qmd 属主)升级时顺带迁移属主
      chown -R violoop-mem:violoop-mem /var/lib/violoop-mem || true
    fi

    # 内存上限按机型分档。unit 里的 MemoryHigh=1792M / MemoryMax=2G 是按
    # 7.7G 的板子定的:实测峰值 1.37G,其中模型 mmap + llama 计算缓冲占了
    # 大头。放到 4G 机器上,同样的峰值就是整机的三分之一,硬限只会让服务
    # 变成"定时被杀"(然后撞重启配额、停手、socket 消失、edge 静默降级到
    # qmd)。所以小内存机型只保留软限节流,硬限交回整机 OOM killer —— unit
    # 里的 OOMScoreAdjust=-500 已经让本服务排在多数用户态进程之后。
    #
    # 写成 drop-in 而不是改 unit:unit 是 dpkg conffile,改它会在升级时跟
    # 操作员的改动打架;drop-in 每次 configure 按当前内存重算,换板子/加
    # 内存后重装即生效。管理员想自己定就放 20-*.conf,序号在后覆盖本文件。
    MEM_DROPIN=/etc/systemd/system/$UNIT.d/10-memory.conf
    MEM_KB=$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || echo 0)
    if [ "$MEM_KB" -gt 0 ]; then
      mkdir -p "$(dirname $MEM_DROPIN)"
      if [ "$MEM_KB" -ge 6291456 ]; then
        # ≥6G:unit 里的默认值就是按这档定的,写个空覆盖把上一次装机可能
        # 留下的小内存档清掉(换板子/加内存的情况)。
        printf '# 内存 %s kB(≥6G):用 unit 默认值,见 violoop-mem.service。\n[Service]\nMemoryHigh=1792M\nMemoryMax=2G\n' "$MEM_KB" > $MEM_DROPIN
      else
        # <6G:软限取总内存的 35%(4G 板 ≈1.4G,正好在实测峰值附近开始节流),
        # 但不低于 1G —— 再低连模型都放不下,节流会变成持续颠簸。
        # MemoryMax=infinity 显式解除硬限(覆盖 unit 里的 2G)。
        HIGH_MB=$(( MEM_KB * 35 / 100 / 1024 ))
        [ "$HIGH_MB" -lt 1024 ] && HIGH_MB=1024
        printf '# 内存 %s kB(<6G):只留软限节流,硬限交回整机 OOM killer。\n[Service]\nMemoryHigh=%sM\nMemoryMax=infinity\n' "$MEM_KB" "$HIGH_MB" > $MEM_DROPIN
      fi
      chmod 0644 $MEM_DROPIN
    fi

    # 早期手动安装(rsync 时代)在 /etc/systemd/system 留过 unit,会遮蔽 deb
    # 装的 /lib unit(.44 真机踩过);仅当内容不同时清理。删文件不需要 systemd
    # 在跑,所以**不放进下面的运行守卫** —— 镜像构建 chroot 里同样该清。
    if [ -f /etc/systemd/system/$UNIT ] \
      && ! cmp -s /etc/systemd/system/$UNIT /lib/systemd/system/$UNIT; then
      rm -f /etc/systemd/system/$UNIT
    fi

    # 同一段历史的另一半:rsync 时代 enable 出来的 wants symlink 指向
    # /etc/systemd/system/$UNIT。上面那个副本被删掉之后(或早就被删过 ——
    # .44 现在就是这样),symlink 就悬在那儿。systemd 眼下容忍它,但
    # deb-systemd-helper 不覆盖已存在的路径,于是这台机器永远拿不到指向
    # /lib 的正规链接,d-s-h 状态里也没有它,将来卸载同样清不掉。
    # 只清"指向那个旧路径、且目标已经不在"的;管理员自己建的链接不碰,
    # 而管理员关掉过的机器压根没有这个链接,所以这里不会把它重新打开。
    for w in /etc/systemd/system/*.wants/$UNIT; do
      [ -L "$w" ] || continue
      [ -e "$w" ] && continue
      case "$(readlink "$w")" in
        /etc/systemd/system/$UNIT) rm -f "$w" ;;
      esac
    done

    # enable 必须在运行守卫**外面**。`/run/systemd/system` 只在 systemd 正在
    # 跑的时候才存在,镜像构建 chroot 里没有 —— 以前 enable 和 start 一起被
    # 圈在守卫里,于是 chroot 装机的盒子 unit 落了地却从来没 enable,刷出来
    # 开机不起记忆服务(dev11 / dev20 两块 RK3576 实测 disabled)。
    #
    # deb-systemd-helper 就是为这件事设计的:它只管建/删 wants symlink,不碰
    # D-Bus,不需要 systemd 在跑。was-enabled / update-state 这一对是为了别把
    # 管理员手动关掉的机器在升级时又打开:首装没有状态文件 → 视为该 enable;
    # 管理员 disable 过 → 只更新状态,不重新 enable。
    if [ -x /usr/bin/deb-systemd-helper ]; then
      deb-systemd-helper unmask $UNIT >/dev/null || true
      if deb-systemd-helper --quiet was-enabled $UNIT; then
        deb-systemd-helper enable $UNIT >/dev/null || true
      else
        deb-systemd-helper update-state $UNIT >/dev/null || true
      fi
    else
      # init-system-helpers 是 systemd 机器的必备包,理论上到不了这里;
      # 真到了就退回 systemctl(chroot 里它会失败,但至少不比原来差)。
      systemctl enable $UNIT >/dev/null 2>&1 || true
    fi

    # 以下是真的需要 systemd 在跑的部分:重载 unit、接管 qmd 的历史 mask、
    # 起服务。chroot 里这一整块跳过是对的。
    if [ -d /run/systemd/system ]; then
      systemctl daemon-reload || true
      # 0.9.0 起共存策略:qmd 一概不碰(不 mask、不 stop、不删)。两服务
      # 各有 socket(0.8.0 身份分离),edge 侧解析优先 violoop-mem。历史
      # 版本(≤0.8.0)mask 过 qmd.service 的盒子,这里顺手解除,让 qmd
      # 回到它自己 deb 管理的原生状态。
      systemctl unmask qmd.service >/dev/null 2>&1 || true
      if systemctl is-active --quiet $UNIT; then
        systemctl try-restart $UNIT || true
      else
        systemctl start $UNIT || true
      fi
    fi
    # 首启空库会自动从 /var/lib/qmd 的 markdown 存量导入(只读,原目录
    # 不删不改);之后两边各自演进,edge 只写 violoop-mem。
    ;;
esac
