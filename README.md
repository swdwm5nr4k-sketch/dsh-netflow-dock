# dsh-netflow-dock

DSH 服务器流量监测插件 —— 在**输入框下方**（composer dock）常驻一行实时上下行速率。

```
↓ 1.24 MB/s   ↑ 342 KB/s
```

鼠标悬停可看到累计上下行流量、采样次数，以及读取失败时的错误原因。
数据来自 Linux 内核的网卡计数器，**重启 DSH 后自动装载，不需要重新定义、重新授权**。

这是一个**双面插件**：

| 半边 | 文件 | 做什么 |
| --- | --- | --- |
| 宿主半 | `lib/index.js` | 每秒读一次 `/proc/net/dev`，把计数器增量换算成速率，经精确路由 `GET /netflow-dock/snapshot` 提供 JSON |
| 浏览器半 | `lib/client.js` | 向 `conversation.composer.dock` 注册一格，每 2 秒轮询上面那条路由并渲染读数 |

---

## 前置要求

- **Linux**：依赖 `/proc/net/dev`。macOS / Windows 上宿主半会返回 `{ ok: false, error: … }`，插件不会崩，但没有数据。
- **Node.js ≥ 20**。
- **DSH**，并且目标 profile 是 Web 表面（`dsh web` / `dsh --profile web`）。
  本插件只贡献浏览器界面，headless / tui profile 上没有意义。
- 本包**没有构建步骤**（`lib/` 里就是可直接运行的纯 JS），所以不需要 `pnpm approve-builds`。
- `@deepseek-ai/cordis` 由 DSH 运行时自带，无需单独安装。

下文用默认 profile 名 `web`；如果你用的是别的 profile，把 `--profile web` 和路径里的 `web` 一起换掉。

---

## 安装

装一个 DSH 静态插件分两件事：**把包装进 profile 的 `node_modules`**，再**让 profile 的 Loader 配置树里出现一行指向它**。
本包不去自动改你的 profile 配置（不声明 `dsh.bundle`），所以第二步要你手动加一行——好处是它绝不会悄悄改动你的 profile。

### 第 1 步 · 把包装进 profile

**方式 A：直接从 GitHub 装（推荐）**

```bash
dsh plugin --profile web add github:swdwm5nr4k-sketch/dsh-netflow-dock
```

`dsh plugin` 是 pnpm 的转发器，会把包装进 `~/.dsh/profiles/web/`。

> 装完它会打印一条 warning：
> `dsh: warning: dsh-netflow-dock declares no dsh.bundle — installed as a plain dependency, not a profile layer`
> **这是预期的**，不是失败。本包刻意不自带 profile 层，改用第 2 步的一条显式 `insert` 行来装载。看到这条 warning 就说明包已经装好了。

**方式 B：本地 clone + link（想改代码时用）**

```bash
git clone https://github.com/swdwm5nr4k-sketch/dsh-netflow-dock.git
dsh plugin --profile web add link:$PWD/dsh-netflow-dock
```

`dsh plugin` 会把相对路径锚定到**你当前所在目录**，所以 `link:./dsh-netflow-dock` 也是安全的，不会误解析到 profile 目录里去。
用 link 装的话，改完 `lib/` 下的代码刷新页面即可生效（浏览器半），改宿主半则要重启。

### 第 2 步 · 在 profile 的 cordis.patch.yml 里加一行

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在**末尾**追加：

```yaml
# dsh-netflow-dock: 输入框下方的服务器上下行流量读数
- insert:
    - id: netflow-dock
      name: dsh-netflow-dock
```

本仓库根目录的 [`cordis.patch.yml`](cordis.patch.yml) 就是这段内容，可以直接 `cat` 出来粘过去。

几个要点：

- `name` 必须是包名 `dsh-netflow-dock`，`id` 是这行在配置树里的键，**在同一个 profile 内必须唯一**。
  若 `netflow-dock` 已被占用，换一个没用过的 id 即可（名字随便起，只要求唯一）。
- 追加前确认文件末尾有换行，且整个文件是一个 **顶层 YAML 数组**（每个条目以 `- ` 开头）。
- 这一层是「profile 自己的 patch 层」，在 bundle 层之后应用，所以它能覆盖内置行，也不会被后续更新冲掉。
- 写在 `~/.dsh/profiles/web/cordis.patch.yml` 里的是**用户层**，DSH 升级不会覆盖它。

### 第 3 步 · 重启 dsh web

```bash
# 停掉当前的 dsh web，然后重新启动
dsh web --host 127.0.0.1 --port 3080
```

**必须重启**：宿主半边（路由注册 + 采样定时器）是在进程启动时随 Loader 配置树装载的，
光刷新浏览器页面不会让它出现。之后如果只改浏览器半 `lib/client.js`，刷新页面就够了。

---

## 验证装好了

**1）宿主半边：路由应该返回 JSON**

```bash
curl -s "http://127.0.0.1:3080/netflow-dock/snapshot?history=0"
```

期望：

```json
{"ok":true,"at":1792051194350,"source":"proc","intervalMs":1000,"samples":42,
 "interfaceCount":2,"rxRate":60472.5,"txRate":90880.1,"rxTotal":909711155,
 "txTotal":1182117336,"peak":{"rx":23560902,"tx":7707077},
 "rows":[{"name":"lo","loopback":true,…},{"name":"eth0","loopback":false,…}],
 "history":[],"error":null}
```

把 `3080` 换成你自己的 `dsh web` 端口。若装了鉴权类插件（如 `dsh-auth`），可能需要带上凭据。

**2）浏览器半边：bundle 应该出现在启动图里**

```bash
curl -s http://127.0.0.1:3080/ | grep -o 'dsh-netflow-dock' | head -1
# → dsh-netflow-dock
```

**3）界面**：刷新页面，输入框卡片下方、自带 stats 行的旁边，应出现 `↓ … ↑ …` 并在 2 秒内变成真实数字。

### 排查

| 现象 | 原因与处理 |
| --- | --- |
| `curl /netflow-dock/snapshot` 返回 **HTML 外壳**（而不是 JSON） | 路由没注册 → 宿主半没装载。说明第 2 步的 insert 行没生效，或没重启。用 `dsh plugin --profile web ls \| grep netflow` 确认包在，再确认 `cordis.patch.yml` 里的 insert 块缩进正确。 |
| 路由正常但**页面没有读数** | 浏览器半没注册。确认上面第 2 条验证能 grep 到，并确认这行没有被别的 patch 用 `- id: netflow-dock` + `disabled: true` 关掉。 |
| 启动时报 **id 重复** | profile 里出现了两条 id 相同的 insert（比如手写了一条，又通过别的机制重复挂载）。删掉多余的那条。 |
| 读数是 `↓ — ↑ —` | `/proc/net/dev` 读失败（非 Linux 常见）。悬停看 tooltip 里的错误。 |

---

## 卸载

1. 从 `~/.dsh/profiles/web/cordis.patch.yml` 里删掉那个 `insert` 块；
2. `dsh plugin --profile web remove dsh-netflow-dock`；
3. 重启 `dsh web`。

只想临时关掉、不想删包的话，在第 2 步的位置加一行即可（包、依赖都留着，删掉这行就恢复）：

```yaml
- id: netflow-dock
  disabled: true
```

---

## 可调参数

| 常量 | 文件 | 默认 | 含义 |
| --- | --- | --- | --- |
| `SAMPLE_MS` | `lib/index.js` | `1000` | 宿主采样周期，也是所有速率的时间分辨率 |
| `HISTORY_MAX` | `lib/index.js` | `120` | 速率窗口长度（`SAMPLE_MS × HISTORY_MAX` ≈ 2 分钟） |
| `ROUTE_PATH` | `lib/index.js` | `/netflow-dock/snapshot` | 精确路由路径，必须与其他已注册路由不同 |
| `POLL_MS` | `lib/client.js` | `2000` | 浏览器轮询周期。宿主仍每秒采样，读数降低到 2 秒一次可把请求数减半且肉眼无差别 |
| `ENDPOINT` | `lib/client.js` | `/netflow-dock/snapshot` | 必须与宿主半的 `ROUTE_PATH` 一致 |

改了宿主半要重启 `dsh web`；只改浏览器半刷新页面即可。

---

## HTTP 路由

### `GET /netflow-dock/snapshot`

| 查询参数 | 含义 |
| --- | --- |
| `history=<n>` | 只返回最近 n 条速率历史（`0 ≤ n ≤ 120`）。本插件的读数不画图，始终用 `history=0` 来减小传输量 |
| `refresh=1` | 先立即采样一次再返回 |
| `reset=1` | 清空速率历史与峰值 |

**无论成败都返回 `200`**，失败时体为 `{ ok: false, error }`。
这样读数能保留上一帧的良好数值、把错误放进 tooltip，而不是整条消失或白屏。

响应字段：

| 字段 | 含义 |
| --- | --- |
| `ok` | 本次采样是否成功 |
| `at` | 采样时刻（epoch ms） |
| `source` | 固定 `"proc"` |
| `intervalMs` | 宿主采样周期 |
| `samples` | 进程启动以来的累计采样次数 |
| `interfaceCount` | 网卡数量 |
| `rxRate` / `txRate` | **不含回环**的合计速率（B/s） |
| `rxTotal` / `txTotal` | **不含回环**的累计字节数（直接来自内核计数器） |
| `peak.rx` / `peak.tx` | 速率峰值（B/s，进程内） |
| `rows[]` | 每张网卡：`name`、`loopback`、`rxRate`、`txRate`、`rxTotal`、`txTotal` |
| `history[]` | 速率历史 `{ rx, tx }`，按时间升序 |
| `error` | 失败原因，成功时为 `null` |

选择 HTTP 路由而不是 Remote API 是刻意的：宿主半就是一个普通 HTTP 端点，
浏览器半因此不必依赖 API 生成机制，整体更简单、更好调试。

---

## 数据流

```
/proc/net/dev ──readFileSync──▶ 宿主半（1s 采样，差分算速率）
                                     │  webServer.register exact /netflow-dock/snapshot
                                     ▼
                              浏览器半 fetch 轮询（2s）
                                     │
                                     ▼
                         conversation.composer.dock 一行读数
```

## 界面位置

`conversation.composer.dock` 是输入框卡片下方的那条带子，DSH 自带的 stats 行就在这里。
本插件用自己的 id（`netflow`）、`order: 1` 新增一格，排在自带 stats（`order: 0`）之后，
**不会覆盖**自带的 stats 行。注册前会等 `slots.inject` 的声明就绪，不依赖槽位注册顺序。

---

## 实现要点

- **回环排除**：`lo` 承载的是 harness 自身与本地服务的通信（本机实测达 GB 级）。
  若把它计进读数，真实流量会被完全淹没，所以默认排除；但它仍作为 `loopback: true` 的行出现在 `rows[]` 里，需要时可以自己取。
- **计数器回绕安全**：增量为负（计数器清零 / 回绕）时报 0，而不是抛出一个负速率的尖峰。
- **采样间隔异常安全**：休眠唤醒或时钟跳变会让时间差过大或过小，此时丢弃该帧速率（`0.05s < Δ < 600s` 之外不采信）。
- **路由路径带 `-dock` 后缀**：Web 服务器要求已注册的路由路径互不相同。
  本包用 `/netflow-dock/snapshot`，因此可以和悬浮窗版 `dsh-netflow`（用 `/netflow/snapshot`）**同时挂载**互不冲突。
- **生命周期**：路由注册、采样定时器、样式标签全部经 `ctx.effect` 归属于当前 fiber，
  卸载时会自动清除，不留残留（已实测 dispose 后路由消失）。
- **无持久状态**：不写盘。内核计数器本身就是持久记录，重启后重新读取即可，
  只有进程内的速率历史与峰值会清零。
- **浏览器半是 lazy-CJS factory**：`lib/client.js` 执行时只向 `window.__ModuleLoader__` 注册一个工厂，
  真正的副作用（style 标签、槽位注册）都在工厂闭包里、到物化时才跑。

## 目录结构

```
.
├── lib/
│   ├── index.js        # 宿主半：采样 /proc/net/dev + 注册精确路由
│   └── client.js       # 浏览器半：lazy-CJS bundle，渲染 composer dock 读数
├── cordis.patch.yml    # 要追加到 profile 的 insert 片段（见「安装」第 2 步）
├── package.json        # 含 dsh.client 清单（platform: web）
├── LICENSE             # MIT
└── README.md
```

## 已知限制

- **仅 Linux**：依赖 `/proc/net/dev`。其他平台返回
  `{ ok: false, error: "reading /proc/net/dev failed: …" }`，读数保留旧值并在 tooltip 报错。
- **没有图表、没有网卡明细表**：只有两个数字和 tooltip。本包是「悬浮窗版」`dsh-netflow` 的精简持久版，
  后者提供可拖拽悬浮窗、速率曲线与分网卡明细；两者的路由路径不同，可以同时挂载。
- **速率历史与峰值只存在内存里**，重启即清零；累计流量不受影响，因为它直接来自内核计数器。
- **没有运行卡片内的面板**：`tool.view.cordis`（`cordis_run` 卡片里的交互区）是**动态 Cordis 插件专属槽位**，
  由动态 Client Guard 绑定 `key: 'self'`，静态组合装载的包无法注册它。
- **速率按采样窗口计算**：瞬时速率是「两个采样点之间的平均」，因此默认 1 秒窗口下，
  短于 1 秒的突发会被抹平。

## License

[MIT](LICENSE)
