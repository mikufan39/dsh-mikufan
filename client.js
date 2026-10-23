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
 * Feature 3, "Control panel":
 * - One sidebar rail entry ("控制面板") opening the central panel under the id
 *   `mikufan-control-panel`. A floating pill tab bar (per the redesigned
 *   control-panel draft) switches between six pages:
 *   - 控制面板: one card per built-in feature switch (delete-sessions, startup
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
 *   - Skills / MCP: the skill manager and the MCP placeholder.
 *   - Agent: one text box editing the user-global `<DSH home>/AGENTS.md` the
 *     Harness loads for every project; Save writes it, blank text removes it.
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
        'deleteFeature.description': '被删除的会话将在下次启动时删除，停用此功能删除不再执行。',
        'deleteFeature.pending.none': '下次启动不会删除任何会话',
        'deleteFeature.pending.some': '下次启动将删除 {count} 个会话',
        'deleteFeature.pending.off': '已关闭，下次启动不执行删除清扫',
        'splash.title': '启动动画',
        'splash.description': '一切皆插件。',
        'splash.pending.off': '已停用，页面加载将不再播放动画',
        'splash.pending.on': '每次加载页面时播放',
        'memoryFeature.title': '记忆',
        'memoryFeature.description': 'Agent 的本地长期记忆，每个会话自动携带记忆索引',
        'memoryFeature.pending.none': '已保存 {count} 条记忆',
        'memoryFeature.pending.off': '已保存 {count} 条记忆（当前已停用）',
        'lanFeature.title': '局域网访问',
        'lanFeature.description': '允许局域网设备访问到 Harness',
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
        'feature.error': '保存失败，请重试。',
        'control.panel.label': '控制面板',
        'control.panel.title': '控制面板',
        'control.panel.subtitle': '更改设置并对插件的功能自定义。',
        'control.panel.tab.dashboard': '控制面板',
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
        'mcp.tab.subtitle': '配置 Model Context Protocol 服务器连接。',
        'mcp.placeholder.title': '暂无服务器',
        'mcp.placeholder.text': '添加 MCP 服务器后，可在此查看连接状态与可用工具。',
        'memory.tab.title': '记忆',
        'memory.tab.subtitle': 'Agent 跨会话记住的持久事实，纯本地存储。',
        'memory.offNotice': '长期记忆功能当前已关闭，可在「控制面板」页开启。',
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
        'deleteFeature.description': 'Marked sessions are deleted at the next startup; disabling this feature stops the sweep.',
        'deleteFeature.pending.none': 'No sessions will be deleted on next startup',
        'deleteFeature.pending.some': '{count} session(s) will be deleted on next startup',
        'deleteFeature.pending.off': 'Disabled — no sweep on next startup',
        'splash.title': 'Startup animation',
        'splash.description': 'Everything is a plugin.',
        'splash.pending.off': 'Disabled — page loads play no animation',
        'splash.pending.on': 'Plays on every page load',
        'memoryFeature.title': 'Memory',
        'memoryFeature.description': 'The agent\'s local long-term memory; every session carries a memory index',
        'memoryFeature.pending.none': '{count} memories saved',
        'memoryFeature.pending.off': '{count} memories saved (currently disabled)',
        'lanFeature.title': 'LAN access',
        'lanFeature.description': 'Let devices on the LAN reach the Harness',
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
        'feature.error': 'Could not save. Try again.',
        'control.panel.label': 'Control panel',
        'control.panel.title': 'Control panel',
        'control.panel.subtitle': 'Change settings and customize the plugin\'s features.',
        'control.panel.tab.dashboard': 'Control panel',
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
        'mcp.tab.subtitle': 'Configure Model Context Protocol server connections.',
        'mcp.placeholder.title': 'No servers yet',
        'mcp.placeholder.text': 'Added MCP servers show their connection status and tools here.',
        'memory.tab.title': 'Memory',
        'memory.tab.subtitle': 'Durable facts the agent remembers across sessions, stored locally.',
        'memory.offNotice': 'Long-term memory is currently off. Enable it on the Control panel page.',
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

    /** Reveal one SKILL.md in the platform file manager. */
    async function revealSkillViaHost(id) {
      return callHost(`skills/${encodeURIComponent(id)}/reveal`, { method: 'POST', headers: { accept: 'application/json' } });
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

    /** 48px globe for the IP-address card. */
    function IpIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 8.2 }),
        h('path', { d: 'M3.8 12h16.4' }),
        h('ellipse', { cx: 12, cy: 12, rx: 3.6, ry: 8.2 }),
      );
    }

    /** 48px wall-socket glyph for the port card. */
    function PortIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3 }),
        h('circle', { cx: 9.6, cy: 11, r: 1 }),
        h('circle', { cx: 14.4, cy: 11, r: 1 }),
        h('path', { d: 'M9.8 14.8h4.4' }),
      );
    }

    /** 48px devices glyph for the connection-cap card. */
    function DevicesIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 2.6, y: 4.6, width: 12.2, height: 8.8, rx: 1.4 }),
        h('path', { d: 'M6.6 17.4h4.2' }),
        h('path', { d: 'M8.7 13.4v4' }),
        h('rect', { x: 16.4, y: 7.6, width: 5, height: 12, rx: 1.3 }),
        h('path', { d: 'M17.9 17.3h1.1' }),
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
      { id: 'dashboard', key: 'control.panel.tab.dashboard', fallback: '控制面板' },
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

    /** 48px crescent glyph for the startup-animation card. */
    function SplashIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M20 13.5A8 8 0 1 1 10.5 4 6.5 6.5 0 0 0 20 13.5z' }),
        h('path', { d: 'M17 4.5l.5 1.5 1.5.5-1.5.5L17 8.5l-.5-1.5L15 6.5l1.5-.5z', fill: 'currentColor', stroke: 'none' }),
      );
    }

    /** 48px brain glyph for the memory card. */
    function MemoryIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M12 4.5a2.8 2.8 0 0 0-2.7 2A2.8 2.8 0 0 0 6.4 9a3 3 0 0 0-1.4 5.4A2.9 2.9 0 0 0 8 19a2.9 2.9 0 0 0 4 1.1V4.5z' }),
        h('path', { d: 'M12 4.5a2.8 2.8 0 0 1 2.7 2A2.8 2.8 0 0 1 17.6 9a3 3 0 0 1 1.4 5.4A2.9 2.9 0 0 1 16 19a2.9 2.9 0 0 1-4 1.1' }),
        h('path', { d: 'M9.3 8.5c.8.4 1.3 1 1.4 2M9 12.6c.9.2 1.5.7 1.9 1.5' }),
        h('path', { d: 'M14.7 8.5c-.8.4-1.3 1-1.4 2M15 12.6c-.9.2-1.5.7-1.9 1.5' }),
      );
    }

    /** 48px network glyph for the LAN-access card. */
    function LanIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 9, y: 3, width: 6, height: 6, rx: 1.2 }),
        h('rect', { x: 3, y: 15, width: 6, height: 6, rx: 1.2 }),
        h('rect', { x: 15, y: 15, width: 6, height: 6, rx: 1.2 }),
        h('path', { d: 'M12 9v3' }),
        h('path', { d: 'M6 15v-1.5a1.5 1.5 0 0 1 1.5-1.5h9a1.5 1.5 0 0 1 1.5 1.5V15' }),
      );
    }

    /** 48px sparkles glyph for the Skills summary card. */
    function SkillsIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M11 3.8l1.6 4.2 4.2 1.6-4.2 1.6L11 15.4l-1.6-4.2L5.2 9.6l4.2-1.6z' }),
        h('path', { d: 'M18 14.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z' }),
      );
    }

    /** 48px terminal glyph for the Agent summary card. */
    function AgentIcon() {
      return h(
        'svg',
        { width: 48, height: 48, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 4.8, width: 18, height: 14.4, rx: 2 }),
        h('path', { d: 'M7.2 9.8l2.9 2.4-2.9 2.4' }),
        h('path', { d: 'M12.6 14.6h4.2' }),
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
            h('p', { className: 'MikufanCpCardDesc' }, translate('lanFeature.description', '允许局域网设备访问到 Harness')),
            failed
              ? h('div', { className: 'MikufanCpCardError', role: 'alert' }, translate('lan.saveFailed', '保存失败，请重试。'))
              : null,
          ),
        ),
        h(LanPendingFooter, { translate }),
      );
    }

    /** The dashboard page: four switch cards plus the Skills / Agent summary cards. */
    function DashboardPage({ translate }) {      return h(
        'div',
        { role: 'tabpanel', 'aria-label': translate('control.panel.tab.dashboard', '控制面板') },
        h(PageHead, {
          translate,
          titleKey: 'control.panel.title',
          fallbackTitle: '控制面板',
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
            fallbackDescription: '被删除的会话将在下次启动时删除，停用此功能删除不再执行。',
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
            ? h('div', { className: 'MikufanMemoryNotice', role: 'status' }, translate('memory.offNotice', '长期记忆功能当前已关闭，可在「控制面板」页开启。'))
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

    /** One not-yet-built feature page: heading + placeholder card. */
    function PlaceholderPage(props) {
      const { translate, tabId, tabFallback, titleKey, fallbackTitle, subtitleKey, fallbackSubtitle, phTitleKey, fallbackPhTitle, phTextKey, fallbackPhText } = props;
      return h(
        'div',
        { role: 'tabpanel', 'aria-label': translate(tabId, tabFallback) },
        h(PageHead, { translate, titleKey, fallbackTitle, subtitleKey, fallbackSubtitle }),
        h(
          'div',
          { className: 'MikufanCpPlaceholder' },
          h('div', { className: 'MikufanCpPlaceholderGlyph' }, '···'),
          h('h2', { className: 'MikufanCpPlaceholderTitle' }, translate(phTitleKey, fallbackPhTitle)),
          h('p', { className: 'MikufanCpPlaceholderText' }, translate(phTextKey, fallbackPhText)),
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
            { className: 'MikufanCpTopbar', role: 'tablist', 'aria-label': translate('control.panel.label', '控制面板') },
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
                    : h(PlaceholderPage, {
                      translate,
                      tabId: 'control.panel.tab.mcp',
                      tabFallback: 'MCP',
                      titleKey: 'mcp.tab.title',
                      fallbackTitle: 'MCP',
                      subtitleKey: 'mcp.tab.subtitle',
                      fallbackSubtitle: '配置 Model Context Protocol 服务器连接。',
                      phTitleKey: 'mcp.placeholder.title',
                      fallbackPhTitle: '暂无服务器',
                      phTextKey: 'mcp.placeholder.text',
                      fallbackPhText: '添加 MCP 服务器后，可在此查看连接状态与可用工具。',
                    }),
        ),
      );
    }

    /** A 16px sliders glyph for the sidebar rail entry. */
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
            strokeWidth: 1.3,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('path', { d: 'M2.5 5h5.5' }),
          h('path', { d: 'M11.9 5h1.6' }),
          h('circle', { cx: 9.7, cy: 5, r: 1.7 }),
          h('path', { d: 'M2.5 11h1.6' }),
          h('path', { d: 'M7.9 11h5.6' }),
          h('circle', { cx: 6.1, cy: 11, r: 1.7 }),
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
              label: () => translate('control.panel.label', '控制面板'),
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
