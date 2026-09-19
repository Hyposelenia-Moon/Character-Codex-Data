# Character-Codex-Data

角色攻略数据仓库。数据为纯 JSON，供 **Atlas-Plugin**（TRSS-Yunzai 图鉴插件）的 `#角色攻略` / `#角色指南` 页面读取；
仓库根目录的 `guide.html` 是由 JSON 生成的网页版，`guide.md` 是由同一份数据生成的文档版文本。

## 目录结构

```
data/<gameId>/<角色名>.json      角色攻略数据（gameId：gi 原神 / hsr 星铁 / zzz 绝区零）
data/<gameId>/_order.json        网页版/文档版的角色顺序（可选，`_` 开头的文件不会当作角色数据）
data/<gameId>/images/…           段落配图（可选）
templates/guide.html             网页版外壳（样式 + 页头）
scripts/build-html.mjs           JSON → guide.html
scripts/build-doc.mjs            JSON → guide.md（文档版文本，可再打包成 .docx）
guide.html                       生成的网页版，请勿手改
guide.md                         生成的文档版文本，请勿手改
汉仪文黑-85W.ttf                  guide.html 使用的字体
```

插件侧的读取规则：仓库存在 `data/` 时只扫 `data/`，按 `<gameId>` 目录判定游戏；
`_` 开头的文件一律跳过。因此新增/调整数据不需要改插件代码。

## 角色 JSON 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 角色名。可以是图鉴条目名，也可以是社区简称（插件会用别名系统归一，如「桃桃」→ 胡桃） |
| `game` | | `gi` / `hsr` / `zzz`；缺省按所在目录推断（目录已能表达游戏，通常不用写） |
| `tags` | | 卡片标签，字符串数组；也可写成 `{ "text": "定位：站场主C", "style": "role" }`（`style` 只影响网页版配色，如 `level` / `role`） |
| `highlight` | | 卡片顶部高亮行（如 `100级提升：7.6%`），会显示在攻略页标题下方 |
| `sections` | ✅ | 段落数组，顺序即展示顺序，见下 |
| `source.guide` | | 数据来源页名（如 `赋光之人 · 队伍攻略`），插件页脚会展示 |

### 段落（sections）

每段必须有 `title`，正文在下面三种里**选一种**：

```json
{ "title": "1. 武器推荐", "lines": ["第一档：苍耀 > 波乱月白经津", "第二档：磐石结绿 > 厄水之祸"] }
```
```json
{ "title": "固有天赋", "items": [{ "name": "天赋名", "desc": "说明" }] }
```
```json
{ "title": "毕业面板", "fields": [{ "label": "暴击率", "value": "70%+" }] }
```

- `lines`：文本行，一行一个数组元素（**不要**在字符串里写 `\n` 或 `<br>`）
- `items`：名称 + 说明的列表
- `fields`：标签 + 取值的表格
- `image`（可选）：段落配图，路径**相对该 JSON 文件**，如 `images/pic.png`。插件会转成 `file://` 绝对路径，站外链接与不存在的文件会被忽略（运行期不联网）

### 行内强调

正文是**纯文本**，不要写 HTML 标签（两个消费者都会自行转义）。需要强调时用：

| 写法 | 效果 |
|------|------|
| `**文字**` | 橙色着重（网页版 `.must` / 插件内同色） |
| `==文字==` | 红色高亮 |

例：`"皇冠：EQ（**必须**）"`

## 新增或修改角色

1. 在 `data/gi/` 下新建 `<角色名>.json`（可复制现有文件改）
2. 想让网页版按指定位置排列，就把角色名写进 `data/gi/_order.json`；没写的排在已列角色之后
3. 重新生成网页版与文档版：

```bash
node scripts/build-html.mjs      # 网页版 guide.html
node scripts/build-doc.mjs       # 文档版 guide.md（Word 用可再打包 docx，命令见脚本头部）
```

### 只有栏位、还没填内容（空档角色）

先把六个栏位建好、内容留空即可占位：

```json
{
  "name": "木偶",
  "game": "gi",
  "tags": [],
  "sections": [
    { "title": "1. 武器推荐", "lines": [] },
    { "title": "2. 圣遗物推荐", "lines": [] },
    { "title": "3. 天赋加点", "lines": [] },
    { "title": "4. 毕业面板参考", "lines": [] },
    { "title": "5. 命座推荐", "lines": [] },
    { "title": "6. 配队推荐", "lines": [] }
  ],
  "source": { "guide": "赋光之人 · 队伍攻略" }
}
```

- 空档角色**不会进 `guide.html`**（生成脚本会跳过并在输出里报数量），插件查询时提示「暂无攻略数据」；填上任意一行内容即自动出现
- 补充内容时按上面的段落规范填 `lines` / `items` / `fields`

### 行文约定（网页版与插件都按这些约定断行排版）

| 写法 | 效果 |
|------|------|
| `主词条：时之沙：攻击力 / 空之杯：生命值 / 理之冠：暴击率` | 按 `/` 拆成多行，`主词条` 作左侧标签 |
| `第一档：A > B > C`（也可用 `≥`） | 拆成档位标签，`>` 显示为分隔箭头且不会单独换行 |
| `首选：A + B + C`（配队段） | 成员拆成独立标签并自动换行 |
| `**必须**` | 红色小标签 |
| `==文字==` | 红色高亮文字 |

- 正文写纯文本，不要写 HTML 标签
- `>`、`≥`、`/`、`+` 两侧留一个半角空格：前端按它们断行，没空格就不会被拆开
- 毕业面板写成「标签：数值」一行一条，数值会自动放大对齐

## 完整示例

`data/gi/丝柯克.json`

```json
{
  "name": "丝柯克",
  "game": "gi",
  "tags": [
    { "text": "建议等级：90级", "style": "level" },
    { "text": "定位：站场主C", "style": "role" }
  ],
  "highlight": "100级提升：约 7.6%~8.4%（随命座）",
  "sections": [
    {
      "title": "1. 武器推荐",
      "lines": [
        "第一档：苍耀 > 波乱月白经津 > 雾切之回光",
        "第二档：磐岩结绿 > 厄水之祸 > 有乐御簾切"
      ]
    },
    {
      "title": "2. 圣遗物推荐",
      "lines": [
        "首选：深廊终曲",
        "主词条：时之沙：攻击力 / 空之杯：冰元素伤害加成 > 攻击力 / 理之冠：暴击伤害 / 暴击率"
      ]
    },
    {
      "title": "3. 天赋加点",
      "lines": [
        "优先级：E > Q > A",
        "皇冠：EQ（**必须**）"
      ]
    }
  ],
  "source": { "guide": "赋光之人 · 队伍攻略" }
}
```

## 说明

- 数据仓库与插件解耦：插件只读 `data/`，页面样式在插件侧（`resources/atlas/codex.html`），改数据不会影响插件渲染逻辑
- 插件按「文件清单 + 大小 + mtime」判断数据是否变化，`#图鉴更新` 后无需重启 bot
- 同名角色在多个游戏下分别建目录（`data/gi/…`、`data/hsr/…`）即可，互不干扰

---

# 模式 v2 与配套脚本

## v2 数据结构

`schema: 2` 的文件在原有字段之外多了一层 `v2`，把「需要引用图鉴图标的实体」拆成独立字段；
`tags` / `sections` 变成**由 `v2` 回推的产物**（`scripts/lib/schema.mjs` 的 `deriveTags` / `deriveSections`），
旧渲染器（`build-html.mjs` / `build-doc.mjs`）与游戏内插件不需要改动即可继续读。

```jsonc
{
  "schema": 2,
  "name": "芙宁娜",
  "game": "gi",
  "highlight": "100级提升：约 8%",        // 可选，卡片顶部高亮行；编辑器只读不改
  "meta": {                                // 基本信息（顶部标签）
    "建议等级": "90级",
    "定位": "元素增伤辅助",
    "100级提升": "___%"
  },
  "v2": {
    "weapons": [                           // 武器推荐，一行 = 一个档位/标签
      {
        "label": "辅助向",                  // 可空（null）
        "tier": null,                      // 1..6 = 第一档…第六档，可空
        "sep": " > ",                      // 条目连接符（原样保留，">" / "≥" / " / "）
        "items": [
          { "name": "西风剑", "note": "精5", "ref": "weapon:西风剑" }   // note 可省
        ]
      }
    ],
    "artifacts": [                         // 圣遗物推荐，kind 决定行的形态
      { "kind": "preferred",  "label": "辅助向", "sep": " > ", "sets": [ { "name": "千岩牢固", "ref": "artifact:千岩牢固" } ] },
      { "kind": "preferred",  "label": null,     "sep": " + ", "sets": [ { "name": "水仙之梦", "ref": "artifact:水仙之梦" }, { "name": "沉沦之心", "ref": "artifact:沉沦之心" } ] },  // 2+2 组合
      { "kind": "transition", "label": null,     "sep": " > ", "sets": [] },   // 过渡
      { "kind": "optional",   "label": null,     "sep": " > ", "sets": [] },   // 可选
      { "kind": "main", "stats": { "时之沙": ["元素充能效率"], "空之杯": ["生命值"], "理之冠": ["暴击率"] } },
      { "kind": "sub",  "stats": ["充能", "暴击"], "sep": " > " },
      { "kind": "text", "label": null, "text": "自由文本" }
    ],
    "talents": [                           // 天赋加点
      { "kind": "priority", "order": [ { "name": "Q", "ref": "talent:Q" } ], "raw": "Q > E > A" },
      { "kind": "crown",    "items": [ { "name": "E", "level": "建议", "ref": "talent:E" } ] }
    ],
    "panels": [                            // 毕业面板参考，二选一
      { "label": "辅助向", "k": "暴击率", "v": "70%+" },
      { "label": "辅助向", "text": "暴击率70%+ / 充能240%+" }
    ],
    "constellations": [                    // 命座推荐，index 由 name 推导（二命 → 2）
      { "name": "二命", "index": 2, "text": "加快增伤叠层速度" }
    ],
    "teams": [                             // 配队推荐
      { "label": "首选", "members": [ { "name": "芙宁娜", "ref": "character:芙宁娜" } ], "text": "" }
    ]
  },
  "unparsed": { "武器推荐": ["Word 里没认出来的整行"] },   // 可选：原样保留，进旧版输出
  "tags": [],        // ← deriveTags(data) 生成，不要手写
  "sections": [],    // ← deriveSections(data) 生成，不要手写
  "source": { "guide": "赋光之人 · 队伍攻略" }
}
```

### ref 写法：`类型:名称`

引用一律存成 `{ "name": "显示名", "ref": "类型:名称" }`，类型前缀与 `MARK_RE` 一致：

| 前缀 | 类型 | 图鉴校验 |
|------|------|----------|
| `weapon:` | 武器 | 对着 `data/_index.json` 的 `weapons` 校验 |
| `artifact:` | 圣遗物套装 | 对着 `artifacts` 校验 |
| `character:` | 角色（配队成员） | 对着 `characters` 校验 |
| `talent:` | 天赋 | 必须是 `A` / `E` / `Q` |
| `constellation:` | 命座 | 必须是 `1`–`6` |

Word 侧对应 `[[w:西风剑]] [[a:千岩牢固]] [[c:芙宁娜]] [[t:E]] [[k:2]]` 标记，转换器按标记决定用哪个解析器。
`name` 是给人看的（可以带错别字），`ref` 是给图标/跳转/校验用的，两者不一致时以 `ref` 为准。

## 脚本用法

### 1. Word → JSON：`node scripts/parse-docx.mjs`

```bash
node scripts/parse-docx.mjs                       # 默认读 D:\文件\游戏\原神\原神·角色攻略.docx
node scripts/parse-docx.mjs <docx路径> [--dry]    # --dry 只报告不写文件
```

- 输出 `data/gi/<角色名>.json`（v2 结构）、`data/_parse-report.json`，并按文档顺序重建 `data/gi/_order.json`
- 认不出来的行原样存进 `unparsed`，**绝不丢内容**
- 会读 `data/_index.json` 给引用打 ref，并统计「名称不在图鉴」的问题
- 组合写法会拆成独立条目，回推文本时按 `sep` 逐个拼回：
  - 2+2 套装：`水仙之梦+沉沦之心` → 2 条 set，`sep: " + "`（成套组合，不是备选）
  - 备选套装：`黄金剧团 / 水仙之梦` → 2 条 set，`sep: " / "`（`/` 是优先级/备选）
  - 配队成员分隔符：`+`、`＋`、`/`、`／`、`、`
  - `2充能` 这类口语写法照拆，但会在 `_parse-report.json` 里被标出来，方便回头改成标准名

### 2. 生成图鉴索引：`node scripts/build-index.mjs`

```bash
node scripts/build-index.mjs [图鉴后端目录]
# 默认：D:\文件\游戏\原神\Atlas-Plugin\tool\nanoka-atlas-backend\nanoka-atlas-backend
```

- 从后端 `data/map.json` 取武器名 / 角色名，从 `data/items/简体中文/原神/圣遗物/**/*.json` 取圣遗物套装名
- **并入 `data/gi` 里实际在用的名字**，避免文档专用名被误判成「不在图鉴」：
  - 角色列表并入 `data/gi/*.json` 的**文件名**（如 `旅行者·火`、`奇偶·男性`），也自动覆盖将来新增的角色
  - 三类清单都并入数据里出现过的 ref 名，但只收「单个实体名」：带 `+ / = ， 、 ＆`、空格、或数字开头
    （`2充能`、`88爆伤`、`任意674白值武器` 这类口语/规格说明）一律不收 —— 它们本来就该继续被标 ⚠
- 去重、按中文拼音排序，写 `data/_index.json`（UTF-8 无 BOM、2 空格缩进、末尾换行）：
  `{ "generatedAt": "ISO 时间", "weapons": [], "characters": [], "artifacts": [] }`
- 找不到后端目录时报错并退出（退出码 1）；某一类为空时只警告、继续
- 编辑器与 `parse-docx.mjs` 都读它；换了后端版本或新增角色后重跑即可
- 当前规模：武器 291 / 角色 138 / 圣遗物套装 69（写这段时实测值）

### 3. 图形化编辑器：`node scripts/editor.mjs`

```bash
node scripts/editor.mjs [--port 8787] [--no-open]
```

浏览器打开 `http://127.0.0.1:8787`（端口被占用会自动 +1 重试，最多 10 次）。
界面中文、零依赖、无 CDN：左边搜角色 / 新增 / 排序 / 重命名 / 删除（软删除到 `data/_trash/`），
右边按区块折叠编辑；保存用「保存」按钮或 `Ctrl+S` / `⌘+S`。

编辑器只用了 Node 内置模块（`node:http` / `node:fs` / `node:path` / `node:url` / `node:child_process`），
静态资源在 `resources/editor/`（`index.html` + `app.js` + `style.css`）。

**关键约定**

- 需要图标的实体（武器 / 圣遗物套装 / 配队角色 / 天赋 / 命座）都是**独立的带类型徽标输入控件**，
  不会和正文文本混在同一个输入框；输入框挂 `<datalist>` 候选（来自 `/api/index`）
- 名字不在图鉴时，输入框旁出现 ⚠ 与原因（来自 `validate(data, index)`）
- 保存时由服务器重新生成 `tags` / `sections`（丢弃前端传来的这两个字段），并强制 `schema: 2`
- **未被编辑器编辑的字段会从原文件按位置合并回来**（`raw`、`sep`、套装 `pieces`、空的主词条占位行等），
  所以「打开再保存」不会产生多余 diff；129 个 v2 文件实测逐字节不变
- `highlight`、`unparsed` 编辑器只读、保存时原样保留

**API**（全部返回 JSON，UTF-8 无 BOM）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/index` | `data/_index.json`（不存在时返回 `{weapons:[],artifacts:[],characters:[]}`） |
| GET | `/api/characters` | `{ order, items: [{name, weapons, artifacts, hasUnparsed}], missing }`；`weapons`/`artifacts` 是 v2 行数 |
| GET | `/api/character?name=X` | 角色 JSON，附带 `issues: validate(data, index)` |
| PUT | `/api/character?name=X` | body 为完整 JSON；保存并返回 `{ok:true, issues:[...]}`；`X` 不在 `_order.json` 时追加 |
| POST | `/api/character` | body `{name}`，新建空白 v2 模板（meta 三项空、v2 六数组空）；已存在返回 409 |
| POST | `/api/rename` | body `{from,to}`，改文件名 + `_order.json` |
| DELETE | `/api/character?name=X` | 软删除：移到 `data/_trash/X.json` 并从 `_order.json` 移除 |
| POST | `/api/reorder` | body `{order:[...]}`，重写 `_order.json`（没提到的角色补在后面） |

`name` 必须是单层文件名（拒绝 `/ \ .. :` 等字符与 `_` 开头），文件操作限制在 `data/gi/` 下；
所有错误返回 `{error:"..."}` 与对应状态码（400 / 403 / 404 / 405 / 409 / 413 / 500）。

### 4. 改完数据后重新生成产物

```bash
node scripts/build-html.mjs      # guide.html
node scripts/build-doc.mjs       # guide.md
```

## 旧版（无 v2）数据

只有 `sections` 文本行、没有 `v2` 的角色文件（如 `木偶.json`）仍能被编辑器打开，但保存时会升级成 v2：
`tags` / `sections` 由结构化字段重新生成，原来的文本行不会自动搬过来。
需要保留旧内容就先手工备份，或先跑一次 `parse-docx.mjs` 让转换器重建结构化字段。

