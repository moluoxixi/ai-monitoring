# 修复通知服务退出与自动恢复 - 技术设计

## 问题边界

故障由两个独立但串联的缺口构成：Codex watcher 的同步目录扫描存在 TOCTOU 竞态，可把瞬时 `ENOENT` 变成进程级未捕获异常；Windows 自启动只提供一次登录触发，不提供进程监督。前者负责减少退出，后者负责在任何意外退出后恢复。

## Watcher 容错

- 在 `captureStartupFiles` 内按目录、按文件建立局部容错边界。
- 目录在递归前消失时跳过该目录；文件在 `stat` 前消失时跳过该文件，同时保留同轮已发现结果。
- discovery 外层保留防御性兜底，记录非预期异常，确保裸定时器回调不向事件循环抛出。
- 启动扫描复用同一实现，不另建行为不同的扫描路径。
- 不吞掉 `syncFile` 的业务错误；该路径继续通过现有 Promise queue 记录并重试。

## Windows 监督

```text
ONLOGON task / Startup shortcut
  -> run-relay-supervisor.ps1
       -> run-relay.ps1
       -> Node 退出
       -> 记录退出码，等待
       -> 再次启动
```

- supervisor 是自启动专用入口，避免改变开发者手工运行 `run-relay.ps1` 的交互语义。
- 通过参数暴露重启延迟和可选最大重启次数，默认无限监督；有限次数只服务于确定性测试和诊断。
- supervisor 不并行启动多个 relay；每次同步等待子脚本返回后才进入下一轮。
- 安装脚本的计划任务和快捷方式只维护一个入口，并显式删除旧 Phoenix 项。

## 兼容与回滚

- watcher 修改不改变 JSONL parser、状态机或 ingestion 数据形状。
- supervisor 只影响重新执行安装脚本后的 Windows 登录启动行为；手工入口和 Docker 不变。
- 如 supervisor 造成异常重启循环，可将安装入口临时回退到 `run-relay.ps1`；watcher 容错可独立保留。

## 验证策略

- watcher 使用确定性依赖注入或测试替身制造一次 `stat` 的 `ENOENT`，避免真实并发删除造成抖动。
- PowerShell supervisor 使用临时 stub 脚本与有限重启次数验证退出码、等待和次数，不启动真实服务。
- 安装脚本使用静态契约测试或可测试 helper 验证入口与 legacy 清理。
- 最后更新本机自启动安装，执行健康检查并验证一次受控子进程恢复。
