# dsh-mikufan

DeepSeek Harness 插件包（bundle）。版本 **0.10.3**。

- 包名 / 行 id：`dsh-mikufan`
- 图标：`icon.jpg`
- 显示元数据：`locale/en.json`、`locale/zh.json`
- **六个功能**，开关与管理页统一收在侧栏「控制面板」：
  1. **Delete-sessions（删除会话）**
  2. **Startup animation（开机动画）**
  3. **Local memory（长期记忆）**
  4. **LAN access（局域网访问）**
  5. **Skills（技能）**
  6. **Agent（全局指令）**

曾经拆成两个独立插件（`dsh-mikufan` + `dsh-mikufan-startup-animation`），后按需求撤回：
一个插件包只能有一个浏览器半边，因此两个功能回到同一个插件里，用**内置开关**区分。

## 功能 1：Delete-sessions（删除会话）

### 交互

1. 侧栏会话列表 → 会话行的「⋯」菜单 → 新增一行 **删除会话**（红色、带分隔线，位于「归档」「复制会话 ID」之后）。
2. 选择后该会话进入「待删除」状态：列表中的会话标题出现删除线并转为次要颜色。
3. 待删除的会话只剩**一个**操作：行尾悬停出现的 **取消删除标记** 按钮；原来的「⋯」菜单、归档、置顶三个控件对该行全部收起（其他会话不受影响）。
4. 待删除状态由 Host 持久化（`~/.dsh/dsh-mikufan/delete-sessions.json`），刷新页面后仍然保留。
5. **继续对话即自动还原**：只要用户在被标记的会话里又发了一条消息（会话日志追加 `user/message`），
   标记立刻被静默清掉——没有提示、没有弹窗，删除线自己消失，该会话重新按普通会话处理。
6. **下次启动 Harness 时**，所有仍然保持待删除的会话被真正删除（含磁盘文件）：
   - 会话日志目录 `~/.dsh/sessions/<工作区>/<会话 ID>/`（含 `session.v4.jsonl.zstd`）
   - 投影缓存 `~/.dsh/storages/session_projcache/sessions/<会话 ID>.json`
   - 工作区登记表 `~/.dsh/storages/workspace.json` 中的 `sessionIds` / `archivedSessionIds` / `pinnedSessionIds` 引用（存在活动 storage domain 时通过 domain 写入，否则直接改写文件）
   - 正在运行/被占用的会话会被跳过并保留标记，下次启动重试；删除失败同样保留标记。

### 开关（内置）

- **控制面板 → 仪表页「删除会话」卡片**（默认开，立即生效）：
  - 关闭后：会话「⋯」菜单里的删除入口与行尾「取消删除标记」按钮消失，已有的删除线样式清除，
    停止对账轮询，并且**下次启动不再执行删除清扫**（已标记的会话保留，数据不动）。
  - 重新打开后：菜单入口恢复，并立即与 Host 对账一次，恢复显示待删除状态。

## 功能 2：Startup animation（开机动画）

素材：用户提供的 `D:\Mikufan\Documents\deepseek-harness\dsh-splash\index.html`（5 秒「光点汇聚」，
自包含 HTML + Canvas 2D，无外部资源）。包内的 `splash/index.html` 与素材**逐字节一致**
（SHA-256 `80da47cfef444a70addb107e510c7ed3210409c682519a72548a9862aa47c5e3`）。

### 交互

1. **在应用渲染之前**铺满全屏播放一次：640 颗光点汇聚成 DeepSeek 鲸标，定格在结束帧，
   约 0.65 秒后淡出（0.5 秒）露出已经加载好的 Harness 界面。
2. 每次**完整页面加载**播放一次（打开、刷新、新标签页）；SPA 内切换会话不重播。
3. **跳过**：点击画面任意位置，或按 `Esc`，覆盖层立即淡出。
4. **控制面板 → 仪表页「启动动画」卡片**：开关（默认开），修改在**下次刷新页面**生效。
5. **减少动态效果**（`prefers-reduced-motion: reduce`）：不播放粒子动画，直接呈现结束帧，
   短暂停留后淡出。
6. 调试：URL 加 `?mikufan-splash=off` 可对**这一次加载**关闭；后台标签页加载时自动不播放。
7. 动画页可直接访问 `/mikufan/splash` 预览，独立模式保留素材自带的重播 / 全屏控件。

### 实现

| 半边 | 文件 | 说明 |
| --- | --- | --- |
| Host | `splash.js` | `webserver/index-inject` 的三行注入（样式 / 覆盖层 / 引导脚本）、`GET /mikufan/splash`（ETag、304、HEAD、信任栅栏）、素材读取与组合缓存 |
| Host | `index.js` | `DeleteSessionStore` + `PreferencesStore`（三个内置开关：删除会话 / 启动动画 / 长期记忆，同步读、串行原子写）+ `GET/POST /mikufan/api/preferences` + 挂载路由 |
| Client | `client.js` | 控制面板仪表页的功能卡（宿主同款 `role="switch"` 结构与 token 样式；图标 + 标题行开关 + 页脚状态）+ 偏好读取 / 乐观写入 / 失败回滚 + 按 `deleteSessionsEnabled` 门控删除功能 UI；旧设置页与插件详情页入口已移除 |
| 素材 | `splash/index.html` | 用户素材原样副本 |
| 素材 | `splash/embed-bridge.html` | 只在**服务时**插入到 `</body>` 前的嵌入桥；素材文件本身不被改写 |

Host 端点（同源 `fetch`，与侧栏插件同样的 Host/Origin 信任栅栏）：

```
GET  /mikufan/api/marked            -> { ok: true, value: { ids: [sessionId...] } }
POST /mikufan/api/mark    {sessionId} -> { ok: true, value: { ids, changed } }
POST /mikufan/api/unmark  {sessionId} -> { ok: true, value: { ids, changed } }

GET  /mikufan/api/preferences                          -> { deleteSessionsEnabled, splashEnabled, memoryEnabled }
POST /mikufan/api/preferences {deleteSessionsEnabled?,  -> { deleteSessionsEnabled, splashEnabled, memoryEnabled, changed }
                              splashEnabled?, memoryEnabled?}

GET  /mikufan/splash                -> 组合后的 HTML（iframe 使用；ETag / 304 / HEAD）
```

偏好文件：`~/.dsh/dsh-mikufan/preferences.json`（`{ version: 3, deleteSessionsEnabled, splashEnabled, memoryEnabled, updatedAt }`，原子写；
读取兼容旧版仅有 `splashEnabled` / 无 `memoryEnabled` 的文件）。

设计要点：

- 删除线不依赖任何「行内挂载」：本包注入一条按 `data-row-key="session:<id>"` 定位的规则，
  只作用于该行标题的 `_title` 元素（或第二个 `span` 回退），因此会话运行中、已归档时同样生效，
  不使用代价高昂的 `:has()`，也不改写其他插件的 DOM。
- 已标记的行只保留一个控件：同一套按 id 生成的规则把该行 `.rowActions` 里的「⋯」触发器、
  归档、置顶按钮（三者共用 `_iconButton` 类）隐藏，本包在 `sidebar.workspaces.session.row.action`
  注册的「取消删除标记」是唯一可见项；文案、图标、悬停行为与宿主行按钮一致。
- 标记集合归属 Host，Client 首屏读取一次后乐观更新，失败回滚。
- 自动还原是**静默**的：Host 订阅 `session/event`，在该会话提交 `user/message` 时清掉标记并落盘，
  不弹任何提示；Client 在「有待删除标记」期间每 2 秒与 Host 对账一次（没有标记时不发请求），
  回到标签页时也会立即对账，因此删除线会自己消失。
- 清扫只在**进程启动后的第一次激活**执行（进程内一次性声明），避免改配置/热重载时提前删掉用户
  刚标记的会话；`deleteSessionsEnabled` 关闭时直接跳过清扫。
- 开机动画覆盖层不能由 Client half 挂载：它要覆盖 React shell 出现之前的空白期。因此 Host 订阅
  `webserver/index-inject`，把三行注入渲染到 `<body>` 开头，浏览器解析到它们时应用模块还没执行；
  iframe 并行加载 `/mikufan/splash`，应用在覆盖层下方正常启动。**Fail-open**：iframe 7 秒内没有
  `ready` 就直接移除覆盖层，不会把用户锁在黑屏里。
- 三个功能开关（删除会话 / 启动动画 / 长期记忆）都只在侧栏「控制面板」的仪表页渲染，
  与 Host 偏好读写同一份文件；设置页与插件详情页的旧入口已移除。
- 客户端文案走 client locale 服务（命名空间 `dsh-mikufan`，zh/en 两套）。

## 功能 3：Local memory（长期记忆）

Agent 的**纯本地**长期记忆（零依赖外部服务，存 `~/.dsh/dsh-mikufan/memory.json`，不上传）。

### Agent 侧：四个工具

| 工具 | 作用 |
| --- | --- |
| `memory_write` | 写一条事实（可选 `type`，或带 `id` 更新既有条目）。返回语义相近的既有条目，提示 Agent 用 UPDATE 代替 ADD（Mem0 式「检索-再决策」；本引擎自身不静默合并） |
| `memory_search` | 关键词检索（中英文均可；中文走 bigram + 单字覆盖，无需分词依赖） |
| `memory_list` | 列出全部记忆（可按 type 过滤） |
| `memory_delete` | 按 id 删除一条 |

- 条目类型（Claude Code auto-memory 四分类）：`user`（用户角色/偏好）、`feedback`（行为纠正）、
  `project`（项目决策/进行中工作，**明确排除可从代码库推导的内容**）、`reference`（外部资料指引）。
- 工具描述已写入使用准则：不存密钥/凭据/临时任务状态；效果层用 harness 的 `defineTool` 编译 schema 并校验参数。
- 上限保护：最多 200 条（超出拒绝写入并提示清理）、单条 ≤2000 字符。

### 注入：会话记忆索引

每个会话的 system prompt 通过 `systemPrompt.context`（order 150，紧随运行时上下文）自动携带
`indexText()` 生成的紧凑索引（每条一行、`[type] content` 截断至 160 字符，最多 40 条，超出时
提示改用 `memory_search`）。空库、功能关闭或条目被停用时注入空文本（框架丢弃空 context）。

### WebUI：「控制面板 → 记忆」页

记忆管理是侧栏「控制面板」的第二个子页（与「控制面板」「局域网访问」共用同一套卡片语言）：
浮动胶囊标签栏切换页面，页面标题下是记忆卡片网格。

- **卡片网格**（两列，窄屏单列）：每页第一张卡片永远是**空白卡**——虚线描边、中间一个 `+`，
  点开「新建记忆」弹窗；
- **计数行右对齐搜索与刷新**：左侧「共 N 条记忆 · M 条启用」，右侧是胶囊搜索框（按内容、
  类型标签、来源即时过滤卡片；过滤时计数后追加「· 匹配 N」）和圆形刷新按钮（重新读一次 Host，
  读取中图标旋转；失败会显示读取失败提示）；
- **每条记忆一张圆角矩形卡片**：标题行是类型标签（用户 / 纠正 / 项目 / 参考）、来源（Agent / 手动）
  与启用开关（`role="switch"`，与仪表页开关同一控件）；正文只显示**前三行**（CSS `-webkit-line-clamp`，
  点击正文即打开编辑弹窗看全文）；页脚状态栏固定两个动作：**编辑**（铅笔）与**删除**（叉号，
  第一下变为「确认删除」，3 秒后自动复位），右侧是「更新于 MM-DD HH:mm」；
- **新建 / 编辑都是弹窗**（`react-dom` 的 `createPortal` 挂到 `document.body`，复用宿主弹窗语言：
  遮罩用 `--dsw-alias-bg-mask-1` + 4px 模糊，面板用 `--dsw-alias-bg-layer-2` + `--dsw-radius-panel` +
  `--dsw-elevation-prominent`）。弹窗内是内容文本框（2000 字上限计数、超限标红、`Ctrl/Cmd+Enter` 保存）、
  四个类型芯片，以及「取消 / 创建（保存）」；`Esc`、点遮罩、右上角叉号都能关闭，保存中不响应关闭；
- 停用的条目仍在网格里，正文变灰、开关关闭（停用=保留但不注入索引）；
- 全部操作走乐观更新 + 失败回滚；读写走 Host HTTP 端点（同源 + 信任栅栏，与侧栏其他端点一致）。

### 开关（内置）

- **控制面板 → 仪表页「记忆」卡片**（默认开，立即生效）：关闭后工具集卸载、索引注入为空、
  侧栏面板显示「off」状态但已存数据不删除；重新打开即恢复。

### 实现与端点

| 半边 | 文件 | 说明 |
| --- | --- | --- |
| Host | `memory.js` | `MemoryStore`（原子写 JSON 文档）、`similarity`/`queryTerms`（关键词+bigram 检索）、`createMemoryTools`（四个工具定义）、`indexText`（索引生成，40 条/160 字符上限） |
| Host | `index.js` | 偏好开关 `memoryEnabled`（preferences v3）+ 工具注册（`ctx.tools.register`，按开关门控）+ `systemPrompt.context` 注入 + memory 路由 |
| Client | `client.js` | 控制面板的「记忆」子页（`MemoryPageBody`：卡片网格 + `MemoryAddCard` 空白卡 + `MemoryCard` 条目卡 + `MemoryDialog` 新建/编辑弹窗）+ 仪表页的记忆开关与计数页脚 + 记忆 store（乐观更新） |

Host 端点（同源 fetch）：

```
GET    /mikufan/api/memory                -> { ok: true, value: { entries } }
POST   /mikufan/api/memory   {content, type?} -> { ok: true, value: { entry } }
PATCH  /mikufan/api/memory/<id> {content?, type?, enabled?} -> { ok: true, value: { entry } }
DELETE /mikufan/api/memory/<id>           -> { ok: true, value: { deleted, id } }
```

记忆文档：`~/.dsh/dsh-mikufan/memory.json`（`{ version: 1, entries: [...], updatedAt }`，原子写；
条目 `{ id, content, type, source: 'agent'|'manual', enabled, createdAt, updatedAt }`）。

设计要点：

- **不静默合并**：`memory_write` 只返回 top-3 相近条目（阈值 0.34）由模型决策；与 Claude Code
  一致，覆盖/删除都是显式动作（带 id 更新、memory_delete、面板删除）。
- **停用而非删除**：面板和工具都支持 `enabled: false`——过期记忆退出索引但保留数据，可随时恢复。
- 工具按 `isConcurrencySafe: true` 声明可并行（写路径经 store 内部串行写链保护）。

## 功能 4：LAN access（局域网访问）

第二条监听（默认 3090）免 token 反向代理到本机 127.0.0.1 入口：代理自己持有回环会话
cookie，LAN 设备直接打开即可；本机入口与登录方式不变。纯明文 HTTP，只适合可信网络。

### WebUI：「控制面板 → 局域网访问」页

四张卡片，与仪表页同一套卡片语言（2×2 网格，窄屏单列；第一行是开关 + 它管辖的上限，
第二行是地址与端口）：

| 卡片 | 作用 | 页脚状态 |
| --- | --- | --- |
| 局域网访问 | 开关（与仪表页功能卡一模一样：48px 图标 + 标题行开关 + 描述 + 页脚）；说明「需手动开启」 | 已开启 `http://ip:port`（带复制）/ 未开启 / 启动失败原因 |
| 最大连接数 | **按 IP 计，0 表示不限**，上限 256 | 当前不限制设备数 / 当前上限 N 台设备 · 已连接 M |
| IP 地址 | 自动探测 / 检测到的地址 / 手动输入 | 自动探测：地址，或 手动指定：地址 |
| 端口 | **默认 3090**（1–65535） | 当前端口 N |

- 开关与下拉立即生效（Host 重启代理）；数字输入与手动 IP **失焦即保存**（Enter 等同失焦），
  非法值就地标红且不会提交。
- 页面文案按简化稿收敛：副标题「局域网快速访问」，三张可编辑卡的说明分别是
  「需手动开启」「按 IP 计，0 表示不限」「默认 3090」；原顶部安全提示条已移除。

### 偏好与实现

- 偏好文件 `~/.dsh/dsh-mikufan/lan-preferences.json`，字段
  `lanAccessEnabled / lanHost / lanPort / lanMaxConnections`（version 1；旧文件缺
  `lanMaxConnections` 时按 0 处理）；从旧 `dsh-lan-access` 升级时读穿旧偏好文件。
- **每次启动 dsh 后开关默认关闭**：启动时若文件里的 `lanAccessEnabled` 为 true，Host 会把它写回
  false 并且不启动代理；`lanHost / lanPort / lanMaxConnections` 保留，需要在控制面板或局域网页面
  手动开启。`GET lan/status` 返回的开关也会以「本次进程是否手动开启」为准。
- **最大连接数按设备（peer IP）计**：同一 IP 的多条 keep-alive / SSE / WebSocket 连接共用一个
  名额；超出上限的**新设备**先收到 503 JSON（`code: too-many-devices`），其请求不会被转发到
  本机入口。改设置会重启代理并重置计数。
- 端点：`GET /mikufan/api/lan/status`、
  `POST /mikufan/api/lan/preferences {lanAccessEnabled?, lanHost?, lanPort?, lanMaxConnections?}`。

## 功能 5：Skills（技能）

Harness 本身不带技能目录：插件启动时**创建 `~/.dsh/skills`**（`DSH_HOME` 下的 `skills`，
即 skill provider 的 `user-dsh` 根），并把插件自带的 **`skill-creator`** 技能安装进去——
首次运行复制一次，之后**绝不覆盖**用户改过的版本；`<dshHome>/dsh-mikufan/bundled-skills.json`
记录安装事实，用户卸载该技能后不会再被自动装回。

自带的 `skill-creator` 已针对本 Harness 改写：技能目录指向 `~/.dsh/skills`，开关用
`disable-model-invocation`，并注明 `agents/openai.yaml` 与 PyYAML 脚本只对 Codex 有效。

### WebUI：「控制面板 → Skills」页

- 与「记忆」同构的卡片网格：第一张是**新建技能卡片**（虚线 + 加号），其余每张是一枚技能卡；
- 卡片**不用图标**：第一行是技能名（kebab-case 目录名 / frontmatter `name`），第二行是描述
  （两行截断）；标题行右侧是**开关**，页脚是**打开**与**详情**；
- 计数行右侧有**搜索技能**（与记忆页同一套胶囊搜索框：按技能名/描述即时过滤，过滤时追加
  「· 匹配 N」）和刷新按钮；左侧显示「共 N 个技能」与管理根目录的绝对路径；
- **开关 = `disable-model-invocation`**：开（默认）表示模型可见；关只写一个 frontmatter 标志，
  文件保留、模型目录里不再出现；
- **新建技能**：先确保根目录与 `skill-creator` 存在，然后**新开一个会话**，输入框里只预填
  一个 `/skill-creator` 技能引用（与手动输入 `/` 选技能完全一致）——真正的创建由 skill-creator
  引导，用户补充需求后自己发送；复用的空白会话里若有旧草稿会被这条引用替换；
- **打开**：与「立即试用」同一条路径——**新开一个会话**，输入框只预填该技能的 `/技能名` 引用
  （复用空白会话时替换旧草稿），不自动发送；
- **详情**：参考图样式的浮层——标题 / 描述 / 开关 /「⋯」菜单（在文件资源管理器中显示、复制
  Markdown）/ 关闭，正文是渲染后的 SKILL.md，页脚是**卸载**（二次确认，删除整个技能目录）与
  **立即试用**（新会话只预填该技能的 `/技能名` 引用）。
- **仪表页摘要卡**：控制面板首页有一张 Skills 卡（无开关），页脚显示
  「启用了 x 个技能，共 Y 个」，挂载时读取技能列表，无需先进入 Skills 页。

### 实现与端点

- `skills.js`：`splitSkillDocument` / `readSkillFrontmatter`（解析顶层标量与 `>`/`|` 块标量）、
  `summarizeSkill`（与 provider 同样严格：kebab-case 名、必需描述、拒绝 camelCase 调用键、
  非法布尔值——无效技能不列出）、`createSkill`、`setSkillEnabled`（文本级改写
  `disable-model-invocation`，保留其余 frontmatter、正文与换行风格）、`removeSkill`、
  `listSkills`（bundle 优先、符号链接跟随、不可解析的 id 不列出）、`installBundledSkill`。
  写入均为临时文件 + rename 的原子写。
- 端点：`GET /mikufan/api/skills`、`GET|PATCH|DELETE /mikufan/api/skills/<id>`、
  `POST /mikufan/api/skills/<id>/reveal`、`POST /mikufan/api/skills/ensure`。

## 功能 6：Agent（全局指令）

编辑 **Harness 每次会话都会加载的全局指令文件** `<DSH home>/AGENTS.md`（默认 `~/.dsh/AGENTS.md`）——
也就是 `@deepseek-ai/dsh-agent-instructions` 解析的用户全局指令链；仓库/项目里的 `AGENTS.md`
仍然照常叠加生效。

### WebUI：「控制面板 → Agent」页

- 页面只有一个**文本框**（默认空白），占位提示 `[添加自定义指令...]`；
- 文本框下方左侧显示该文件的绝对路径，右侧是**保存**按钮（`Ctrl/Cmd+Enter` 同效）；
- 打开页面时先读取文件：已有内容会填进文本框便于继续编辑；文件不存在就是空白（正常状态）；
- 点保存把**整段文本**写入 `~/.dsh/AGENTS.md`（UTF-8，原样保存），成功后提示「已保存」；
- **清空后保存会移除该文件**（相当于撤销全局指令）；保存失败保留用户输入并提示重试；
- 文本框上限 64 Ki 字符，写入为就地覆盖（保持符号链接指向，适配 dotfiles 仓库）。
- **仪表页摘要卡**：控制面板首页有一张 Agent 卡（无开关），页脚显示「上次更新时间：10-23 22:05」，
  取 `~/.dsh/AGENTS.md` 的修改时间；文件不存在时显示「上次更新时间：—」。

### 实现与端点

| 半边 | 文件 | 说明 |
| --- | --- | --- |
| Host | `agent.js` | `readAgentInstructions`（缺失文件=空白、去 BOM）、`saveAgentInstructions`（类型/长度校验、空文本删除、就地写 UTF-8） |
| Host | `index.js` | `GET/POST /mikufan/api/agent` 路由 + `agentHome`（`resolveDshHome()`） |
| Client | `client.js` | 控制面板的「Agent」子页（`AgentPageBody`：单个文本框 + 路径 + 保存按钮 + 状态提示）与独立样式表 `agent-panel.css` |

```
GET  /mikufan/api/agent            -> { ok: true, value: { path, exists, content, updatedAt } }
POST /mikufan/api/agent {content}  -> { ok: true, value: { path, exists, content, bytes, updatedAt, saved } }
                                      （content 为空白时删除文件：{ exists: false, removed: true, updatedAt: '' }）
```

## 验证

> 测试套件（`tests/`）与交接文档（`HANDOFF.md`）仅保留在本地，不随本仓库发布；以下命令在插件根目录可用。

```powershell
node tests/sweep.test.mjs    # Host：清扫、存活会话跳过、两种登记表路径、继续对话还原、路由契约
node tests/client.test.mjs   # Client：菜单行、行悬停按钮、样式规则、三个开关的写入/回滚/门控、面板注册、记忆卡片网格与新建/编辑弹窗、搜索与刷新、局域网四卡片页、Skills 卡片/详情/新建技能引用、Agent 单文本框页、仪表页 Skills/Agent 摘要卡与页脚
node tests/skills.test.mjs   # 技能：解析/列表/创建/开关/删除/内置安装 + skills 路由
node tests/agent.test.mjs    # 全局指令：空白读取/BOM/原样写入/清空移除/长度上限/更新时间 + agent 路由
node tests/splash.test.mjs   # 动画：注入行、组合文档、路由契约、偏好读写、preferences API
node tests/memory.test.mjs   # 记忆：store 生命周期、检索语义、四个工具契约、索引上限、memory 路由
node tests/lan.test.mjs      # 局域网：连接数上限校验、偏好读写与旧文件读穿、真实 socket 的上限拒绝/释放
```

七个脚本都只操作临时目录或桩对象，不会触碰真实的 `~/.dsh`。

## 已知边界（0.10.3）

- 删除在**下次启动**时执行，当前进程内不会立刻消失（这是本组件约定的语义）；插件热重载不触发清扫。
- 若某会话在标记后仍被 Harness 保持打开，重启后该会话会被删除，属于预期行为；只要期间再发一条消息
  就会自动还原，从而保留下来。
- 删除线依赖工作区侧栏的行属性 `data-row-key` 与标题类名中的 `_title` 片段；收起三控件依赖
  宿主行按钮共用的 `_iconButton` 类名。上游大幅改版时样式可能失效（不会报错，也不会影响其他功能）。
- 会话级联数据（附件 blob 等）不在此清理范围内；附件按内容哈希共享，删除会话不会删除 blob。
- 动画是**页面级**的：只在完整页面加载时出现；SPA 内导航、客户端 HMR 热更新不重播。
- 动画固定使用素材的近黑舞台，不跟随 Harness 明暗主题（开机画面是品牌帧，不是应用界面）。
- 「开机动画」开关只对**后续页面加载**生效；「删除会话」开关对 Host 立即生效，浏览器 UI 的增减
  在下次页面刷新后生效。
- 六个功能共用一个插件：插件管理页里是一张卡片、一行组件；各功能开关在侧栏「控制面板」仪表页。
- 记忆检索是关键词/bigram 级别的，不是向量语义检索；改写幅度大的中英文混合表述可能漏召回
  （`memory_write` 的相近条目提示只是辅助，不构成保证）。v2 可引入 embedding。
- 记忆索引每条截断 160 字符、上限 40 条；超出的条目仍在库里，但模型只能通过 `memory_search` 看到它们。
- 「长期记忆」开关关闭时工具与索引立即下线（HMR 重激活生效）；侧栏面板仍可查看/管理已存数据。
- Agent 页只编辑**用户全局**文件 `~/.dsh/AGENTS.md`；项目/仓库里的 `AGENTS.md` 由 Harness 自动叠加，
  本页不读取也不修改它们（页面副标题已说明「代码仓库的说明也可能适用」）。
- 全局指令在会话的**下一次请求**才进入上下文：`dsh-agent-instructions` 不监听外部编辑，已经带过
  指令基线的会话要等下一次请求/恢复会话才重新对账；新会话立即生效。
- 清空文本框后保存是**删除文件**（不是写一个空文件）；文件被其他程序占用时保存会失败，输入保留在页面上。
