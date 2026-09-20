# Character-Codex-Data

角色攻略数据仓库。数据为纯 JSON，供 **Atlas-Plugin**（TRSS-Yunzai 图鉴插件）的 `#角色攻略` / `#角色指南` 页面读取；
仓库根目录的 `guide.html` 是由 JSON 生成的网页版，`guide.md` 是由同一份数据生成的文档版文本。

---

## 改动传播清单（每次改动必读）

> **任何内容变更都必须同时更新全部消费者并跑固定验收集，不得只改一处。**
> 用户说过"改了什么"，就要把所有对应栏目一起改到位 —— 不要等用户自己查、自己提醒。

### A. 十类消费者（逐条勾选，缺一不可）

| # | 消费者 | 怎么更新 | 证据 |
|---|---|---|---|
| 1 | `data/gi/*.json`（必要时含 `_order.json` / `_index.json`） | 数据改动走**文档层**：改主文档 → `node scripts/parse-docx.mjs`；索引 `node scripts/build-index.mjs` | 关键文件 sha256 前后 |
| 2 | **主文档** `D:\文件\游戏\原神\原神·角色攻略.docx` | 脚本化改（跨 run 安全 + CAS + 备份 `.bak-<时间戳>`），或 `node scripts/build-docx.mjs --write-main` | 改前备份路径 + 主文档 sha1 |
| 3 | **标记版 docx**（`out\…(标记版).docx` + `D:\…\…(标记版).docx`） | 由 `build-docx --write-main` 一并产出，无需手改 | 标记版 sha1 + "去标记后逐字一致：是" |
| 4 | `guide.html` | `node scripts/build-html.mjs` | 卡片数 129 + `audit-guide-html` 通过 |
| 5 | `guide.md` | `node scripts/build-doc.mjs`（**选 A 口径**：只过滤占位符，**文档词汇不变**） | `___`=0 + 文档词汇计数 + 新旧字节/行数 |
| 6 | **编辑器**（表单文案 + `/api/preview` 预览） | `resources/editor/app.js`（文案 / 下拉 / **标签与档位联动**）＋ 服务端走共享层；**改完必须重启编辑器进程**（长驻进程会缓存旧模块） | `/api/preview` html 与 `guide.html` **逐字节一致** ＋ `.dsh/verify-editor-label.mjs` 12/12 |
| 7 | **插件面板** | `model/codexIndex/display.js`（**与 `scripts/lib/guide-display.mjs` 逐字节一致**）、`parse.js`、`resources/atlas/codex.html`、`codex.css` | `node scripts/check-display-sync.mjs` + `audit-web-vs-panel` |
| 8 | `README` 与 `templates/` | 改受影响的说明、词汇表、符号语义、期望值 | 本节表格与预期计数 |
| 9 | **审计脚本的期望值** | `audit-*` / `display-*` / `check-display-sync` 的断言与合法集 | 每个审计 `exit=0` |
| 10 | 离线脚手架 | `.dsh/` 下的脚手架**不得再读陈旧副本**，统一用 `CODEX_DIR` 环境变量、缺省读**主仓库** | 离线渲染输出能反映主仓库最新数据 |

### B. 固定验收集（十二条全绿才算完成）

```bash
node scripts/parse-docx.mjs --dry                 # 129 角色 / 未识别 0
node scripts/build-docx.mjs --write-main          # 往返 129/129 深度相等 + 幂等
node scripts/diagnose-docx-json.mjs               # 不一致 0
node scripts/audit-web-vs-panel.mjs               # 真实角色 0 + 自定义档位词合成样例 3 条一致
node scripts/audit-dup-items.mjs                  # 重复名 0/0、序列不一致 0
node scripts/check-display-sync.mjs               # 两份显示级归一逐字节一致
node scripts/scan-separators.mjs                  # 0
node scripts/display-selftest.mjs <角色>           # 自定义档位词断言 7/7
node scripts/build-html.mjs && node scripts/build-doc.mjs   # 产物刷新
# 编辑器 129 角色「打开→原样保存」逐字节不变 + /api/preview 与 guide.html 逐字节一致
#   （需先 node scripts/editor.mjs --port <p> --no-open 起服务；改过共享层务必重启）
node --check <每个改过的 .mjs>                     # 全过
# 本地未入库：.dsh/verify-editor-label.mjs（编辑器 label/tier 口径 12/12）
```

### C. 传播矩阵（每次报告都要交）

```
变更: <一句话>
产物 → 是否已更新 → 证据(sha/mtime/计数)
data/gi | 主文档 | 标记版 | guide.html | guide.md | 编辑器 | 面板 | README | 审计期望
```

---

## 目录结构

```
data/<gameId>/<角色名>.json      角色攻略数据（gameId：gi 原神 / hsr 星铁 / zzz 绝区零）
data/<gameId>/_order.json        网页版/文档版的角色顺序（可选，`_` 开头的文件不会当作角色数据）
data/<gameId>/images/…           段落配图（可选）
templates/guide.html             网页版外壳（样式 + 页头）
scripts/build-html.mjs           JSON → guide.html
scripts/build-doc.mjs            JSON → guide.md（文档版文本，可再打包成 .docx）
scripts/fetch-font.mjs           从上游图鉴仓库同步 guide.html 用的字体（不入库）
guide.html                       生成的网页版，请勿手改
guide.md                         生成的文档版文本，请勿手改
汉仪文黑-85W.ttf                  guide.html 使用的字体（商业字体，**不入库**；用 fetch-font.mjs 取回，见「字体」一节）
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
| `source.guide` | | 数据来源页名（如 `原神·角色攻略`），插件页脚会展示 |

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
  "source": { "guide": "原神·角色攻略" }
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
  "source": { "guide": "原神·角色攻略" }
}
```

## 说明

- 数据仓库与插件解耦：插件只读 `data/`，页面样式在插件侧（`resources/atlas/codex.html`），改数据不会影响插件渲染逻辑
- 插件按「文件清单 + 大小 + mtime」判断数据是否变化，`#图鉴更新` 后无需重启 bot
- 同名角色在多个游戏下分别建目录（`data/gi/…`、`data/hsr/…`）即可，互不干扰

## 文档词汇 vs 显示词汇（**重要，改数据前先看**）

仓库里有**两套词汇表**。它们不是重复劳动，是分工；搞混会**直接破坏 129/129 文档往返**。

| | 文档词汇（**源**，必须原样保留） | 显示词汇（**呈现**，只由显示层产出） |
|---|---|---|
| 档位 | `第一档` / `第二档` / `第三档`、`首选` / `次选` / `可选` / `过渡` / `套装`；**`label` 非空 = 自定义档位词**（如 `建议`，见下节） | `推荐` / `可选` / `过渡`（**三档**，第三档为空时整行不渲染） |
| 命座 | `二命——说明` | `命之座2` |
| 段落标题 | `1. 武器推荐` / `4. 毕业面板参考` / `5. 命座推荐` / `6. 配队推荐` | `武器` / `圣遗物` / `天赋` / `面板` / `命座` / `配队` |
| **副词条百分比** | `生命值百分比` / `百分比生命值` / `攻击力百分比` / `百分比攻击力` / `防御力百分比` / `百分比防御力` | **`大生命` / `大攻击` / `大防御`**（**简写才是最终显示形态**，不再展开成 `生命值`/`攻击力`/`防御力` —— 那是"固定值"语义） |
| 其它简写 | `充能` / `精通` / `暴伤` / `爆伤` / `大公鸡` … | `元素充能效率` / `元素精通` / `暴击伤害` / `攻击力` … |
| 固定术语 | `双爆` | `暴击率=暴击伤害`（**同级**，恒等；只作词条时才展开，散文里原样） |
| 出现位置 | 主文档 docx、`data/gi/*.json` 的 `v2.*.label` 与 `sections[].*`、`guide.md` | `guide.html`、插件面板、编辑器预览 |

**符号语义（用户定稿，四处一致）**：`=`（显示 `＝`）**同级/等价**；`/` **或者/可替换**；
`>`（显示 `＞`）**优先级/顺序**；`≥` 保留原样。**副词条是唯一例外**，
源文档里 `/` 表示**同级**、`>` 表示**优先级**，所以显示层把副词条的 `/` 折成 `=`、`>` 折成 `＞`
（`subSep()`）——**不允许**把 `/` 一律折成 `＞`，那会把"同级"说成"优先级"。
`｜` 只用于主词条三个**槽位**之间的并列。

**为什么 `v2.label` 里必须留着 `首选` / `过渡` / `第一档`：**

- `parse-docx.mjs` 的行首档位正则只认 `首选|次选|可选|过渡|套装`，**不认 `推荐`**；
  小节标题也只认 `武器推荐` / `毕业面板参考` 这些**长标题**，不认 `面板`。
- 所以 `docx → JSON → docx` 往返（硬验收 **129/129 深度相等**）依赖这些来源写法**逐字存在**。
- 显示词一律由 `scripts/lib/guide-display.mjs` 的 `displayTitle` / `displayLabel` /
  `TIER_BY_INDEX` / `constellationNumber` / `STAT_ALIASES` 在**渲染期**换算，
  **一个字都不写回 JSON / docx**。

> ⚠ **误删会破坏往返**：把 `v2.artifacts[].label` 的 `首选` 改成 `推荐`（或把 `sections[].title`
> 改成短标题）之后，`build-docx --write-main` 写出的文档将无法被 `parse-docx` 读回 ——
> `推荐：…` 会掉进 `unparsed`，往返校验立刻**不再是 129/129**。真要去掉这些词，顺序必须是：
> 先改 `parse-docx` 的识别规则 → 再改文档与数据 → 最后才改落盘词。

### 自定义档位词（把「推荐」写成「建议」）

行的 `label` **非空**时它就是这一行的标签词 —— 这是唯一一处"文档 / 数据 / 网页 / 面板"四处都要一致的口径：

| 位置 | 规则 |
|---|---|
| 数据 | `v2.weapons[].label = '建议'` 时 `tier` 必须是 `null`；圣遗物 `label = '输出向'` 时 `kind` 必须是 `preferred` |
| 文档层 `schema.renderWeaponRow` | `label` 非空 → `建议：西风剑`（**不再写** `第N档：`）；为空才写 `第一档：西风剑` |
| 显示层 `displayLabel(label, tier)` | `label` 非空 → 归一后原样显示（`首选`→`推荐` 等仍生效）；为空才用 `TIER_BY_INDEX[tier]` |
| 网页版 `build-html.weaponLabelHints` | **同一条规则**（过去这里按 `tier` 算，所以自定义词"不生效"，还与面板漂移） |
| 编辑器 | label 输入框实时显示「显示为：建议」；输入自定义词自动清空档位下拉，选档位词自动清空自定义标签（圣遗物则把 `kind` 同步成 `首选`/`过渡`/`可选`） |

**为什么「自定义词」与「档位」互斥**：文档一行只有**一个标签词**。二者并存会拼出
`建议：第一档：西风剑` —— `parse-docx` 认不出（往返立刻不再 129/129）。

断言（改动显示层 / 文档层 / 编辑器标签时都要跑）：
`scripts/display-selftest.mjs <角色>`（自定义档位词 7 条）、
`scripts/audit-web-vs-panel.mjs` 的合成样例（3 条）、
本地未入库的 `.dsh/verify-editor-label.mjs`（编辑器标签口径 12 条）。

**空值 / 占位符**：`data.tags` 与 `meta` 里**允许**留 `___级` / `___` / `___%` 这类"还没填"的占位
（派生层刻意保留原文）。**是否显示由展示层判断**，三处共用同一个判空口径
`guide-display.mjs` 的 `isBlankDisplay`（空串 / `___` / 只剩标点都算没填）：
`guide.html` 与面板**不显示**这些标签行；`guide.md` 也**不输出**这些占位（`___` 出现次数为 0）。
空模块的显示：`guide.html` / 面板显示「暂无」，`guide.md` 显示 `（暂无数据）` —— 同一条规则、不同文字，
`guide.md` 沿用与它自己的空栏位骨架（`第一档：`）一致的风格。

---

# 模式 v2 与配套脚本

## v2 数据结构

`schema: 2` 的文件在原有字段之外多了一层 `v2`，把「需要引用图鉴图标的实体」拆成独立字段；
`tags` / `sections` 变成**由 `v2` 回推的产物**（`scripts/lib/schema.mjs` 的 `deriveTags` / `deriveSections`），
旧渲染器（`build-html.mjs` / `build-doc.mjs`）与游戏内插件不需要改动即可继续读。
`build-docx.mjs` 也直接复用 `deriveSections` —— 「JSON 里的 `sections`」与「写进 Word 的正文行」
永远是同一份渲染结果，不会出现两套渲染器漂移。

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
      { "kind": "main", "note": "二命", "noteSlot": "空之杯", "stats": { "时之沙": ["元素充能效率"], "空之杯": ["生命值", "水元素伤害加成"], "理之冠": ["暴击率"] } },
      { "kind": "sub",  "stats": ["充能", "暴击"], "sep": " > " },
      { "kind": "text", "label": null, "text": "自由文本" },
      { "kind": "note", "text": "二命" }        // 段末备注行 → 文档里渲染成「注：建议二命及以上…」
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
      { "label": "首选", "members": [ { "name": "芙宁娜", "ref": "character:芙宁娜" } ], "text": "" },
      { "kind": "note", "text": "二命" },
      { "kind": "note", "text": "高金" }
    ]
  },
  "tags": [],        // ← deriveTags(data) 生成，不要手写
  "sections": [],    // ← deriveSections(data) 生成，不要手写
  "source": { "guide": "原神·角色攻略" }
}
```

> `unparsed` 字段已**取消**：解析器对六个小节的每一种行都有对应分支，认不出来的行会让
> `parse-docx` 退出码 1 并列出明细（实测当前主文档 0 行）。旧数据里的 `unparsed` 会在下次
> `parse-docx` 时自动消失。

### 备注行（段末 `注：`）—— 括注不丢，正文保持干净

正文行只放**标准名 / 标准词条**（这样 `ref` 能取到图鉴图标），括注（`（二命）` `（高金）`
`（随命座）` …）统一转到**所属段落末尾的一行 `注：`**。数据结构就是上面 `{kind:'note', text}` 的形式，
放进对应的 `v2.artifacts` / `v2.weapons` / `v2.teams` 等数组里，位置放在该段落数组的末尾。

```text
2. 圣遗物推荐
首选：翠绿之影 / 血红之证
主词条：时之沙：元素精通 / 空之杯：水元素伤害加成 / 理之冠：暴击率
副词条：元素精通 / 元素充能效率
注：建议二命及以上使用水伤杯
```

规则：

| 场景 | JSON | 文档 |
|------|------|------|
| 配队成员的命座括注 | `teams` 里补 `{kind:'note', text:'二命'}` | 成员只留标准名，段末 `注：建议二命及以上` |
| 成本括注 | `{kind:'note', text:'高金'}` | 段末 `注：高金配置` |
| 同一段多条 | 多条 note（或一条里用 `；`） | 合并成**一行**、用 `；` 分隔 |
| 主词条的括注 | `kind:'main'` 上加 `note`（+ `noteSlot` 指定部位） | 挂在**那个词条值后面**：`空之杯：水元素伤害加成（二命）` |
| 手写的 `（…）` | 直接写 note 文本即可 | 按下面的润色表输出 |

**语义化润色**（原始括注 → 文档文本；认不出语义的原样保留）：

| 原始括注 | 文档文本 |
|----------|----------|
| `二命` / `2命`（有同段主词条时） | `建议二命及以上使用<该词条>` → 例 `建议二命及以上使用水元素伤害加成` |
| `二命` / `2命`（无主词条） | `建议二命及以上` |
| `高金` | `高金配置` |
| `中金` / `低金` | `中金配置` / `低金配置` |
| `随命座` | `随命座变化` |
| 其它（`特殊` `华馆` `非讨龙` …） | 原样 |

**不参与备注走廊**（保持现状不动）：`（精五）` `（叠满）` 这类精炼备注、皇冠的
`（建议 / 必须 / 可选）`、`（满命）`、以及套装件数 `（2件套）` —— 它们留在正文里。

**双向无损**：`parse-docx` 读懂 `注：` 行 → `{kind:'note'}`；`build-docx` 再把
`{kind:'note'}` 写回段末 `注：` 行。实测 `JSON → docx → JSON` **129/129 深度相等**且连续两次运行逐字节幂等。

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
- **认不出来的行不再塞进 `unparsed`**：六个小节的每种行都有对应分支，
  真遇到没认出来的写法会打印明细并**退出码 1**（当前主文档实测 0 行），不会再静默丢内容
- `注：…` 备注行 → 该段的 `{kind:'note', text}`（见上面「备注行」一节）
- 会读 `data/_index.json` 给引用打 ref，并统计「名称不在图鉴」的问题
- 组合写法会拆成独立条目，回推文本时按 `sep` 逐个拼回：
  - 2+2 套装：`水仙之梦+沉沦之心` → 2 条 set，`sep: " + "`（成套组合，不是备选）
  - 备选套装：`黄金剧团 / 水仙之梦` → 2 条 set，`sep: " / "`（`/` 是优先级/备选）
  - 配队成员分隔符：`+`、`＋`、`/`、`／`、`、`
  - `2充能` 这类口语写法照拆，但会在 `_parse-report.json` 里被标出来，方便回头改成标准名
- 天赋优先级行保留**分隔符原文**（`A＞E＞Q`、`E ≥ Q`、`E / Q`、`A=Q＞E` 各写各的），不归一成 `>`

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
- **`data/_index.json` 是生成物，但照样入库**：没有图鉴后端的机器跑不出索引，所以仓库里留一份最新的；
  数据变动后（编辑、重命名、删除、批量替换）编辑器会自动重建它，手工重建就用 `node scripts/build-index.mjs`
- `data/_parse-report.json`、`out/`、`data/_trash/`、`data/_backup/`、`.tmp/` 都是本地中间产物，已在 `.gitignore` 里**不入库**
- 当前规模：武器 291 / 角色 138 / 圣遗物套装 69（写这段时实测值）

### 3. 图形化编辑器：`node scripts/editor.mjs`

```bash
cd <仓库目录>
node scripts/editor.mjs [--port 8787] [--no-open] [--exit-on-idle[=<秒>]]
```

浏览器打开终端提示的地址（默认 `http://127.0.0.1:8787`；端口被占用会自动 +1 重试，最多 10 次）。
界面中文、零依赖、无 CDN：左边搜角色 / 新增 / 排序 / 重命名 / 删除（软删除到 `data/_trash/`），
右边按区块折叠编辑；保存用「保存」按钮或 `Ctrl+S` / `⌘+S`；
「保存并发布」或 `Ctrl+Shift+S` 走全链路（写 JSON → 重建索引 → 写回 Word 主文档 → 生成 `guide.html` → 三方一致性校验 → **自动提交，不推送**）；
「发布」按钮只把**已保存的**数据重新生成 `guide.html` 与 Word 主文档，不写入正在编辑的表单。

**关闭网页后自动结束服务**（`--exit-on-idle`，默认关闭，只在手动开时生效）

后台隐藏启动时（见下）关掉浏览器窗口，服务会变成任务管理器里的幽灵进程，所以加了空闲自动退出：

- `--exit-on-idle`（单写 = 20 秒）或 `--exit-on-idle=30`：**连续 N 秒没有页面心跳**就优雅退出
  （先 `server.close()`，1 秒兜底后 `process.exit(0)`），退出前在日志里留一行 `[idle] 无心跳 Ns（阈值 Ns），自动退出`
- 页面每 5 秒 `POST /api/heartbeat`；页面 `pagehide` / `beforeunload` 时用 `navigator.sendBeacon('/api/close')` 发关闭信号
- 收到关闭信号后服务再等 **5 秒**才退：这 5 秒内只要又来一次心跳（F5 刷新、关掉马上重开）就**取消退出**，不会误杀
- **多标签页天然正确**：服务端只记「最近一次心跳时间」，任一标签还在心跳就不会超时
- 界面上也能手动停：右上角「关闭服务」（二次确认后调 `/api/close`），或直接 `POST /api/close`
- 不传这个开关时，`/api/heartbeat` 与 `/api/close` 都只是 200 的空操作 —— 命令行用户行为完全不变

**本机便利（可选，不随仓库分发）**：想要「双击就开、窗口不残留、关网页自动收掉」，可以在桌面建一个快捷方式指向
PowerShell 的隐藏命令，而不是直接指向 `node.exe`：

- 「目标」：`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
- 「参数」：`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "cd '<仓库目录>'; node scripts/editor.mjs --exit-on-idle 20 *>> '<仓库目录>\out\editor.log'"`
- 「起始位置」：仓库目录；「运行方式」：最小化（窗口样式 7）
- 效果：无窗口后台启动、输出追加到 `out/editor.log`（`out/` 已在 `.gitignore` 里）、关掉网页约 20 秒后服务自己结束

仓库内**不提供** `.cmd` / `.lnk` 之类的启动脚本：启动脚本与快捷方式都属于个人环境配置，不入库，避免污染仓库。

### 4. 保存即发布：`POST /api/publish`

界面里点「保存并发布」（快捷键 `Ctrl+Shift+S`）或直接打 API，一次把改动铺到全链路：

```
写角色 JSON  →  重建 data/_index.json  →  build-docx.mjs 写回 Word 主文档（先备份）
            →  build-html.mjs 生成 guide.html  →  生成提交摘要
            →  三方一致性校验（全过才继续）  →  git add + git commit（**绝不 push**）
```

**保存并发布 = 保存 + 发布 + 多方校验 + 自动提交；推送（`git push`）由人工执行** ——
全链路只做 `git add` / `git commit`，**不执行任何 `git push`，也不设置远端**。

「一致」指：**数据库（`data/gi`）× 主文档（干净可读版）× 标记版文档 × 网页版（`guide.html`）** 内容等价。
提交前逐项校验，**任一项不过就跳过提交**（已生成的文档 / 网页保持可用，不回滚）：

| 校验 | 命令 / 依据 | 通过标准 |
|------|-------------|----------|
| a. 数据 ↔ 主文档 | `node scripts/diagnose-docx-json.mjs` | 不一致角色 **0** |
| b. 主文档往返 | `build-docx --write-main` 的往返校验（`parse-docx` 读回 vs 生成时 JSON） | **129/129 深度相等** |
| c. 网页版新鲜度 | `guide.html` 必须是本次 publish 的 `build-html` 刚生成的（比对 sha1/大小） | 本次生成 |
| d. 悬挂分隔符 | `node scripts/scan-separators.mjs` | **0 处** |
| e. 标记版文档 | 标记版本次刷新；`parse-docx` 读回与 `data/gi` **129/129 深度相等**；与主文档**去标记后逐字一致** | 全过 |

任一项不过时返回 `{ok:false, step:'verify', detail:'…', commitExecuted:false}`，
`detail` 里写明**哪一项没过、哪几个角色不一致**，摘要也会标注「已跳过自动提交」。

### 两份文档的分工（主文档=可读版，标记版=转换用）

`build-docx --write-main` 一次产出**两份**文档，内容同源、去标记后逐字等价：

| 文档 | 内容 | 用途 |
|------|------|------|
| `D:\文件\游戏\原神\原神·角色攻略.docx`（主文档） | **纯文本可读版**（等价 `--no-mark`） | 给人读 / 手工微调 |
| `out\原神·角色攻略(标记版).docx` + `D:\文件\游戏\原神\原神·角色攻略(标记版).docx` | **带引用标记** `[[w:]] [[a:]] [[c:]] [[t:]] [[k:]]` | 给 `parse-docx` 转换用（引用显式化） |

* 只想单独生成一种：`--out x.docx --no-mark`（纯文本）/ `--out x.docx`（带标记，默认）；`--marked-src` 表示按标记版语义生成。
* 标记版覆盖交付副本前备份 `.bak-<时间戳>`（保留最近 5 份）。
* 写主文档**只**发生在显式 `--write-main`，且往返校验不过就拒绝写。

### 解析告警（防呆，不静默）

`parse-docx` 遇到**无法保留 / 无法归位**的括注或标记时会显式告警：
逐条 `⚠ 解析告警：…` 打到 stderr，并汇总进 `data/_parse-report.json` 的 `warnings` 数组
（既有 `注：` 备注走廊机制不变）。正常文档应为 `解析告警：0 条`。

**已知的「名称校验问题」（不是告警，属正常）**：文档里 `过渡：2充能 + 2充能`、`可选：2攻击 + 2攻击`
这类写法是**效果描述**（"带充能/攻击 2 件套的两套"），**不是套装名**，因此不在图鉴里 ——
`parse-docx` 会记进 `_parse-report.json` 的 `issues`（当前 33 条 / 13 行），**不影响往返**。
真名写法见 `首选：翠绿之影 / 角斗士的终幕礼（2件套）`。

| 产出 | 说明 |
|------|------|
| `data/gi/<角色名>.json` | body 带 `name` 时由服务器按 v2 规范化后写盘（同「保存」） |
| `data/_index.json` | 用 `build-index.mjs` 重建（新角色立刻能被名称校验认识） |
| `D:\文件\游戏\原神\原神·角色攻略.docx` | 主文档。**写前自动备份**为同名 `.bak-YYYYMMDD-HHmmss`（保留最近 5 份），再原子替换 |
| `guide.html` | 网页版 |
| `out/_commit-summary.md` | 提交摘要（最新一份覆盖写），同时留 `out/_commit-summary-<时间戳>.md`（保留最近 5 份） |

**提交摘要**（界面右下角 toast 里显示同样内容，带「复制提交信息」按钮）包含四段：

1. **建议提交信息** —— 单行标题 + 正文要点（单角色 `docs: 更新 <角色名>（<字段>）`，批量 `docs: 批量更新 <n> 个角色`），
   自动提交用的就是它（首行标题 + 正文要点）
2. **变更文件** —— 新增 / 修改 / 删除 + 行数（新增文件给 `+行数`）
3. **按角色变化** —— 武器 / 圣遗物 / 天赋 / 面板 / 命座 / 配队 各「增 / 删 / 改」几条
4. **未跟踪文件** —— `git status` 里的 `??` 文件提醒

**提交范围**：只提交本次发布真正动过的路径（`data/gi/*.json`、`data/_index.json`、`guide.html`、`out/_commit-summary*.md`）
以及**未跟踪的新文件**，不会把仓库里别人的在途改动一起卷进去。
主文档不在仓库内，不进 git。需要「整仓 `git add -A`」时可显式传 `{ "stageAll": true }`。

**提交失败/无改动都不算发布失败**：`git` 不可用、无改动、提交失败 → 返回
`{ok:true, commitExecuted:false, commitError|commitSkipped:'…'}`，保存与生成的结果**不回滚**，提示用户手动提交。

响应形状：

```json
{
  "ok": true,
  "steps": [{ "step": "写角色 JSON", "ok": true, "detail": "data/gi/旅行者·火.json" }],
  "verify": { "ok": true, "checks": [{ "key": "docx-json", "name": "数据 ↔ 文档（diagnose-docx-json）", "ok": true, "detail": "不一致角色 0 个" }] },
  "summary": { "suggestedMessage": "docs: 更新 旅行者·火（武器）", "markdown": "…", "changedFiles": [], "characterChanges": [], "untracked": [] },
  "summaryFile": "out/_commit-summary.md",
  "summaryStampFile": "out/_commit-summary-20260919-213340.md",
  "docx": { "path": "D:\\文件\\游戏\\原神\\原神·角色攻略.docx", "backup": "…bak-20260919-213340", "bytes": 29414 },
  "html": { "path": "guide.html", "bytes": 220601 },
  "commit": "1a2b3c4",
  "commitExecuted": true,
  "pushed": false
}
```

任何一步失败：该步 `ok:false` 并带 `detail`，**后续步骤继续尝试**（例如 docx 失败也会照常产摘要），
响应里如实列出每一步，不会静默跳过。

> 幂等的手动重试入口：`POST /api/commit`（body `{message?, paths?, stageAll?}`，不传 message 则取摘要里的建议标题）——
> 界面上没有入口；**无改动时返回 `{ok:true, commitExecuted:false, commitSkipped:'…'}` 且不报错**，同样不 push。

#### `scripts/build-docx.mjs`：JSON → Word 主文档

```bash
node scripts/build-docx.mjs [--out 目标docx] [--template 模板docx] [--no-mark] [--dry] [--no-verify]
```

* 默认目标就是主文档；`--dry` 只打印将写入的段落数 / 角色数 / 标记数，不写文件。
* 以现有主文档为模板，**只替换 `word/document.xml`**，其余部件（`[Content_Types].xml`、`_rels`、`styles`…）逐字节复制；
  段落数与文本行数一致，`[Content_Types].xml` / `_rels/.rels` / `word/document.xml` 必须齐全。
* **默认只写仓库内的试验产物** `out/build-docx-<时间戳>.docx`；**只有显式 `--write-main` 才写主文档**，
  且写前自动备份为 `.bak-<时间戳>`（保留最近 5 份）、原子替换；**往返校验不过就拒绝写**（保留原文档）。
* 默认写入引用标记 `[[w:]] [[a:]] [[c:]] [[t:]] [[k:]]`（与 `mark-docx.mjs` 同一套实现，逐行做回推校验，有损标记自动撤回）；
  `--no-mark` 写纯文本。**两种模式下 `parse-docx` 读回来都与 `data/gi/*.json` 129/129 深度相等**。
* 幂等：连续跑两次，`word/document.xml` 逐字节相同（zip 内各条目的时间戳按运行时刻写入，所以整包字节会变）。

编辑器只用了 Node 内置模块（`node:http` / `node:fs` / `node:path` / `node:url` / `node:child_process`），
静态资源在 `resources/editor/`（`index.html` + `app.js` + `picker.js` + `style.css`；
拼音表 `scripts/lib/pinyin.mjs` 由服务端以 `/pinyin.js` 发给浏览器，不重复维护两份）。

**关键约定**

- 需要图标的实体（武器 / 圣遗物套装 / 配队角色 / 天赋 / 命座）都是**独立的带类型徽标输入控件**，
  不会和正文文本混在同一个输入框；输入框挂 `<datalist>` 候选（来自 `/api/index`），旁边还有「▾」按钮
  打开**可搜索选择器**（支持中文 / 拼音首字母过滤），列表里第一条之后的行还能「⧉ 上一条」复制上一行的名字
- 配队成员用**可搜索多选选择器**：输入中文或拼音首字母（如 `ldjj` → 雷电将军）过滤全部角色候选，
  回车添加、`↑↓` 选择、已选 chip 可拖动排序（也能用 `←/→` 键移动），确认后写入 `{name, ref:"character:…"[, note]}`
- 名字不在图鉴时，输入框旁出现 ⚠ 与原因（来自 `validate(data, index)`）
- **回收站**（左侧「🗑 回收站」）：列出 `data/_trash/` 里被软删除的角色（删除时间 / 大小 / 各段行数 / 是否撞名），
  可「恢复」（移回 `data/gi/` 并把名字补回 `_order.json` 末尾）、「彻底删除」单个、「清空回收站」——三个写操作都有二次确认
- **批量替换**（工具箱 → 批量替换，或从全局搜索结果直接发起）：按类别把某个名字换成另一个，
  只改 v2 引用（`name` / `ref`），**不动 `note`**，并回推 `tags` / `sections`；
  先「预览命中」（列出命中角色 / 段落 / 第几行），执行前把要改的文件复制到 `data/_backup/<时间戳>/`，
  可一键回滚（`POST /api/batch-replace/undo`）；名字不在 `_index.json` 时只给 ⚠、仍允许强制替换
- **全局检索**（顶栏搜索框，`Ctrl+F`）：搜名称 → 返回「哪些角色 / 哪个段落 / 第几行用到它」，
  点结果跳转到该角色并高亮所在行；也支持搜正文关键词（匹配 `sections` 文本行）
- **名称库浏览**（工具箱）：列出 `_index.json` 的武器 / 圣遗物套装 / 角色，标出「未使用 / 被 N 个角色用到 M 处」，
  点名字看它用在哪里，并可从这里直接发起批量替换
- 保存时由服务器重新生成 `tags` / `sections`（丢弃前端传来的这两个字段），并强制 `schema: 2`
- **未被编辑器编辑的字段会从原文件按位置合并回来**（`raw`、`sep`、套装 `pieces`、空的主词条占位行等），
  所以「打开再保存」不会产生多余 diff；129 个 v2 文件实测逐字节不变
- `highlight` 编辑器只读、保存时原样保留；备注行（`{kind:'note'}`）与主词条的 `note` / `noteSlot` 也会原样带回
  （圣遗物段可以直接把某一行切成「备注（注：）」类型来编辑）

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
| GET | `/api/trash` | 回收站清单：`{ok,total,items:[{name,file,bytes,deletedAt,schema,broken,summary:{weapons,artifacts,teams,constellations},conflicts}]}`（按删除时间倒序；`conflicts` = `data/gi/` 已有同名文件，恢复会 409） |
| POST | `/api/trash/restore` | body `{name}`：把 `data/_trash/<name>.json` 移回 `data/gi/` 并把名字**补回 `_order.json` 末尾**，重建索引；撞名返回 409 |
| DELETE | `/api/trash?name=X` | **彻底删除**回收站里的一个角色（不可撤销） |
| DELETE | `/api/trash` | **清空回收站**：返回 `{ok,removed,names}`（删不掉的个别文件会跳过） |
| GET | `/api/search?q=&type=&scope=` | 全局检索。`type` = `weapon`/`artifact`/`character`/`talent`/`constellation`/`set`（`set` = 圣遗物套装）；`scope` = `name`（只查名称引用）/ `text`（只搜正文）/ `auto`（默认，两者都查）。返回 `{names:[{type,name,total,characters,hits:[{file,name,section,line,rowId,path,ref,text,hitId}]}], text:[...]}` |
| GET | `/api/name-usage` | 名称库使用统计：`{weapons,artifacts,characters}`，每项 `{name,total,characters:[{name,count}]}`（未出现的名字即「未使用」） |
| POST | `/api/batch-replace` | body `{type,from,to,dry?}`。`dry:true` 只预览（返回 `total` / `files` / `perCharacter` / `hits` / `warnings`）；否则执行替换，返回 `{stamp,files,perCharacter,changed,remaining,warnings}`，并在 `data/_backup/<stamp>/` 留副本 |
| POST | `/api/batch-replace/undo` | body `{stamp}`，用备份逐字节还原并删除该备份目录 |
| POST | `/api/publish` | 保存并发布全链路：写角色 JSON（body 带 `name` 才写）→ 重建 `data/_index.json` → `build-docx.mjs --write-main` 写回 Word 主文档（自动备份）→ `build-html.mjs` 生成 `guide.html` → 提交摘要 `out/_commit-summary.md`（+ 最近 5 份时间戳副本）→ **三方一致性校验**（diagnose 不一致 0 / 往返 129-129 / guide.html 本次生成 / 悬挂分隔符 0）→ `git add` + `git commit`。返回 `{ok, steps, verify, summary, docx, html, summaryFile, summaryStampFile, commit:'<短hash>', commitExecuted, pushed:false}`；校验不过时 `{ok:false, step:'verify', detail, commitExecuted:false}` 且**不提交**；提交失败/无改动时 `{ok:true, commitExecuted:false, commitError|commitSkipped}` 且**不回滚**。**永不 push**（详见「保存即发布」一节） |
| POST | `/api/commit` | 幂等的手动提交入口（界面无入口）：body `{message?, paths?, stageAll?}`，不传 message 则取摘要里的建议标题；`git add` + `git commit`，返回 `{ok, commit:'<短hash>', commitExecuted, commitError?, commitSkipped?, pushed:false}`；**无改动不报错**，同样不 push |
| GET/POST | `/api/heartbeat` | 页面心跳（前端每 5 秒一次）：返回 `{ok, exitOnIdle, idleSeconds, at}`；`--exit-on-idle` 未开启时 `exitOnIdle:false`（空操作，不影响命令行用法） |
| POST | `/api/close` | 页面关闭信号：返回 `{ok, exitOnIdle, graceMs}`。开启空闲退出时，**5 秒宽限期**后退出；期间再来一次心跳就取消退出（刷新页面不会误杀服务）。未开启时是空操作。前端用 `navigator.sendBeacon('/api/close')` 在 `pagehide` / `beforeunload` 时发出 |

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

## 许可

本仓库按内容类型**分别授权**，两部分**都是非商用许可**：可自由使用、修改、分享，
但**不得用于商业用途**；商用需另行取得授权。

| 范围 | 内容 | 许可 |
|------|------|------|
| `scripts/`、`resources/` | Node 脚本（Word→JSON 转换、索引 / 网页 / 文档生成、图形化编辑器）与编辑器静态资源 | **PolyForm Noncommercial 1.0.0**（非商用），见 [`LICENSE`](LICENSE) |
| `data/`、`templates/`、`guide.html`、`guide.md` | 角色攻略数据、页面模板，以及由数据生成的网页版 / 文档版 | **CC BY-NC-SA 4.0**（署名—非商业性使用—相同方式共享），见 [`LICENSE-DATA`](LICENSE-DATA) |
| `汉仪文黑-85W.ttf` | `guide.html` 使用的字体（**不入库**，用 `node scripts/fetch-font.mjs` 从上游同步） | 商业字体，版权归汉仪字库所有，**不随仓库分发**；使用者需自行获取，或直接用免费回退字体 |

1. **脚本（PolyForm Noncommercial 1.0.0，非商用）**：可自由使用、修改、分享与再分发，
   **仅限非商业目的**（个人学习 / 研究 / 实验 / 业余项目，以及慈善、教育、公共研究、
   公共安全与卫生、环保、政府机构的使用）；**不得用于商业用途**，商用需另行取得授权。
   分发时须随附本许可条款（或官方 URL），并保留 `Required Notice:` 版权行；本许可不允许再许可（sublicense）。
   官方文本：<https://polyformproject.org/licenses/noncommercial/1.0.0>（全文亦见 [`LICENSE`](LICENSE)）。
2. **攻略数据与文档（CC BY-NC-SA 4.0，署名—非商业性使用—相同方式共享 4.0 国际）**：
   - 允许复制、转载、改编，但**仅限非商业用途**；**商业用途不在授权范围内**，需另行取得授权；
   - 必须**署名**：注明来源为本仓库（`Character-Codex-Data`，并附仓库链接）及所用许可；
   - 改编作品（含基于本数据的二次整理）**必须以相同许可**（CC BY-NC-SA 4.0 或兼容许可）发布
     —— 这是 NC 之外的另一项限制：**SA 相同方式共享**；
   - 官方法律文本全文见 [`LICENSE-DATA`](LICENSE-DATA)（英文逐字转载），亦见
     <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>；简体中文参考译本：
     <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.zh-Hans>。**如有出入，一律以官方文本为准。**
3. 上述许可只覆盖整理者可以主张权利的「整理、编排、结构化与表述」部分，**第三方内容不在授权范围内**。

### 字体（不入库，用 `scripts/fetch-font.mjs` 从上游同步）

`汉仪文黑-85W.ttf` 是**商业字体**，版权归汉仪字库（北京汉仪创新科技股份有限公司）所有，
**不在本仓库的授权范围内，也不随仓库分发**：

- 该文件**已从整个 git 历史里彻底移除**（`git filter-repo` / `git filter-branch --index-filter` + `reflog expire` + `gc --prune=now`，
  所有 ref 的任何提交里都不再含这个 blob），因此**远端一旦强推，别人也看不到它**；
- 同时写进 `.gitignore` 的 `*.ttf` / `*.otf`，避免以后再被 `git add` 带进去；
- 本机想看图鉴网页版的真实排版，用 `node scripts/fetch-font.mjs` 从上游取一份同名文件放到仓库根目录即可（见下）。

#### 上游到底有没有这个字体

**有等价文件，没有同名文件**：上游图鉴仓库 [Atlas-Plugin](https://github.com/AxiuCN/Atlas-Plugin)
的 `resources/common/font/hk4e_zh-cn.ttf` 与本仓库原先那份 `汉仪文黑-85W.ttf`
**字节完全相同**（都是 7,232,220 字节，SHA256 `fcc8454a5ea27e2cd5a0e435ca83e0b5a87af31c95a2e57e74975c3e9df96d23`），
在 `origin/master` / `upstream/master` 里都是普通 blob（非 LFS）。它是从原神客户端提取的 hk4e 内置字体，
Atlas-Plugin 自己注释为「hk4e（原神官方字体）」。

> ⚠️ 因此「从上游取回」只解决**本机排版一致**的问题，不改变授权性质：
> 上游那份同样是汉仪商业字体 + 米哈游游戏资源。想规避风险，见下面的「免费替代」。

#### 取回字体

```bash
node scripts/fetch-font.mjs          # 已有同名文件时跳过
node scripts/fetch-font.mjs --force  # 强制重新同步
node scripts/fetch-font.mjs --from <路径或URL> --force
```

按顺序尝试：

1. **本地上游图鉴仓库**（优先，不必联网）：`<Atlas-Plugin>\resources\common\font\hk4e_zh-cn.ttf`
2. **上游 raw 地址**：`https://raw.githubusercontent.com/AxiuCN/Atlas-Plugin/master/resources/common/font/hk4e_zh-cn.ttf`
   （以及 `Hyposelenia-Moon/Atlas-Plugin` 的同路径）

成功后在**仓库根目录**写出 `汉仪文黑-85W.ttf`，并打印字节数与 SHA256（方便核对是不是同一份）。
实测（本机）：

```
$ node scripts/fetch-font.mjs --force
复制：D:\文件\游戏\原神\Atlas-Plugin\resources\common\font\hk4e_zh-cn.ttf … OK（7232220 字节（6.90 MB））
SHA256：fcc8454a5ea27e2cd5a0e435ca83e0b5a87af31c95a2e57e74975c3e9df96d23
来源：本地上游图鉴仓库
```

拿不到时脚本退出码 1，并提示三条手动路径（放文件 / `--from` / 直接用免费字体）。

#### 没有字体时会怎样（回退栈）

`guide.html` 的 `@font-face` 仍按相对路径引用 `./汉仪文黑-85W.ttf`；文件不存在时浏览器会回退到
`font-family` 栈里的免费字体：

```css
font-family: 'HYWenHei-85W', 'MiSans', 'Source Han Sans SC', 'Noto Sans CJK SC',
             'Noto Sans SC', '思源黑体', 'Microsoft YaHei', 'PingFang SC', sans-serif;
```

- **本机有 `汉仪文黑-85W.ttf` 时仍优先用它**（栈里排第一），排版与原来完全一致；
- 没有时按 `MiSans → 思源黑体 / Noto Sans SC → 微软雅黑 / 苹方` 依次回退，观感与汉仪文黑接近；
  `MiSans` 官方声明**全球免费商用、允许嵌入式**（<https://hyperos.mi.com/font/faq>），
  `Noto Sans SC / Source Han Sans SC` 为 SIL OFL，都可自由分发；
- 也就是说**别人 clone 下来不做任何事也能正常看网页版**，只是字形略有差别。

想彻底规避商业字体，把 `templates/guide.html` 里 `@font-face` 指向 MiSans / Noto 即可
（`fetch-font.mjs` 与 `.gitignore` 都不用动）。

#### 手动获取与授权

需要商业字体本身的，走官方渠道（个人非商用可免费下载，商用需购买授权）：

- 汉仪文黑 85W 产品页：<https://www.hanyi.com.cn/productdetail.php?id=992&type=0>
  （页面原文：「当前字体仅供个人使用，若需商用，请您『购买授权』」）
- 《汉仪字库个人非商用须知》：<https://www.hanyi.com.cn/coupon/faq-doc-1>
  （关键限制：「**不得对外销售或提供许可字库或其中的任何字体，无论通过何种技术方式**」
  「**不得将许可字库或其中的字体加载到您或第三方经营的产品中**」）
- 商用 / Webfont 授权：<https://www.hanyi.com.cn/license>、<https://www.hanyi.com.cn/webfont>

结论：**商业字体，个人非商用免费、商用需付费；不构成可合法随仓库分发的来源**（上游那份也一样）。

### 游戏内容版权声明

《原神》及其相关名称、角色、武器、圣遗物、图标、游戏内文本与数值等，版权归 **米哈游 / HoYoverse**
（上海米哈游影铁科技有限公司及其关联公司）所有。

本仓库是**非官方**的玩家整理，与米哈游 / HoYoverse 无任何隶属、赞助或合作关系；
内容仅供学习、研究与个人使用，**不得用于商业用途**，商业使用请自行向权利人取得授权。
如权利人认为本仓库内容侵犯其合法权益，请联系仓库维护者处理。

### 数据来源

- **攻略正文**：由本地 Word 文档《原神·角色攻略.docx》整理转换而来（`scripts/parse-docx.mjs`）。
  每个角色文件的出处记录在 `source.guide` 字段，目前取值有 `原神·角色攻略.docx` 与 `原神·角色攻略`。
- **名称索引** `data/_index.json`（武器 / 角色 / 圣遗物套装名）：由图鉴后端
  [nanoka-atlas-backend](https://github.com/MOPELotus/nanoka-atlas-backend)（数据源 [nanoka.cc](https://nanoka.cc/)）生成，
  见 `scripts/build-index.mjs`。
- **游戏内名词与原始资料**：名称、图标、数值等的原始出处为游戏内图鉴与官方资料；
  若某条正文引用或改编自米游社观测枢等社区词条，其版权归原作者所有，转载时请一并保留原作者署名。

`source` 字段是本仓库唯一的来源标注依据（当前 129 个角色文件全部带有 `source.guide`）；
数据文件中的 `source` 与本节描述不一致时，以数据文件为准。

