<img src="icon.jpg" width="96" height="96" alt="dsh-mikufan 图标">

# dsh-mikufan

DeepSeek Harness 的插件包（bundle）：魔法未来为dsh增加/强化了几个功能：删除会话、启动动画、记忆、局域网访问、Skills管理、Agent自定义和MCP管理。

## 功能

| 功能 | 简介 |
| --- | --- |
| **删除会话** | 标记后**下次启动**时删除（含子代理会话）；标记期间再发消息会自动还原。 |
| **开机动画** | 页面加载时播 5 秒鲸标动画；任意键或点击跳过。 |
| **长期记忆** | 纯本地记忆，提供 `memory_*` 四个工具与每个会话的索引；面板可编辑、停用。 |
| **局域网访问** | 另开端口（默认 3090）免 token 反向代理；每次启动默认关，连接数按设备 IP 计。 |
| **Skills** | 管理 `~/.dsh/skills`，自带 `skill-creator`；面板可开关、新建、查看、卸载。 |
| **Agent** | 编辑用户全局 `~/.dsh/AGENTS.md`；清空保存即删除该文件。 |
| **MCP** | 按 ChatGPT / Codex 的 `mcp_servers` 标准管理服务器；令牌值不落盘，接入后开关立即生效。 |

## MAGICAL MIRAI面板

侧栏「MAGICAL MIRAI」入口是统一管理中枢

![MAGICAL MIRAI 控制面板主页](MAGICAL%20MIRAI.png)
