/**
 * dsh-mikufan — Client half.
 *
 * Feature 1, "Delete-sessions":
 * - One row in a session's "..." menu: "删除会话" marks the session for the next
 *   startup deletion.
 * - One hover action on a marked session's row: "取消删除标记". For that row the
 *   shipped "..." trigger, pin and archive controls are retired, so a marked
 *   session offers exactly this one action.
 * - One `<style>` pair owned by this package (`data-plugin`), where the second
 *   tag carries the per-session rules: the title's strikethrough plus the
 *   retired row controls.
 *
 * Feature 2, "Startup animation":
 * - The cover itself belongs to the Host (`splash.js`), because it has to be in
 *   the served index.html before this module can even load; this half only
 *   reads and writes the Host preference.
 *
 * Feature 3, "Control panel" (shown as MAGICAL MIRAI):
 * - One sidebar rail entry ("MAGICAL MIRAI") opening the central panel under the id
 *   `mikufan-control-panel`. A floating pill tab bar (per the redesigned
 *   control-panel draft) switches between six pages:
 *   - MAGICAL MIRAI: one card per built-in feature switch (delete-sessions, startup
 *     animation, long-term memory). Every switch used to live in Settings →
 *     General and on the plugin detail page; both seats are retired and the
 *     panel is the only place to flip a feature now. Writes go through the
 *     Host preferences route with optimistic apply and rollback.
 *   - 记忆: the memory manager, migrated here from its own panel — list, add,
 *     edit, enable/disable and delete the durable entries in memory.json.
 *   - 局域网访问: the LAN-access manager driven by the `dsh-lan-access`
 *     bundle's engine (a second no-token reverse-proxy listener). This page
 *     is that plugin's only UI: the switch, the LAN address picker, the port
 *     and the live proxy status live here. dsh-lan-access's own Client half
 *     retired its former Settings row and plugin-page section.
 *   - Skills / MCP: the skill manager and the MCP server manager (the
 *     ChatGPT/Codex `mcp_servers` standard, stored by the Host in
 *     `~/.dsh/dsh-mikufan/mcp.json`).
 *   - Agent: one text box editing the user-global `<DSH home>/AGENTS.md` the
 *     Harness loads for every project; Save writes it, blank text removes it.
 * The dashboard page also carries a summary card per manager page (Skills,
 * Agent, MCP — no switch): its footer hydrates the same store the page uses,
 * so the status is visible without visiting the page.
 * - The last opened page is remembered in `localStorage`.
 *
 * The marked set, the preferences and the memories are the Host's (see
 * `index.js` and `memory.js`): this half hydrates from the HTTP routes and
 * updates optimistically.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mikufan',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useSyncExternalStore, useState, useEffect } = React;
    /**
     * `react-dom` is a platform seed word, so `createPortal` is available; the
     * memory dialog portals to `document.body` to escape the panel's scroll
     * container (a fixed overlay inside a transformed ancestor would be
     * trapped there). Guarded: without it the dialog still renders in place.
     */
    let ReactDOM;
    try {
      ReactDOM = require('react-dom');
    } catch {
      ReactDOM = undefined;
    }

    /** Package name; also the locale namespace this plugin owns. */
    const PACKAGE_NAME = 'dsh-mikufan';
    /** Host route prefix, relative to the page base. */
    const API_PREFIX = 'mikufan/api';
    /** The per-session "..." menu rows. */
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    /** The hover controls at the end of one session row. */
    const ROW_ACTION_SLOT = 'sidebar.workspaces.session.row.action';
    /** Sidebar panel icon list entry for the control panel. */
    const PANEL_LIST_SLOT = 'sidebar.panellist';
    /** The central panel body keyed by the same id. */
    const MAIN_SLOT = 'main';
    /** Panel id: both the sidebar entry and the `main` key. */
    const CONTROL_PANEL_ID = 'mikufan-control-panel';
    /** Our row sits after the shipped rows (`archive` 400, `session-id` 450). */
    const MENU_ORDER = 500;
    /** Our action sits after the shipped row actions (`pin`, `archive`). */
    const ROW_ACTION_ORDER = 900;
    /** Sidebar rail position of the control panel entry. */
    const PANEL_ORDER = 60;
    /** A session id safe to embed in a CSS attribute selector. */
    const SAFE_ID = /^[A-Za-z0-9._-]+$/;
    /** localStorage key remembering the last opened control-panel page. */
    const TAB_STORAGE_KEY = 'dsh-mikufan:control-panel-tab';
    /** The bundled skill that guides a user through creating a skill. */
    const SKILL_CREATOR_NAME = 'skill-creator';
    /**
     * The literal `/name` reference the Harness composer resolves to a skill:
     * the sent message carries this text and the Host loads the skill body.
     */
    const skillReference = (name) => `/${name}`;

    /** Dictionaries for the locale namespace; the loader injects no `t` for ours. */
    const DICTIONARIES = {
      zh: {
        'menu.deleteSession': '删除会话',
        'menu.cancelDeleteSession': '取消删除标记',
        'row.cancelDeleteSession': '取消删除标记',
        'deleteFeature.title': '删除会话',
        'deleteFeature.description': '被删除的会话将在下次启动时删除，其子代理会话一并删除；停用此功能删除不再执行。',
        'deleteFeature.pending.none': '下次启动不会删除任何会话',
        'deleteFeature.pending.some': '下次启动将删除 {count} 个会话',
        'deleteFeature.pending.off': '已关闭，下次启动不执行删除清扫',
        'splash.title': '启动动画',
        'splash.description': '一切皆插件。',
        'splash.pending.off': '已停用，页面加载将不再播放动画',
        'splash.pending.on': '每次加载页面时播放',
        'memoryFeature.title': '记忆',
        'memoryFeature.description': 'Agent 的本地长期记忆，每个会话自动携带记忆索引。',
        'memoryFeature.pending.none': '已保存 {count} 条记忆',
        'memoryFeature.pending.off': '已保存 {count} 条记忆（当前已停用）',
        'lanFeature.title': '局域网访问',
        'lanFeature.description': '允许局域网设备访问到 Harness。',
        'lanFeature.pending.off': '未开启',
        'lanFeature.pending.on': '使用 {url} 访问',
        'skillsFeature.title': 'Skills',
        'skillsFeature.description': '管理助手可用的技能扩展。',
        'skillsFeature.pending': '启用了 {enabled} 个技能，共 {total} 个',
        'agentFeature.title': 'Agent',
        'agentFeature.description': '编辑所选机器上的AGENTS.md。代码仓库的说明也可能适用。',
        'agentFeature.pending.some': '上次更新时间：{time}',
        'agentFeature.pending.none': '上次更新时间：—',
        'agentFeature.pending.loading': '上次更新时间：…',
        'mcpFeature.title': 'MCP',
        'mcpFeature.description': '按 ChatGPT/Codex 标准管理 MCP 服务器连接。',
        'mcpFeature.pending': '{enabled} / {total} 个服务器已启用',
        'mcpFeature.pending.off': '还没有 MCP 服务器，在 MCP 页添加',
        'feature.error': '保存失败，请重试。',
        'control.panel.label': 'MAGICAL MIRAI',
        'control.panel.title': '主页',
        'control.panel.subtitle': '更改设置并对插件的功能自定义。',
        'control.panel.tab.dashboard': '主页',
        'control.panel.tab.memory': '记忆',
        'control.panel.tab.lan': '局域网访问',
        'control.panel.tab.skills': 'Skills',
        'control.panel.tab.agent': 'Agent',
        'control.panel.tab.mcp': 'MCP',
        'lan.tab.title': '局域网访问',
        'lan.tab.subtitle': '局域网快速访问',
        'lan.card.switch.title': '局域网访问',
        'lan.card.switch.description': '需手动开启',
        'lan.card.ip.title': 'IP 地址',
        'lan.address.auto': '自动探测（推荐）',
        'lan.address.detected': '检测到的地址：{addresses}',
        'lan.address.detectedNone': '未检测到局域网地址；可选择「手动输入」填写。',
        'lan.address.manual': '手动输入…',
        'lan.address.placeholder': '192.168.31.6',
        'lan.card.port.title': '端口',
        'lan.card.port.description': '默认 {port}',
        'lan.card.max.title': '最大连接数',
        'lan.card.max.description': '按 IP 计，0 表示不限',
        'lan.max.invalid': '请输入 0–{limit} 之间的整数（0 表示不限制）。',
        'lan.foot.running': '已开启：{url}',
        'lan.foot.off': '入口未开启；本机 127.0.0.1 访问不受影响',
        'lan.foot.auto': '自动探测：{address}',
        'lan.foot.autoNone': '自动探测：未检测到可用地址',
        'lan.foot.manual': '手动指定：{address}',
        'lan.foot.port': '当前端口 {port}',
        'lan.foot.maxOff': '当前不限制设备数',
        'lan.foot.maxOn': '当前上限 {max} 台设备',
        'lan.foot.connections': ' · 已连接 {count} 台设备',
        'lan.foot.notApplied': '（未生效）',
        'lan.readFailed': '局域网状态读取失败，请刷新页面重试。',
        'lan.status.error': '启动失败：{message}',
        'lan.status.copy': '复制',
        'lan.status.copied': '已复制',
        'lan.saved': '已应用',
        'lan.saveFailed': '保存失败，请重试。',
        'lan.address.invalid': '地址无效：请填写本机的具体 IPv4/IPv6。',
        'lan.port.invalid': '端口无效：请输入 1–65535 之间的整数。',
        'skills.tab.title': 'Skills',
        'skills.tab.subtitle': '管理助手可用的技能扩展。',
        'skills.add': '新建技能',
        'skills.add.hint': '新建一个只引用 /skill-creator 的会话',
        'skills.count': '共 {count} 个技能',
        'skills.bar.matched': ' · 匹配 {count}',
        'skills.search.placeholder': '搜索技能',
        'skills.search.label': '搜索技能',
        'skills.empty': '还没有技能。点击上方卡片，让 Skill Creator 帮你创建一个。',
        'skills.empty.search': '没有匹配的技能。',
        'skills.refresh': '刷新技能列表',
        'skills.readFailed': '技能列表读取失败，请刷新页面重试。',
        'skills.updated': '更新于 {time}',
        'skills.open': '打开',
        'skills.details': '详情',
        'skills.enabled.on': '已启用（模型可见）',
        'skills.enabled.off': '已停用（保留文件，不进模型目录）',
        'skills.enable': '启用',
        'skills.disable': '停用',
        'skills.enabled.switch': '{action}技能：{name}',
        'skills.create.failed': '无法打开新会话，请手动新建会话并输入 /skill-creator。',
        'skills.restore.notice': '已恢复内置技能 skill-creator',
        'skills.openSession.failed': '无法打开新会话，请手动新建会话并输入 /{name}。',
        'skills.detail.loading': '读取 SKILL.md…',
        'skills.detail.error': '读取 SKILL.md 失败：{message}',
        'skills.detail.try': '立即试用',
        'skills.detail.uninstall': '卸载',
        'skills.detail.confirm': '确认卸载',
        'skills.detail.reveal': '在文件资源管理器中显示',
        'skills.detail.copy': '复制 Markdown',
        'skills.detail.copied': '已复制',
        'skills.detail.close': '关闭',
        'skills.detail.menu': '更多操作',
        'skills.preview.title': '技能',
        'skills.preview.missing': '没有要预览的技能。',
        'agent.tab.title': 'Agent',
        'agent.tab.subtitle': '编辑所选机器上的AGENTS.md。代码仓库的说明也可能适用。',
        'agent.placeholder': '[添加自定义指令...]',
        'agent.input.label': 'AGENTS.md 内容',
        'agent.save': '保存',
        'agent.saving': '保存中…',
        'agent.saved': '已保存',
        'agent.saveFailed': '保存失败，请重试。',
        'agent.readFailed': '读取 AGENTS.md 失败，请刷新页面重试。',
        'mcp.tab.title': 'MCP',
        'mcp.tab.subtitle': '按 ChatGPT/Codex 的 mcp_servers 标准管理 Model Context Protocol 服务器连接。',
        'mcp.placeholder.title': '暂无服务器',
        'mcp.placeholder.text': '添加 MCP 服务器后，可在此查看连接状态与可用工具。',
        'mcp.add': '添加服务器',
        'mcp.add.hint': '按 ChatGPT/Codex 的 mcp_servers 标准新增',
        'mcp.count': '共 {count} 个服务器 · {enabled} 个启用',
        'mcp.bar.matched': ' · 匹配 {count}',
        'mcp.search.placeholder': '搜索服务器',
        'mcp.search.label': '搜索服务器',
        'mcp.empty': '还没有 MCP 服务器。点击上方卡片，按 Codex 标准添加第一个。',
        'mcp.empty.search': '没有匹配的服务器。',
        'mcp.refresh': '刷新服务器列表',
        'mcp.readFailed': 'MCP 服务器列表读取失败，请刷新页面重试。',
        'mcp.transport.stdio': 'stdio（本地进程）',
        'mcp.transport.streamable_http': 'streamable_http（远程服务）',
        'mcp.enabled.on': '已启用（同步开关到运行中的 Harness）',
        'mcp.enabled.off': '已停用（保留条目，不写入配置）',
        'mcp.enabled.enable': '启用',
        'mcp.enabled.disable': '停用',
        'mcp.enabled.switch': '{action}MCP 服务器：{name}',
        'mcp.applied.reloaded': '已同步到运行中的 Harness（立即生效）。',
        'mcp.applied.failed': '已写入 mcp.json，但同步到运行中的 Harness 失败：{message}',
        'mcp.applied.restart': '已写入 mcp.json；该条目需要重启 Harness 才能生效。',
        'mcp.edit': '编辑',
        'mcp.details': '详情',
        'mcp.delete': '删除',
        'mcp.confirmDelete': '确认删除',
        'mcp.new.title': '添加 MCP 服务器',
        'mcp.new.desc': '按 ChatGPT/Codex 的 mcp_servers 标准填写；保存后可在详情里复制配置。',
        'mcp.edit.title': '编辑 MCP 服务器',
        'mcp.edit.desc': '字段与 Codex 的 [mcp_servers.<名称>] 一致，保存后写入 mcp.json。',
        'mcp.field.name': '名称',
        'mcp.field.name.hint': '1–32 位字母、数字、_ 或 -；对应 [mcp_servers.<名称>]',
        'mcp.field.transport': '传输方式',
        'mcp.field.command': '命令',
        'mcp.field.command.hint': '启动服务器的可执行文件，例如 npx 或 python',
        'mcp.field.args': '参数',
        'mcp.field.args.hint': '空格分隔；含空格的参数用引号包裹',
        'mcp.field.envVars': '转发环境变量',
        'mcp.field.envVars.hint': '每行一个变量名；从本机环境原样转发',
        'mcp.field.env': '附加环境变量',
        'mcp.field.env.hint': '每行 KEY = value；复制进服务器进程',
        'mcp.field.cwd': '工作目录',
        'mcp.field.cwd.hint': '可选；服务器的启动目录',
        'mcp.field.url': 'URL',
        'mcp.field.url.hint': 'Streamable HTTP 端点地址',
        'mcp.field.bearer': 'Bearer 令牌环境变量',
        'mcp.field.bearer.hint': '只填变量名（如 GITHUB_TOKEN），令牌值本身不落盘',
        'mcp.field.headers': '附加请求头',
        'mcp.field.headers.hint': '每行 NAME = value；随请求发送',
        'mcp.field.startupTimeout': '启动超时（秒）',
        'mcp.field.startupTimeout.hint': '默认 10',
        'mcp.field.toolTimeout': '工具超时（秒）',
        'mcp.field.toolTimeout.hint': '默认 60',
        'mcp.error.name': '名称需为 1–32 位字母、数字、_ 或 -。',
        'mcp.error.command': 'stdio 服务器需要填写命令。',
        'mcp.error.url': 'URL 必须以 http:// 或 https:// 开头。',
        'mcp.error.table': '键值表每行写 NAME = value。',
        'mcp.error.timeout': '超时必须是 0–600 之间的秒数。',
        'mcp.detail.codex': 'Codex / ChatGPT（config.toml）',
        'mcp.detail.dsh': '本机 Harness（cordis.patch.yml 条目）',
        'mcp.detail.copy': '复制',
        'mcp.detail.copied': '已复制',
        'mcp.close': '关闭',
        'memory.tab.title': '记忆',
        'memory.tab.subtitle': 'Agent 跨会话记住的持久事实，纯本地存储。',
        'memory.offNotice': '长期记忆功能当前已关闭，可在「MAGICAL MIRAI」页开启。',
        'memory.add.placeholder': '记一条新记忆，例如：用户偏好简洁回复…',
        'memory.addCard': '新建记忆',
        'memory.addCard.hint': '新建一条记忆',
        'memory.empty.search': '没有匹配的记忆。',
        'memory.empty': '还没有记忆。点击上方卡片新建第一条。',
        'memory.count': '共 {count} 条记忆 · {enabled} 条启用',
        'memory.bar.matched': ' · 匹配 {count}',
        'memory.search.placeholder': '搜索记忆',
        'memory.search.label': '搜索记忆',
        'memory.refresh': '刷新记忆列表',
        'memory.readFailed': '记忆列表读取失败，请刷新页面重试。',
        'memory.new': '新建记忆',
        'memory.new.desc': '写一条希望 Agent 跨会话记住的事实，保存后立即进入记忆索引。',
        'memory.edit.title': '编辑记忆',
        'memory.edit.desc': '修改内容或类型，保存后立即生效。',
        'memory.field.content': '内容',
        'memory.field.type': '类型',
        'memory.counter': '{count} / {max}',
        'memory.create': '创建',
        'memory.close': '关闭',
        'memory.openEdit': '查看并编辑这条记忆',
        'memory.type.user': '用户',
        'memory.type.feedback': '纠正',
        'memory.type.project': '项目',
        'memory.type.reference': '参考',
        'memory.source.agent': 'Agent',
        'memory.source.manual': '手动',
        'memory.save': '保存',
        'memory.cancel': '取消',
        'memory.edit': '编辑',
        'memory.delete': '删除',
        'memory.confirmDelete': '确认删除',
        'memory.enabled.on': '已启用（会注入会话索引）',
        'memory.enabled.off': '已停用（保留但不注入）',
        'memory.enabled.enable': '启用',
        'memory.enabled.disable': '停用',
        'memory.enabled.switch': '{action}记忆：{content}',
        'memory.updated': '更新于 {time}',
        'memory.error': '操作失败：{message}',
      },
      en: {
        'menu.deleteSession': 'Delete session',
        'menu.cancelDeleteSession': 'Cancel deletion mark',
        'row.cancelDeleteSession': 'Cancel deletion mark',
        'deleteFeature.title': 'Delete sessions',
        'deleteFeature.description': 'Marked sessions are deleted at the next startup together with their subagent sessions; disabling this feature stops the sweep.',
        'deleteFeature.pending.none': 'No sessions will be deleted on next startup',
        'deleteFeature.pending.some': '{count} session(s) will be deleted on next startup',
        'deleteFeature.pending.off': 'Disabled — no sweep on next startup',
        'splash.title': 'Startup animation',
        'splash.description': 'Everything is a plugin.',
        'splash.pending.off': 'Disabled — page loads play no animation',
        'splash.pending.on': 'Plays on every page load',
        'memoryFeature.title': 'Memory',
        'memoryFeature.description': 'The agent\'s local long-term memory; every session carries a memory index.',
        'memoryFeature.pending.none': '{count} memories saved',
        'memoryFeature.pending.off': '{count} memories saved (currently disabled)',
        'lanFeature.title': 'LAN access',
        'lanFeature.description': 'Let devices on the LAN reach the Harness.',
        'lanFeature.pending.off': 'Off',
        'lanFeature.pending.on': 'Use {url} to connect',
        'skillsFeature.title': 'Skills',
        'skillsFeature.description': 'Manage the skill extensions available to the agent.',
        'skillsFeature.pending': '{enabled} of {total} skills enabled',
        'agentFeature.title': 'Agent',
        'agentFeature.description': 'Edit AGENTS.md on the selected machine. Repository instructions may also apply.',
        'agentFeature.pending.some': 'Last updated: {time}',
        'agentFeature.pending.none': 'Last updated: —',
        'agentFeature.pending.loading': 'Last updated: …',
        'mcpFeature.title': 'MCP',
        'mcpFeature.description': 'Manage MCP servers in the ChatGPT/Codex standard.',
        'mcpFeature.pending': '{enabled} / {total} servers enabled',
        'mcpFeature.pending.off': 'No MCP servers yet — add one on the MCP page',
        'feature.error': 'Could not save. Try again.',
        'control.panel.label': 'MAGICAL MIRAI',
        'control.panel.title': 'Home',
        'control.panel.subtitle': 'Change settings and customize the plugin\'s features.',
        'control.panel.tab.dashboard': 'Home',
        'control.panel.tab.memory': 'Memory',
        'control.panel.tab.lan': 'LAN access',
        'control.panel.tab.skills': 'Skills',
        'control.panel.tab.agent': 'Agent',
        'control.panel.tab.mcp': 'MCP',
        'lan.tab.title': 'LAN access',
        'lan.tab.subtitle': 'Quick LAN access',
        'lan.card.switch.title': 'LAN access',
        'lan.card.switch.description': 'Turn it on manually',
        'lan.card.ip.title': 'IP address',
        'lan.address.auto': 'Auto-detect (recommended)',
        'lan.address.detected': 'Detected addresses: {addresses}',
        'lan.address.detectedNone': 'No LAN address detected; choose "manual" and type one.',
        'lan.address.manual': 'Manual…',
        'lan.address.placeholder': '192.168.31.6',
        'lan.card.port.title': 'Port',
        'lan.card.port.description': 'Defaults to {port}',
        'lan.card.max.title': 'Max connections',
        'lan.card.max.description': 'Per IP; 0 means unlimited',
        'lan.max.invalid': 'Enter an integer between 0 and {limit} (0 means unlimited).',
        'lan.foot.running': 'On: {url}',
        'lan.foot.off': 'Entry is off; local access on 127.0.0.1 is unaffected',
        'lan.foot.auto': 'Auto-detected: {address}',
        'lan.foot.autoNone': 'Auto-detect: no usable address found',
        'lan.foot.manual': 'Manual: {address}',
        'lan.foot.port': 'Current port {port}',
        'lan.foot.maxOff': 'Unlimited devices',
        'lan.foot.maxOn': 'Limit {max} devices',
        'lan.foot.connections': ' · {count} device(s) connected',
        'lan.foot.notApplied': ' (not applied)',
        'lan.readFailed': 'Could not read the LAN status. Refresh the page to retry.',
        'lan.status.error': 'Failed to start: {message}',
        'lan.status.copy': 'Copy',
        'lan.status.copied': 'Copied',
        'lan.saved': 'Applied',
        'lan.saveFailed': 'Saving failed, please retry.',
        'lan.address.invalid': 'Invalid address: enter a concrete IPv4/IPv6 of this machine.',
        'lan.port.invalid': 'Invalid port: enter an integer between 1 and 65535.',
        'skills.tab.title': 'Skills',
        'skills.tab.subtitle': 'Manage the skill extensions available to the agent.',
        'skills.add': 'New skill',
        'skills.add.hint': 'Start a session that only references /skill-creator',
        'skills.count': '{count} skills',
        'skills.bar.matched': ' · {count} matching',
        'skills.search.placeholder': 'Search skills',
        'skills.search.label': 'Search skills',
        'skills.empty': 'No skills yet. Use the card above to have Skill Creator build one.',
        'skills.empty.search': 'No matching skills.',
        'skills.refresh': 'Refresh skills',
        'skills.readFailed': 'Could not read the skills. Refresh the page to retry.',
        'skills.updated': 'Updated {time}',
        'skills.open': 'Open',
        'skills.details': 'Details',
        'skills.enabled.on': 'Enabled (visible to the model)',
        'skills.enabled.off': 'Disabled (kept on disk, out of the model catalog)',
        'skills.enable': 'Enable',
        'skills.disable': 'Disable',
        'skills.enabled.switch': '{action} skill: {name}',
        'skills.create.failed': 'Could not open a new session — start one and type /skill-creator.',
        'skills.restore.notice': 'Restored the bundled skill-creator',
        'skills.openSession.failed': 'Could not open a new session — start one and type /{name}.',
        'skills.detail.loading': 'Reading SKILL.md…',
        'skills.detail.error': 'Could not read SKILL.md: {message}',
        'skills.detail.try': 'Try it',
        'skills.detail.uninstall': 'Uninstall',
        'skills.detail.confirm': 'Confirm uninstall',
        'skills.detail.reveal': 'Show in file manager',
        'skills.detail.copy': 'Copy Markdown',
        'skills.detail.copied': 'Copied',
        'skills.detail.close': 'Close',
        'skills.detail.menu': 'More actions',
        'skills.preview.title': 'Skill',
        'skills.preview.missing': 'No skill to preview.',
        'agent.tab.title': 'Agent',
        'agent.tab.subtitle': 'Edit AGENTS.md on the selected machine. Repository instructions may also apply.',
        'agent.placeholder': '[Add custom instructions...]',
        'agent.input.label': 'AGENTS.md content',
        'agent.save': 'Save',
        'agent.saving': 'Saving…',
        'agent.saved': 'Saved',
        'agent.saveFailed': 'Could not save. Try again.',
        'agent.readFailed': 'Could not read AGENTS.md. Refresh the page to retry.',
        'mcp.tab.title': 'MCP',
        'mcp.tab.subtitle': 'Manage Model Context Protocol servers in the ChatGPT/Codex mcp_servers format.',
        'mcp.placeholder.title': 'No servers yet',
        'mcp.placeholder.text': 'Added MCP servers show their connection status and tools here.',
        'mcp.add': 'Add server',
        'mcp.add.hint': 'Add one in the ChatGPT/Codex mcp_servers format',
        'mcp.count': '{count} servers · {enabled} enabled',
        'mcp.bar.matched': ' · {count} matched',
        'mcp.search.placeholder': 'Search servers',
        'mcp.search.label': 'Search servers',
        'mcp.empty': 'No MCP servers yet. Use the card above to add the first one, Codex-style.',
        'mcp.empty.search': 'No matching servers.',
        'mcp.refresh': 'Refresh server list',
        'mcp.readFailed': 'Reading the MCP server list failed; reload the page and retry.',
        'mcp.transport.stdio': 'stdio (local process)',
        'mcp.transport.streamable_http': 'streamable_http (remote service)',
        'mcp.enabled.on': 'Enabled (synced into the running Harness)',
        'mcp.enabled.off': 'Disabled (kept here, not written into the config)',
        'mcp.enabled.enable': 'Enable',
        'mcp.enabled.disable': 'Disable',
        'mcp.enabled.switch': '{action} MCP server: {name}',
        'mcp.applied.reloaded': 'Synced into the running Harness (effective immediately).',
        'mcp.applied.failed': 'Written to mcp.json, but syncing into the running Harness failed: {message}',
        'mcp.applied.restart': 'Written to mcp.json; this entry needs a Harness restart to take effect.',
        'mcp.edit': 'Edit',
        'mcp.details': 'Details',
        'mcp.delete': 'Remove',
        'mcp.confirmDelete': 'Confirm removal',
        'mcp.new.title': 'Add MCP server',
        'mcp.new.desc': 'Fill in the ChatGPT/Codex mcp_servers fields; copy the config from the details view afterwards.',
        'mcp.edit.title': 'Edit MCP server',
        'mcp.edit.desc': 'The fields match the Codex [mcp_servers.<name>] table; saving writes mcp.json.',
        'mcp.field.name': 'Name',
        'mcp.field.name.hint': '1–32 letters, digits, _ or -; maps to [mcp_servers.<name>]',
        'mcp.field.transport': 'Transport',
        'mcp.field.command': 'Command',
        'mcp.field.command.hint': 'Executable that starts the server, e.g. npx or python',
        'mcp.field.args': 'Arguments',
        'mcp.field.args.hint': 'Space-separated; quote arguments containing spaces',
        'mcp.field.envVars': 'Forwarded env vars',
        'mcp.field.envVars.hint': 'One variable name per line; forwarded from the local environment',
        'mcp.field.env': 'Extra env vars',
        'mcp.field.env.hint': 'One KEY = value per line; copied into the server process',
        'mcp.field.cwd': 'Working directory',
        'mcp.field.cwd.hint': 'Optional; where the server starts',
        'mcp.field.url': 'URL',
        'mcp.field.url.hint': 'Streamable HTTP endpoint',
        'mcp.field.bearer': 'Bearer token env var',
        'mcp.field.bearer.hint': 'The variable name only (e.g. GITHUB_TOKEN); the token value itself is never stored',
        'mcp.field.headers': 'Extra headers',
        'mcp.field.headers.hint': 'One NAME = value per line; sent with every request',
        'mcp.field.startupTimeout': 'Startup timeout (s)',
        'mcp.field.startupTimeout.hint': 'Default 10',
        'mcp.field.toolTimeout': 'Tool timeout (s)',
        'mcp.field.toolTimeout.hint': 'Default 60',
        'mcp.error.name': 'The name must be 1–32 letters, digits, _ or -.',
        'mcp.error.command': 'A stdio server needs a command.',
        'mcp.error.url': 'The URL must start with http:// or https://.',
        'mcp.error.table': 'Write one NAME = value per line.',
        'mcp.error.timeout': 'The timeout must be 0–600 seconds.',
        'mcp.detail.codex': 'Codex / ChatGPT (config.toml)',
        'mcp.detail.dsh': 'This Harness (cordis.patch.yml entry)',
        'mcp.detail.copy': 'Copy',
        'mcp.detail.copied': 'Copied',
        'mcp.close': 'Close',
        'memory.tab.title': 'Memory',
        'memory.tab.subtitle': 'Durable facts the agent remembers across sessions, stored locally.',
        'memory.offNotice': 'Long-term memory is currently off. Enable it on the MAGICAL MIRAI page.',
        'memory.add.placeholder': 'Add a memory, e.g. "User prefers concise replies…"',
        'memory.addCard': 'New memory',
        'memory.addCard.hint': 'Create a memory',
        'memory.empty.search': 'No matching memories.',
        'memory.empty': 'No memories yet. Use the card above to add the first one.',
        'memory.count': '{count} memories · {enabled} enabled',
        'memory.bar.matched': ' · {count} matched',
        'memory.search.placeholder': 'Search memories',
        'memory.search.label': 'Search memories',
        'memory.refresh': 'Refresh memories',
        'memory.readFailed': 'Could not read the memories. Refresh the page to retry.',
        'memory.new': 'New memory',
        'memory.new.desc': 'Write a fact the agent should remember across sessions; it joins the memory index as soon as you save.',
        'memory.edit.title': 'Edit memory',
        'memory.edit.desc': 'Change the content or type; saved changes apply immediately.',
        'memory.field.content': 'Content',
        'memory.field.type': 'Type',
        'memory.counter': '{count} / {max}',
        'memory.create': 'Create',
        'memory.close': 'Close',
        'memory.openEdit': 'View and edit this memory',
        'memory.type.user': 'User',
        'memory.type.feedback': 'Feedback',
        'memory.type.project': 'Project',
        'memory.type.reference': 'Reference',
        'memory.source.agent': 'Agent',
        'memory.source.manual': 'Manual',
        'memory.save': 'Save',
        'memory.cancel': 'Cancel',
        'memory.edit': 'Edit',
        'memory.delete': 'Delete',
        'memory.confirmDelete': 'Confirm delete',
        'memory.enabled.on': 'Enabled (injected into session index)',
        'memory.enabled.off': 'Disabled (kept, not injected)',
        'memory.enabled.enable': 'Enable',
        'memory.enabled.disable': 'Disable',
        'memory.enabled.switch': '{action} memory: {content}',
        'memory.updated': 'Updated {time}',
        'memory.error': 'Operation failed: {message}',
      },
    };

    // ---------------------------------------------------------------------
    // Package-owned stylesheets (the loader claims `style[data-plugin]` tags,
    // removes them on unload, and dedupes them by `data-plugin-css`).
    // ---------------------------------------------------------------------
    const STYLE_BASE = `${PACKAGE_NAME}/menu.css`;
    const STYLE_MARKED = `${PACKAGE_NAME}/marked-sessions.css`;
    const STYLE_PANEL = `${PACKAGE_NAME}/control-panel.css`;
    const STYLE_MEMORY = `${PACKAGE_NAME}/memory-panel.css`;
    const STYLE_LAN = `${PACKAGE_NAME}/lan-panel.css`;
    const STYLE_SKILLS = `${PACKAGE_NAME}/skills-panel.css`;
    const STYLE_MCP = `${PACKAGE_NAME}/mcp-panel.css`;
    const STYLE_AGENT = `${PACKAGE_NAME}/agent-panel.css`;

    /** Install (or find) one package-owned style tag. */
    function installStyle(key, css) {
      if (typeof document === 'undefined') return null;
      const selector = `style[data-plugin-css=${JSON.stringify(key)}]`;
      const existing = document.querySelector(selector);
      if (existing !== null) return existing;
      const tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE_NAME;
      tag.dataset.pluginCss = key;
      tag.textContent = css;
      document.head.appendChild(tag);
      return tag;
    }

    // ---------------------------------------------------------------------
    // Built-in feature switches (Host-owned preferences).
    //
    // The switches live on the control panel's dashboard page. The Host owns
    // the durable state; this store hydrates once, updates optimistically and
    // rolls back on a failed write.
    // ---------------------------------------------------------------------
    const FEATURE_NAMES = ['deleteSessionsEnabled', 'splashEnabled', 'memoryEnabled'];
    const featureListeners = new Set();
    let features = { deleteSessionsEnabled: true, splashEnabled: true, memoryEnabled: true };
    /** Whether the one-time preference read failure was already reported. */
    let featureReadFailureReported = false;

    function subscribeFeatures(listener) {
      featureListeners.add(listener);
      return () => {
        featureListeners.delete(listener);
      };
    }

    function getFeature(name) {
      return features[name];
    }

    function applyFeatures(next) {
      const merged = { ...features };
      for (const name of FEATURE_NAMES) {
        if (typeof next?.[name] === 'boolean') merged[name] = next[name];
      }
      if (
        merged.deleteSessionsEnabled === features.deleteSessionsEnabled &&
        merged.splashEnabled === features.splashEnabled &&
        merged.memoryEnabled === features.memoryEnabled
      ) {
        return false;
      }
      const deleteWasEnabled = features.deleteSessionsEnabled;
      features = merged;
      if (deleteWasEnabled && !features.deleteSessionsEnabled) stopPolling();
      if (!deleteWasEnabled && features.deleteSessionsEnabled) void adoptHostMarked();
      paintMarkedStyle();
      if (features.deleteSessionsEnabled && marked.size > 0) ensurePolling();
      else stopPolling();
      for (const listener of [...featureListeners]) listener();
      return true;
    }

    /** Read the Host feature switches and adopt them. @returns whether the read worked. */
    async function adoptHostFeatures() {
      try {
        const value = await callHost('preferences', { method: 'GET', headers: { accept: 'application/json' } });
        applyFeatures(value);
        return true;
      } catch (error) {
        if (!featureReadFailureReported) {
          featureReadFailureReported = true;
          console.warn('[dsh-mikufan] could not read the feature switches:', error);
        }
        return false;
      }
    }

    /** First load, retried a few times across a slow boot. */
    function hydrateFeatures(attempt = 0) {
      void adoptHostFeatures().then((ok) => {
        if (ok || attempt >= 3) return;
        setTimeout(() => hydrateFeatures(attempt + 1), 400 * (attempt + 1));
      });
    }

    /**
     * Write one or more feature switches, optimistically, and roll back on failure.
     * @param patch - fields to change.
     * @returns the write completion.
     */
    async function saveFeatures(patch) {
      const previous = { ...features };
      applyFeatures(patch);
      try {
        const value = await callHost('preferences', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        applyFeatures(value);
      } catch (error) {
        applyFeatures(previous);
        console.warn('[dsh-mikufan] could not save the feature switches:', error);
        throw error;
      }
    }

    // ---------------------------------------------------------------------
    // Shared marked-session store (module scope: the row and the stylesheet
    // read one state; changes repaint CSS without re-rendering any row).
    // ---------------------------------------------------------------------
    const listeners = new Set();
    let marked = new Set();
    const markedStyle = installStyle(STYLE_MARKED, '');

    /** Rewrite the per-session rules from the current marked set. */
    function paintMarkedStyle() {
      if (markedStyle === null) return;
      if (!features.deleteSessionsEnabled) {
        markedStyle.textContent = '';
        return;
      }
      const rules = [];
      for (const id of marked) {
        if (!SAFE_ID.test(id)) continue;
        const row = `[role="treeitem"][data-row-key="session:${id}"]`;
        rules.push(
          `${row} > span[class*="_title"],${row} > span:nth-of-type(2){text-decoration:line-through;text-decoration-thickness:1.5px;text-decoration-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-caption)}`,
        );
        // A marked session keeps exactly one control: our own cancel button. The
        // row's shipped controls ("..." trigger, pin, archive) share one class, so
        // one rule retires all three without touching any other row.
        rules.push(`${row} [class*="_rowActions"] button[class*="_iconButton"]{display:none}`);
      }
      markedStyle.textContent = rules.join('\n');
    }

    function emit() {
      paintMarkedStyle();
      if (features.deleteSessionsEnabled && marked.size > 0) ensurePolling();
      else stopPolling();
      for (const listener of [...listeners]) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function getMarked() {
      return marked;
    }

    function setMarked(ids) {
      const next = new Set();
      for (const id of ids) if (typeof id === 'string' && SAFE_ID.test(id)) next.add(id);
      if (next.size === marked.size && [...next].every((id) => marked.has(id))) return;
      marked = next;
      emit();
    }

    function addMark(id) {
      if (marked.has(id)) return;
      const next = new Set(marked);
      next.add(id);
      marked = next;
      emit();
    }

    function removeMark(id) {
      if (!marked.has(id)) return;
      const next = new Set(marked);
      next.delete(id);
      marked = next;
      emit();
    }

    // ---------------------------------------------------------------------
    // Host calls (`fetch` on the plugin's own Host route).
    // ---------------------------------------------------------------------
    function apiUrl(action) {
      const base =
        typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== ''
          ? document.baseURI
          : 'http://127.0.0.1/';
      return new URL(`${API_PREFIX}/${action}`, base).href;
    }

    async function callHost(action, init) {
      const response = await fetch(apiUrl(action), init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      }
      return payload.value;
    }

    // --- Host reads: first load, then reconciliation while marks are pending ---
    //
    // The Host drops a mark as soon as the user sends a message in that session,
    // which happens outside this tab's control (another window, a queued prompt).
    // While at least one mark is pending the page reconciles against the Host, so
    // the strikethrough disappears on its own; with no marks there is no traffic.
    /** Reconciliation period while at least one mark is pending. */
    const RECONCILE_INTERVAL_MS = 2000;
    /** Mutating requests sent from this tab; a reconcile never clobbers them. */
    let mutating = 0;
    /** Pending reconciliation timer, or null. */
    let pollTimer = null;
    /** Whether the one-time read failure was already reported. */
    let readFailureReported = false;

    function stopPolling() {
      if (pollTimer === null) return;
      clearInterval(pollTimer);
      pollTimer = null;
    }

    function ensurePolling() {
      if (pollTimer !== null) return;
      if (!features.deleteSessionsEnabled) return;
      pollTimer = setInterval(() => {
        if (!features.deleteSessionsEnabled || marked.size === 0) {
          stopPolling();
          return;
        }
        void reconcile();
      }, RECONCILE_INTERVAL_MS);
      // Node (tests, SSR) keeps the process alive for a pending interval.
      if (typeof pollTimer?.unref === 'function') pollTimer.unref();
    }

    /** Read the Host's marked set and adopt it. @returns whether the read worked. */
    async function adoptHostMarked() {
      try {
        const value = await callHost('marked', { method: 'GET', headers: { accept: 'application/json' } });
        if (Array.isArray(value?.ids)) setMarked(value.ids);
        return true;
      } catch (error) {
        if (!readFailureReported) {
          readFailureReported = true;
          console.warn('[dsh-mikufan] could not read the sessions marked for deletion:', error);
        }
        return false;
      }
    }

    /** Re-read the Host set unless this tab has a write of its own in flight. */
    async function reconcile() {
      if (mutating > 0) return;
      await adoptHostMarked();
    }

    /** First load, retried a few times across a slow boot. */
    function hydrate(attempt = 0) {
      void adoptHostMarked().then((ok) => {
        if (ok || attempt >= 3) return;
        setTimeout(() => hydrate(attempt + 1), 400 * (attempt + 1));
      });
    }

    async function markForDeletion(sessionId) {
      addMark(sessionId);
      mutating += 1;
      try {
        const value = await callHost('mark', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
        if (Array.isArray(value?.ids)) setMarked(value.ids);
      } catch (error) {
        removeMark(sessionId);
        console.warn('[dsh-mikufan] could not mark the session for deletion:', error);
      } finally {
        mutating -= 1;
      }
    }

    async function cancelDeletion(sessionId) {
      removeMark(sessionId);
      mutating += 1;
      try {
        const value = await callHost('unmark', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
        if (Array.isArray(value?.ids)) setMarked(value.ids);
      } catch (error) {
        addMark(sessionId);
        console.warn('[dsh-mikufan] could not clear the deletion mark:', error);
      } finally {
        mutating -= 1;
      }
    }

    // ---------------------------------------------------------------------
    // Menu row styles: copied from the host's menu primitive (`MenuItemButton`
    // in the Web bundle) and re-prefixed; token references only.
    // ---------------------------------------------------------------------
    installStyle(
      STYLE_BASE,
      `
.MikufanMenuItemWrap{position:relative}
.MikufanMenuItemSeparator{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)}
.MikufanMenuItemButton{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left;font-family:inherit}
.MikufanMenuItemButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.MikufanMenuItemButton:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}
.MikufanMenuItemButton:disabled{opacity:.4;cursor:not-allowed}
.MikufanMenuItemIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon)}
.MikufanMenuItemIcon svg{width:14px;height:14px}
.MikufanMenuItemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.MikufanMenuItemDanger{color:var(--dsw-alias-state-error-primary)}
.MikufanMenuItemDanger .MikufanMenuItemIcon{color:var(--dsw-alias-state-error-primary)}
.MikufanMenuItemDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.MikufanMenuItemDanger:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}
.MikufanRowAction{display:inline-flex;flex:none;align-items:center}
.MikufanRowActionButton{border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.MikufanRowActionButton:hover{color:var(--dsw-alias-label-primary)}
.MikufanRowActionButton:focus-visible{color:var(--dsw-alias-label-primary);outline:none}
.MikufanRowActionButton svg{width:15px;height:15px}
`,
    );

    // ---------------------------------------------------------------------
    // Control panel styles: the floating pill tab bar, the page titles, the
    // setting cards and the iOS-style switch are the redesigned panel (the
    // switch primitive is the one copied earlier from the host settings row,
    // same tokens, no literal colours).
    // ---------------------------------------------------------------------
    installStyle(
      STYLE_PANEL,
      `
.MikufanCpRoot{width:100%;box-sizing:border-box;height:100%;min-height:0;overflow:auto;padding:16px 24px 64px}
.MikufanCpNavWrap{position:sticky;top:12px;z-index:10;display:flex;justify-content:center;margin-bottom:28px}
.MikufanCpTopbar{display:flex;align-items:center;gap:4px;max-width:100%;padding:5px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);background:color-mix(in oklch,var(--dsw-alias-bg-layer-1) 88%,transparent);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);box-shadow:0 4px 24px rgba(0,0,0,.08);overflow-x:auto}
.MikufanCpTab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;padding:8px 16px;border-radius:999px;cursor:pointer;white-space:nowrap;transition:background .18s ease,color .18s ease}
.MikufanCpTab:hover{color:var(--dsw-alias-label-primary)}
.MikufanCpTab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.MikufanCpTab[aria-selected=true]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground)}
.MikufanCpContent{max-width:680px;margin:0 auto}
.MikufanCpTitle{margin:0 0 6px;font-size:22px;font-weight:600;line-height:30px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.MikufanCpSubtitle{margin:0 0 28px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.MikufanCpGroup{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:700px){.MikufanCpGroup{grid-template-columns:1fr}}
.MikufanCpCard{display:flex;flex-direction:column;justify-content:space-between;gap:16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,.04);transition:transform .15s ease,box-shadow .15s ease}
.MikufanCpCard:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.07)}
.MikufanCpCardTitle{margin:0 0 3px;font-size:15px;font-weight:600;line-height:22px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.MikufanCpCardDesc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.MikufanCpCardRow{display:flex;align-items:center;justify-content:space-between}
.MikufanCpCardError{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.MikufanCpCardBody{display:flex;align-items:flex-start;gap:14px}
.MikufanCpCardIcon{flex:0 0 auto;width:48px;height:48px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.MikufanCpCardIcon svg{display:block}
.MikufanCpCardIconDanger{color:var(--dsw-alias-state-error-primary)}
.MikufanCpCardMain{flex:1;min-width:0}
.MikufanCpCardHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.MikufanCpCardHead .MikufanCpCardTitle{margin:0}
.MikufanCpCardFoot{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption);display:flex;align-items:center;gap:6px}
.MikufanCpCardFootHot{color:var(--dsw-alias-state-error-primary)}
.MikufanCpCardFootActive{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.MikufanCpPlaceholder{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);padding:40px 28px;text-align:center;color:var(--dsw-alias-label-secondary);box-shadow:0 1px 3px rgba(0,0,0,.04)}
.MikufanCpPlaceholderGlyph{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:22px;line-height:28px;color:var(--dsw-alias-label-primary);opacity:.4;margin-bottom:10px}
.MikufanCpPlaceholderTitle{margin:0 0 6px;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.MikufanCpPlaceholderText{margin:0;font-size:13px;line-height:20px}
.MikufanCpIcon{display:inline-flex}
.MikufanCpIcon svg{display:block}
.MikufanSwitch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
.MikufanSwitch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.MikufanSwitch:disabled{cursor:default;opacity:.5}
.MikufanSwitch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.MikufanSwitchThumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}
.MikufanSwitch[aria-checked=false] .MikufanSwitchThumb{background:var(--dsw-alias-switch-thumb)}
.MikufanSwitch[aria-checked=true] .MikufanSwitchThumb{transform:translate(16px)}
@media (prefers-reduced-motion:reduce){.MikufanSwitchThumb{transition:none}}
`,
    );

    // ---------------------------------------------------------------------
    // Feature 3, local memory: the panel store (module scope), styles, and
    // components. The Host owns the durable store; this half hydrates once
    // when the memory page mounts and updates optimistically with rollback.
    // ---------------------------------------------------------------------

    /** Entry type vocabulary, aligned with the Host engine. */
    const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
    /** Valid MCP server name: the Codex `[mcp_servers.<name>]` key budget. */
    const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
    /** The two transports the Codex standard defines, in dialog order. */
    const MCP_TRANSPORT_KEYS = ['stdio', 'streamable_http'];
    /** Shown beside the count row: where the Host stores the servers. */
    const MCP_DOC_DISPLAY = '~/.dsh/dsh-mikufan/mcp.json';
    const memoryListeners = new Set();
    /** @type {Array<object>} */
    let memoryEntries = [];
    /** Whether the first Host read has completed. */
    let memoryLoaded = false;
    /** Whether the one-time memory read failure was already reported. */
    let memoryReadFailureReported = false;
    /** Whether the read retries are exhausted (the page then shows a retry hint). */
    let memoryReadGaveUp = false;

    function subscribeMemory(listener) {
      memoryListeners.add(listener);
      return () => {
        memoryListeners.delete(listener);
      };
    }

    function getMemoryEntries() {
      return memoryEntries;
    }

    function isMemoryLoaded() {
      return memoryLoaded;
    }

    function isMemoryReadFailed() {
      return memoryReadGaveUp;
    }

    function emitMemory() {
      for (const listener of [...memoryListeners]) listener();
    }

    function replaceMemoryEntries(entries) {
      if (!Array.isArray(entries)) return;
      memoryEntries = entries.filter(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof entry.id === 'string' &&
          typeof entry.content === 'string',
      );
      memoryLoaded = true;
      emitMemory();
    }

    function upsertMemoryEntry(entry) {
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') return;
      const index = memoryEntries.findIndex((candidate) => candidate.id === entry.id);
      if (index === -1) {
        // The Host stores and returns entries oldest-first (`MemoryStore.create`
        // pushes), so a new entry goes to the end: the card then keeps its place
        // across the next hydrate instead of jumping to the top.
        memoryEntries = [...memoryEntries, entry];
      } else {
        const next = [...memoryEntries];
        next[index] = entry;
        memoryEntries = next;
      }
      emitMemory();
    }

    function dropMemoryEntry(id) {
      const next = memoryEntries.filter((entry) => entry.id !== id);
      if (next.length === memoryEntries.length) return;
      memoryEntries = next;
      emitMemory();
    }

    /** Read the full memory list from the Host. @returns whether the read worked. */
    async function adoptHostMemory() {
      try {
        const value = await callHost('memory', { method: 'GET', headers: { accept: 'application/json' } });
        memoryReadGaveUp = false;
        replaceMemoryEntries(Array.isArray(value?.entries) ? value.entries : []);
        return true;
      } catch (error) {
        if (!memoryReadFailureReported) {
          memoryReadFailureReported = true;
          console.warn('[dsh-mikufan] could not read the memory list:', error);
        }
        return false;
      }
    }

    /** First load, retried a few times across a slow boot (the LAN page does the same). */
    function hydrateMemory(attempt = 0) {
      void adoptHostMemory().then((ok) => {
        if (ok) return;
        if (attempt < 3) {
          setTimeout(() => hydrateMemory(attempt + 1), 400 * (attempt + 1));
          return;
        }
        // Out of retries: say so on the page instead of showing an empty grid.
        memoryReadGaveUp = true;
        emitMemory();
      });
    }

    /** Create one memory from the panel (optimistic id stays server-side). */
    async function createMemoryViaHost(content, type) {
      const value = await callHost('memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, type }),
      });
      if (value?.entry !== null && typeof value?.entry === 'object') upsertMemoryEntry(value.entry);
      return value.entry;
    }

    /** Patch one memory (content / type / enabled) with optimistic apply + rollback. */
    async function patchMemoryViaHost(id, patch) {
      const previous = memoryEntries.find((entry) => entry.id === id);
      if (previous !== undefined) upsertMemoryEntry({ ...previous, ...patch });
      try {
        const value = await callHost(`memory/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (value?.entry !== null && typeof value?.entry === 'object') upsertMemoryEntry(value.entry);
      } catch (error) {
        if (previous !== undefined) upsertMemoryEntry(previous);
        throw error;
      }
    }

    /** Remove one memory with optimistic apply + rollback. */
    async function deleteMemoryViaHost(id) {
      const index = memoryEntries.findIndex((entry) => entry.id === id);
      const previous = index === -1 ? undefined : memoryEntries[index];
      dropMemoryEntry(id);
      try {
        await callHost(`memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (error) {
        if (previous !== undefined) {
          // Put it back where it was, not at the front.
          const next = [...memoryEntries];
          next.splice(Math.min(index, next.length), 0, previous);
          memoryEntries = next;
          emitMemory();
        }
        throw error;
      }
    }

    // ---------------------------------------------------------------------
    // LAN access: the status store for this package's integrated LAN engine
    // (`lan.js` on the Host, routes under /mikufan/api/lan/…). The engine
    // owns the proxy, the preferences and the migration from the superseded
    // standalone dsh-lan-access bundle.
    // ---------------------------------------------------------------------

    const lanListeners = new Set();
    /** @type {null | object} */
    let lanStatus = null;
    /** Whether the first status read completed. */
    let lanLoaded = false;
    /** Whether the one-time status read failure was already reported. */
    let lanReadFailureReported = false;
    /** Whether the status retries are exhausted (the page then says so). */
    let lanReadGaveUp = false;

    function subscribeLan(listener) {
      lanListeners.add(listener);
      return () => {
        lanListeners.delete(listener);
      };
    }

    function getLanStatus() {
      return lanStatus;
    }

    function isLanLoaded() {
      return lanLoaded;
    }

    function isLanReadFailed() {
      return lanReadGaveUp;
    }

    function emitLan() {
      for (const listener of [...lanListeners]) listener();
    }

    function setLanStatus(next) {
      lanStatus = next;
      lanLoaded = true;
      emitLan();
    }

    /** Read the engine status and adopt it. @returns whether the read worked. */
    async function refreshLanStatus() {
      try {
        const value = await callHost('lan/status', { method: 'GET', headers: { accept: 'application/json' } });
        lanReadGaveUp = false;
        setLanStatus(value);
        return true;
      } catch (error) {
        if (!lanReadFailureReported) {
          lanReadFailureReported = true;
          console.warn('[dsh-mikufan] could not read the LAN status:', error);
        }
        return false;
      }
    }

    /** First load, retried a few times across a slow boot. */
    function hydrateLanStatus(attempt = 0) {
      void refreshLanStatus().then((ok) => {
        if (ok) return;
        if (attempt < 3) {
          setTimeout(() => hydrateLanStatus(attempt + 1), 400 * (attempt + 1));
          return;
        }
        // Out of retries: the page shows a retry hint instead of an empty grid.
        lanReadGaveUp = true;
        emitLan();
      });
    }

    /**
     * Save one LAN preference patch; the engine applies it immediately and
     * the authoritative status (running proxy included) refreshes the store.
     * @param patch - `{ lanAccessEnabled?, lanHost?, lanPort? }`.
     */
    async function saveLanPreferences(patch) {
      const value = await callHost('lan/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      setLanStatus(value);
    }

    // ---------------------------------------------------------------------
    // Skills: the store behind the Skills page. The Host owns the managed root
    // (`<dshHome>/skills`); this half reads the list and updates optimistically.
    // ---------------------------------------------------------------------

    const skillListeners = new Set();
    /** @type {Array<object>} */
    let skillEntries = [];
    /** Absolute path of the managed skills root, as reported by the Host. */
    let skillRoot = '';
    /** Whether the first Host read has completed. */
    let skillLoaded = false;
    /** Whether the one-time read failure was already reported. */
    let skillReadFailureReported = false;
    /** Whether the read retries are exhausted (the page then shows a hint). */
    let skillReadGaveUp = false;

    function subscribeSkills(listener) {
      skillListeners.add(listener);
      return () => {
        skillListeners.delete(listener);
      };
    }

    function getSkillEntries() {
      return skillEntries;
    }

    function getSkillRoot() {
      return skillRoot;
    }

    function isSkillsLoaded() {
      return skillLoaded;
    }

    function isSkillsReadFailed() {
      return skillReadGaveUp;
    }

    function emitSkills() {
      for (const listener of [...skillListeners]) listener();
    }

    /** Adopt one Host list payload (`{ root, entries }`). */
    function replaceSkills(value) {
      if (typeof value?.root === 'string') skillRoot = value.root;
      if (Array.isArray(value?.entries)) {
        skillEntries = value.entries.filter(
          (entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            typeof entry.id === 'string' &&
            typeof entry.name === 'string',
        );
      }
      skillLoaded = true;
      emitSkills();
    }

    function upsertSkillEntry(entry) {
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') return;
      const index = skillEntries.findIndex((candidate) => candidate.id === entry.id);
      if (index === -1) {
        skillEntries = [...skillEntries, entry].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      } else {
        const next = [...skillEntries];
        next[index] = entry;
        skillEntries = next;
      }
      emitSkills();
    }

    function dropSkillEntry(id) {
      const next = skillEntries.filter((entry) => entry.id !== id);
      if (next.length === skillEntries.length) return;
      skillEntries = next;
      emitSkills();
    }

    /** Read the skill list from the Host. @returns whether the read worked. */
    async function adoptHostSkills() {
      try {
        const value = await callHost('skills', { method: 'GET', headers: { accept: 'application/json' } });
        skillReadGaveUp = false;
        replaceSkills(value);
        return true;
      } catch (error) {
        if (!skillReadFailureReported) {
          skillReadFailureReported = true;
          console.warn('[dsh-mikufan] could not read the skill list:', error);
        }
        return false;
      }
    }

    /** First load, retried a few times across a slow boot. */
    function hydrateSkills(attempt = 0) {
      void adoptHostSkills().then((ok) => {
        if (ok) return;
        if (attempt < 3) {
          setTimeout(() => hydrateSkills(attempt + 1), 400 * (attempt + 1));
          return;
        }
        skillReadGaveUp = true;
        emitSkills();
      });
    }

    /** Flip one skill's model-invocation flag with optimistic apply + rollback. */
    async function patchSkillViaHost(id, enabled) {
      const previous = skillEntries.find((entry) => entry.id === id);
      if (previous !== undefined) upsertSkillEntry({ ...previous, enabled });
      try {
        const value = await callHost(`skills/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        if (value?.entry !== null && typeof value?.entry === 'object') upsertSkillEntry(value.entry);
      } catch (error) {
        if (previous !== undefined) upsertSkillEntry(previous);
        throw error;
      }
    }

    /** Remove one skill with optimistic apply + rollback. */
    async function deleteSkillViaHost(id) {
      const index = skillEntries.findIndex((entry) => entry.id === id);
      const previous = index === -1 ? undefined : skillEntries[index];
      dropSkillEntry(id);
      try {
        await callHost(`skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (error) {
        if (previous !== undefined) {
          const next = [...skillEntries];
          next.splice(Math.min(index, next.length), 0, previous);
          skillEntries = next;
          emitSkills();
        }
        throw error;
      }
    }

    /** Read one SKILL.md for the detail view. */
    async function readSkillDetail(id) {
      return callHost(`skills/${encodeURIComponent(id)}`, { method: 'GET', headers: { accept: 'application/json' } });
    }

    /** Ensure the root and the bundled skill-creator exist; returns the host list. */
    async function ensureBundledSkill() {
      return callHost('skills/ensure', { method: 'POST', headers: { accept: 'application/json' } });
    }

    /**
     * Put the bundled skill-creator back when its directory is gone. The create
     * card opens a `/skill-creator` session, so the Skills page repairs the
     * skill on every open; the Host never overwrites an existing copy.
     */
    async function restoreBundledSkill() {
      return callHost('skills/restore', { method: 'POST', headers: { accept: 'application/json' } });
    }

    /** Reveal one SKILL.md in the platform file manager. */
    async function revealSkillViaHost(id) {
      return callHost(`skills/${encodeURIComponent(id)}/reveal`, { method: 'POST', headers: { accept: 'application/json' } });
    }

    // ---------------------------------------------------------------------
    // MCP: the store behind the MCP page. The Host owns the Codex-standard
    // `mcp_servers` document (`~/.dsh/dsh-mikufan/mcp.json`); this half reads
    // the list and updates optimistically, the same way Skills does.
    // ---------------------------------------------------------------------

    const mcpListeners = new Set();
    /** @type {Array<object>} */
    let mcpServers = [];
    /** Whether the first Host read has completed. */
    let mcpLoaded = false;
    /** Whether the one-time read failure was already reported. */
    let mcpReadFailureReported = false;
    /** Whether the read retries are exhausted (the page then shows a hint). */
    let mcpReadGaveUp = false;

    function subscribeMcp(listener) {
      mcpListeners.add(listener);
      return () => {
        mcpListeners.delete(listener);
      };
    }

    function getMcpServers() {
      return mcpServers;
    }

    function isMcpLoaded() {
      return mcpLoaded;
    }

    function isMcpReadFailed() {
      return mcpReadGaveUp;
    }

    function emitMcp() {
      for (const listener of [...mcpListeners]) listener();
    }

    /** Adopt one Host list payload (`{ servers }`). */
    function replaceMcpServers(value) {
      if (Array.isArray(value?.servers)) {
        mcpServers = value.servers.filter(
          (server) => server !== null && typeof server === 'object' && typeof server.name === 'string',
        );
      }
      mcpLoaded = true;
      emitMcp();
    }

    function upsertMcpServer(server) {
      if (server === null || typeof server !== 'object' || typeof server.name !== 'string') return;
      const index = mcpServers.findIndex((candidate) => candidate.name === server.name);
      if (index === -1) {
        mcpServers = [...mcpServers, server];
      } else {
        const next = [...mcpServers];
        next[index] = server;
        mcpServers = next;
      }
      emitMcp();
    }

    function dropMcpServer(name) {
      const next = mcpServers.filter((server) => server.name !== name);
      if (next.length === mcpServers.length) return;
      mcpServers = next;
      emitMcp();
    }

    /** Read the MCP server list from the Host. @returns whether the read worked. */
    async function adoptHostMcp() {
      try {
        const value = await callHost('mcp', { method: 'GET', headers: { accept: 'application/json' } });
        mcpReadGaveUp = false;
        replaceMcpServers(value);
        return true;
      } catch (error) {
        if (!mcpReadFailureReported) {
          mcpReadFailureReported = true;
          console.warn('[dsh-mikufan] could not read the MCP server list:', error);
        }
        return false;
      }
    }

    /** First load, retried a few times across a slow boot (every page does this). */
    function hydrateMcp(attempt = 0) {
      void adoptHostMcp().then((ok) => {
        if (ok) return;
        if (attempt < 3) {
          setTimeout(() => hydrateMcp(attempt + 1), 400 * (attempt + 1));
          return;
        }
        mcpReadGaveUp = true;
        emitMcp();
      });
    }

    /** Create one server from the panel dialog (optimistic apply + rollback). */
    async function createMcpViaHost(draft) {
      let optimistic = false;
      try {
        const value = await callHost('mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft),
        });
        if (value?.server !== null && typeof value?.server === 'object') upsertMcpServer(value.server);
        return value?.server ?? null;
      } catch (error) {
        optimistic = true;
        throw error;
      } finally {
        if (optimistic) dropMcpServer(draft?.name);
      }
    }

    /** Replace one server (the edit dialog; a rename moves the card). */
    async function updateMcpViaHost(name, draft) {
      const previous = mcpServers.find((server) => server.name === name);
      try {
        const value = await callHost(`mcp/${encodeURIComponent(name)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft),
        });
        if (value?.server !== null && typeof value?.server === 'object') {
          // A rename moves the card: drop the old key, insert the new record.
          if (typeof name === 'string' && name !== value.server.name) dropMcpServer(name);
          upsertMcpServer(value.server);
        }
        return value?.server ?? null;
      } catch (error) {
        if (previous !== undefined) upsertMcpServer(previous);
        throw error;
      }
    }

    /**
     * Flip one server's enabled flag with optimistic apply + rollback. The
     * Host answer carries the sync outcome (`server.applied`): `reloaded`
     * means the running composition entry followed the flag, `absent` means
     * no such entry exists (document-only change), `failed`/`restart-required`
     * surface as a card error line.
     */
    async function patchMcpEnabledViaHost(name, enabled) {
      const previous = mcpServers.find((server) => server.name === name);
      if (previous !== undefined) upsertMcpServer({ ...previous, enabled, applied: undefined, applyError: undefined });
      try {
        const value = await callHost(`mcp/${encodeURIComponent(name)}/enabled`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        if (value?.server !== null && typeof value?.server === 'object') upsertMcpServer(value.server);
        return value?.server ?? null;
      } catch (error) {
        if (previous !== undefined) upsertMcpServer(previous);
        throw error;
      }
    }

    /** The card error line for one enable-sync outcome; '' when nothing to say. */
    function mcpAppliedNotice(translate, server) {
      if (server?.applied === 'failed') {
        return formatTemplate(translate('mcp.applied.failed', '已写入 mcp.json，但同步到运行中的 Harness 失败：{message}'), {
          message: server.applyError ?? '',
        });
      }
      if (server?.applied === 'restart-required') {
        return translate('mcp.applied.restart', '已写入 mcp.json；该条目需要重启 Harness 才能生效。');
      }
      return '';
    }

    /** Remove one server with optimistic apply + rollback. */
    async function deleteMcpViaHost(name) {
      const index = mcpServers.findIndex((server) => server.name === name);
      const previous = index === -1 ? undefined : mcpServers[index];
      dropMcpServer(name);
      try {
        await callHost(`mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
      } catch (error) {
        if (previous !== undefined) {
          const next = [...mcpServers];
          next.splice(Math.min(index, next.length), 0, previous);
          mcpServers = next;
          emitMcp();
        }
        throw error;
      }
    }

    installStyle(
      STYLE_MEMORY,
      `
.MikufanMemoryPanel{display:flex;flex-direction:column;min-height:0;gap:14px}
.MikufanMemoryNotice{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.MikufanMemoryBar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
/* Right-aligned search + refresh, on the same row as the memory count. */
.MikufanMemoryTools{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto}
.MikufanMemSearch{display:flex;align-items:center;gap:6px;box-sizing:border-box;height:32px;width:210px;max-width:100%;padding:0 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);transition:border-color .15s ease}
.MikufanMemSearch:focus-within{border-color:var(--dsw-alias-brand-primary)}
.MikufanMemSearchIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.MikufanMemSearchIcon svg{width:14px;height:14px}
.MikufanMemSearchInput{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px}
.MikufanMemSearchInput::placeholder{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary))}
.MikufanMemSearchInput:focus{outline:none}
.MikufanMemSearchInput::-webkit-search-cancel-button,.MikufanMemSearchInput::-webkit-search-decoration{-webkit-appearance:none;display:none}
.MikufanMemRefresh{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.MikufanMemRefresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.MikufanMemRefresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanMemRefresh:disabled{opacity:.5;cursor:not-allowed}
.MikufanMemRefresh svg{width:16px;height:16px}
.MikufanMemRefresh[data-busy=true] svg{animation:MikufanMemSpin .9s linear infinite}
@keyframes MikufanMemSpin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.MikufanMemRefresh[data-busy=true] svg{animation:none}}
.MikufanMemoryGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:stretch}
.MikufanMemoryGrid[data-empty=true]{grid-template-columns:minmax(0,1fr)}
@media (max-width:700px){.MikufanMemoryGrid{grid-template-columns:minmax(0,1fr)}}
.MikufanMemoryEmpty{margin:0;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
/* The first grid card is always present: the blank "+" card that opens the create dialog. */
.MikufanMemAdd{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:150px;padding:18px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:border-color .15s ease,background .15s ease,color .15s ease}
.MikufanMemAdd:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.MikufanMemAdd:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.MikufanMemAddGlyph{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);transition:border-color .15s ease,color .15s ease}
.MikufanMemAdd:hover .MikufanMemAddGlyph{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.MikufanMemAddGlyph svg{width:20px;height:20px}
.MikufanMemAddLabel{font-size:13px;line-height:20px}
/* One entry card: type + source + switch header, clamped content, action footer. */
.MikufanMemCard{display:flex;flex-direction:column;gap:10px;min-width:0;padding:16px 18px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 3px rgba(0,0,0,.04);transition:transform .15s ease,box-shadow .15s ease}
.MikufanMemCard:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.07)}
.MikufanMemCardTop{display:flex;align-items:center;gap:8px;min-width:0}
.MikufanMemCardTop .MikufanSwitch{margin-left:auto}
.MikufanMemTag{flex:none;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap}
.MikufanMemSource{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.MikufanMemCard[data-disabled=true] .MikufanMemTag{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary))}
.MikufanMemBody{cursor:pointer}
.MikufanMemBody:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm)}
.MikufanMemContent{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-line;word-break:break-word}
.MikufanMemCard[data-disabled=true] .MikufanMemContent{color:var(--dsw-alias-label-tertiary)}
.MikufanMemCardFoot{display:flex;align-items:center;gap:2px;margin-top:auto;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.MikufanMemAction{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.MikufanMemAction:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.MikufanMemAction:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanMemAction:disabled{opacity:.5;cursor:not-allowed}
.MikufanMemAction svg{width:14px;height:14px}
.MikufanMemActionDanger{color:var(--dsw-alias-label-tertiary)}
.MikufanMemActionDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.MikufanMemActionArmed{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.MikufanMemUpdated{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.MikufanMemErrorLine{margin:-4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
/* Create/edit dialog: a portalled overlay in the host's own modal idiom. */
.MikufanMemMask{position:fixed;inset:0;z-index:1010;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur,blur(4px));-webkit-backdrop-filter:var(--dsw-mask-blur,blur(4px));animation:MikufanMemFade .16s ease-out}
.MikufanMemDialog{display:flex;flex-direction:column;gap:14px;box-sizing:border-box;width:min(520px,100%);max-height:min(80vh,640px);overflow:auto;padding:18px 20px 16px;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.22));animation:MikufanMemPop .16s ease-out}
@keyframes MikufanMemFade{from{opacity:0}to{opacity:1}}
@keyframes MikufanMemPop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.MikufanMemMask,.MikufanMemDialog{animation:none}}
.MikufanMemDialogHead{display:flex;align-items:flex-start;gap:12px}
.MikufanMemDialogHeadText{flex:1;min-width:0}
.MikufanMemDialogTitle{margin:0;font-size:16px;font-weight:600;line-height:24px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.MikufanMemDialogDesc{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.MikufanMemClose{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.MikufanMemClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.MikufanMemClose:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanMemClose:disabled{opacity:.5;cursor:not-allowed}
.MikufanMemClose svg{width:14px;height:14px}
.MikufanMemField{display:flex;flex-direction:column;gap:6px}
.MikufanMemFieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.MikufanMemTextarea{box-sizing:border-box;width:100%;min-height:132px;max-height:40vh;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;resize:vertical}
.MikufanMemTextarea::placeholder{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary))}
.MikufanMemTextarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:var(--dsw-alias-brand-primary)}
.MikufanMemTextarea[data-over=true]{border-color:var(--dsw-alias-state-error-primary)}
.MikufanMemCounter{align-self:flex-end;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.MikufanMemCounter[data-over=true]{color:var(--dsw-alias-state-error-primary)}
.MikufanMemTypes{display:flex;flex-wrap:wrap;gap:6px}
.MikufanMemTypeChip{padding:4px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.MikufanMemTypeChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.MikufanMemTypeChip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanMemTypeChip[aria-checked=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-brand-primary)}
.MikufanMemDialogFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:2px}
.MikufanMemBtn{box-sizing:border-box;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer}
.MikufanMemBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.MikufanMemBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanMemBtn:disabled{opacity:.5;cursor:not-allowed}
.MikufanMemBtnPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.MikufanMemBtnPrimary:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
`,
    );

    /** Host-side cap on one entry's content (mirrors `MEMORY_MAX_CONTENT_LENGTH` in `memory.js`). */
    const MEMORY_MAX_CONTENT = 2000;
    /** Selector for the tabbable controls inside the open dialog (Tab trap). */
    const MEMORY_FOCUSABLE =
      'button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
    /** The control that opened the dialog; focus returns to it when the dialog closes. */
    let memoryDialogReturnFocus = null;
    /** The open dialog's element (one at a time), for the Tab focus trap. */
    let memoryDialogElement = null;

    /** 16px plus for the blank create card. */
    function PlusIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M8 3.2v9.6' }),
        h('path', { d: 'M3.2 8h9.6' }),
      );
    }

    /** 16px pencil for the card footer's edit action. */
    function PencilIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M10.4 2.6 13.4 5.6 5.9 13.1 2.4 13.6l.5-3.5z' }),
        h('path', { d: 'M9 4l3 3' }),
      );
    }

    /** 16px cross for the card footer's delete action and the dialog's close button. */
    function CrossIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M3.6 3.6l8.8 8.8' }),
        h('path', { d: 'M12.4 3.6l-8.8 8.8' }),
      );
    }

    /** 16px magnifier for the memory search field. */
    function SearchIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true },
        h('circle', { cx: 7, cy: 7, r: 4.3 }),
        h('path', { d: 'M10.2 10.2 13.6 13.6' }),
      );
    }

    /** 16px circular arrows for the memory-list refresh button. */
    function RefreshIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M13.3 8a5.3 5.3 0 1 1-1.6-3.8' }),
        h('path', { d: 'M13.5 2.7v3.3H10.2' }),
      );
    }

    /** Short local "MM-DD HH:mm" stamp for one entry; empty when unparseable. */
    function formatMemoryTime(value) {
      if (typeof value !== 'string' || value === '') return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (part) => String(part).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** `操作失败：<message>` for one rejection, shared by the cards and the dialog. */
    function memoryErrorText(translate, cause) {
      return formatTemplate(translate('memory.error', '操作失败：{message}'), {
        message: String(cause?.message ?? cause),
      });
    }

    /** Remember which control opened the dialog, so focus can return to it. */
    function rememberDialogOpener() {
      if (typeof document === 'undefined') return;
      const active = document.activeElement;
      memoryDialogReturnFocus = active !== null && active !== undefined && active !== document.body ? active : null;
    }

    /**
     * The blank card that always comes first in the grid: one dashed, empty
     * card with a "+" that opens the create dialog.
     */
    function MemoryAddCard(props) {
      const {
        translate,
        onClick,
        labelKey = 'memory.addCard',
        fallbackLabel = '新建记忆',
        hintKey = 'memory.addCard.hint',
        fallbackHint = '新建一条记忆',
      } = props;
      return h(
        'button',
        {
          type: 'button',
          className: 'MikufanMemAdd',
          title: translate(hintKey, fallbackHint),
          onClick,
        },
        h('span', { className: 'MikufanMemAddGlyph' }, h(PlusIcon, null)),
        h('span', { className: 'MikufanMemAddLabel' }, translate(labelKey, fallbackLabel)),
      );
    }

    /**
     * One memory entry as a rounded card: a type tag, its source and the
     * enable switch on the header row; the first lines of the content below
     * (CSS clamps it to three lines); an 编辑 / 删除 footer. Clicking the
     * content opens the edit dialog, which is where the full text lives.
     */
    function MemoryCard(props) {
      const { entry, translate, onEdit } = props;
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [armed, setArmed] = useState(false);
      const typeLabel = translate(`memory.type.${entry.type}`, entry.type);
      const sourceLabel = translate(`memory.source.${entry.source}`, entry.source);
      const enabledLabel = entry.enabled
        ? translate('memory.enabled.on', '已启用（会注入会话索引）')
        : translate('memory.enabled.off', '已停用（保留但不注入）');
      const updated = formatMemoryTime(entry.updatedAt);
      // A switch is named after the entry it belongs to (not by its own state
      // sentence, which every card would share); the state lives in aria-checked.
      const excerpt = entry.content.length > 24 ? `${entry.content.slice(0, 24)}…` : entry.content;
      const switchLabel = formatTemplate(translate('memory.enabled.switch', '{action}记忆：{content}'), {
        action: entry.enabled
          ? translate('memory.enabled.disable', '停用')
          : translate('memory.enabled.enable', '启用'),
        content: excerpt,
      });

      // Delete arms on the first click and disarms itself after a moment.
      useEffect(() => {
        if (!armed) return undefined;
        const timer = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(timer);
      }, [armed]);

      const run = (operation) => {
        if (busy) return;
        setBusy(true);
        setError('');
        Promise.resolve()
          .then(operation)
          .catch((cause) => setError(memoryErrorText(translate, cause)))
          .finally(() => setBusy(false));
      };

      const openEditor = () => {
        if (busy) return;
        onEdit(entry);
      };
      const onDelete = () => {
        if (busy) return;
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        run(() => deleteMemoryViaHost(entry.id));
      };

      return h(
        'div',
        { className: 'MikufanMemCard', 'data-disabled': entry.enabled ? 'false' : 'true' },
        h(
          'div',
          { className: 'MikufanMemCardTop' },
          h('span', { className: 'MikufanMemTag' }, typeLabel),
          h('span', { className: 'MikufanMemSource' }, sourceLabel),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'MikufanSwitch',
              'aria-checked': entry.enabled,
              'aria-label': switchLabel,
              title: enabledLabel,
              disabled: busy,
              onClick: () => run(() => patchMemoryViaHost(entry.id, { enabled: !entry.enabled })),
            },
            h('span', { className: 'MikufanSwitchThumb' }),
          ),
        ),
        h(
          'div',
          {
            className: 'MikufanMemBody',
            role: 'button',
            tabIndex: 0,
            title: translate('memory.openEdit', '查看并编辑这条记忆'),
            'aria-label': translate('memory.openEdit', '查看并编辑这条记忆'),
            onClick: openEditor,
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              openEditor();
            },
          },
          h('div', { className: 'MikufanMemContent' }, entry.content),
        ),
        h(
          'div',
          { className: 'MikufanMemCardFoot' },
          h(
            'button',
            { type: 'button', className: 'MikufanMemAction', disabled: busy, onClick: openEditor },
            h(PencilIcon, null),
            translate('memory.edit', '编辑'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: `MikufanMemAction MikufanMemActionDanger${armed ? ' MikufanMemActionArmed' : ''}`,
              disabled: busy,
              title: armed ? translate('memory.confirmDelete', '确认删除') : translate('memory.delete', '删除'),
              onClick: onDelete,
            },
            h(CrossIcon, null),
            armed ? translate('memory.confirmDelete', '确认删除') : translate('memory.delete', '删除'),
          ),
          updated !== ''
            ? h('span', { className: 'MikufanMemUpdated' }, formatTemplate(translate('memory.updated', '更新于 {time}'), { time: updated }))
            : null,
        ),
        error !== '' ? h('div', { className: 'MikufanMemErrorLine', role: 'alert' }, error) : null,
      );
    }

    /**
     * The create/edit dialog: the memory page's "sub page" is this popup rather
     * than an inline form. One textarea, the four type chips, 取消 / 保存.
     * Portalled to `document.body` so the overlay covers the whole window; Esc,
     * the backdrop and the close button all dismiss it (never while saving).
     */
    function MemoryDialog(props) {
      const { mode, entry, translate, onClose } = props;
      const editing = mode === 'edit' && entry !== null && entry !== undefined;
      const [draft, setDraft] = useState(editing ? entry.content : '');
      const [type, setType] = useState(editing ? entry.type : 'project');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const text = draft.trim();
      // The Host trims before capping, so judge the trimmed length, not the raw one.
      const tooLong = text.length > MEMORY_MAX_CONTENT;
      const canSave = !busy && text !== '' && !tooLong;
      const title = editing ? translate('memory.edit.title', '编辑记忆') : translate('memory.new', '新建记忆');
      const description = editing
        ? translate('memory.edit.desc', '修改内容或类型，保存后立即生效。')
        : translate('memory.new.desc', '写一条希望 Agent 跨会话记住的事实，保存后立即进入记忆索引。');

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!busy) onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          const root = memoryDialogElement;
          if (root === null || typeof root.querySelectorAll !== 'function') return;
          const items = [...root.querySelectorAll(MEMORY_FOCUSABLE)];
          if (items.length === 0) return;
          const first = items[0];
          const last = items[items.length - 1];
          const active = document.activeElement;
          const inside = active !== null && typeof root.contains === 'function' && root.contains(active);
          if (event.shiftKey && (!inside || active === first)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (!inside || active === last)) {
            event.preventDefault();
            first.focus();
          }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [busy, onClose]);

      // Hold the page still behind the overlay, and hand focus back on close.
      useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
          document.body.style.overflow = previousOverflow;
          memoryDialogElement = null;
          const target = memoryDialogReturnFocus;
          memoryDialogReturnFocus = null;
          if (target !== null && target !== undefined && typeof target.focus === 'function' && target.isConnected !== false) {
            target.focus();
          }
        };
      }, []);

      const save = () => {
        if (!canSave) return;
        setBusy(true);
        setError('');
        const operation = editing
          ? patchMemoryViaHost(entry.id, { content: text, type })
          : createMemoryViaHost(text, type);
        Promise.resolve(operation)
          .then(() => onClose())
          .catch((cause) => setError(memoryErrorText(translate, cause)))
          .finally(() => setBusy(false));
      };

      // A click on the backdrop closes the dialog only when the same press also
      // started there: dragging a text selection out of the textarea must not
      // throw the draft away.
      let pressedOnBackdrop = false;

      const dialog = h(
        'div',
        {
          className: 'MikufanMemMask',
          onMouseDown: (event) => {
            pressedOnBackdrop = event.target === event.currentTarget;
          },
          onClick: (event) => {
            const startedOnBackdrop = pressedOnBackdrop;
            pressedOnBackdrop = false;
            if (startedOnBackdrop && event.target === event.currentTarget && !busy) onClose();
          },
        },
        h(
          'div',
          {
            className: 'MikufanMemDialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'mikufan-memory-dialog-title',
            ref: (node) => {
              memoryDialogElement = node;
            },
          },
          h(
            'div',
            { className: 'MikufanMemDialogHead' },
            h(
              'div',
              { className: 'MikufanMemDialogHeadText' },
              h('h2', { className: 'MikufanMemDialogTitle', id: 'mikufan-memory-dialog-title' }, title),
              h('p', { className: 'MikufanMemDialogDesc' }, description),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'MikufanMemClose',
                title: translate('memory.close', '关闭'),
                'aria-label': translate('memory.close', '关闭'),
                disabled: busy,
                onClick: onClose,
              },
              h(CrossIcon, null),
            ),
          ),
          h(
            'div',
            { className: 'MikufanMemField' },
            h('label', { className: 'MikufanMemFieldLabel' }, translate('memory.field.content', '内容')),
            h('textarea', {
              className: 'MikufanMemTextarea',
              value: draft,
              placeholder: translate('memory.add.placeholder', '记一条新记忆，例如：用户偏好简洁回复…'),
              autoFocus: true,
              spellCheck: false,
              'data-over': tooLong ? 'true' : 'false',
              'aria-label': translate('memory.field.content', '内容'),
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  save();
                }
              },
            }),
            h(
              'span',
              { className: 'MikufanMemCounter', 'data-over': tooLong ? 'true' : 'false' },
              formatTemplate(translate('memory.counter', '{count} / {max}'), {
                count: draft.length,
                max: MEMORY_MAX_CONTENT,
              }),
            ),
          ),
          h(
            'div',
            { className: 'MikufanMemField' },
            h('span', { className: 'MikufanMemFieldLabel' }, translate('memory.field.type', '类型')),
            h(
              'div',
              { className: 'MikufanMemTypes', role: 'radiogroup', 'aria-label': translate('memory.field.type', '类型') },
              MEMORY_TYPES.map((candidate) =>
                h(
                  'button',
                  {
                    key: candidate,
                    type: 'button',
                    role: 'radio',
                    className: 'MikufanMemTypeChip',
                    'aria-checked': type === candidate,
                    'data-type': candidate,
                    disabled: busy,
                    onClick: () => setType(candidate),
                    // A radiogroup is expected to move with the arrow keys too.
                    onKeyDown: (event) => {
                      const step =
                        event.key === 'ArrowRight' || event.key === 'ArrowDown'
                          ? 1
                          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                            ? -1
                            : 0;
                      if (step === 0) return;
                      event.preventDefault();
                      const index = MEMORY_TYPES.indexOf(candidate);
                      const next = MEMORY_TYPES[(index + step + MEMORY_TYPES.length) % MEMORY_TYPES.length];
                      setType(next);
                      const group = event.currentTarget.parentElement;
                      const buttons = group === null ? [] : [...group.querySelectorAll('button[data-type]')];
                      const target = buttons.find((button) => button.dataset.type === next);
                      if (target !== undefined) target.focus();
                    },
                  },
                  translate(`memory.type.${candidate}`, candidate),
                ),
              ),
            ),
          ),
          error !== '' ? h('div', { className: 'MikufanMemErrorLine', role: 'alert' }, error) : null,
          h(
            'div',
            { className: 'MikufanMemDialogFoot' },
            h(
              'button',
              { type: 'button', className: 'MikufanMemBtn', disabled: busy, onClick: onClose },
              translate('memory.cancel', '取消'),
            ),
            h(
              'button',
              { type: 'button', className: 'MikufanMemBtn MikufanMemBtnPrimary', disabled: !canSave, onClick: save },
              editing ? translate('memory.save', '保存') : translate('memory.create', '创建'),
            ),
          ),
        ),
      );

      const canPortal =
        typeof document !== 'undefined' && ReactDOM !== undefined && typeof ReactDOM.createPortal === 'function';
      return canPortal ? ReactDOM.createPortal(dialog, document.body) : dialog;
    }

    // ---------------------------------------------------------------------
    // LAN page components: status line, switch card, address card, port card.
    // Styled with the same tokens as the dashboard cards; the inputs reuse
    // the memory-panel input look.
    // ---------------------------------------------------------------------

    installStyle(
      STYLE_LAN,
      `
.MikufanLanNotice{display:flex;align-items:flex-start;gap:8px;margin-bottom:14px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.MikufanLanSelect{box-sizing:border-box;height:28px;max-width:168px;padding:0 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font-family:inherit}
.MikufanLanSelect:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanLanInput{box-sizing:border-box;height:28px;padding:0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font-family:inherit}
.MikufanLanInput::placeholder{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary))}
.MikufanLanInput:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanLanInputPort{width:88px}
.MikufanLanInputMax{width:72px}
.MikufanLanInputWide{flex:1;min-width:110px;width:auto}
.MikufanLanControlRow{display:flex;align-items:center;gap:6px;margin-top:10px;flex-wrap:wrap}
.MikufanLanManualRow{display:flex;align-items:center;gap:6px;flex:1;min-width:0}
.MikufanLanFootNote{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.MikufanLanFootError{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.MikufanLanFootUrl{overflow-wrap:anywhere}
.MikufanLanCopyButton{flex:none;margin-left:auto;padding:1px 8px;font-size:11px;line-height:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit}
.MikufanLanCopyButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.MikufanLanCopyButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
`,
    );

    /** Tiny `{name}` formatter for dictionary strings. */
    function formatTemplate(template, params) {
      let text = template;
      for (const [name, value] of Object.entries(params)) {
        text = text.split(`{${name}}`).join(String(value));
      }
      return text;
    }

    /**
     * 48px location-pin glyph for the IP-address card (the user's supplied
     * icon): a pin holding an "IP" monogram, single-color via `currentColor`
     * at the svg root. The source paths are 1024-based; the geometry is
     * unchanged, the missing fills come from the root.
     */
    function IpIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 1024 1024', fill: 'currentColor', 'aria-hidden': true },
        h('path', {
          d: 'M512.77824 993.75104L352.256 751.5136A375.808 375.808 0 0 1 136.56064 411.66848C136.54016 204.63616 304.96768 36.20864 512 36.20864c207.01184 0 375.43936 168.42752 375.43936 375.45984 0 151.08096-88.63744 285.32736-226.69312 344.82176l-147.968 237.2608zM512 97.64864c-173.1584 0-314.01984 140.86144-314.01984 314.01984a314.34752 314.34752 0 0 0 187.41248 287.45728l8.23296 3.62496 117.59616 177.41824 107.9296-173.056 9.33888-3.72736a312.70912 312.70912 0 0 0 197.5296-291.71712C825.99936 238.51008 685.13792 97.64864 512 97.64864z',
        }),
        h('path', { d: 'M380.55936 294.74816h43.95008V562.3808h-43.95008V294.74816z' }),
        h('path', { d: 'M434.74944 572.6208h-64.43008V284.50816h64.43008V572.6208z m-43.95008-20.48h23.47008V304.98816h-23.47008V552.1408z' }),
        h('path', {
          d: 'M604.22144 458.9568h-72.41728v103.424h-45.21984V293.45792h120.23808c58.61376 2.58048 90.05056 29.73696 94.37184 81.44896-0.88064 55.17312-33.21856 83.18976-96.9728 84.04992z m-3.8912-125.41952h-68.54656v86.60992h68.54656c37.04832 0 55.6032-15.07328 55.6032-45.24032-1.7408-26.70592-20.2752-40.50944-55.6032-41.3696z',
        }),
        h('path', {
          d: 'M542.04416 572.6208h-65.69984V283.21792h130.47808c80.54784 3.54304 101.2736 51.34336 104.57088 90.84928-0.6144 43.29472-19.72224 93.96224-107.02848 95.1296h-62.32064v103.424z m-45.24032-20.48h24.73984v-103.424h82.65728c58.34752-0.77824 85.93408-24.28928 86.71232-73.95328-3.87072-45.79328-30.76096-68.68992-84.60288-71.0656h-109.52704V552.1408z m103.5264-121.73312h-78.78656v-107.08992h78.78656c51.77344 1.26976 64.34816 28.40576 65.82272 50.93376 0.02048 21.38112-8.54016 56.15616-65.82272 56.15616z m-58.28608-20.48h58.30656c40.20224 0 45.3632-18.71872 45.3632-35.00032-0.83968-12.53376-6.49216-30.18752-45.60896-31.1296h-58.0608v66.12992z',
        }),
      );
    }

    /**
     * 48px wall-plate glyph for the port card (the user's supplied icon): an
     * Ethernet wall socket, single-color via `currentColor` at the svg root.
     * The source path is 1024-based; the geometry is unchanged, the missing
     * fill comes from the root.
     */
    function PortIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 1024 1024', fill: 'currentColor', 'aria-hidden': true },
        h('path', {
          d: 'M0 64l0 832 960 0L960 64 0 64zM896 832 64 832 64 128l832 0L896 832zM832 384l-128 0L704 256l-64 0L640 192 320 192l0 64L256 256l0 128L128 384l0 384 704 0L832 384zM768 704 192 704 192 448l64 0 64 0L320 384 320 320l64 0L384 256l192 0 0 64 64 0 0 64 0 64 64 0 64 0L768 704zM256 512l64 0 0 128L256 640 256 512zM384 512l64 0 0 128L384 640 384 512zM512 512l64 0 0 128L512 640 512 512zM640 512l64 0 0 128-64 0L640 512z',
        }),
      );
    }

    /**
     * 48px link-chain glyph for the connection-cap card (the user's supplied
     * icon): two interlocking chain halves, single-color via `currentColor`
     * at the svg root. The source paths are 1024-based; the geometry is
     * unchanged, the hardcoded fills were removed.
     */
    function DevicesIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 1024 1024', fill: 'currentColor', 'aria-hidden': true },
        h('path', {
          d: 'M861.866667 164.266667c-87.466667-87.466667-230.4-89.6-320-2.133334l-68.266667 68.266667c-12.8 12.8-12.8 32 0 44.8s32 12.8 44.8 0l68.266667-68.266667c64-61.866667 166.4-61.866667 230.4 2.133334 64 64 64 168.533333 2.133333 232.533333l-117.333333 119.466667c-34.133333 34.133333-81.066667 51.2-128 49.066666-46.933333-4.266667-91.733333-27.733333-119.466667-66.133333-10.666667-14.933333-29.866667-17.066667-44.8-6.4-14.933333 10.666667-17.066667 29.866667-6.4 44.8 40.533333 53.333333 100.266667 87.466667 166.4 91.733333h17.066667c59.733333 0 119.466667-23.466667 162.133333-68.266666l117.333333-119.466667c83.2-89.6 83.2-234.666667-4.266666-322.133333z',
        }),
        h('path', {
          d: 'M505.6 750.933333l-66.133333 68.266667c-64 61.866667-166.4 61.866667-230.4-2.133333-64-64-64-168.533333-2.133334-232.533334l117.333334-119.466666c34.133333-34.133333 81.066667-51.2 128-49.066667 46.933333 4.266667 91.733333 27.733333 119.466666 66.133333 10.666667 14.933333 29.866667 17.066667 44.8 6.4 14.933333-10.666667 17.066667-29.866667 6.4-44.8-40.533333-53.333333-100.266667-87.466667-166.4-91.733333-66.133333-4.266667-130.133333 19.2-177.066666 66.133333l-117.333334 119.466667c-85.333333 89.6-85.333333 234.666667 2.133334 322.133333 44.8 44.8 102.4 66.133333 162.133333 66.133334 57.6 0 115.2-21.333333 160-64l66.133333-68.266667c12.8-12.8 12.8-32 0-44.8-14.933333-10.666667-34.133333-10.666667-46.933333 2.133333z',
        }),
      );
    }

    /** Footer for the LAN-access card: live URL with copy, the last error, or off. */
    function LanAccessFooter({ translate }) {
      const current = useSyncExternalStore(subscribeLan, getLanStatus);
      const [copied, setCopied] = useState(false);
      const proxy = current?.proxy ?? {};
      const lanUrl = typeof proxy.lanUrl === 'string' ? proxy.lanUrl : '';
      const running = proxy.running === true && lanUrl !== '';
      const onCopy = () => {
        if (!running) return;
        void navigator.clipboard
          ?.writeText(lanUrl)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => {});
      };
      return h(
        'div',
        { className: 'MikufanCpCardFoot' + (running ? ' MikufanCpCardFootActive' : '') },
        typeof proxy.error === 'string'
          ? h(
              'span',
              { className: 'MikufanLanFootError' },
              formatTemplate(translate('lan.status.error', '启动失败：{message}'), { message: proxy.error }),
            )
          : h(
              'span',
              { className: 'MikufanLanFootUrl' },
              running
                ? formatTemplate(translate('lan.foot.running', '已开启：{url}'), { url: lanUrl })
                : translate('lan.foot.off', '入口未开启；本机 127.0.0.1 访问不受影响'),
            ),
        running
          ? h(
              'button',
              { type: 'button', className: 'MikufanLanCopyButton', onClick: onCopy, title: lanUrl },
              copied ? translate('lan.status.copied', '已复制') : translate('lan.status.copy', '复制'),
            )
          : null,
      );
    }

    /** Footer for one option card: the committed value, plus a brief applied note. */
    function lanFootText(translate, text, applied) {
      return h(
        'div',
        { className: 'MikufanCpCardFoot' },
        h('span', null, text),
        applied ? h('span', { className: 'MikufanLanFootNote', role: 'status' }, translate('lan.saved', '已应用')) : null,
      );
    }

    /**
     * Card 1: the LAN-access switch. Same anatomy as the dashboard's feature
     * cards — 48px icon, title and switch on one row, description beneath, a
     * status footer — because this page and the dashboard share one language.
     */
    function LanSwitchCard({ translate }) {
      const current = useSyncExternalStore(subscribeLan, getLanStatus);
      const enabled = current?.saved?.lanAccessEnabled === true;
      const [busy, setBusy] = useState(false);
      const [failed, setFailed] = useState(false);
      const title = translate('lan.card.switch.title', '局域网访问');
      const onChange = () => {
        if (busy) return;
        setFailed(false);
        setBusy(true);
        Promise.resolve(saveLanPreferences({ lanAccessEnabled: !enabled }))
          .then(() => {
            // The proxy start takes a moment; settle before repainting.
            setTimeout(() => void refreshLanStatus(), 400);
          })
          .catch(() => setFailed(true))
          .finally(() => setBusy(false));
      };
      return h(
        'div',
        { className: 'MikufanCpCard' },
        h(
          'div',
          { className: 'MikufanCpCardBody' },
          h('div', { className: 'MikufanCpCardIcon' }, h(LanIcon, null)),
          h(
            'div',
            { className: 'MikufanCpCardMain' },
            h(
              'div',
              { className: 'MikufanCpCardHead' },
              h('h2', { className: 'MikufanCpCardTitle' }, title),
              h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  className: 'MikufanSwitch',
                  'aria-checked': enabled,
                  'aria-label': title,
                  title,
                  disabled: busy,
                  onClick: onChange,
                },
                h('span', { className: 'MikufanSwitchThumb' }),
              ),
            ),
            h('p', { className: 'MikufanCpCardDesc' }, translate('lan.card.switch.description', '需手动开启')),
            failed
              ? h('div', { className: 'MikufanCpCardError', role: 'alert' }, translate('lan.saveFailed', '保存失败，请重试。'))
              : null,
          ),
        ),
        h(LanAccessFooter, { translate }),
      );
    }

    /**
     * Card 2: the IP address the LAN listener binds to — auto-detect, one of
     * the detected addresses, or a hand-typed one (the input then moves to its
     * own row under the description, where it has room).
     */
    function LanAddressCard({ translate }) {
      const current = useSyncExternalStore(subscribeLan, getLanStatus);
      const saved = current?.saved?.lanHost ?? '';
      const detected = current?.detected ?? [];
      const [custom, setCustom] = useState(null);
      // The "手动输入…" choice needs its own flag: with an empty custom value
      // the select would otherwise snap back to 自动探测 (empty = auto).
      const [manualMode, setManualMode] = useState(false);
      const committed = saved;
      const startFailed = typeof current?.proxy?.error === 'string';
      const isAuto = committed === '';
      const isDetected = detected.includes(committed);
      const showManual = manualMode || (!isAuto && !isDetected);
      const value = showManual ? (custom ?? committed) : committed;
      const dirty = value !== committed;
      const [busy, setBusy] = useState(false);
      /** '' | 'value' (the Host rejected the address) | 'save' (anything else). */
      const [errorKind, setErrorKind] = useState('');
      const [savedNote, setSavedNote] = useState(false);
      const apply = (host) => {
        if (busy) return;
        setErrorKind('');
        setSavedNote(false);
        setBusy(true);
        Promise.resolve(saveLanPreferences({ lanHost: host }))
          .then(() => {
            setCustom(null);
            setManualMode(false);
            setSavedNote(true);
            setTimeout(() => setSavedNote(false), 2500);
          })
          .catch((cause) => setErrorKind(String(cause?.message ?? cause).includes('lanHost') ? 'value' : 'save'))
          .finally(() => setBusy(false));
      };
      const onPick = (event) => {
        const picked = event.target.value;
        if (picked === '__manual__') {
          setManualMode(true);
          setCustom(committed);
          return;
        }
        setManualMode(false);
        setCustom(null);
        // Auto-detect applies directly, like picking a detected address.
        apply(picked);
      };
      const onSave = () => {
        const wanted = value.trim();
        if (busy || wanted === '' || wanted === committed) return;
        apply(wanted);
      };
      const selectValue = showManual ? '__manual__' : isAuto ? '' : committed;
      const footBase = isAuto
        ? detected.length > 0
          ? formatTemplate(translate('lan.foot.auto', '自动探测：{address}'), { address: detected[0] })
          : translate('lan.foot.autoNone', '自动探测：未检测到可用地址')
        : formatTemplate(translate('lan.foot.manual', '手动指定：{address}'), { address: committed });
      const foot = startFailed ? footBase + translate('lan.foot.notApplied', '（未生效）') : footBase;
      return h(
        'div',
        { className: 'MikufanCpCard' },
        h(
          'div',
          { className: 'MikufanCpCardBody' },
          h('div', { className: 'MikufanCpCardIcon' }, h(IpIcon, null)),
          h(
            'div',
            { className: 'MikufanCpCardMain' },
            h(
              'div',
              { className: 'MikufanCpCardHead' },
              h('h2', { className: 'MikufanCpCardTitle' }, translate('lan.card.ip.title', 'IP 地址')),
            ),
            h(
              'p',
              { className: 'MikufanCpCardDesc' },
              detected.length > 0
                ? formatTemplate(translate('lan.address.detected', '检测到的地址：{addresses}'), { addresses: detected.join(', ') })
                : translate('lan.address.detectedNone', '未检测到局域网地址。'),
            ),
            h(
              'div',
              { className: 'MikufanLanControlRow' },
              h(
                'select',
                {
                  className: 'MikufanLanSelect',
                  value: selectValue,
                  onChange: onPick,
                  disabled: busy,
                  'aria-label': translate('lan.card.ip.title', 'IP 地址'),
                },
                h('option', { value: '' }, translate('lan.address.auto', '自动探测（推荐）')),
                detected.map((address) => h('option', { key: address, value: address }, address)),
                h('option', { value: '__manual__' }, translate('lan.address.manual', '手动输入…')),
              ),
            ),
            selectValue === '__manual__'
              ? h(
                  'div',
                  { className: 'MikufanLanManualRow' },
                  h('input', {
                    type: 'text',
                    className: 'MikufanLanInput MikufanLanInputWide',
                    value,
                    placeholder: translate('lan.address.placeholder', '192.168.31.6'),
                    spellCheck: false,
                    autoCapitalize: 'off',
                    'aria-label': translate('lan.card.ip.title', 'IP 地址'),
                    onChange: (event) => setCustom(event.target.value),
                    onBlur: onSave,
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    },
                  }),
                )
              : null,
            errorKind === 'value'
              ? h('div', { className: 'MikufanCpCardError', role: 'alert' }, translate('lan.address.invalid', '地址无效：请填写本机的具体 IPv4/IPv6。'))
              : errorKind === 'save'
                ? h('div', { className: 'MikufanCpCardError', role: 'alert' }, translate('lan.saveFailed', '保存失败，请重试。'))
                : null,
          ),
        ),
        lanFootText(translate, foot, savedNote),
      );
    }

    /** Card 3: the LAN listener's port. */
    function LanPortCard({ translate }) {
      const current = useSyncExternalStore(subscribeLan, getLanStatus);
      const committed = String(current?.saved?.lanPort ?? 3090);
      const [value, setValue] = useState(null);
      const text = value === null ? committed : value;
      const parsed = Number.parseInt(text, 10);
      const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
      const dirty = text !== committed && valid;
      const [busy, setBusy] = useState(false);
      /** '' | 'value' (the Host rejected the port) | 'save' (anything else). */
      const [errorKind, setErrorKind] = useState('');
      const [savedNote, setSavedNote] = useState(false);
      const startFailed = typeof current?.proxy?.error === 'string';
      const defaultPort = Number.isInteger(current?.defaultPort) ? current.defaultPort : 3090;
      // Save on blur (or Enter, which just blurs): no Apply button.
      const onSave = () => {
        if (busy || !valid || !dirty) return;
        setErrorKind('');
        setSavedNote(false);
        setBusy(true);
        Promise.resolve(saveLanPreferences({ lanPort: parsed }))
          .then(() => {
            setValue(null);
            setSavedNote(true);
            setTimeout(() => setSavedNote(false), 2500);
          })
          .catch((cause) => setErrorKind(String(cause?.message ?? cause).includes('lanPort') ? 'value' : 'save'))
          .finally(() => setBusy(false));
      };
      const footBase = formatTemplate(translate('lan.foot.port', '当前端口 {port}'), { port: committed });
      const foot = startFailed ? footBase + translate('lan.foot.notApplied', '（未生效）') : footBase;
      const showInvalid = text !== '' && !valid;
      return h(
        'div',
        { className: 'MikufanCpCard' },
        h(
          'div',
          { className: 'MikufanCpCardBody' },
          h('div', { className: 'MikufanCpCardIcon' }, h(PortIcon, null)),
          h(
            'div',
            { className: 'MikufanCpCardMain' },
            h(
              'div',
              { className: 'MikufanCpCardHead' },
              h('h2', { className: 'MikufanCpCardTitle' }, translate('lan.card.port.title', '端口')),
            ),
            h(
              'p',
              { className: 'MikufanCpCardDesc' },
              formatTemplate(translate('lan.card.port.description', '默认 {port}'), { port: defaultPort }),
            ),
            h(
              'div',
              { className: 'MikufanLanControlRow' },
              h('input', {
                type: 'text',
                inputMode: 'numeric',
                className: 'MikufanLanInput MikufanLanInputPort',
                value: text,
                spellCheck: false,
                'aria-label': translate('lan.card.port.title', '端口'),
                onChange: (event) => setValue(event.target.value),
                onBlur: onSave,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                },
              }),
            ),
            showInvalid
              ? h('div', { className: 'MikufanCpCardError', role: 'alert' }, translate('lan.port.invalid', '端口无效：请输入 1–65535 之间的整数。'))
              : errorKind === 'value'
                ? h('div', { className: 'MikufanCpCardError', role: 'alert' }, translate('lan.port.invalid', '端口无效：请输入 1–65535 之间的整数。'))
                : errorKind === 'save'
                  ? h('div', { className: 'MikufanCpCardError', role: 'alert' }, translate('lan.saveFailed', '保存失败，请重试。'))
                  : null,
          ),
        ),
        lanFootText(translate, foot, savedNote),
      );
    }

    /** Card 4: the cap on concurrently connected LAN devices (0 = unlimited). */
    function LanMaxCard({ translate }) {
      const current = useSyncExternalStore(subscribeLan, getLanStatus);
      const committed = String(current?.saved?.lanMaxConnections ?? 0);
      const limit = Number.isInteger(current?.maxConnectionsLimit) ? current.maxConnectionsLimit : 256;
      const [value, setValue] = useState(null);
      const text = value === null ? committed : value;
      const parsed = Number.parseInt(text, 10);
      const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= limit;
      const dirty = text !== committed && valid;
      const [busy, setBusy] = useState(false);
      /** '' | 'value' (the Host rejected the number) | 'save' (anything else). */
      const [errorKind, setErrorKind] = useState('');
      const [savedNote, setSavedNote] = useState(false);
      const startFailed = typeof current?.proxy?.error === 'string';
      // Save on blur (or Enter, which just blurs): no Apply button.
      const onSave = () => {
        if (busy || !valid || !dirty) return;
        setErrorKind('');
        setSavedNote(false);
        setBusy(true);
        Promise.resolve(saveLanPreferences({ lanMaxConnections: parsed }))
          .then(() => {
            setValue(null);
            setSavedNote(true);
            setTimeout(() => setSavedNote(false), 2500);
          })
          .catch((cause) => setErrorKind(String(cause?.message ?? cause).includes('lanMaxConnections') ? 'value' : 'save'))
          .finally(() => setBusy(false));
      };
      const running = current?.proxy?.running === true;
      const devices = typeof current?.proxy?.devices === 'number' ? current.proxy.devices : 0;
      const base =
        committed === '0'
          ? translate('lan.foot.maxOff', '当前不限制设备数')
          : formatTemplate(translate('lan.foot.maxOn', '当前上限 {max} 台设备'), { max: committed });
      const foot = running
        ? base + formatTemplate(translate('lan.foot.connections', ' · 已连接 {count} 台设备'), { count: devices })
        : startFailed
          ? base + translate('lan.foot.notApplied', '（未生效）')
          : base;
      const showInvalid = text !== '' && !valid;
      return h(
        'div',
        { className: 'MikufanCpCard' },
        h(
          'div',
          { className: 'MikufanCpCardBody' },
          h('div', { className: 'MikufanCpCardIcon' }, h(DevicesIcon, null)),
          h(
            'div',
            { className: 'MikufanCpCardMain' },
            h(
              'div',
              { className: 'MikufanCpCardHead' },
              h('h2', { className: 'MikufanCpCardTitle' }, translate('lan.card.max.title', '最大连接数')),
            ),
            h('p', { className: 'MikufanCpCardDesc' }, translate('lan.card.max.description', '按 IP 计，0 表示不限')),
            h(
              'div',
              { className: 'MikufanLanControlRow' },
              h('input', {
                type: 'text',
                inputMode: 'numeric',
                className: 'MikufanLanInput MikufanLanInputMax',
                value: text,
                spellCheck: false,
                'aria-label': translate('lan.card.max.title', '最大连接数'),
                onChange: (event) => setValue(event.target.value),
                onBlur: onSave,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                },
              }),
            ),
            showInvalid
              ? h(
                  'div',
                  { className: 'MikufanCpCardError', role: 'alert' },
                  formatTemplate(translate('lan.max.invalid', '请输入 0–{limit} 之间的整数（0 表示不限制）。'), { limit }),
                )
              : errorKind === 'value'
                ? h(
                    'div',
                    { className: 'MikufanCpCardError', role: 'alert' },
                    formatTemplate(translate('lan.max.invalid', '请输入 0–{limit} 之间的整数（0 表示不限制）。'), { limit }),
                  )
                : errorKind === 'save'
                  ? h('div', { className: 'MikufanCpCardError', role: 'alert' }, translate('lan.saveFailed', '保存失败，请重试。'))
                  : null,
          ),
        ),
        lanFootText(translate, foot, savedNote),
      );
    }

    /**
     * The LAN page: four cards in the dashboard's grid and card anatomy —
     * the access switch, the IP address, the port, and the connection cap.
     * The engine status hydrates on mount.
     */
    function LanPageBody({ translate }) {
      const loaded = useSyncExternalStore(subscribeLan, isLanLoaded);
      const readFailed = useSyncExternalStore(subscribeLan, isLanReadFailed);

      useEffect(() => {
        hydrateLanStatus();
        // The connection counter is live status: refresh it while this page is
        // open (paused while the tab is hidden so a background tab stays quiet).
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
          void refreshLanStatus();
        }, 6000);
        return () => clearInterval(timer);
      }, []);

      return h(
        'div',
        { role: 'tabpanel', 'aria-label': translate('control.panel.tab.lan', '局域网访问') },
        h(PageHead, {
          translate,
          titleKey: 'lan.tab.title',
          fallbackTitle: '局域网访问',
          subtitleKey: 'lan.tab.subtitle',
          fallbackSubtitle: '局域网快速访问',
        }),
        readFailed && !loaded
          ? h('div', { className: 'MikufanLanNotice', role: 'alert' }, translate('lan.readFailed', '局域网状态读取失败，请刷新页面重试。'))
          : null,
        loaded
          ? h(
              'div',
              { className: 'MikufanCpGroup' },
              // Row 1: the switch beside the limit it governs; row 2: address and port.
              h(LanSwitchCard, { translate }),
              h(LanMaxCard, { translate }),
              h(LanAddressCard, { translate }),
              h(LanPortCard, { translate }),
            )
          : null,
      );
    }

    // ---------------------------------------------------------------------
    // Skills page: the managed skill root as cards (no icons: name on the first
    // line, description on the second, the model-invocation switch in the
    // header, 打开 / 详情 in the footer) plus the detail overlay the reference
    // sketch describes, and a right-sidebar tab that previews one SKILL.md.
    // ---------------------------------------------------------------------

    /** Kind of this plugin's right-sidebar preview tab. */
    const SKILL_TAB_KIND = 'mikufan-skill';
    /** Id of the sidebar tab type / slot cell (also its registration identity). */
    const SKILL_TAB_ID = `${PACKAGE_NAME}/skill-preview`;

    installStyle(
      STYLE_SKILLS,
      `
.MikufanSkillPanel{display:flex;flex-direction:column;min-height:0;gap:14px}
.MikufanSkillBar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.MikufanSkillBarRoot{min-width:0;overflow-wrap:anywhere}
.MikufanSkillTools{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto}
.MikufanSkillGroup{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:stretch}
.MikufanSkillGroup[data-empty=true]{grid-template-columns:minmax(0,1fr)}
@media (max-width:700px){.MikufanSkillGroup{grid-template-columns:minmax(0,1fr)}}
.MikufanSkillEmpty{margin:0;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.MikufanSkillCard{display:flex;flex-direction:column;gap:10px;min-width:0;padding:16px 18px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 3px rgba(0,0,0,.04);transition:transform .15s ease,box-shadow .15s ease}
.MikufanSkillCard:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.07)}
.MikufanSkillCardHead{display:flex;align-items:flex-start;gap:8px;min-width:0}
.MikufanSkillCardHead .MikufanSwitch{margin-left:auto;margin-top:1px}
.MikufanSkillName{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:600;line-height:22px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.MikufanSkillDesc{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.MikufanSkillCard[data-disabled=true] .MikufanSkillName{color:var(--dsw-alias-label-tertiary)}
.MikufanSkillCard[data-disabled=true] .MikufanSkillDesc{color:var(--dsw-alias-label-tertiary)}
.MikufanSkillFoot{display:flex;align-items:center;gap:2px;margin-top:auto;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.MikufanSkillAction{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.MikufanSkillAction:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.MikufanSkillAction:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanSkillAction:disabled{opacity:.5;cursor:not-allowed}
.MikufanSkillAction svg{width:14px;height:14px}
.MikufanSkillUpdated{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.MikufanSkillErrorLine{margin:-4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
/* Detail overlay: the reference layout — header, scrolling markdown, footer. */
.MikufanSkillDetailMask{position:fixed;inset:0;z-index:1010;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur,blur(4px));-webkit-backdrop-filter:var(--dsw-mask-blur,blur(4px));animation:MikufanMemFade .16s ease-out}
.MikufanSkillDetail{display:flex;flex-direction:column;box-sizing:border-box;width:min(760px,100%);max-height:min(88vh,920px);overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.22));animation:MikufanMemPop .16s ease-out}
.MikufanSkillDetailHead{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.MikufanSkillDetailText{flex:1;min-width:0}
.MikufanSkillDetailTitle{margin:0;font-size:20px;font-weight:600;line-height:28px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.MikufanSkillDetailDesc{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.MikufanSkillDetailControls{display:flex;align-items:center;gap:6px;flex:none}
.MikufanSkillIconButton{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.MikufanSkillIconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.MikufanSkillIconButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanSkillIconButton:disabled{opacity:.5;cursor:not-allowed}
.MikufanSkillIconButton svg{width:16px;height:16px}
.MikufanSkillMenuWrap{position:relative}
.MikufanSkillMenu{position:absolute;top:36px;right:0;z-index:2;min-width:190px;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent,0 12px 30px rgba(0,0,0,.18))}
.MikufanSkillMenuItem{display:block;width:100%;padding:7px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;text-align:left;white-space:nowrap;cursor:pointer}
.MikufanSkillMenuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.MikufanSkillMenuItem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.MikufanSkillDetailBody{flex:1;min-height:0;overflow:auto;padding:18px 22px 24px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary)}
.MikufanSkillDetailFoot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1)}
.MikufanSkillDangerButton{height:30px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer}
.MikufanSkillDangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.MikufanSkillDangerButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanSkillDangerButtonArmed{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.MikufanSkillDangerButton:disabled{opacity:.5;cursor:not-allowed}
.MikufanSkillPrimaryButton{height:30px;padding:0 16px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer}
.MikufanSkillPrimaryButton:hover:not(:disabled){opacity:.9}
.MikufanSkillPrimaryButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanSkillPrimaryButton:disabled{opacity:.5;cursor:not-allowed}
/* Markdown body (headings, paragraphs, lists, quotes, code). */
.MikufanMdH1{margin:0 0 10px;font-size:19px;font-weight:600;line-height:26px;letter-spacing:-.01em}
.MikufanMdH2{margin:16px 0 8px;font-size:16px;font-weight:600;line-height:24px}
.MikufanMdH3{margin:14px 0 6px;font-size:14px;font-weight:600;line-height:22px}
.MikufanMdH4{margin:12px 0 6px;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary)}
.MikufanMdP{margin:0 0 10px}
.MikufanMdList{margin:0 0 10px;padding-left:20px}
.MikufanMdItem{margin:2px 0}
.MikufanMdCode{padding:1px 5px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px}
.MikufanMdPre{margin:0 0 12px;padding:10px 12px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px;line-height:18px;white-space:pre}
.MikufanMdQuote{margin:0 0 10px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.MikufanMdHr{margin:12px 0;border:0;border-top:1px solid var(--dsw-alias-border-l1)}
/* Right-sidebar preview tab body. */
.MikufanSkillPreview{display:flex;flex-direction:column;height:100%;min-height:0}
.MikufanSkillPreviewHead{flex:none;padding:14px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.MikufanSkillPreviewName{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.MikufanSkillPreviewSub{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.MikufanSkillPreviewBody{flex:1;min-height:0;overflow:auto;padding:14px 18px 20px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary)}
.MikufanSkillPreviewHint{padding:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
`,
    );

    // ---------------------------------------------------------------------
    // MCP page: the Codex-standard mcp_servers list as a card grid. One card
    // per server — first line the name, second line the transport + endpoint
    // (`stdio` 命令 or streamable_http url), the header switch is the entry's
    // `enabled` flag, the footer 编辑 / 详情 / 删除. Creating and editing
    // happen in the McpDialog popup; 详情 opens the McpDetailOverlay, whose
    // body shows the Codex TOML and the dsh-mcp-client YAML transcription.
    // ---------------------------------------------------------------------

    installStyle(
      STYLE_MCP,
      `
.MikufanMcpPanel{display:flex;flex-direction:column;min-height:0;gap:14px}
.MikufanMcpBar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.MikufanMcpBarRoot{min-width:0;overflow-wrap:anywhere}
.MikufanMcpTools{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto}
.MikufanMcpGroup{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:stretch}
.MikufanMcpGroup[data-empty=true]{grid-template-columns:minmax(0,1fr)}
@media (max-width:700px){.MikufanMcpGroup{grid-template-columns:minmax(0,1fr)}}
.MikufanMcpEmpty{margin:0;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.MikufanMcpCard{display:flex;flex-direction:column;gap:10px;min-width:0;padding:16px 18px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 3px rgba(0,0,0,.04);transition:transform .15s ease,box-shadow .15s ease}
.MikufanMcpCard:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.07)}
.MikufanMcpCardHead{display:flex;align-items:flex-start;gap:8px;min-width:0}
.MikufanMcpCardHead .MikufanSwitch{margin-left:auto;margin-top:1px}
.MikufanMcpName{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:600;line-height:22px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.MikufanMcpDesc{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.MikufanMcpCard[data-disabled=true] .MikufanMcpName{color:var(--dsw-alias-label-tertiary)}
.MikufanMcpCard[data-disabled=true] .MikufanMcpDesc{color:var(--dsw-alias-label-tertiary)}
.MikufanMcpCardFoot{display:flex;align-items:center;gap:2px;margin-top:auto;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.MikufanMcpAction{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.MikufanMcpAction:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.MikufanMcpAction:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanMcpAction:disabled{opacity:.5;cursor:not-allowed}
.MikufanMcpAction svg{width:14px;height:14px}
.MikufanMcpActionDanger{color:var(--dsw-alias-label-tertiary)}
.MikufanMcpActionDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.MikufanMcpActionArmed{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.MikufanMcpErrorLine{margin:-4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.MikufanMcpAppliedLine{margin:-4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
/* Dialog: the memory dialog's overlay idiom, two columns wide for the fields. */
.MikufanMcpMask{position:fixed;inset:0;z-index:1010;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur,blur(4px));-webkit-backdrop-filter:var(--dsw-mask-blur,blur(4px));animation:MikufanMemFade .16s ease-out}
.MikufanMcpDialog{display:flex;flex-direction:column;gap:14px;box-sizing:border-box;width:min(620px,100%);max-height:min(84vh,760px);overflow:auto;padding:18px 20px 16px;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.22));animation:MikufanMemPop .16s ease-out}
@media (prefers-reduced-motion:reduce){.MikufanMcpMask,.MikufanMcpDialog{animation:none}}
.MikufanMcpDialogHead{display:flex;align-items:flex-start;gap:12px}
.MikufanMcpDialogHeadText{flex:1;min-width:0}
.MikufanMcpDialogTitle{margin:0;font-size:16px;font-weight:600;line-height:24px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.MikufanMcpDialogDesc{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.MikufanMcpFieldGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
@media (max-width:700px){.MikufanMcpFieldGrid{grid-template-columns:minmax(0,1fr)}}
.MikufanMcpField{display:flex;flex-direction:column;gap:6px;min-width:0}
.MikufanMcpFieldSpan{grid-column:1 / -1}
.MikufanMcpFieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.MikufanMcpFieldHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.MikufanMcpInput{box-sizing:border-box;width:100%;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:18px}
.MikufanMcpInput::placeholder{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary))}
.MikufanMcpInput:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:var(--dsw-alias-brand-primary)}
.MikufanMcpInput[data-over=true]{border-color:var(--dsw-alias-state-error-primary)}
.MikufanMcpTextarea{box-sizing:border-box;width:100%;min-height:64px;max-height:32vh;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px;line-height:18px;resize:vertical}
.MikufanMcpTextarea::placeholder{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary))}
.MikufanMcpTextarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:var(--dsw-alias-brand-primary)}
.MikufanMcpTypes{display:flex;flex-wrap:wrap;gap:6px}
.MikufanMcpTypeChip{padding:4px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.MikufanMcpTypeChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.MikufanMcpTypeChip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanMcpTypeChip[aria-checked=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-brand-primary)}
.MikufanMcpError{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.MikufanMcpDialogFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:2px}
/* Detail overlay: the Skills detail idiom — header, scrolling body, footer. */
.MikufanMcpDetail{display:flex;flex-direction:column;box-sizing:border-box;width:min(760px,100%);max-height:min(88vh,920px);overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.22));animation:MikufanMemPop .16s ease-out}
.MikufanMcpDetailHead{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.MikufanMcpDetailText{flex:1;min-width:0}
.MikufanMcpDetailTitle{margin:0;font-size:20px;font-weight:600;line-height:28px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.MikufanMcpDetailDesc{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.MikufanMcpDetailBody{flex:1;min-height:0;overflow:auto;padding:18px 22px 24px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary)}
.MikufanMcpDetailFoot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1)}
.MikufanMcpCodeHead{display:flex;align-items:center;gap:8px;margin:14px 0 6px}
.MikufanMcpCodeHead:first-child{margin-top:0}
.MikufanMcpCodeTitle{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.MikufanMcpCopyButton{padding:1px 8px;font-size:11px;line-height:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit}
.MikufanMcpCopyButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.MikufanMcpCopyButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.MikufanMcpDangerButton{height:30px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer}
.MikufanMcpDangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.MikufanMcpDangerButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanMcpDangerButton:disabled{opacity:.5;cursor:not-allowed}
`,
    );

    /** transport chip text for one server card. */
    function mcpTransportLabel(translate, server) {
      return server.transport === 'stdio'
        ? translate('mcp.transport.stdio', 'stdio（本地进程）')
        : translate('mcp.transport.streamable_http', 'streamable_http（远程服务）');
    }

    /** The one-line endpoint shown under a card's name. */
    function mcpEndpointText(server) {
      return server.transport === 'stdio' ? server.command : server.url;
    }

    /**
     * One MCP server as a rounded card in the memory/skills idiom: the header
     * row is the name plus the `enabled` switch, the body shows the transport
     * chip and the endpoint, and the footer is 编辑 / 详情 / 删除 (two-step).
     */
    function McpCard(props) {
      const { server, translate, onEdit, onDetails } = props;
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [armed, setArmed] = useState(false);
      // The enable-sync outcome (reloaded / absent / failed / restart-required)
      // arrives on the server record after a toggle; it stays visible until the
      // next toggle or reload replaces the record.
      const applied = server.applied;
      const appliedNotice = mcpAppliedNotice(translate, server);
      const enabledLabel = server.enabled
        ? translate('mcp.enabled.on', '已启用（写进 Codex 配置后可用）')
        : translate('mcp.enabled.off', '已停用（保留条目，不写入配置）');
      const excerpt = mcpEndpointText(server);
      const switchLabel = formatTemplate(translate('mcp.enabled.switch', '{action}MCP 服务器：{name}'), {
        action: server.enabled ? translate('mcp.enabled.disable', '停用') : translate('mcp.enabled.enable', '启用'),
        name: server.name,
      });

      useEffect(() => {
        if (!armed) return undefined;
        const timer = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(timer);
      }, [armed]);

      const run = (operation) => {
        if (busy) return;
        setBusy(true);
        setError('');
        Promise.resolve()
          .then(operation)
          .catch((cause) => setError(memoryErrorText(translate, cause)))
          .finally(() => setBusy(false));
      };
      const onDelete = () => {
        if (busy) return;
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        run(() => deleteMcpViaHost(server.name));
      };

      return h(
        'div',
        { className: 'MikufanMcpCard', 'data-disabled': server.enabled ? 'false' : 'true' },
        h(
          'div',
          { className: 'MikufanMcpCardHead' },
          h('h3', { className: 'MikufanMcpName' }, server.name),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'MikufanSwitch',
              'aria-checked': server.enabled,
              'aria-label': switchLabel,
              title: enabledLabel,
              disabled: busy,
              onClick: () => run(() => patchMcpEnabledViaHost(server.name, !server.enabled)),
            },
            h('span', { className: 'MikufanSwitchThumb' }),
          ),
        ),
        h(
          'div',
          { className: 'MikufanMcpBody' },
          h('span', { className: 'MikufanMemTag' }, mcpTransportLabel(translate, server)),
          h('div', { className: 'MikufanMcpDesc' }, mcpEndpointText(server)),
        ),
        h(
          'div',
          { className: 'MikufanMcpCardFoot' },
          h(
            'button',
            { type: 'button', className: 'MikufanMcpAction', disabled: busy, onClick: () => onEdit(server) },
            h(PencilIcon, null),
            translate('mcp.edit', '编辑'),
          ),
          h(
            'button',
            { type: 'button', className: 'MikufanMcpAction', disabled: busy, onClick: () => onDetails(server) },
            h(InfoIcon, null),
            translate('mcp.details', '详情'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: `MikufanMcpAction MikufanMcpActionDanger${armed ? ' MikufanMcpActionArmed' : ''}`,
              disabled: busy,
              title: armed ? translate('mcp.confirmDelete', '确认删除') : translate('mcp.delete', '删除'),
              onClick: onDelete,
            },
            h(CrossIcon, null),
            armed ? translate('mcp.confirmDelete', '确认删除') : translate('mcp.delete', '删除'),
          ),
        ),
        error !== '' ? h('div', { className: 'MikufanMcpErrorLine', role: 'alert' }, error) : null,
        appliedNotice !== ''
          ? h('div', { className: 'MikufanMcpErrorLine', role: 'alert' }, appliedNotice)
          : applied === 'reloaded'
            ? h('div', { className: 'MikufanMcpAppliedLine', role: 'status' }, translate('mcp.applied.reloaded', '已同步到运行中的 Harness（立即生效）。'))
            : null,
      );
    }

    /**
     * One labeled dialog field; `wide` spans both grid columns. The control
     * travels in the `content` prop (not `children`): this client half's
     * element stub carries children outside `props`, so a component cannot
     * read its own children.
     */
    function McpField(props) {
      const { label, hint, wide, content } = props;
      return h(
        'div',
        { className: 'MikufanMcpField' + (wide ? ' MikufanMcpFieldSpan' : '') },
        h('span', { className: 'MikufanMcpFieldLabel' }, label),
        content,
        typeof hint === 'string' && hint !== '' ? h('span', { className: 'MikufanMcpFieldHint' }, hint) : null,
      );
    }

    /**
     * Parse one `KEY = value` per line (or `{ "KEY": "value", … }`) table.
     * Values run to the separator or end of line; surrounding quotes are
     * optional and stripped, so `DEBUG = 1`, `KEY = "value"` and an inline
     * `{ "A": "b" }` all parse — a word with no `=` (or an empty value) fails.
     */
    function parseStringTable(raw) {
      const text = String(raw ?? '').trim();
      if (text === '') return { ok: true, value: {} };
      const inline = /^\{[\s\S]*\}$/.test(text) ? text.slice(1, -1) : text;
      const value = {};
      const pattern = /["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*["']?([^;"']*)["']?/g;
      let match;
      while ((match = pattern.exec(inline)) !== null) {
        const key = match[1].trim();
        const item = match[2].trim();
        if (key !== '' && item !== '') value[key] = item;
      }
      if (Object.keys(value).length === 0) return { ok: false };
      return { ok: true, value };
    }

    /** Parse one whitespace-separated list of bare words. */
    function parseWordList(raw) {
      const words = String(raw ?? '')
        .split(/[\s,]+/)
        .filter((word) => word !== '');
      return words.length > 0 ? { ok: true, value: words } : { ok: true, value: [] };
    }

    /** Parse one newline-separated list of bare words (env_vars / args). */
    function parseLineList(raw) {
      const words = String(raw ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
      return words.length > 0 ? { ok: true, value: words } : { ok: true, value: [] };
    }

    /** Parse one optional positive float (the two timeout fields). */
    function parseTimeout(raw) {
      const text = String(raw ?? '').trim();
      if (text === '') return { ok: true, value: undefined };
      const value = Number(text);
      if (!Number.isFinite(value) || value <= 0 || value > 600) return { ok: false };
      return { ok: true, value };
    }

    /**
     * The create/edit dialog: the memory dialog's idiom carrying the Codex
     * fields — name, transport chips, the per-transport block (stdio:
     * command/args/env/env_vars/cwd; streamable_http:
     * url/bearer_token_env_var/http_headers), the two timeouts, and a
     * `Ctrl/Cmd+Enter` save. Blank optional fields are dropped on save.
     */
    function McpDialog(props) {
      const { mode, server, translate, onClose } = props;
      const editing = mode === 'edit' && server !== null && server !== undefined;
      const isStdio = editing ? server.transport === 'stdio' : true;
      const [name, setName] = useState(editing ? server.name : '');
      const [transport, setTransport] = useState(isStdio ? 'stdio' : 'streamable_http');
      const [command, setCommand] = useState(editing && server.command ? server.command : '');
      const [args, setArgs] = useState(editing && Array.isArray(server.args) ? server.args.join(' ') : '');
      const [env, setEnv] = useState(editing && server.env ? mcpFormatTable(server.env) : '');
      const [envVars, setEnvVars] = useState(editing && Array.isArray(server.env_vars) ? server.env_vars.join('\n') : '');
      const [cwd, setCwd] = useState(editing && typeof server.cwd === 'string' ? server.cwd : '');
      const [url, setUrl] = useState(editing && typeof server.url === 'string' ? server.url : '');
      const [bearer, setBearer] = useState(editing && typeof server.bearer_token_env_var === 'string' ? server.bearer_token_env_var : '');
      const [headers, setHeaders] = useState(editing && server.http_headers ? mcpFormatTable(server.http_headers) : '');
      const [startupTimeout, setStartupTimeout] = useState(editing && typeof server.startup_timeout_sec === 'number' ? String(server.startup_timeout_sec) : '');
      const [toolTimeout, setToolTimeout] = useState(editing && typeof server.tool_timeout_sec === 'number' ? String(server.tool_timeout_sec) : '');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [touched, setTouched] = useState(false);

      const nameOk = MCP_NAME_PATTERN.test(name.trim());
      const commandOk = transport !== 'stdio' || command.trim() !== '';
      const urlOk = transport === 'stdio' || /^https?:\/\//i.test(url.trim());
      const tableOk = (raw) => parseStringTable(raw).ok;
      const timeoutOk = (raw) => parseTimeout(raw).ok;
      const draft = () => {
        const payload = { name: name.trim(), transport };
        if (transport === 'stdio') {
          payload.command = command.trim();
          const argList = parseWordList(args);
          if (argList.value.length > 0) payload.args = argList.value;
          const envTable = parseStringTable(env);
          if (Object.keys(envTable.value ?? {}).length > 0) payload.env = envTable.value;
          const varList = parseLineList(envVars);
          if (varList.value.length > 0) payload.env_vars = varList.value;
          const directory = cwd.trim();
          if (directory !== '') payload.cwd = directory;
        } else {
          payload.url = url.trim();
          const token = bearer.trim();
          if (token !== '') payload.bearer_token_env_var = token;
          const headerTable = parseStringTable(headers);
          if (Object.keys(headerTable.value ?? {}).length > 0) payload.http_headers = headerTable.value;
        }
        const startup = parseTimeout(startupTimeout);
        if (startup.value !== undefined) payload.startup_timeout_sec = startup.value;
        const tool = parseTimeout(toolTimeout);
        if (tool.value !== undefined) payload.tool_timeout_sec = tool.value;
        return payload;
      };
      const canSave = !busy && nameOk && commandOk && urlOk && tableOk(env) && tableOk(headers) && timeoutOk(startupTimeout) && timeoutOk(toolTimeout);
      const title = editing ? translate('mcp.edit.title', '编辑 MCP 服务器') : translate('mcp.new.title', '添加 MCP 服务器');
      const description = editing
        ? translate('mcp.edit.desc', '字段与 Codex 的 [mcp_servers.<名称>] 一致，保存后写入 mcp.json。')
        : translate('mcp.new.desc', '按 ChatGPT/Codex 的 mcp_servers 标准填写；保存后可在详情里复制配置。');

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!busy) onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          const root = memoryDialogElement;
          if (root === null || typeof root.querySelectorAll !== 'function') return;
          const items = [...root.querySelectorAll(MEMORY_FOCUSABLE)];
          if (items.length === 0) return;
          const first = items[0];
          const last = items[items.length - 1];
          const active = document.activeElement;
          const inside = active !== null && typeof root.contains === 'function' && root.contains(active);
          if (event.shiftKey && (!inside || active === first)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (!inside || active === last)) {
            event.preventDefault();
            first.focus();
          }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [busy, onClose]);

      useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
          document.body.style.overflow = previousOverflow;
          memoryDialogElement = null;
          const target = memoryDialogReturnFocus;
          memoryDialogReturnFocus = null;
          if (target !== null && target !== undefined && typeof target.focus === 'function' && target.isConnected !== false) {
            target.focus();
          }
        };
      }, []);

      const save = () => {
        setTouched(true);
        if (!canSave) return;
        setBusy(true);
        setError('');
        const payload = draft();
        const operation = editing ? updateMcpViaHost(server.name, payload) : createMcpViaHost(payload);
        Promise.resolve(operation)
          .then(() => onClose())
          .catch((cause) => setError(memoryErrorText(translate, cause)))
          .finally(() => setBusy(false));
      };

      let pressedOnBackdrop = false;
      const dialog = h(
        'div',
        {
          className: 'MikufanMcpMask',
          onMouseDown: (event) => {
            pressedOnBackdrop = event.target === event.currentTarget;
          },
          onClick: (event) => {
            const startedOnBackdrop = pressedOnBackdrop;
            pressedOnBackdrop = false;
            if (startedOnBackdrop && event.target === event.currentTarget && !busy) onClose();
          },
        },
        h(
          'div',
          {
            className: 'MikufanMcpDialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'mikufan-mcp-dialog-title',
            ref: (node) => {
              memoryDialogElement = node;
            },
          },
          h(
            'div',
            { className: 'MikufanMcpDialogHead' },
            h(
              'div',
              { className: 'MikufanMcpDialogHeadText' },
              h('h2', { className: 'MikufanMcpDialogTitle', id: 'mikufan-mcp-dialog-title' }, title),
              h('p', { className: 'MikufanMcpDialogDesc' }, description),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'MikufanMemClose',
                title: translate('mcp.close', '关闭'),
                'aria-label': translate('mcp.close', '关闭'),
                disabled: busy,
                onClick: onClose,
              },
              h(CrossIcon, null),
            ),
          ),
          h(
            'div',
            { className: 'MikufanMcpFieldGrid' },
            h(McpField, {
              label: translate('mcp.field.name', '名称'),
              hint: translate('mcp.field.name.hint', '1–32 位字母、数字、_ 或 -；对应 [mcp_servers.<名称>]'),
              content: h('input', {
                className: 'MikufanMcpInput',
                value: name,
                placeholder: 'github',
                autoFocus: true,
                spellCheck: false,
                maxLength: 32,
                'data-over': touched && !nameOk ? 'true' : 'false',
                disabled: busy,
                onChange: (event) => setName(event.target.value),
              }),
            }),
            h(McpField, {
              label: translate('mcp.field.transport', '传输方式'),
              content: h(
                'div',
                { className: 'MikufanMcpTypes', role: 'radiogroup', 'aria-label': translate('mcp.field.transport', '传输方式') },
                MCP_TRANSPORT_KEYS.map((candidate) =>
                  h(
                    'button',
                    {
                      key: candidate,
                      type: 'button',
                      role: 'radio',
                      className: 'MikufanMcpTypeChip',
                      'aria-checked': transport === candidate,
                      'data-transport': candidate,
                      disabled: busy,
                      onClick: () => setTransport(candidate),
                    },
                    mcpTransportLabel(translate, { transport: candidate }),
                  ),
                ),
              ),
            }),
            transport === 'stdio'
              ? h(McpField, {
                  label: translate('mcp.field.command', '命令'),
                  hint: translate('mcp.field.command.hint', '启动服务器的可执行文件，例如 npx 或 python'),
                  content: h('input', {
                    className: 'MikufanMcpInput',
                    value: command,
                    placeholder: 'npx',
                    spellCheck: false,
                    'data-over': touched && !commandOk ? 'true' : 'false',
                    disabled: busy,
                    onChange: (event) => setCommand(event.target.value),
                  }),
                })
              : h(McpField, {
                  label: translate('mcp.field.url', 'URL'),
                  hint: translate('mcp.field.url.hint', 'Streamable HTTP 端点地址'),
                  content: h('input', {
                    className: 'MikufanMcpInput',
                    value: url,
                    placeholder: 'https://api.example.com/mcp/',
                    spellCheck: false,
                    'data-over': touched && !urlOk ? 'true' : 'false',
                    disabled: busy,
                    onChange: (event) => setUrl(event.target.value),
                  }),
                }),
            transport === 'stdio'
              ? h(McpField, {
                  label: translate('mcp.field.args', '参数'),
                  hint: translate('mcp.field.args.hint', '空格分隔；含空格的参数用引号包裹'),
                  content: h('input', {
                    className: 'MikufanMcpInput',
                    value: args,
                    placeholder: '-y @modelcontextprotocol/server-github',
                    spellCheck: false,
                    disabled: busy,
                    onChange: (event) => setArgs(event.target.value),
                  }),
                })
              : h(McpField, {
                  label: translate('mcp.field.bearer', 'Bearer 令牌环境变量'),
                  hint: translate('mcp.field.bearer.hint', '只填变量名（如 GITHUB_TOKEN），令牌值本身不落盘'),
                  content: h('input', {
                    className: 'MikufanMcpInput',
                    value: bearer,
                    placeholder: 'GITHUB_TOKEN',
                    spellCheck: false,
                    disabled: busy,
                    onChange: (event) => setBearer(event.target.value),
                  }),
                }),
            transport === 'stdio'
              ? h(McpField, {
                  label: translate('mcp.field.envVars', '转发环境变量'),
                  hint: translate('mcp.field.envVars.hint', '每行一个变量名；从本机环境原样转发'),
                  content: h('textarea', {
                    className: 'MikufanMcpTextarea',
                    value: envVars,
                    placeholder: 'GITHUB_TOKEN\nGITHUB_HOST',
                    spellCheck: false,
                    disabled: busy,
                    onChange: (event) => setEnvVars(event.target.value),
                  }),
                })
              : null,
            transport === 'stdio'
              ? h(McpField, {
                  label: translate('mcp.field.env', '附加环境变量'),
                  hint: translate('mcp.field.env.hint', '每行 KEY = value；复制进服务器进程'),
                  content: h('textarea', {
                    className: 'MikufanMcpTextarea',
                    value: env,
                    placeholder: 'DEBUG = 1',
                    spellCheck: false,
                    'data-over': touched && !tableOk(env) ? 'true' : 'false',
                    disabled: busy,
                    onChange: (event) => setEnv(event.target.value),
                  }),
                })
              : h(McpField, {
                  label: translate('mcp.field.headers', '附加请求头'),
                  hint: translate('mcp.field.headers.hint', '每行 NAME = value；随请求发送'),
                  content: h('textarea', {
                    className: 'MikufanMcpTextarea',
                    value: headers,
                    placeholder: 'X-Example = value',
                    spellCheck: false,
                    'data-over': touched && !tableOk(headers) ? 'true' : 'false',
                    disabled: busy,
                    onChange: (event) => setHeaders(event.target.value),
                  }),
                }),
            transport === 'stdio'
              ? h(McpField, {
                  label: translate('mcp.field.cwd', '工作目录'),
                  hint: translate('mcp.field.cwd.hint', '可选；服务器的启动目录'),
                  content: h('input', {
                    className: 'MikufanMcpInput',
                    value: cwd,
                    placeholder: 'D:\\path\\to\\server',
                    spellCheck: false,
                    disabled: busy,
                    onChange: (event) => setCwd(event.target.value),
                  }),
                })
              : null,
            h(McpField, {
              label: translate('mcp.field.startupTimeout', '启动超时（秒）'),
              hint: translate('mcp.field.startupTimeout.hint', '默认 10'),
              content: h('input', {
                className: 'MikufanMcpInput',
                value: startupTimeout,
                placeholder: '10',
                inputMode: 'decimal',
                'data-over': touched && !timeoutOk(startupTimeout) ? 'true' : 'false',
                disabled: busy,
                onChange: (event) => setStartupTimeout(event.target.value),
              }),
            }),
            h(McpField, {
              label: translate('mcp.field.toolTimeout', '工具超时（秒）'),
              hint: translate('mcp.field.toolTimeout.hint', '默认 60'),
              content: h('input', {
                className: 'MikufanMcpInput',
                value: toolTimeout,
                placeholder: '60',
                inputMode: 'decimal',
                'data-over': touched && !timeoutOk(toolTimeout) ? 'true' : 'false',
                disabled: busy,
                onChange: (event) => setToolTimeout(event.target.value),
              }),
            }),
          ),
          touched && !nameOk
            ? h('div', { className: 'MikufanMcpError', role: 'alert' }, translate('mcp.error.name', '名称需为 1–32 位字母、数字、_ 或 -。'))
            : touched && !commandOk
              ? h('div', { className: 'MikufanMcpError', role: 'alert' }, translate('mcp.error.command', 'stdio 服务器需要填写命令。'))
              : touched && !urlOk
                ? h('div', { className: 'MikufanMcpError', role: 'alert' }, translate('mcp.error.url', 'URL 必须以 http:// 或 https:// 开头。'))
                : touched && (!tableOk(env) || !tableOk(headers))
                  ? h('div', { className: 'MikufanMcpError', role: 'alert' }, translate('mcp.error.table', '键值表每行写 NAME = value。'))
                  : touched && (!timeoutOk(startupTimeout) || !timeoutOk(toolTimeout))
                    ? h('div', { className: 'MikufanMcpError', role: 'alert' }, translate('mcp.error.timeout', '超时必须是 0–600 之间的秒数。'))
                    : null,
          error !== '' ? h('div', { className: 'MikufanMcpError', role: 'alert' }, error) : null,
          h(
            'div',
            { className: 'MikufanMcpDialogFoot' },
            h(
              'button',
              { type: 'button', className: 'MikufanMemBtn', disabled: busy, onClick: onClose },
              translate('memory.cancel', '取消'),
            ),
            h(
              'button',
              { type: 'button', className: 'MikufanMemBtn MikufanMemBtnPrimary', disabled: !canSave, onClick: save },
              editing ? translate('memory.save', '保存') : translate('memory.create', '创建'),
            ),
          ),
        ),
      );

      const canPortal =
        typeof document !== 'undefined' && ReactDOM !== undefined && typeof ReactDOM.createPortal === 'function';
      return canPortal ? ReactDOM.createPortal(dialog, document.body) : dialog;
    }

    /** Render the `KEY = value` rows of one table for the textarea placeholders. */
    function mcpFormatTable(table) {
      return Object.entries(table ?? {})
        .map(([key, value]) => `${key} = ${value}`)
        .join('\n');
    }

    /** TOML value writer for the detail overlay: strings quoted, arrays inline. */
    function mcpTomlValue(value) {
      if (Array.isArray(value)) return `[${value.map((item) => mcpTomlValue(item)).join(', ')}]`;
      if (value === true) return 'true';
      if (value === false) return 'false';
      if (typeof value === 'number') return String(value);
      return JSON.stringify(String(value));
    }

    /**
     * The Codex TOML block for one server — the exact `[mcp_servers.<name>]`
     * table the ChatGPT desktop app, the Codex CLI and the IDE extension read.
     */
    function mcpCodexToml(server) {
      const lines = [`[${'mcp_servers'}.${server.name}]`];
      if (server.enabled === false) lines.push('enabled = false');
      for (const key of ['command', 'url']) {
        if (typeof server[key] === 'string') lines.push(`${key} = ${mcpTomlValue(server[key])}`);
      }
      if (Array.isArray(server.args) && server.args.length > 0) lines.push(`args = ${mcpTomlValue(server.args)}`);
      if (server.env && Object.keys(server.env).length > 0) lines.push(`env = { ${Object.entries(server.env).map(([key, value]) => `${JSON.stringify(key)} = ${mcpTomlValue(value)}`).join(', ')} }`);
      if (Array.isArray(server.env_vars) && server.env_vars.length > 0) lines.push(`env_vars = ${mcpTomlValue(server.env_vars)}`);
      if (typeof server.cwd === 'string') lines.push(`cwd = ${mcpTomlValue(server.cwd)}`);
      if (typeof server.bearer_token_env_var === 'string') lines.push(`bearer_token_env_var = ${mcpTomlValue(server.bearer_token_env_var)}`);
      if (server.http_headers && Object.keys(server.http_headers).length > 0) lines.push(`http_headers = { ${Object.entries(server.http_headers).map(([key, value]) => `${JSON.stringify(key)} = ${mcpTomlValue(value)}`).join(', ')} }`);
      if (typeof server.startup_timeout_sec === 'number') lines.push(`startup_timeout_sec = ${server.startup_timeout_sec}`);
      if (typeof server.tool_timeout_sec === 'number') lines.push(`tool_timeout_sec = ${server.tool_timeout_sec}`);
      return lines.join('\n');
    }

    /** The equivalent `@deepseek-ai/dsh-mcp-client` entry for this profile's cordis patch. */
    function mcpDshYaml(server) {
      const lines = ['- id: mcp-' + server.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'), "  name: '@deepseek-ai/dsh-mcp-client'", '  config:'];
      lines.push(`    serverName: ${server.name}`);
      lines.push(`    transport: ${server.transport === 'streamable_http' ? 'streamable-http' : 'stdio'}`);
      if (server.transport === 'stdio') {
        lines.push(`    command: ${JSON.stringify(server.command)}`);
        if (Array.isArray(server.args) && server.args.length > 0) {
          lines.push('    args:');
          for (const item of server.args) lines.push(`      - ${JSON.stringify(item)}`);
        }
        if (server.env && Object.keys(server.env).length > 0) {
          lines.push('    env:');
          for (const [key, value] of Object.entries(server.env)) lines.push(`      ${key}: ${JSON.stringify(value)}`);
        }
      } else {
        lines.push(`    url: ${JSON.stringify(server.url)}`);
        if (server.http_headers && Object.keys(server.http_headers).length > 0) {
          lines.push('    headers:');
          for (const [key, value] of Object.entries(server.http_headers)) lines.push(`      ${key}: ${JSON.stringify(value)}`);
        }
      }
      if (typeof server.tool_timeout_sec === 'number') lines.push(`    toolCallTimeoutMs: ${Math.round(server.tool_timeout_sec * 1000)}`);
      return lines.join('\n');
    }

    /** Copy one snippet and flip the copied flag back after a moment. */
    function useCopyFlash() {
      const [copied, setCopied] = useState('');
      const copy = (event, key, text) => {
        event.stopPropagation();
        const finish = () => {
          setTimeout(() => setCopied(''), 1600);
        };
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            navigator.clipboard
              .writeText(text)
              .then(() => {
                setCopied(key);
                finish();
              })
              .catch(() => finish());
            return;
          }
        } catch {
          /* clipboard unavailable: stay silent */
        }
        setCopied(key);
        finish();
      };
      return [copied, copy];
    }

    /**
     * The detail overlay: the reference sketch's header/body/footer shell.
     * The body shows the Codex TOML and the dsh-mcp-client YAML snippets with
     * copy buttons; the footer is 删除 (two-step) and 关闭.
     */
    function McpDetailOverlay(props) {
      const { server, translate, onClose, onDelete } = props;
      const [armed, setArmed] = useState(false);
      const [copied, copy] = useCopyFlash();

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          const root = memoryDialogElement;
          if (root === null || typeof root.querySelectorAll !== 'function') return;
          const items = [...root.querySelectorAll(MEMORY_FOCUSABLE)];
          if (items.length === 0) return;
          const first = items[0];
          const last = items[items.length - 1];
          const active = document.activeElement;
          const inside = active !== null && typeof root.contains === 'function' && root.contains(active);
          if (event.shiftKey && (!inside || active === first)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (!inside || active === last)) {
            event.preventDefault();
            first.focus();
          }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [onClose]);

      useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
          document.body.style.overflow = previousOverflow;
          memoryDialogElement = null;
          const target = memoryDialogReturnFocus;
          memoryDialogReturnFocus = null;
          if (target !== null && target !== undefined && typeof target.focus === 'function' && target.isConnected !== false) {
            target.focus();
          }
        };
      }, []);

      const toml = mcpCodexToml(server);
      const yaml = mcpDshYaml(server);
      let pressedOnBackdrop = false;
      const overlay = h(
        'div',
        {
          className: 'MikufanMcpMask',
          onMouseDown: (event) => {
            pressedOnBackdrop = event.target === event.currentTarget;
          },
          onClick: (event) => {
            const startedOnBackdrop = pressedOnBackdrop;
            pressedOnBackdrop = false;
            if (startedOnBackdrop && event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          {
            className: 'MikufanMcpDetail',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'mikufan-mcp-detail-title',
            ref: (node) => {
              memoryDialogElement = node;
            },
          },
          h(
            'div',
            { className: 'MikufanMcpDetailHead' },
            h(
              'div',
              { className: 'MikufanMcpDetailText' },
              h('h2', { className: 'MikufanMcpDetailTitle', id: 'mikufan-mcp-detail-title' }, server.name),
              h('p', { className: 'MikufanMcpDetailDesc' }, mcpTransportLabel(translate, server)),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'MikufanMemClose',
                title: translate('mcp.close', '关闭'),
                'aria-label': translate('mcp.close', '关闭'),
                onClick: onClose,
              },
              h(CrossIcon, null),
            ),
          ),
          h(
            'div',
            { className: 'MikufanMcpDetailBody' },
            h(
              'div',
              { className: 'MikufanMcpCodeHead' },
              h('span', { className: 'MikufanMcpCodeTitle' }, translate('mcp.detail.codex', 'Codex / ChatGPT（config.toml）')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'MikufanMcpCopyButton',
                  onClick: (event) => copy(event, 'toml', toml),
                },
                copied === 'toml' ? translate('mcp.detail.copied', '已复制') : translate('mcp.detail.copy', '复制'),
              ),
            ),
            h('pre', { className: 'MikufanMdPre' }, toml),
            h(
              'div',
              { className: 'MikufanMcpCodeHead' },
              h('span', { className: 'MikufanMcpCodeTitle' }, translate('mcp.detail.dsh', '本机 Harness（cordis.patch.yml 条目）')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'MikufanMcpCopyButton',
                  onClick: (event) => copy(event, 'yaml', yaml),
                },
                copied === 'yaml' ? translate('mcp.detail.copied', '已复制') : translate('mcp.detail.copy', '复制'),
              ),
            ),
            h('pre', { className: 'MikufanMdPre' }, yaml),
          ),
          h(
            'div',
            { className: 'MikufanMcpDetailFoot' },
            h(
              'button',
              {
                type: 'button',
                className: `MikufanMcpDangerButton${armed ? ' MikufanMcpActionArmed' : ''}`,
                onClick: () => {
                  if (!armed) {
                    setArmed(true);
                    return;
                  }
                  setArmed(false);
                  onDelete(server);
                },
              },
              armed ? translate('mcp.confirmDelete', '确认删除') : translate('mcp.delete', '删除'),
            ),
            h(
              'button',
              { type: 'button', className: 'MikufanMcpDangerButton', onClick: onClose },
              translate('mcp.close', '关闭'),
            ),
          ),
        ),
      );

      const canPortal =
        typeof document !== 'undefined' && ReactDOM !== undefined && typeof ReactDOM.createPortal === 'function';
      return canPortal ? ReactDOM.createPortal(overlay, document.body) : overlay;
    }

    /**
     * The MCP page: the card grid in the dashboard's own idiom — first card
     * the blank "+" card, one card per configured server, the count row with
     * search and refresh on the right.
     */
    function McpPageBody({ translate }) {
      const servers = useSyncExternalStore(subscribeMcp, getMcpServers);
      const loaded = useSyncExternalStore(subscribeMcp, isMcpLoaded);
      const readFailed = useSyncExternalStore(subscribeMcp, isMcpReadFailed);
      /** `null` while closed, else `{ mode: 'create' }` or `{ mode: 'edit', name }`. */
      const [dialog, setDialog] = useState(null);
      /** The open detail overlay's server name, or null. */
      const [detailName, setDetailName] = useState(null);
      /** What the bar's search field filters the cards by. */
      const [query, setQuery] = useState('');
      /** A manual refresh is in flight. */
      const [refreshing, setRefreshing] = useState(false);

      useEffect(() => {
        hydrateMcp();
      }, []);

      const enabledCount = servers.filter((server) => server.enabled).length;
      const needle = query.trim().toLowerCase();
      const visible =
        needle === ''
          ? servers
          : servers.filter((server) =>
              [server.name, server.transport, server.command ?? '', server.url ?? '', server.cwd ?? '']
                .join('\n')
                .toLowerCase()
                .includes(needle),
            );
      const searching = needle !== '';

      const onRefresh = () => {
        if (refreshing) return;
        setRefreshing(true);
        void adoptHostMcp()
          .then((ok) => {
            if (ok) return;
            mcpReadGaveUp = true;
            emitMcp();
          })
          .finally(() => setRefreshing(false));
      };
      const openCreate = () => {
        rememberDialogOpener();
        setDialog({ mode: 'create' });
      };
      const openEdit = (server) => {
        rememberDialogOpener();
        setDialog({ mode: 'edit', name: server.name });
      };
      const closeDialog = () => setDialog(null);
      const editingServer = dialog !== null && dialog.mode === 'edit' ? (servers.find((server) => server.name === dialog.name) ?? null) : null;
      const detailServer = detailName === null ? null : (servers.find((server) => server.name === detailName) ?? null);

      return h(
        'div',
        { role: 'tabpanel', 'aria-label': translate('control.panel.tab.mcp', 'MCP') },
        h(PageHead, {
          translate,
          titleKey: 'mcp.tab.title',
          fallbackTitle: 'MCP',
          subtitleKey: 'mcp.tab.subtitle',
          fallbackSubtitle: '配置 Model Context Protocol 服务器连接。',
        }),
        h(
          'div',
          { className: 'MikufanMcpPanel' },
          readFailed
            ? h('div', { className: 'MikufanMemoryNotice', role: 'alert' }, translate('mcp.readFailed', 'MCP 服务器列表读取失败，请刷新页面重试。'))
            : null,
          loaded && servers.length > 0
            ? h(
                'div',
                { className: 'MikufanMcpBar' },
                h(
                  'span',
                  { className: 'MikufanMcpBarRoot' },
                  formatTemplate(translate('mcp.count', '共 {count} 个服务器 · {enabled} 个启用'), {
                    count: servers.length,
                    enabled: enabledCount,
                  }) +
                    (searching
                      ? formatTemplate(translate('mcp.bar.matched', ' · 匹配 {count}'), { count: visible.length })
                      : '') +
                    ` · ${MCP_DOC_DISPLAY}`,
                ),
                h(
                  'div',
                  { className: 'MikufanMcpTools' },
                  h(
                    'label',
                    { className: 'MikufanMemSearch' },
                    h('span', { className: 'MikufanMemSearchIcon' }, h(SearchIcon, null)),
                    h('input', {
                      type: 'search',
                      className: 'MikufanMemSearchInput',
                      value: query,
                      placeholder: translate('mcp.search.placeholder', '搜索服务器'),
                      'aria-label': translate('mcp.search.label', '搜索服务器'),
                      spellCheck: false,
                      onChange: (event) => setQuery(event.target.value),
                    }),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'MikufanMemRefresh',
                      'data-busy': refreshing ? 'true' : 'false',
                      title: translate('mcp.refresh', '刷新服务器列表'),
                      'aria-label': translate('mcp.refresh', '刷新服务器列表'),
                      disabled: refreshing,
                      onClick: onRefresh,
                    },
                    h(RefreshIcon, null),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'MikufanMcpGroup', 'data-empty': !loaded || servers.length === 0 ? 'true' : 'false' },
            h(MemoryAddCard, {
              key: '__add__',
              translate,
              onClick: openCreate,
              labelKey: 'mcp.add',
              fallbackLabel: '添加服务器',
              hintKey: 'mcp.add.hint',
              fallbackHint: '按 ChatGPT/Codex 的 mcp_servers 标准新增',
            }),
            loaded ? visible.map((server) => h(McpCard, { key: server.name, server, translate, onEdit: openEdit, onDetails: (item) => setDetailName(item.name) })) : null,
          ),
          loaded && servers.length === 0
            ? h('div', { className: 'MikufanMcpEmpty' }, translate('mcp.empty', '还没有 MCP 服务器。点击上方卡片，按 Codex 标准添加第一个。'))
            : loaded && searching && visible.length === 0
              ? h('div', { className: 'MikufanMcpEmpty' }, translate('mcp.empty.search', '没有匹配的服务器。'))
              : null,
          dialog !== null && dialog.mode === 'create'
            ? h(McpDialog, { key: 'create', mode: 'create', server: null, translate, onClose: closeDialog })
            : editingServer !== null
              ? h(McpDialog, {
                  key: `edit:${editingServer.name}`,
                  mode: 'edit',
                  server: editingServer,
                  translate,
                  onClose: closeDialog,
                })
              : null,
          detailServer !== null
            ? h(McpDetailOverlay, {
                key: `detail:${detailServer.name}`,
                server: detailServer,
                translate,
                onClose: () => setDetailName(null),
                onDelete: (server) => {
                  setDetailName(null);
                  void deleteMcpViaHost(server.name).catch(() => {});
                },
              })
            : null,
        ),
      );
    }

    /** 14px panel glyph for the card's 打开 action. */
    function PanelOpenIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 2.2, y: 3.2, width: 11.6, height: 9.6, rx: 1.4 }),
        h('path', { d: 'M8.6 2.2h5.2v5.2' }),
        h('path', { d: 'M9.4 6.6 13.8 2.2' }),
      );
    }

    /** 14px info glyph for the card's 详情 action. */
    function InfoIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 5.8 }),
        h('path', { d: 'M8 7.2v4' }),
        h('path', { d: 'M8 5.1v.1' }),
      );
    }

    /** 16px three-dot glyph for the detail header's menu. */
    function DotsIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
        h('circle', { cx: 3.4, cy: 8, r: 1.2 }),
        h('circle', { cx: 8, cy: 8, r: 1.2 }),
        h('circle', { cx: 12.6, cy: 8, r: 1.2 }),
      );
    }

    /** Render one inline Markdown run: `code`, **bold** and plain text. */
    function renderInline(text, keyPrefix) {
      const nodes = [];
      const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
      let last = 0;
      let index = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        index += 1;
        const token = match[0];
        if (token.startsWith('`')) {
          nodes.push(h('code', { key: `${keyPrefix}-c${index}`, className: 'MikufanMdCode' }, token.slice(1, -1)));
        } else {
          nodes.push(h('strong', { key: `${keyPrefix}-b${index}` }, token.slice(2, -2)));
        }
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    /**
     * A deliberately small Markdown renderer for one SKILL.md body: headings,
     * paragraphs, lists, quotes, fenced code and horizontal rules. The panel
     * cannot import a Markdown package, and this is the whole subset the skill
     * instructions use.
     * @param markdown - body text.
     * @returns React nodes.
     */
    function renderMarkdown(markdown) {
      const lines = String(markdown ?? '').split(/\r?\n/);
      const blocks = [];
      let cursor = 0;
      let seq = 0;
      const nextKey = () => {
        seq += 1;
        return `md-${seq}`;
      };
      const isFence = (line) => /^\s*```/.test(line);
      const isHeading = (line) => /^#{1,6}\s+/.test(line);
      const isList = (line) => /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
      const isQuote = (line) => /^\s*>/.test(line);
      while (cursor < lines.length) {
        const line = lines[cursor];
        if (line.trim() === '') {
          cursor += 1;
          continue;
        }
        if (isFence(line)) {
          const code = [];
          cursor += 1;
          while (cursor < lines.length && !isFence(lines[cursor])) {
            code.push(lines[cursor]);
            cursor += 1;
          }
          cursor += 1;
          blocks.push(h('pre', { key: nextKey(), className: 'MikufanMdPre' }, code.join('\n')));
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading !== null) {
          const level = Math.min(heading[1].length, 4);
          blocks.push(
            h(`h${level}`, { key: nextKey(), className: `MikufanMdH${level}` }, renderInline(heading[2], nextKey())),
          );
          cursor += 1;
          continue;
        }
        if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
          blocks.push(h('hr', { key: nextKey(), className: 'MikufanMdHr' }));
          cursor += 1;
          continue;
        }
        if (isQuote(line)) {
          const quote = [];
          while (cursor < lines.length && isQuote(lines[cursor])) {
            quote.push(lines[cursor].replace(/^\s*>\s?/, ''));
            cursor += 1;
          }
          blocks.push(h('blockquote', { key: nextKey(), className: 'MikufanMdQuote' }, renderInline(quote.join(' '), nextKey())));
          continue;
        }
        if (isList(line)) {
          const ordered = /^\s*\d+\./.test(line);
          const items = [];
          while (cursor < lines.length && isList(lines[cursor])) {
            items.push(lines[cursor].replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
            cursor += 1;
          }
          blocks.push(
            h(
              ordered ? 'ol' : 'ul',
              { key: nextKey(), className: 'MikufanMdList' },
              items.map((item) => h('li', { key: nextKey(), className: 'MikufanMdItem' }, renderInline(item, nextKey()))),
            ),
          );
          continue;
        }
        const paragraph = [];
        while (
          cursor < lines.length &&
          lines[cursor].trim() !== '' &&
          !isFence(lines[cursor]) &&
          !isHeading(lines[cursor]) &&
          !isList(lines[cursor]) &&
          !isQuote(lines[cursor])
        ) {
          paragraph.push(lines[cursor].trim());
          cursor += 1;
        }
        if (paragraph.length > 0) {
          blocks.push(h('p', { key: nextKey(), className: 'MikufanMdP' }, renderInline(paragraph.join(' '), nextKey())));
        } else {
          cursor += 1;
        }
      }
      return blocks;
    }

    /** One skill card: name, description, enable switch, 打开 / 详情. */
    function SkillCard(props) {
      const { entry, translate, onOpen, onDetails, onToggle } = props;
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const updated = formatMemoryTime(entry.updatedAt);
      const switchLabel = formatTemplate(translate('skills.enabled.switch', '{action}技能：{name}'), {
        action: entry.enabled ? translate('skills.disable', '停用') : translate('skills.enable', '启用'),
        name: entry.name,
      });
      const run = (operation) => {
        if (busy) return;
        setBusy(true);
        setError('');
        Promise.resolve()
          .then(operation)
          .catch((cause) => setError(memoryErrorText(translate, cause)))
          .finally(() => setBusy(false));
      };
      return h(
        'div',
        { className: 'MikufanSkillCard', 'data-disabled': entry.enabled ? 'false' : 'true' },
        h(
          'div',
          { className: 'MikufanSkillCardHead' },
          h('h3', { className: 'MikufanSkillName', title: entry.name }, entry.name),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'MikufanSwitch',
              'aria-checked': entry.enabled,
              'aria-label': switchLabel,
              title: entry.enabled
                ? translate('skills.enabled.on', '已启用（模型可见）')
                : translate('skills.enabled.off', '已停用（保留文件，不进模型目录）'),
              disabled: busy,
              onClick: () => run(() => onToggle(entry, !entry.enabled)),
            },
            h('span', { className: 'MikufanSwitchThumb' }),
          ),
        ),
        h('p', { className: 'MikufanSkillDesc', title: entry.description }, entry.description),
        h(
          'div',
          { className: 'MikufanSkillFoot' },
          h(
            'button',
            { type: 'button', className: 'MikufanSkillAction', disabled: busy, onClick: () => onOpen(entry) },
            h(PanelOpenIcon, null),
            translate('skills.open', '打开'),
          ),
          h(
            'button',
            { type: 'button', className: 'MikufanSkillAction', disabled: busy, onClick: () => onDetails(entry) },
            h(InfoIcon, null),
            translate('skills.details', '详情'),
          ),
          updated !== ''
            ? h('span', { className: 'MikufanSkillUpdated' }, formatTemplate(translate('skills.updated', '更新于 {time}'), { time: updated }))
            : null,
        ),
        error !== '' ? h('div', { className: 'MikufanSkillErrorLine', role: 'alert' }, error) : null,
      );
    }

    /**
     * The skill detail overlay: header (name, description, switch, actions menu,
     * close), the rendered SKILL.md, and the reference footer (卸载 / 立即试用).
     */
    function SkillDetailOverlay(props) {
      const { entry, translate, onClose, onToggle, onTry, onReveal, onUninstall } = props;
      const [detail, setDetail] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [menuOpen, setMenuOpen] = useState(false);
      const [copied, setCopied] = useState(false);
      const [armed, setArmed] = useState(false);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const [toggleBusy, setToggleBusy] = useState(false);
      const [toggleError, setToggleError] = useState('');

      const onToggleClick = () => {
        if (toggleBusy || busy) return;
        setToggleBusy(true);
        setToggleError('');
        Promise.resolve()
          .then(() => onToggle(entry, !entry.enabled))
          .catch((cause) => setToggleError(memoryErrorText(translate, cause)))
          .finally(() => setToggleBusy(false));
      };

      useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError('');
        void readSkillDetail(entry.id)
          .then((value) => {
            if (cancelled) return;
            setDetail(value);
            setLoading(false);
          })
          .catch((cause) => {
            if (cancelled) return;
            setError(String(cause?.message ?? cause));
            setLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, [entry.id]);

      // Escape closes; the menu closes on any outside pointer press.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (menuOpen) setMenuOpen(false);
          else if (!busy) onClose();
        };
        const onPointerDown = (event) => {
          if (menuOpen && typeof event.target?.closest === 'function' && event.target.closest('.MikufanSkillMenuWrap') === null) {
            setMenuOpen(false);
          }
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('mousedown', onPointerDown);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('mousedown', onPointerDown);
        };
      }, [busy, menuOpen, onClose]);

      useEffect(() => {
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
          document.body.style.overflow = previous;
        };
      }, []);

      const markdown = typeof detail?.markdown === 'string' ? detail.markdown : '';
      const onCopy = () => {
        if (markdown === '') return;
        void navigator.clipboard
          ?.writeText(markdown)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => {});
      };
      const useSkill = () => {
        setMenuOpen(false);
        setNotice('');
        if (!onTry(entry)) {
          setNotice(
            formatTemplate(translate('skills.openSession.failed', '无法打开新会话，请手动新建会话并输入 /{name}。'), {
              name: entry.name,
            }),
          );
        }
      };
      const onUninstallClick = () => {
        if (busy) return;
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
          return;
        }
        setArmed(false);
        setBusy(true);
        setError('');
        Promise.resolve(onUninstall(entry.id))
          .then(() => onClose())
          .catch((cause) => setError(memoryErrorText(translate, cause)))
          .finally(() => setBusy(false));
      };

      const mask = h(
        'div',
        {
          className: 'MikufanSkillDetailMask',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onClose();
          },
        },
        h(
          'div',
          {
            className: 'MikufanSkillDetail',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'mikufan-skill-detail-title',
          },
          h(
            'div',
            { className: 'MikufanSkillDetailHead' },
            h(
              'div',
              { className: 'MikufanSkillDetailText' },
              h('h2', { className: 'MikufanSkillDetailTitle', id: 'mikufan-skill-detail-title' }, entry.name),
              h('p', { className: 'MikufanSkillDetailDesc' }, entry.description),
              toggleError !== ''
                ? h('p', { className: 'MikufanSkillErrorLine', role: 'alert' }, toggleError)
                : null,
            ),
            h(
              'div',
              { className: 'MikufanSkillDetailControls' },
              h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  className: 'MikufanSwitch',
                  'aria-checked': entry.enabled,
                  'aria-label': formatTemplate(translate('skills.enabled.switch', '{action}技能：{name}'), {
                    action: entry.enabled ? translate('skills.disable', '停用') : translate('skills.enable', '启用'),
                    name: entry.name,
                  }),
                  disabled: busy || toggleBusy,
                  onClick: onToggleClick,
                },
                h('span', { className: 'MikufanSwitchThumb' }),
              ),
              h(
                'div',
                { className: 'MikufanSkillMenuWrap' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'MikufanSkillIconButton',
                    title: translate('skills.detail.menu', '更多操作'),
                    'aria-label': translate('skills.detail.menu', '更多操作'),
                    'aria-expanded': menuOpen,
                    onClick: () => setMenuOpen((open) => !open),
                  },
                  h(DotsIcon, null),
                ),
                menuOpen
                  ? h(
                      'div',
                      { className: 'MikufanSkillMenu', role: 'menu' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'MikufanSkillMenuItem',
                          role: 'menuitem',
                          onClick: () => {
                            setMenuOpen(false);
                            void onReveal(entry.id);
                          },
                        },
                        translate('skills.detail.reveal', '在文件资源管理器中显示'),
                      ),
                      h(
                        'button',
                        { type: 'button', className: 'MikufanSkillMenuItem', role: 'menuitem', onClick: onCopy },
                        copied ? translate('skills.detail.copied', '已复制') : translate('skills.detail.copy', '复制 Markdown'),
                      ),
                    )
                  : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'MikufanSkillIconButton',
                  title: translate('skills.detail.close', '关闭'),
                  'aria-label': translate('skills.detail.close', '关闭'),
                  disabled: busy,
                  onClick: onClose,
                },
                h(CrossIcon, null),
              ),
            ),
          ),
          h(
            'div',
            { className: 'MikufanSkillDetailBody' },
            loading ? h('p', { className: 'MikufanSkillPreviewHint' }, translate('skills.detail.loading', '读取 SKILL.md…')) : null,
            error !== '' ? h('p', { className: 'MikufanSkillErrorLine', role: 'alert' }, formatTemplate(translate('skills.detail.error', '读取 SKILL.md 失败：{message}'), { message: error })) : null,
            !loading && error === '' ? renderMarkdown(markdown) : null,
            notice !== '' ? h('p', { className: 'MikufanSkillPreviewHint' }, notice) : null,
          ),
          h(
            'div',
            { className: 'MikufanSkillDetailFoot' },
            h(
              'button',
              {
                type: 'button',
                className: `MikufanSkillDangerButton${armed ? ' MikufanSkillDangerButtonArmed' : ''}`,
                disabled: busy,
                onClick: onUninstallClick,
              },
              armed ? translate('skills.detail.confirm', '确认卸载') : translate('skills.detail.uninstall', '卸载'),
            ),
            h(
              'button',
              { type: 'button', className: 'MikufanSkillPrimaryButton', disabled: busy, onClick: useSkill },
              translate('skills.detail.try', '立即试用'),
            ),
          ),
        ),
      );
      const canPortal = typeof document !== 'undefined' && ReactDOM !== undefined && typeof ReactDOM.createPortal === 'function';
      return canPortal ? ReactDOM.createPortal(mask, document.body) : mask;
    }

    /**
     * The right-sidebar tab body that previews one SKILL.md. The tab is opened
     * by kind with `{ params: { skill: id } }`; the body reads the id from the
     * tab's navigation parameters and renders the same Markdown subset.
     */
    function SkillPreviewTab(props) {
      const { translate, useTabInfo } = props;
      const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined;
      const params = info?.tab?.navigation?.params ?? {};
      const skillId = typeof params.skill === 'string' ? params.skill : '';
      const [detail, setDetail] = useState(null);
      const [error, setError] = useState('');
      useEffect(() => {
        if (skillId === '') return undefined;
        let cancelled = false;
        void readSkillDetail(skillId)
          .then((value) => {
            if (!cancelled) setDetail(value);
          })
          .catch((cause) => {
            if (!cancelled) setError(String(cause?.message ?? cause));
          });
        return () => {
          cancelled = true;
        };
      }, [skillId]);
      if (skillId === '') {
        return h('div', { className: 'MikufanSkillPreviewHint' }, translate('skills.preview.missing', '没有要预览的技能。'));
      }
      if (error !== '') {
        return h(
          'div',
          { className: 'MikufanSkillPreviewHint' },
          formatTemplate(translate('skills.detail.error', '读取 SKILL.md 失败：{message}'), { message: error }),
        );
      }
      if (detail === null) {
        return h('div', { className: 'MikufanSkillPreviewHint' }, translate('skills.detail.loading', '读取 SKILL.md…'));
      }
      return h(
        'div',
        { className: 'MikufanSkillPreview' },
        h(
          'div',
          { className: 'MikufanSkillPreviewHead' },
          h('h2', { className: 'MikufanSkillPreviewName' }, detail.entry.name),
          h('p', { className: 'MikufanSkillPreviewSub' }, detail.entry.description),
        ),
        h('div', { className: 'MikufanSkillPreviewBody' }, renderMarkdown(detail.markdown)),
      );
    }

    /** The Skills page: the managed root as cards plus the detail overlay. */
    function SkillsPageBody(props) {
      const { translate, startSkillSession } = props;
      const entries = useSyncExternalStore(subscribeSkills, getSkillEntries);
      const loaded = useSyncExternalStore(subscribeSkills, isSkillsLoaded);
      const readFailed = useSyncExternalStore(subscribeSkills, isSkillsReadFailed);
      const root = useSyncExternalStore(subscribeSkills, getSkillRoot);
      const [detailId, setDetailId] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const [notice, setNotice] = useState('');
      /** What the bar's search field filters the skill cards by. */
      const [query, setQuery] = useState('');

      useEffect(() => {
        hydrateSkills();
        // The bundled skill-creator powers the create card: repair it whenever
        // this page opens. The Host copies only when the directory is missing.
        void restoreBundledSkill()
          .then((value) => {
            if (value?.installed !== true) return undefined;
            setNotice(translate('skills.restore.notice', '已恢复内置技能 skill-creator'));
            return adoptHostSkills();
          })
          .catch(() => {});
      }, []);

      const detailEntry = detailId === null ? null : (entries.find((entry) => entry.id === detailId) ?? null);
      const needle = query.trim().toLowerCase();
      // The search matches the skill name and description (the id is the
      // directory name, so a name query covers it as well).
      const visible =
        needle === ''
          ? entries
          : entries.filter((entry) => [entry.name, entry.description, entry.id].join('\n').toLowerCase().includes(needle));
      const searching = needle !== '';
      const onRefresh = () => {
        if (refreshing) return;
        setRefreshing(true);
        void adoptHostSkills()
          .then((ok) => {
            if (ok) return;
            skillReadGaveUp = true;
            emitSkills();
          })
          .finally(() => setRefreshing(false));
      };
      const onCreate = () => {
        setNotice('');
        // Re-ensure the bundled skill first, so the new session's catalog
        // resolves the /skill-creator reference on its first send. Then open
        // the new session with exactly that reference in the composer — no
        // extra instruction text; skill-creator asks for the rest itself.
        void ensureBundledSkill()
          .then(() => adoptHostSkills())
          .catch(() => {})
          .then(() => {
            const started = startSkillSession(skillReference(SKILL_CREATOR_NAME), { clearPreviousDraft: true });
            if (!started) setNotice(translate('skills.create.failed', '无法打开新会话，请手动新建会话并输入 /skill-creator。'));
          });
      };
      const onUse = (entry) => {
        setNotice('');
        const started = startSkillSession(skillReference(entry.name), { clearPreviousDraft: true });
        if (!started) {
          setNotice(
            formatTemplate(translate('skills.openSession.failed', '无法打开新会话，请手动新建会话并输入 /{name}。'), {
              name: entry.name,
            }),
          );
        }
        return started;
      };
      const onOpen = (entry) => onUse(entry);
      const onToggle = (entry, enabled) => patchSkillViaHost(entry.id, enabled);
      const onTry = (entry) => onUse(entry);
      const onReveal = (id) => {
        void revealSkillViaHost(id).catch(() => {});
      };

      return h(
        'div',
        { role: 'tabpanel', 'aria-label': translate('control.panel.tab.skills', 'Skills') },
        h(PageHead, {
          translate,
          titleKey: 'skills.tab.title',
          fallbackTitle: 'Skills',
          subtitleKey: 'skills.tab.subtitle',
          fallbackSubtitle: '管理助手可用的技能扩展。',
        }),
        h(
          'div',
          { className: 'MikufanSkillPanel' },
          readFailed
            ? h('div', { className: 'MikufanMemoryNotice', role: 'alert' }, translate('skills.readFailed', '技能列表读取失败，请刷新页面重试。'))
            : null,
          notice !== '' ? h('div', { className: 'MikufanMemoryNotice', role: 'status' }, notice) : null,
          loaded && entries.length > 0
            ? h(
                'div',
                { className: 'MikufanSkillBar' },
                h(
                  'span',
                  { className: 'MikufanSkillBarRoot' },
                  formatTemplate(translate('skills.count', '共 {count} 个技能'), { count: entries.length }) +
                    (searching
                      ? formatTemplate(translate('skills.bar.matched', ' · 匹配 {count}'), { count: visible.length })
                      : '') +
                    (root === '' ? '' : ` · ${root}`),
                ),
                h(
                  'div',
                  { className: 'MikufanSkillTools' },
                  h(
                    'label',
                    { className: 'MikufanMemSearch' },
                    h('span', { className: 'MikufanMemSearchIcon' }, h(SearchIcon, null)),
                    h('input', {
                      type: 'search',
                      className: 'MikufanMemSearchInput',
                      value: query,
                      placeholder: translate('skills.search.placeholder', '搜索技能'),
                      'aria-label': translate('skills.search.label', '搜索技能'),
                      spellCheck: false,
                      onChange: (event) => setQuery(event.target.value),
                    }),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'MikufanMemRefresh',
                      'data-busy': refreshing ? 'true' : 'false',
                      title: translate('skills.refresh', '刷新技能列表'),
                      'aria-label': translate('skills.refresh', '刷新技能列表'),
                      disabled: refreshing,
                      onClick: onRefresh,
                    },
                    h(RefreshIcon, null),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'MikufanSkillGroup', 'data-empty': !loaded || entries.length === 0 ? 'true' : 'false' },
            h(MemoryAddCard, {
              key: '__add__',
              translate,
              onClick: onCreate,
              labelKey: 'skills.add',
              fallbackLabel: '新建技能',
              hintKey: 'skills.add.hint',
              fallbackHint: '新建一个只引用 /skill-creator 的会话',
            }),
            loaded
              ? visible.map((entry) =>
                  h(SkillCard, { key: entry.id, entry, translate, onOpen, onDetails: (item) => setDetailId(item.id), onToggle }),
                )
              : null,
          ),
          loaded && entries.length === 0
            ? h('div', { className: 'MikufanSkillEmpty' }, translate('skills.empty', '还没有技能。点击上方卡片，让 Skill Creator 帮你创建一个。'))
            : loaded && searching && visible.length === 0
              ? h('div', { className: 'MikufanSkillEmpty' }, translate('skills.empty.search', '没有匹配的技能。'))
              : null,
          detailEntry !== null
            ? h(SkillDetailOverlay, {
                key: `detail:${detailEntry.id}`,
                entry: detailEntry,
                translate,
                onClose: () => setDetailId(null),
                onToggle,
                onTry,
                onReveal,
                onUninstall: deleteSkillViaHost,
              })
            : null,
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Control panel pages.
    // ---------------------------------------------------------------------

    /** The six pages, in nav order. */
    const CONTROL_TABS = [
      { id: 'dashboard', key: 'control.panel.tab.dashboard', fallback: '主页' },
      { id: 'memory', key: 'control.panel.tab.memory', fallback: '记忆' },
      { id: 'lan', key: 'control.panel.tab.lan', fallback: '局域网访问' },
      { id: 'skills', key: 'control.panel.tab.skills', fallback: 'Skills' },
      { id: 'agent', key: 'control.panel.tab.agent', fallback: 'Agent' },
      { id: 'mcp', key: 'control.panel.tab.mcp', fallback: 'MCP' },
    ];

    /** The last opened page, or the dashboard. */
    function readStoredTab() {
      try {
        const saved = localStorage.getItem(TAB_STORAGE_KEY);
        return CONTROL_TABS.some((tab) => tab.id === saved) ? saved : 'dashboard';
      } catch {
        return 'dashboard';
      }
    }

    function storeTab(id) {
      try {
        localStorage.setItem(TAB_STORAGE_KEY, id);
      } catch {
        /* private mode: the choice just does not persist */
      }
    }

    /** One page heading: title + subtitle. */
    function PageHead({ translate, titleKey, fallbackTitle, subtitleKey, fallbackSubtitle }) {
      return h(
        'div',
        null,
        h('h1', { className: 'MikufanCpTitle' }, translate(titleKey, fallbackTitle)),
        h('p', { className: 'MikufanCpSubtitle' }, translate(subtitleKey, fallbackSubtitle)),
      );
    }

    /** 48px trash glyph for the delete-sessions card. */
    function DeleteIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M10 4h4' }),
        h('path', { d: 'M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12' }),
        h('path', { d: 'M10.2 11v6' }),
        h('path', { d: 'M13.8 11v6' }),
      );
    }

    /**
     * 48px play-ring glyph for the startup-animation card (the user's supplied
     * icon): a broken ring with an inner play triangle, single-color via
     * `currentColor`. The source path is 1024-based; both subpaths keep their
     * original geometry, only the fill color was localized.
     */
    function SplashIcon() {
      return h(
        'svg',
        {
          width: 48,
          height: 48,
          viewBox: '0 0 1024 1024',
          fill: 'none',
          'aria-hidden': true,
        },
        h('path', {
          fill: 'currentColor',
          d: 'M512 128c212.0704 0 384 171.9296 384 384 0 57.9328-12.8256 112.8448-35.7888 162.0992a34.4832 34.4832 0 0 1-31.744 21.1456 34.304 34.304 0 0 1-31.8208-47.104l1.3312-2.8672A314.24 314.24 0 0 0 827.392 512c0-174.208-141.2096-315.4176-315.4176-315.4176S196.5824 337.792 196.5824 512 337.792 827.4176 512 827.4176c52.864 0 102.6816-13.0048 146.432-35.968a34.304 34.304 0 0 1 32.0768 60.5184l0.0768 0.0768A382.336 382.336 0 0 1 512 896c-212.0704 0-384-171.9296-384-384 0-212.0704 171.9296-384 384-384z m-58.7776 195.9168c13.8496 0 27.3408 4.4032 38.5024 12.5952l167.2448 122.5472a65.152 65.152 0 0 1 0 105.088l-167.2448 122.5728a65.152 65.152 0 0 1-103.6288-52.5568v-245.0944a65.152 65.152 0 0 1 65.1264-65.152z m3.4304 71.9104v231.5776l158.0032-115.7888-158.0032-115.7888z',
        }),
      );
    }

    /**
     * 48px brain glyph for the memory card (the user's supplied icon): the
     * two-hemisphere brain, single-color via `currentColor`. The source path
     * is 1024-based; the geometry is unchanged, only the fill color moved to
     * the svg root.
     */
    function MemoryIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 1024 1024', fill: 'currentColor', 'aria-hidden': true },
        h('path', {
          d: 'M303.5392 51.2C387.9168 51.2 457.6 115.1488 468.0448 197.888a18.5344 18.5344 0 0 1 1.3824 6.8096v653.7216a19.6096 19.6096 0 0 1-3.7888 11.4688c-16.384 75.5712-82.7392 132.1472-162.0992 132.1472-91.5968 0-165.888-75.3664-165.888-168.3456l0.256-7.0656a165.2224 165.2224 0 0 1-14.8992-3.328C34.5344 799.232-17.9456 706.8672 5.76 616.96c8.704-32.8704 26.5728-61.2864 50.4832-82.688A169.8816 169.8816 0 0 1 5.7088 364.4416a166.8608 166.8608 0 0 1 133.4272-122.6752 166.0416 166.0416 0 0 1-1.536-22.1696C137.7024 126.5664 211.9936 51.2 303.5904 51.2z m0 84.1728c-45.7728 0-82.944 37.6832-82.944 84.224 0 16.0256 4.4032 31.2832 12.5952 44.544l-1.536-2.9184a42.5472 42.5472 0 0 1 7.5776 30.208l-0.7168 3.7376 0.3072-1.0752-0.256 1.0752-0.256 1.0752-0.1024 0.6656a43.3664 43.3664 0 0 1-1.3824 4.4032l-0.9216 2.1504a41.0624 41.0624 0 0 1-52.6336 22.3232 82.688 82.688 0 0 0-97.4336 60.416A84.3264 84.3264 0 0 0 144.4608 489.4208c12.2368 3.328 24.6784 3.7888 36.7104 1.4848l8.96-2.2528 4.6592-1.1776a41.4208 41.4208 0 0 1 47.104 29.0816 42.24 42.24 0 0 1-27.4944 52.6336 162.6112 162.6112 0 0 1-56.6784 7.168l-4.864 1.1264-6.3488 1.28c-29.1328 7.168-52.6848 29.8496-60.672 60.1088A84.3264 84.3264 0 0 0 144.4608 741.888c7.7824 2.0992 15.6672 3.072 23.552 2.8672l-5.2736-0.1536 0.1024-0.1536a41.1136 41.1136 0 0 1 57.1904-13.3632 42.496 42.496 0 0 1 15.4624 53.6576l-2.304 4.352a84.48 84.48 0 0 0-12.544 44.544c0 46.4896 37.12 84.1728 82.944 84.1728 45.7728 0 82.944-37.6832 82.944-84.1728v-256.3072c0-58.112-46.4384-105.2672-103.7312-105.2672a41.7792 41.7792 0 0 1-41.472-42.0864c0-23.2448 18.5856-42.0864 41.472-42.0864 38.4 0 74.0864 11.776 103.7312 31.9488V219.5968c0-46.5408-37.1712-84.224-82.944-84.224zM720.6144 51.2c-84.3776 0-154.0608 63.9488-164.5056 146.688a18.5344 18.5344 0 0 0-1.3824 6.8096v653.7216c0 4.1984 1.3824 8.0384 3.7888 11.4688 16.384 75.5712 82.7392 132.1472 162.0992 132.1472 91.5968 0 165.888-75.3664 165.888-168.3456l-0.256-7.0656c4.9664-0.8704 9.984-1.9968 14.8992-3.328 88.4736-24.064 140.9536-116.4288 117.248-206.2848a168.5504 168.5504 0 0 0-50.4832-82.688c45.6704-40.96 67.328-105.984 50.4832-169.8816a166.8608 166.8608 0 0 0-133.4272-122.6752c1.024-7.2704 1.536-14.6944 1.536-22.1696 0-93.0304-74.2912-168.3968-165.888-168.3968z m0 84.1728c45.7728 0 82.944 37.6832 82.944 84.224 0 16.0256-4.4032 31.2832-12.5952 44.544l1.536-2.9184a42.5472 42.5472 0 0 0-7.5776 30.208l0.7168 3.7376-0.3072-1.0752 0.256 1.0752 0.256 1.0752 0.1024 0.6656a43.3664 43.3664 0 0 0 1.3824 4.4032l0.9216 2.1504a41.0624 41.0624 0 0 0 52.6336 22.3232 82.688 82.688 0 0 1 97.4336 60.416 84.3264 84.3264 0 0 1-58.624 103.168 81.2032 81.2032 0 0 1-36.7104 1.4848l-8.96-2.2528-4.6592-1.1776a41.4208 41.4208 0 0 0-47.104 29.0816c-6.656 22.272 5.632 45.824 27.4944 52.6336 18.3808 5.6832 37.5296 8.1408 56.6784 7.168l4.864 1.1264 6.3488 1.28c29.1328 7.168 52.6848 29.8496 60.672 60.1088a84.3264 84.3264 0 0 1-58.624 103.1168c-7.7824 2.0992-15.6672 3.072-23.552 2.8672l5.2736-0.1536-0.1024-0.1536a41.1136 41.1136 0 0 0-57.1904-13.3632 42.496 42.496 0 0 0-15.4624 53.6576l2.304 4.352c8.192 13.2096 12.544 28.5184 12.544 44.544 0 46.4896-37.12 84.1728-82.944 84.1728-45.7728 0-82.944-37.6832-82.944-84.1728v-256.3072c0-58.112 46.4384-105.2672 103.7312-105.2672 22.8864 0 41.472-18.8416 41.472-42.0864a41.7792 41.7792 0 0 0-41.472-42.0864c-38.4 0-74.0864 11.776-103.7312 31.9488V219.5968c0-46.5408 37.1712-84.224 82.944-84.224z',
        }),
      );
    }

    /**
     * 48px LAN glyph for the LAN-access card (the user's supplied icon): a
     * broken ring with two endpoint dots plus a connected-nodes chart,
     * single-color via `currentColor` at the svg root. The source paths are
     * 1024-based; the geometry is unchanged, the hardcoded fills were removed.
     */
    function LanIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 1024 1024', fill: 'currentColor', 'aria-hidden': true },
        h('path', {
          d: 'M514.048 72.704c72.192 0 142.336 17.408 204.8 50.688v0.512c0 32.768 26.112 58.88 58.88 58.88s58.88-26.112 58.88-58.88-26.112-58.88-58.88-58.88c-8.192 0-16.384 1.536-23.552 4.608-73.728-39.936-155.648-60.928-240.64-60.928C235.52 8.704 9.728 235.008 9.728 512.512c0 102.4 30.72 200.704 88.064 284.672l52.736-36.352c-50.176-73.216-76.8-159.232-76.8-248.832 0-242.176 197.632-439.296 440.32-439.296zM925.184 220.672l-52.224 36.864c53.248 74.752 81.408 162.816 81.408 254.464 0 242.688-197.632 439.808-439.808 439.808-74.752 0-146.944-18.432-211.456-53.76v-1.536c0-32.768-26.112-58.88-58.88-58.88s-58.88 26.112-58.88 58.88 26.112 58.88 58.88 58.88c7.68 0 15.36-1.536 22.528-4.608 75.264 42.496 160.256 65.024 247.808 65.024 278.016 0 503.808-226.304 503.808-503.808-0.512-104.96-32.768-205.824-93.184-291.328z',
        }),
        h('path', {
          d: 'M723.456 482.816c39.936 0 72.192-32.256 72.192-72.192s-32.256-72.192-72.192-72.192-72.192 32.256-72.192 72.192c0 18.944 7.168 35.84 18.944 48.64L602.624 593.92c-2.048 0-3.584-0.512-5.632-0.512-10.24 0-19.968 2.56-28.672 7.168L471.04 509.952c0.512-3.072 1.024-5.632 1.024-8.704 0-29.696-24.064-53.76-53.76-53.76s-53.76 24.064-53.76 53.76c0 3.072 0.512 6.144 1.024 9.216l-91.136 84.48c-3.584-1.024-6.656-1.024-10.752-1.024-25.6 0-46.08 20.48-46.08 46.08s20.48 46.08 46.08 46.08 46.08-20.48 46.08-46.08c0-2.56 0-4.608-0.512-7.168l88.064-81.92c6.656 3.072 13.824 4.608 21.504 4.608s14.848-1.536 21.504-4.608l96.768 89.6c-1.536 5.12-2.048 10.752-2.048 16.384 0 34.816 28.16 62.976 62.976 62.976S660.48 691.2 660.48 656.384c0-14.336-4.608-27.136-12.8-37.888l68.608-136.192c2.56 0 5.12 0.512 7.168 0.512z',
        }),
      );
    }

    /**
     * 48px checklist glyph for the Skills summary card (the user's supplied
     * icon): a document with list rows plus a checked circle, single-color
     * via `currentColor` at the svg root. The source path is 1025-based; the
     * geometry is unchanged, the missing fill comes from the root.
     */
    function SkillsIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 1025 1024', fill: 'currentColor', 'aria-hidden': true },
        h('path', {
          d: 'M254.401252 745.6H520.801252a328 328 0 0 0 40 54.4H254.401252v-53.6z m0-84.8h231.2a358.4 358.4 0 0 1-10.4-53.6H254.401252v53.6z m0-137.6h221.6c2.4-18.4 5.6-36.8 10.4-53.6h-232v53.6z m431.2 358.4v46.4c0 22.4-16.8 40.8-37.6 40.8h-560c-20.8 0-37.6-18.4-37.6-40V249.6l185.6-168v178.4H138.401252v52.8h147.2V53.6h362.4c20.8 0 37.6 18.4 37.6 40v160c16-4.8 32-8 48.8-11.2V94.4C734.401252 42.4 696.801252 0 648.801252 0H249.601252L0.801252 224.8v704c0 51.2 39.2 93.6 86.4 93.6H648.801252c48 0 86.4-42.4 86.4-94.4v-35.2c-16-2.4-32.8-5.6-48.8-11.2zM187.201252 469.6h-64v53.6h64v-53.6z m-64 329.6h64v-53.6h-64v53.6z m64-192h-64v53.6h64V608zM904.801252 488l-39.2-32-99.2 140-89.6-74.4-30.4 42.4 128 107.2 130.4-184z m120 80c0-148.8-112-269.6-248.8-269.6-137.6 0-249.6 121.6-249.6 270.4 0 148.8 112 270.4 249.6 270.4C912.801252 838.4 1024.801252 716.8 1024.801252 568z m-49.6 0c0 120-89.6 217.6-200 217.6-109.6 0-200-97.6-200-216.8 0-120 90.4-216.8 200-216.8 110.4 0 200 96.8 200 216z',
        }),
      );
    }

    /**
     * 48px file-badge glyph for the Agent summary card (the user's supplied
     * icon): a document with an "MD" badge, single-color via `currentColor`
     * at the svg root. The source path is 1024-based; the geometry is
     * unchanged, the missing fill comes from the root.
     */
    function AgentIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 1024 1024', fill: 'currentColor', 'aria-hidden': true },
        h('path', {
          d: 'M354.40128 0c-87.04 0-157.44 70.55872-157.44 157.59872v275.68128H78.72c-21.6576 0-39.36256 17.69984-39.36256 39.36256v236.31872c0 21.6576 17.69984 39.35744 39.36256 39.35744h118.24128v118.08256c0 87.04 70.4 157.59872 157.44 157.59872h472.63744c87.04 0 157.59872-70.55872 157.59872-157.59872V315.0336c0-41.74848-38.9888-81.93024-107.52-149.27872l-29.11744-29.12256L818.87744 107.52C751.5392 38.9888 711.39328 0 669.59872 0H354.4064z m0 78.72h287.20128c28.35456 7.0912 27.99616 42.1376 27.99616 76.8v120.16128c0 21.6576 17.69984 39.35744 39.36256 39.35744h118.07744c39.38816 0 78.87872-0.0256 78.87872 39.36256v512c0 43.32032-35.55328 78.87872-78.87872 78.87872H354.4064c-43.32544 0-78.72-35.5584-78.72-78.87872v-118.08256h393.91744c21.66272 0 39.36256-17.69472 39.36256-39.35744V472.64256c0-21.66272-17.69984-39.36256-39.36256-39.36256H275.68128V157.59872c0-43.32032 35.39456-78.87872 78.72-78.87872zM195.9936 507.36128h32.64l49.92 143.03744h0.96256l48.95744-143.03744h33.60256v175.67744h-22.08256v-106.55744c0-10.88 0.32256-26.56256 0.96256-47.04256h-0.96256l-52.79744 153.6h-19.2l-52.80256-153.6h-0.95744c1.28 22.4 1.92 38.72256 1.92 48.96256v104.63744H195.9936V507.36128z m214.08256 0h48.95744c24.96 0 44.48256 7.68 58.56256 23.04 14.72 14.72 22.07744 35.84 22.07744 63.36 0 28.8-7.68 50.87744-23.04 66.23744-14.72 15.36-35.51744 23.04-62.39744 23.04h-44.16V507.36128z m22.07744 19.2v137.27744h19.2c21.76 0 37.76-5.76 48-17.28 10.88-11.52 16.32256-28.8 16.32256-51.84s-5.12-39.99744-15.36-50.87744c-9.6-11.52-24.32-17.28-44.16-17.28h-24.00256z',
        }),
      );
    }

    /**
     * 48px plug glyph for the MCP summary card (the user's supplied icon):
     * two mating connector halves, single-color via `currentColor` at the svg
     * root. The source path is 1024-based; the geometry is unchanged, the
     * missing fill comes from the root.
     */
    function McpIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 1024 1024', fill: 'currentColor', 'aria-hidden': true },
        h('path', {
          d: 'M944.5376 124.416l-45.2096-45.2096a8.8576 8.8576 0 0 0-12.1344 0l-81.152 81.2032a213.248 213.248 0 0 0-270.4896 26.0096L427.0592 295.1168a8.5504 8.5504 0 0 0 0 12.0832l289.5872 289.5872a8.2944 8.2944 0 0 0 6.144 2.4576 9.1136 9.1136 0 0 0 5.9904-2.4576l108.6464-108.6464a213.248 213.248 0 0 0 26.0096-270.1312l81.2032-81.2032a8.5504 8.5504 0 0 0 0-12.0832l-0.1024-0.256z m-158.464 312.1152l-63.3344 63.3344-199.168-199.168 63.3344-63.2832a140.8 140.8 0 1 1 199.1168 199.1168zM583.168 548.352a8.5504 8.5504 0 0 0-11.9808 0L500.2752 619.52l-96.256-96.256 71.0656-71.0656a8.4992 8.4992 0 0 0 0-12.0832l-38.7072-38.8096a8.6016 8.6016 0 0 0-12.032 0l-71.168 71.168-45.824-45.824a8.448 8.448 0 0 0-6.1952-2.56 9.0112 9.0112 0 0 0-6.0416 2.56l-108.4928 108.544a213.248 213.248 0 0 0-26.0096 270.1824l-81.152 81.2032a8.6016 8.6016 0 0 0 0 11.9808l45.2608 45.2096c3.4304 3.2256 8.704 3.2256 12.1344 0l81.2032-81.2032a213.248 213.248 0 0 0 270.4384-26.0096l108.6464-108.544a8.6016 8.6016 0 0 0 2.5088-6.0416 8.5504 8.5504 0 0 0-2.56-5.632l-45.8752-45.7728 71.1168-71.168a8.5504 8.5504 0 0 0 0-11.9808l-39.1168-39.0656z m-146.176 237.056a140.8 140.8 0 1 1-199.168-199.1168l63.3344-63.3344 199.1168 199.2704-63.2832 63.1808z',
        }),
      );
    }

    /**
     * Card footer for the delete-sessions feature: how many sessions are
     * currently marked for the next startup sweep. Reads the same marked-set
     * store the sidebar rows use, so the count updates live.
     */
    function DeletePendingFooter({ translate }) {
      const markedCount = useSyncExternalStore(subscribe, () => marked.size);
      const deleteEnabled = useSyncExternalStore(subscribeFeatures, () => getFeature('deleteSessionsEnabled'));
      let text;
      let hot = false;
      if (!deleteEnabled) {
        text = translate('deleteFeature.pending.off', '已关闭，下次启动不执行删除清扫');
      } else if (markedCount === 0) {
        text = translate('deleteFeature.pending.none', '下次启动不会删除任何会话');
      } else {
        text = translate('deleteFeature.pending.some', '下次启动将删除 {count} 个会话').replace('{count}', String(markedCount));
        hot = true;
      }
      return h('div', { className: 'MikufanCpCardFoot' + (hot ? ' MikufanCpCardFootHot' : '') }, text);
    }

    /** Card footer for the startup-animation feature: plays while enabled. */
    function SplashPendingFooter({ translate }) {
      const enabled = useSyncExternalStore(subscribeFeatures, () => getFeature('splashEnabled'));
      const text = enabled
        ? translate('splash.pending.on', '每次加载页面时播放')
        : translate('splash.pending.off', '已停用，页面加载将不再播放动画');
      return h('div', { className: 'MikufanCpCardFoot' }, text);
    }

    /**
     * Card footer for the LAN-access feature: off, or the live LAN entry URL
     * from the engine status store.
     */
    function LanPendingFooter({ translate }) {
      const current = useSyncExternalStore(subscribeLan, getLanStatus);
      const url = typeof current?.proxy?.lanUrl === 'string' ? current.proxy.lanUrl : '';
      const running = current?.proxy?.running === true && url !== '';
      const text = running
        ? formatTemplate(translate('lanFeature.pending.on', '使用 {url} 访问'), { url })
        : translate('lanFeature.pending.off', '未开启');
      return h(
        'div',
        { className: 'MikufanCpCardFoot' + (running ? ' MikufanCpCardFootActive' : '') },
        text,
      );
    }

    /**
     * Card footer for the memory feature: how many entries the local memory
     * store holds. Reads the same store the Memory page uses; hydrates the
     * store on mount so the count appears without visiting the Memory page.
     */
    function MemoryPendingFooter({ translate }) {
      const entries = useSyncExternalStore(subscribeMemory, getMemoryEntries);
      const loaded = useSyncExternalStore(subscribeMemory, isMemoryLoaded);
      const memoryEnabled = useSyncExternalStore(subscribeFeatures, () => getFeature('memoryEnabled'));
      useEffect(() => {
        void adoptHostMemory();
      }, []);
      const text = formatTemplate(
        memoryEnabled
          ? translate('memoryFeature.pending.none', '已保存 {count} 条记忆')
          : translate('memoryFeature.pending.off', '已保存 {count} 条记忆（当前已停用）'),
        { count: loaded ? String(entries.length) : '…' },
      );
      return h('div', { className: 'MikufanCpCardFoot' }, text);
    }

    /**
     * Card footer for the Skills page: how many skills are enabled out of the
     * managed root's total. Hydrates the shared skill store on mount, so the
     * count appears without visiting the Skills page.
     */
    function SkillsPendingFooter({ translate }) {
      const entries = useSyncExternalStore(subscribeSkills, getSkillEntries);
      const loaded = useSyncExternalStore(subscribeSkills, isSkillsLoaded);
      useEffect(() => {
        hydrateSkills();
      }, []);
      const enabled = entries.filter((entry) => entry.enabled === true).length;
      const text = formatTemplate(translate('skillsFeature.pending', '启用了 {enabled} 个技能，共 {total} 个'), {
        enabled: loaded ? String(enabled) : '…',
        total: loaded ? String(entries.length) : '…',
      });
      return h('div', { className: 'MikufanCpCardFoot' }, text);
    }

    /**
     * Card footer for the MCP summary card: how many of the configured servers
     * are enabled. Reads the same store the MCP page uses and hydrates it on
     * mount, so the count appears without visiting the MCP page; an empty
     * document shows a hint instead of a zero count.
     */
    function McpPendingFooter({ translate }) {
      const servers = useSyncExternalStore(subscribeMcp, getMcpServers);
      const loaded = useSyncExternalStore(subscribeMcp, isMcpLoaded);
      useEffect(() => {
        hydrateMcp();
      }, []);
      const enabled = servers.filter((server) => server.enabled === true).length;
      const text =
        loaded && servers.length === 0
          ? translate('mcpFeature.pending.off', '还没有 MCP 服务器，在 MCP 页添加')
          : formatTemplate(translate('mcpFeature.pending', '{enabled} / {total} 个服务器已启用'), {
              enabled: loaded ? String(enabled) : '…',
              total: loaded ? String(servers.length) : '…',
            });
      return h('div', { className: 'MikufanCpCardFoot' }, text);
    }

    /**
     * Card footer for the Agent page: when the user-global AGENTS.md was last
     * saved. Reads the same Host route the Agent page uses, so the stamp also
     * follows edits made outside this plugin.
     */
    function AgentPendingFooter({ translate }) {
      const [updatedAt, setUpdatedAt] = useState('');
      const [loaded, setLoaded] = useState(false);
      useEffect(() => {
        let alive = true;
        void readAgentInstructions()
          .then((value) => {
            if (alive) setUpdatedAt(typeof value?.updatedAt === 'string' ? value.updatedAt : '');
          })
          .catch(() => {})
          .finally(() => {
            if (alive) setLoaded(true);
          });
        return () => {
          alive = false;
        };
      }, []);
      const time = formatMemoryTime(updatedAt);
      const text = !loaded
        ? translate('agentFeature.pending.loading', '上次更新时间：…')
        : time === ''
          ? translate('agentFeature.pending.none', '上次更新时间：—')
          : formatTemplate(translate('agentFeature.pending.some', '上次更新时间：{time}'), { time });
      return h('div', { className: 'MikufanCpCardFoot' }, text);
    }

    /**
     * One setting card with an iOS-style switch. The switch is styled like the
     * host's own switch primitive (the plugin cannot import Client packages).
     *
     * @param props.name - Host preference field this card flips.
     * @param props.titleKey - locale key of the card title.
     * @param props.fallbackTitle - zh fallback of the card title.
     * @param props.descriptionKey - locale key of the card description.
     * @param props.fallbackDescription - zh fallback of the description.
     * @param props.translate - localized text for this plugin's namespace.
     */
    function FeatureCard(props) {
      const {
        name,
        titleKey,
        fallbackTitle,
        descriptionKey,
        fallbackDescription,
        translate,
        icon = null,
        iconDanger = false,
        footer = null,
      } = props;
      const enabled = useSyncExternalStore(subscribeFeatures, () => getFeature(name));
      const [busy, setBusy] = useState(false);
      const [failed, setFailed] = useState(false);
      const title = translate(titleKey, fallbackTitle);
      const description = translate(descriptionKey, fallbackDescription);
      const onChange = () => {
        if (busy) return;
        setFailed(false);
        setBusy(true);
        Promise.resolve(saveFeatures({ [name]: !enabled }))
          .catch(() => setFailed(true))
          .finally(() => setBusy(false));
      };
      return h(
        'div',
        { className: 'MikufanCpCard' },
        h(
          'div',
          { className: 'MikufanCpCardBody' },
          icon !== null ? h('div', { className: 'MikufanCpCardIcon' + (iconDanger ? ' MikufanCpCardIconDanger' : '') }, icon) : null,
          h(
            'div',
            { className: 'MikufanCpCardMain' },
            h(
              'div',
              { className: 'MikufanCpCardHead' },
              h('h2', { className: 'MikufanCpCardTitle' }, title),
              h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  className: 'MikufanSwitch',
                  'aria-checked': enabled,
                  'aria-label': title,
                  title,
                  disabled: busy,
                  onClick: onChange,
                },
                h('span', { className: 'MikufanSwitchThumb' }),
              ),
            ),
            h('p', { className: 'MikufanCpCardDesc' }, description),
            failed
              ? h('div', { className: 'MikufanCpCardError', role: 'alert' }, translate('feature.error', '保存失败，请重试。'))
              : null,
          ),
        ),
        footer,
      );
    }

    /**
     * One dashboard card without a switch: the Skills and Agent pages have no
     * on/off preference, so their cards summarize the page instead (icon +
     * title + description + footer).
     *
     * @param props.titleKey - locale key of the card title.
     * @param props.fallbackTitle - zh fallback of the card title.
     * @param props.descriptionKey - locale key of the card description.
     * @param props.fallbackDescription - zh fallback of the description.
     * @param props.icon - the 48px glyph element.
     * @param props.footer - the footer element (status line).
     * @param props.translate - localized text for this plugin's namespace.
     */
    function SummaryCard(props) {
      const { translate, titleKey, fallbackTitle, descriptionKey, fallbackDescription, icon, footer } = props;
      return h(
        'div',
        { className: 'MikufanCpCard' },
        h(
          'div',
          { className: 'MikufanCpCardBody' },
          h('div', { className: 'MikufanCpCardIcon' }, icon),
          h(
            'div',
            { className: 'MikufanCpCardMain' },
            h(
              'div',
              { className: 'MikufanCpCardHead' },
              h('h2', { className: 'MikufanCpCardTitle' }, translate(titleKey, fallbackTitle)),
            ),
            h('p', { className: 'MikufanCpCardDesc' }, translate(descriptionKey, fallbackDescription)),
          ),
        ),
        footer,
      );
    }

    /**
     * The dashboard's LAN card: same visual structure as {@link FeatureCard},
     * but its switch drives the LAN engine preference (a different Host store)
     * and needs the status hydrated on mount.
     */
    function LanFeatureCard({ translate }) {
      const current = useSyncExternalStore(subscribeLan, getLanStatus);
      const enabled = current?.saved?.lanAccessEnabled === true;
      const [busy, setBusy] = useState(false);
      const [failed, setFailed] = useState(false);
      const title = translate('lanFeature.title', '局域网访问');
      useEffect(() => {
        hydrateLanStatus();
      }, []);
      const onChange = () => {
        if (busy) return;
        setFailed(false);
        setBusy(true);
        Promise.resolve(saveLanPreferences({ lanAccessEnabled: !enabled }))
          .then(() => {
            // The proxy start takes a moment; settle before repainting.
            setTimeout(() => void refreshLanStatus(), 400);
          })
          .catch(() => setFailed(true))
          .finally(() => setBusy(false));
      };
      return h(
        'div',
        { className: 'MikufanCpCard' },
        h(
          'div',
          { className: 'MikufanCpCardBody' },
          h('div', { className: 'MikufanCpCardIcon' }, h(LanIcon, null)),
          h(
            'div',
            { className: 'MikufanCpCardMain' },
            h(
              'div',
              { className: 'MikufanCpCardHead' },
              h('h2', { className: 'MikufanCpCardTitle' }, title),
              h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  className: 'MikufanSwitch',
                  'aria-checked': enabled,
                  'aria-label': title,
                  title,
                  disabled: busy || !isLanLoaded(),
                  onClick: onChange,
                },
                h('span', { className: 'MikufanSwitchThumb' }),
              ),
            ),
            h('p', { className: 'MikufanCpCardDesc' }, translate('lanFeature.description', '允许局域网设备访问到 Harness。')),
            failed
              ? h('div', { className: 'MikufanCpCardError', role: 'alert' }, translate('lan.saveFailed', '保存失败，请重试。'))
              : null,
          ),
        ),
        h(LanPendingFooter, { translate }),
      );
    }

    /** The dashboard page: four switch cards plus the Skills / Agent / MCP summary cards. */
    function DashboardPage({ translate }) {      return h(
        'div',
        { role: 'tabpanel', 'aria-label': translate('control.panel.tab.dashboard', '主页') },
        h(PageHead, {
          translate,
          titleKey: 'control.panel.title',
          fallbackTitle: '主页',
          subtitleKey: 'control.panel.subtitle',
          fallbackSubtitle: '更改设置并对插件的功能自定义。',
        }),
        h(
          'div',
          { className: 'MikufanCpGroup' },
          h(FeatureCard, {
            name: 'deleteSessionsEnabled',
            titleKey: 'deleteFeature.title',
            fallbackTitle: '删除会话',
            descriptionKey: 'deleteFeature.description',
            fallbackDescription: '被删除的会话将在下次启动时删除，其子代理会话一并删除；停用此功能删除不再执行。',
            translate,
            icon: h(DeleteIcon, null),
            iconDanger: true,
            footer: h(DeletePendingFooter, { translate }),
          }),
          h(FeatureCard, {
            name: 'splashEnabled',
            titleKey: 'splash.title',
            fallbackTitle: '启动动画',
            descriptionKey: 'splash.description',
            fallbackDescription: '一切皆插件。',
            translate,
            icon: h(SplashIcon, null),
            footer: h(SplashPendingFooter, { translate }),
          }),
          h(FeatureCard, {
            name: 'memoryEnabled',
            titleKey: 'memoryFeature.title',
            fallbackTitle: '记忆',
            descriptionKey: 'memoryFeature.description',
            fallbackDescription: 'Agent 的本地长期记忆，每个会话自动携带记忆索引',
            translate,
            icon: h(MemoryIcon, null),
            footer: h(MemoryPendingFooter, { translate }),
          }),
          h(LanFeatureCard, { translate }),
          h(SummaryCard, {
            translate,
            titleKey: 'skillsFeature.title',
            fallbackTitle: 'Skills',
            descriptionKey: 'skillsFeature.description',
            fallbackDescription: '管理助手可用的技能扩展。',
            icon: h(SkillsIcon, null),
            footer: h(SkillsPendingFooter, { translate }),
          }),
          h(SummaryCard, {
            translate,
            titleKey: 'agentFeature.title',
            fallbackTitle: 'Agent',
            descriptionKey: 'agentFeature.description',
            fallbackDescription: '编辑所选机器上的AGENTS.md。代码仓库的说明也可能适用。',
            icon: h(AgentIcon, null),
            footer: h(AgentPendingFooter, { translate }),
          }),
          h(SummaryCard, {
            translate,
            titleKey: 'mcpFeature.title',
            fallbackTitle: 'MCP',
            descriptionKey: 'mcpFeature.description',
            fallbackDescription: '按 ChatGPT/Codex 标准管理 MCP 服务器连接。',
            icon: h(McpIcon, null),
            footer: h(McpPendingFooter, { translate }),
          }),
        ),
      );
    }

    /**
     * The memory page, rebuilt as a card grid in the dashboard's own idiom:
     * the first card is always the blank "+" card, every stored entry is one
     * rounded card (type tag, source, enable switch, a three-line preview and
     * an 编辑 / 删除 footer), and both creating and editing happen in the
     * {@link MemoryDialog} popup instead of an inline form.
     */
    function MemoryPageBody(props) {
      const { translate } = props;
      const entries = useSyncExternalStore(subscribeMemory, getMemoryEntries);
      const loaded = useSyncExternalStore(subscribeMemory, isMemoryLoaded);
      const readFailed = useSyncExternalStore(subscribeMemory, isMemoryReadFailed);
      const memoryEnabled = useSyncExternalStore(subscribeFeatures, () => getFeature('memoryEnabled'));
      /** `null` while closed, else `{ mode: 'create' }` or `{ mode: 'edit', id }`. */
      const [dialog, setDialog] = useState(null);
      /** What the bar's search field filters the cards by. */
      const [query, setQuery] = useState('');
      /** A manual refresh is in flight. */
      const [refreshing, setRefreshing] = useState(false);

      // Every mount reads the list again (the panel renders only the active
      // page), retried a few times across a slow boot; a hard failure surfaces
      // as a notice instead of an empty grid.
      useEffect(() => {
        hydrateMemory();
      }, []);

      const enabledCount = entries.filter((entry) => entry.enabled).length;
      const needle = query.trim().toLowerCase();
      // The search matches the content plus the localized type and source, so
      // typing 项目 or Agent works as well as a phrase from the memory itself.
      const visible =
        needle === ''
          ? entries
          : entries.filter((entry) =>
              [
                entry.content,
                translate(`memory.type.${entry.type}`, entry.type),
                translate(`memory.source.${entry.source}`, entry.source),
              ]
                .join('\n')
                .toLowerCase()
                .includes(needle),
            );
      const searching = needle !== '';

      /** Manual refresh: one Host read, and the retry notice when it fails. */
      const onRefresh = () => {
        if (refreshing) return;
        setRefreshing(true);
        void adoptHostMemory()
          .then((ok) => {
            if (ok) return;
            memoryReadGaveUp = true;
            emitMemory();
          })
          .finally(() => setRefreshing(false));
      };

      const editingEntry =
        dialog !== null && dialog.mode === 'edit' ? (entries.find((entry) => entry.id === dialog.id) ?? null) : null;
      const openCreate = () => {
        rememberDialogOpener();
        setDialog({ mode: 'create' });
      };
      const openEdit = (entry) => {
        rememberDialogOpener();
        setDialog({ mode: 'edit', id: entry.id });
      };
      const closeDialog = () => setDialog(null);

      return h(
        'div',
        { role: 'tabpanel', 'aria-label': translate('control.panel.tab.memory', '记忆') },
        h(PageHead, {
          translate,
          titleKey: 'memory.tab.title',
          fallbackTitle: '记忆',
          subtitleKey: 'memory.tab.subtitle',
          fallbackSubtitle: 'Agent 跨会话记住的持久事实，纯本地存储。',
        }),
        h(
          'div',
          { className: 'MikufanMemoryPanel' },
          !memoryEnabled
            ? h('div', { className: 'MikufanMemoryNotice', role: 'status' }, translate('memory.offNotice', '长期记忆功能当前已关闭，可在「MAGICAL MIRAI」页开启。'))
            : null,
          readFailed
            ? h('div', { className: 'MikufanMemoryNotice', role: 'alert' }, translate('memory.readFailed', '记忆列表读取失败，请刷新页面重试。'))
            : null,
          loaded && entries.length > 0
            ? h(
                'div',
                { className: 'MikufanMemoryBar' },
                h(
                  'span',
                  null,
                  formatTemplate(translate('memory.count', '共 {count} 条记忆 · {enabled} 条启用'), {
                    count: entries.length,
                    enabled: enabledCount,
                  }) +
                    (searching
                      ? formatTemplate(translate('memory.bar.matched', ' · 匹配 {count}'), { count: visible.length })
                      : ''),
                ),
                h(
                  'div',
                  { className: 'MikufanMemoryTools' },
                  h(
                    'label',
                    { className: 'MikufanMemSearch' },
                    h('span', { className: 'MikufanMemSearchIcon' }, h(SearchIcon, null)),
                    h('input', {
                      type: 'search',
                      className: 'MikufanMemSearchInput',
                      value: query,
                      placeholder: translate('memory.search.placeholder', '搜索记忆'),
                      'aria-label': translate('memory.search.label', '搜索记忆'),
                      spellCheck: false,
                      onChange: (event) => setQuery(event.target.value),
                    }),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'MikufanMemRefresh',
                      'data-busy': refreshing ? 'true' : 'false',
                      title: translate('memory.refresh', '刷新记忆列表'),
                      'aria-label': translate('memory.refresh', '刷新记忆列表'),
                      disabled: refreshing,
                      onClick: onRefresh,
                    },
                    h(RefreshIcon, null),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'MikufanMemoryGrid', 'data-empty': !loaded || entries.length === 0 ? 'true' : 'false' },
            h(MemoryAddCard, { key: '__add__', translate, onClick: openCreate }),
            loaded
              ? visible.map((entry) => h(MemoryCard, { key: entry.id, entry, translate, onEdit: openEdit }))
              : null,
          ),
          loaded && entries.length === 0
            ? h('div', { className: 'MikufanMemoryEmpty' }, translate('memory.empty', '还没有记忆。点击上方卡片新建第一条。'))
            : loaded && searching && visible.length === 0
              ? h('div', { className: 'MikufanMemoryEmpty' }, translate('memory.empty.search', '没有匹配的记忆。'))
              : null,
          dialog !== null && dialog.mode === 'create'
            ? h(MemoryDialog, { key: 'create', mode: 'create', entry: null, translate, onClose: closeDialog })
            : editingEntry !== null
              ? h(MemoryDialog, {
                  key: `edit:${editingEntry.id}`,
                  mode: 'edit',
                  entry: editingEntry,
                  translate,
                  onClose: closeDialog,
                })
              : null,
        ),
      );
    }

    /**
     * The Agent page: one text box for the user-global instruction file the
     * Harness loads for every project (`<DSH home>/AGENTS.md`), and one save.
     * The first read fills the box with the current text; a blank box is the
     * normal state when the file does not exist yet, and saving blank text
     * removes the file again.
     */
    installStyle(
      STYLE_AGENT,
      `
.MikufanAgentPanel{display:flex;flex-direction:column;gap:12px}
.MikufanAgentInput{box-sizing:border-box;width:100%;min-height:280px;max-height:56vh;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:21px;resize:vertical}
.MikufanAgentInput::placeholder{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary))}
.MikufanAgentInput:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:var(--dsw-alias-brand-primary)}
.MikufanAgentFoot{display:flex;align-items:center;gap:12px}
.MikufanAgentPath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.MikufanAgentSave{margin-left:auto;flex:none;height:32px;padding:0 18px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer}
.MikufanAgentSave:hover:not(:disabled){opacity:.9}
.MikufanAgentSave:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.MikufanAgentSave:disabled{opacity:.5;cursor:not-allowed}
`,
    );

    /** Shown before the Host reports the resolved path. */
    const AGENT_FILE_DISPLAY = '~/.dsh/AGENTS.md';
    /** Host-side cap on the instruction text (mirrors `MAX_AGENT_INSTRUCTIONS_LENGTH`). */
    const AGENT_MAX_INSTRUCTIONS = 64 * 1024;

    /** Read the user-global AGENTS.md through the Host route. */
    async function readAgentInstructions() {
      return callHost('agent', { method: 'GET', headers: { accept: 'application/json' } });
    }

    /** Write the user-global AGENTS.md; blank text removes the file. */
    async function saveAgentInstructions(content) {
      return callHost('agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    }

    /** The Agent page body: one text box, one save, the file path underneath. */
    function AgentPageBody({ translate }) {
      const [content, setContent] = useState('');
      const [savedContent, setSavedContent] = useState('');
      const [path, setPath] = useState('');
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState('');
      const [readFailed, setReadFailed] = useState(false);

      useEffect(() => {
        let alive = true;
        void readAgentInstructions()
          .then((value) => {
            if (!alive) return;
            const text = typeof value?.content === 'string' ? value.content : '';
            setContent(text);
            setSavedContent(text);
            if (typeof value?.path === 'string') setPath(value.path);
          })
          .catch(() => {
            if (alive) setReadFailed(true);
          })
          .finally(() => {
            if (alive) setLoading(false);
          });
        return () => {
          alive = false;
        };
      }, []);

      const dirty = content !== savedContent;
      const save = () => {
        if (loading || saving || !dirty) return;
        setSaving(true);
        setNotice('');
        void saveAgentInstructions(content)
          .then((value) => {
            const text = typeof value?.content === 'string' ? value.content : content;
            setContent(text);
            setSavedContent(text);
            if (typeof value?.path === 'string') setPath(value.path);
            setNotice(translate('agent.saved', '已保存'));
          })
          .catch(() => setNotice(translate('agent.saveFailed', '保存失败，请重试。')))
          .finally(() => setSaving(false));
      };
      const onChange = (event) => {
        setContent(event.target.value);
        setNotice('');
      };
      const onKeyDown = (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          save();
        }
      };

      return h(
        'div',
        { role: 'tabpanel', 'aria-label': translate('control.panel.tab.agent', 'Agent') },
        h(PageHead, {
          translate,
          titleKey: 'agent.tab.title',
          fallbackTitle: 'Agent',
          subtitleKey: 'agent.tab.subtitle',
          fallbackSubtitle: '编辑所选机器上的AGENTS.md。代码仓库的说明也可能适用。',
        }),
        h(
          'div',
          { className: 'MikufanAgentPanel' },
          readFailed
            ? h(
                'div',
                { className: 'MikufanMemoryNotice', role: 'alert' },
                translate('agent.readFailed', '读取 AGENTS.md 失败，请刷新页面重试。'),
              )
            : null,
          notice !== '' ? h('div', { className: 'MikufanMemoryNotice', role: 'status' }, notice) : null,
          h('textarea', {
            className: 'MikufanAgentInput',
            value: content,
            placeholder: translate('agent.placeholder', '[添加自定义指令...]'),
            'aria-label': translate('agent.input.label', 'AGENTS.md 内容'),
            spellCheck: false,
            maxLength: AGENT_MAX_INSTRUCTIONS,
            disabled: loading,
            onChange,
            onKeyDown,
          }),
          h(
            'div',
            { className: 'MikufanAgentFoot' },
            h('span', { className: 'MikufanAgentPath' }, path !== '' ? path : AGENT_FILE_DISPLAY),
            h(
              'button',
              {
                type: 'button',
                className: 'MikufanAgentSave',
                disabled: loading || saving || !dirty,
                onClick: save,
              },
              saving ? translate('agent.saving', '保存中…') : translate('agent.save', '保存'),
            ),
          ),
        ),
      );
    }

    /**
     * The control panel body, registered under `main` key
     * {@link CONTROL_PANEL_ID} and opened by the matching sidebar entry. A
     * floating pill tab bar switches pages; the last choice persists in
     * localStorage.
     */
    function ControlPanelPage(props) {
      const { translate, startSkillSession } = props;
      const [tab, setTab] = useState(readStoredTab);
      const select = (id) => {
        setTab(id);
        storeTab(id);
      };
      return h(
        'div',
        { className: 'MikufanCpRoot' },
        h(
          'div',
          { className: 'MikufanCpNavWrap' },
          h(
            'div',
            { className: 'MikufanCpTopbar', role: 'tablist', 'aria-label': translate('control.panel.label', 'MAGICAL MIRAI') },
            CONTROL_TABS.map((entry) =>
              h(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  role: 'tab',
                  className: 'MikufanCpTab',
                  'aria-selected': tab === entry.id,
                  onClick: () => select(entry.id),
                },
                translate(entry.key, entry.fallback),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'MikufanCpContent' },
          tab === 'dashboard'
            ? h(DashboardPage, { translate })
            : tab === 'memory'
              ? h(MemoryPageBody, { translate })
              : tab === 'lan'
                ? h(LanPageBody, { translate })
                : tab === 'skills'
                  ? h(SkillsPageBody, { translate, startSkillSession })
                  : tab === 'agent'
                    ? h(AgentPageBody, { translate })
                    : h(McpPageBody, { translate }),
        ),
      );
    }

    /**
     * 16px glyph for the sidebar rail entry: an octagonal "01" monogram drawn
     * from the user's reference image (octagon-bold digits), rendered hollow —
     * outline only, single-color via `currentColor`, no fill.
     */
    function ControlPanelIcon(props) {
      const size = props?.size ?? 16;
      return h(
        'span',
        { className: 'MikufanCpIcon' },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinejoin: 'miter',
            strokeLinecap: 'butt',
            'aria-hidden': true,
          },
          h('path', {
            d: 'M3 3H7L9 5V11L7 13H3L1 11V5ZM4.2 5.2H5.8L6.8 6.2V9.8L5.8 10.8H4.2L3.2 9.8V6.2ZM12.1 3H15V13H12.2V6.2L10.4 7.4V4.9Z',
          }),
        ),
      );
    }

    /** Inline trash icon, 14px, stroke-inheriting like the host's own row icons. */
    function TrashIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M2.6 4.6h10.8' }),
        h('path', { d: 'M6.5 4.6V3.2a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.4' }),
        h('path', { d: 'M4.2 4.6l.6 7.8a1.1 1.1 0 0 0 1.1 1h4.2a1.1 1.1 0 0 0 1.1-1l.6-7.8' }),
        h('path', { d: 'M6.9 7.2v3.6M9.1 7.2v3.6' }),
      );
    }

    /** Inline undo icon for the already-marked state. */
    function UndoIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M3 7.2h6.6a3.4 3.4 0 1 1 0 6.8H6.2' }),
        h('path', { d: 'M5.6 4.4 3 7l2.6 2.6' }),
      );
    }

    /**
     * One row in a session's "..." menu.
     *
     * Rendered only while the delete-sessions feature is enabled: the control
     * panel's switch owns the visibility, so a disabled feature leaves no menu
     * rows behind.
     *
     * @param props.sessionId - the row's session.
     * @param props.displayTitle - its title (used for the accessible name).
     * @param props.useMenuOpenState - the slot's menu-open state hook.
     * @param props.translate - localized text for this plugin's namespace.
     * @param props.markForDeletion - Host operation: mark for the startup delete.
     * @param props.cancelDeletion - inverse Host operation.
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, translate, markForDeletion: mark, cancelDeletion: cancel } = props;
      const deleteEnabled = useSyncExternalStore(subscribeFeatures, () => getFeature('deleteSessionsEnabled'));
      if (!deleteEnabled) return null;
      const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined;
      const closeMenu = typeof menuState?.[1] === 'function' ? menuState[1] : undefined;
      const isMarked = useSyncExternalStore(subscribe, () => marked.has(sessionId));
      const label = isMarked
        ? translate('menu.cancelDeleteSession', '取消删除标记')
        : translate('menu.deleteSession', '删除会话');
      const onSelect = () => {
        if (typeof closeMenu === 'function') closeMenu(false);
        const operation = isMarked ? cancel : mark;
        if (typeof operation === 'function') void operation(sessionId);
      };
      return h(
        'div',
        { className: 'MikufanMenuItemWrap' },
        h('div', { className: 'MikufanMenuItemSeparator', role: 'separator' }),
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: isMarked ? 'MikufanMenuItemButton' : 'MikufanMenuItemButton MikufanMenuItemDanger',
            'aria-label': displayTitle ? `${label}: ${displayTitle}` : label,
            onClick: onSelect,
          },
          h('span', { className: 'MikufanMenuItemIcon' }, isMarked ? h(UndoIcon) : h(TrashIcon)),
          h('span', { className: 'MikufanMenuItemLabel' }, label),
        ),
      );
    }

    /**
     * The one control a marked session keeps: clear the deletion mark.
     *
     * Rendered in the row's hover-action seat; for that same row the stylesheet
     * retires the shipped "..." trigger, pin and archive controls, so the row
     * offers exactly this action.
     *
     * @param props.sessionId - the row's session.
     * @param props.displayTitle - its title (accessible name).
     * @param props.translate - localized text for this plugin's namespace.
     * @param props.cancelDeletion - inverse Host operation.
     */
    function CancelDeletionRowAction(props) {
      const { sessionId, displayTitle, translate, cancelDeletion: cancel } = props;
      const deleteEnabled = useSyncExternalStore(subscribeFeatures, () => getFeature('deleteSessionsEnabled'));
      const isMarked = useSyncExternalStore(subscribe, () => marked.has(sessionId));
      if (!isMarked || !deleteEnabled) return null;
      const label = translate('row.cancelDeleteSession', '取消删除标记');
      return h(
        'span',
        { className: 'MikufanRowAction' },
        h(
          'button',
          {
            type: 'button',
            className: 'MikufanRowActionButton',
            title: label,
            'aria-label': displayTitle ? `${label}: ${displayTitle}` : label,
            onClick: (event) => {
              event.stopPropagation();
              void cancel(sessionId);
            },
          },
          h(UndoIcon),
        ),
      );
    }

    /** Fallback translate for this plugin's namespace (bound once, read live). */
    function createTranslate(ctx) {
      let bound;
      try {
        bound = ctx.get('locale') === undefined ? undefined : ctx.locale.bind(PACKAGE_NAME);
      } catch {
        bound = undefined;
      }
      return (key, fallback) => {
        if (typeof bound !== 'function') return fallback;
        try {
          const value = bound(key);
          return typeof value === 'string' && value !== key ? value : fallback;
        } catch {
          return fallback;
        }
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const translate = createTranslate(ctx);

        /**
         * Open one skill's SKILL.md in the right Sidebar for reading. Prefers
         * `dsh-better-sidebar`'s native editor tab when that plugin is mounted;
         * otherwise falls back to this plugin's own preview tab. The right
         * Sidebar lives in the Conversation panel, so the panel is revealed
         * first.
         * @param entry - skill entry (id/name/path) or a bare skill id.
         * @returns whether a sidebar open was requested.
         */
        const openSkillInSidebar = (entry) => {
          const id = typeof entry === 'string' ? entry : entry?.id;
          if (typeof id !== 'string' || id === '') return false;
          const path = typeof entry === 'object' && entry !== null && typeof entry.path === 'string' ? entry.path : '';
          const title = typeof entry === 'object' && entry !== null && typeof entry.name === 'string' ? entry.name : id;
          try {
            const layout = ctx.get('layout');
            const uiSession = ctx.get('uiSession');
            const sessionSnapshot = uiSession?.adapter?.current?.getSnapshot?.();
            const currentSessionId = typeof sessionSnapshot?.key === 'string' ? sessionSnapshot.key : '';
            // Prefer dsh-better-sidebar: its editor opens the real SKILL.md.
            const better = ctx.get('betterSidebar');
            const betterEditorEnabled =
              better === undefined ||
              typeof better.isTabEnabled !== 'function' ||
              better.isTabEnabled('editor') !== false;
            if (better !== undefined && betterEditorEnabled && typeof better.openFile === 'function' && path !== '') {
              try {
                let sessionId = currentSessionId;
                if (sessionId === '') {
                  const snapshot = typeof better.getSnapshot === 'function' ? better.getSnapshot() : undefined;
                  if (typeof snapshot?.sessionId === 'string' && snapshot.sessionId !== '') sessionId = snapshot.sessionId;
                }
                if (sessionId !== '') {
                  if (typeof layout?.selectPanel === 'function') layout.selectPanel('conversation');
                  better.openFile({ sessionId }, path, title);
                  return true;
                }
              } catch (error) {
                console.warn('[dsh-mikufan] better-sidebar open failed; falling back:', error);
              }
            }
            // Fallback: this plugin's preview tab in the host's right Sidebar.
            const tabs = ctx.get('sidebarRightTabs') ?? ctx.sidebarRightTabs;
            const sidebarRight = ctx.get('sidebarRight') ?? ctx.sidebarRight;
            if (tabs === undefined || sidebarRight === undefined) return false;
            if (typeof tabs.get === 'function' && tabs.get(SKILL_TAB_KIND) === undefined) return false;
            if (typeof sidebarRight.openTab !== 'function') return false;
            if (currentSessionId === '') return false;
            if (typeof layout?.selectPanel === 'function') layout.selectPanel('conversation');
            const attempt = (remaining) => {
              try {
                sidebarRight.openTab(SKILL_TAB_KIND, { params: { skill: id } });
              } catch (error) {
                if (remaining > 0) {
                  setTimeout(() => attempt(remaining - 1), 120);
                  return;
                }
                console.warn('[dsh-mikufan] could not open the skill preview in the sidebar:', error);
              }
            };
            attempt(8);
            return true;
          } catch (error) {
            console.warn('[dsh-mikufan] could not open the skill preview in the sidebar:', error);
            return false;
          }
        };

        /**
         * Open a new Session with one draft in its composer — the "新建技能"
         * and "立即试用" actions both route through here. The draft is the
         * literal `/name` skill reference the Harness composer resolves, and a
         * stale draft in a reused blank Session is replaced so the reference
         * is what the user actually sees.
         * @param prompt - draft text for the new session.
         * @param options - extra StartSessionOptions, e.g. clearPreviousDraft.
         * @returns whether a new session was requested.
         */
        const startSkillSession = (prompt, options = {}) => {
          try {
            const workspace = ctx.get('uiWorkspace');
            if (workspace === undefined || typeof workspace.startSession !== 'function') return false;
            workspace.startSession(undefined, { ...options, prompt });
            return true;
          } catch (error) {
            console.warn('[dsh-mikufan] could not start a new session:', error);
            return false;
          }
        };

        for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
          ctx.effect(() => ctx.locale.register(PACKAGE_NAME, locale, dictionary), `dsh-mikufan: ${locale} dictionary`);
        }

        // Coming back to the tab is the other moment worth a fresh read.
        ctx.effect(() => {
          const onVisibility = () => {
            if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
            if (features.deleteSessionsEnabled && marked.size > 0) void reconcile();
          };
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
          return () => {
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
            stopPolling();
          };
        }, 'dsh-mikufan: mark reconciliation');

        void hydrate();
        void hydrateFeatures();

        ctx.slots.inject(MENU_SLOT, () =>
          ctx.slots.register(
            {
              name: MENU_SLOT,
              id: 'mikufan-delete-session',
              order: MENU_ORDER,
              inject: () => ({ translate, markForDeletion, cancelDeletion }),
            },
            DeleteSessionMenuItem,
          ),
        );

        ctx.slots.inject(ROW_ACTION_SLOT, () =>
          ctx.slots.register(
            {
              name: ROW_ACTION_SLOT,
              id: 'mikufan-cancel-delete',
              order: ROW_ACTION_ORDER,
              inject: () => ({ translate, cancelDeletion }),
            },
            CancelDeletionRowAction,
          ),
        );

        // The control panel: one sidebar rail entry plus the `main` panel it
        // opens. The shared id is what the layout uses to connect the two.
        // Every feature switch moved here; the former Settings → General rows
        // and the plugin-detail config section are gone.
        ctx.slots.inject(PANEL_LIST_SLOT, () =>
          ctx.slots.register(
            {
              name: PANEL_LIST_SLOT,
              id: CONTROL_PANEL_ID,
              order: PANEL_ORDER,
              label: () => translate('control.panel.label', 'MAGICAL MIRAI'),
            },
            ControlPanelIcon,
          ),
        );
        ctx.slots.inject(MAIN_SLOT, () =>
          ctx.slots.register(
            {
              name: MAIN_SLOT,
              key: CONTROL_PANEL_ID,
              inject: () => ({ translate, openSkillInSidebar, startSkillSession }),
            },
            ControlPanelPage,
          ),
        );

        // The skills preview: one right-sidebar tab type opened by kind, plus
        // its body. Opening a skill from the page passes the id as a navigation
        // param, so the tab needs no Session file address.
        ctx.inject(['sidebarRightTabs'], (scoped) =>
          scoped.sidebarRightTabs.register({
            id: SKILL_TAB_ID,
            kind: SKILL_TAB_KIND,
            priority: 'extension',
            title: () => translate('skills.preview.title', '技能'),
          }),
        );
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: SKILL_TAB_ID,
              inject: () => ({ translate }),
            },
            SkillPreviewTab,
          ),
        );
      },
    };
  },
});
