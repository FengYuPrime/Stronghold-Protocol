# 皮肤特效 / 官方 VFX 移植手册（本 fork 的实做记录）

> 面向对象：**要复刻本 fork「皮肤换装 + 官方战斗特效」功能的其他仓库维护者/智能体**。
> 目的：把「结论 + 做法 + 代码位置」一次讲清，避免从零翻代码。
> 基线：上游 `sganggs/Stronghold-Protocol` **0.3.0**（官方自带 VFX 系统：`render/vfx/**` + `tools/local-extract/fx.py`）。
> 本文件描述的改动全部是 **fork 侧增量**，上游没有皮肤换装，因此「皮肤 × 特效」的组合全部是本 fork 自己打通的。

---

## 0. 先读这一节（否则会浪费几小时）

三条最容易把人带沟里的事实：

1. **fx 键（特效名）按「干员 code」命名，不按 charId**。
   `char_1033_swire2` 的特效键叫 `swire2_skill_02_start`，不是 `char_1033_swire2_...`。
   而且 `data/local-fx.json` 是**单行压缩 JSON** —— 用 `grep char_2025_shu` 会得 0 命中，**这不是「没导出」**，是命名假象。搜 `shu_talent_buff_01`、`swire2_`、`blaze2_`。
2. **游戏客户端的资源有两层：基础包 + 热更覆盖层**。
   - 基础：`Arknights_Data/StreamingAssets/AB/Windows/`
   - 热更覆盖：`Arknights_Data/PersistentData/Bundles/`
   新皮肤（例如国家图书馆联名 `@nlc#1`）的 `skinpack/*.ab` **只在覆盖层里**。只扫基础包 = 永远找不到新皮肤的特效 hooker，而且不会报错。
3. **提取顺序是刚性的**：`fetch-assets → skins inject`。
   `tools/fetch-assets.mjs` 会**重建 `data/assets.json`**，把 `skins.mjs inject` 写进去的皮肤/召唤物字段全部冲掉。改完素材又要注入，必须按这个顺序重跑。

---

## 1. 五分钟数据流地图

```
游戏客户端 AB（基础 + 覆盖层）
   │  tools/local-extract/extract.py --only fx --fx-set used   （Python 3.12！）
   ▼
public/assets/local/fx/{index.json, prefabs/**, tex/**, mesh/**}
data/local-fx.json                  ← 特效 prefab 清单（单行，~2.5MB）

官方皮肤表（.cache/skin-table.json）
   │  tools/skins.mjs（tokenSkinMap → 召唤物皮肤；numberedSkills → 皮肤技能片段）
   │  tools/assets/plan.mjs（token 皮肤变体 + owner 派生）
   ▼
data/assets.json                    ← chars[charId].{spine,skins[...]}、tokens[...]
public/assets/spine/**              ← 模型文件（镜像下载）

运行时（浏览器）
   public/js/assets.js     spineEntry() / tokenSkinSpine()  ← 选模型（干员 / 皮肤 / 召唤物变体）
   public/js/render/units.js                                ← 单位视图（把 skin 传下去）
   public/js/render/spine.js                                ← 骨骼/动画状态机
   public/js/render/vfx/wiring.js  playOn()/keysFor()       ← 特效键解析 + 皮肤替换
   public/js/render/vfx/skills.js  FX_BINDINGS / FX_COVER   ← 「哪个技能播哪些键」
   public/js/render/vfx/talents.js talentBindings()          ← 天赋特效
   public/js/render/vfx/skillfx.js simFx()/_bound()         ← sim 事件 → 特效键 → spawn
   public/js/render/vfx/system.js                           ← 预算（MAX_EFFECTS / MAX_PARTICLES）
```

---

## 2. 皮肤特效（核心功能）

### 2.1 原理：皮肤通过 `CharacterSkinHooker` 换特效键

官方客户端里，每套皮肤有一个 battle prefab：

```
dyn/battle/prefabs/skins/character/<charId>/<charId>@<group>#<n>.prefab
```

它上面挂着 `Torappu.Battle.CharacterSkinHooker`，字段：

| 字段 | 含义 |
|---|---|
| `_replaceEffectPairs` | `{ 原特效键 → 皮肤特效键 }`，**逐键替换**（最主要，21 条/皮肤很常见） |
| `_fakeProjectileConfigs` | `originProjectileKey → { graphical, logical }` 弹道替换（本 fork **未接线**） |
| `skin_points`（挂点） | 皮肤自己的枪口/手部/特技点，可能和默认模型位置差一格 |

**关键结论：皮肤的「特效」不是靠命名约定推出来的**——试过用后缀反推（`key + @skin#n`），604 套里只有 495 套能命中，`@epoque#4` / `@winter#1` 这类是「hooker 存在但替换为空」。**必须读 prefab**。

### 2.2 提取器改动：`tools/local-extract/fx.py`

| 改动 | 位置（函数） | 说明 |
|---|---|---|
| 读 hooker、产出 `skinFx` 段 | `skin_hooks()` | 扫 `skinpack/<charId>.ab`，把每套皮肤的 `replace` 映射写成 `index.json` 顶层 **`skinFx: { skinId: { replace, points, fakeProjectiles? } }`** |
| **replace 两侧都并入导出集** | `skin_referenced()`（被 `export_fx()` 调用） | 原来只并入**右值**（皮肤变体）→ 被替换的**基础键永不导出** → 运行时 `library.has(base)` = false，表现是「皮肤特效没有、原版也没有」。**这是必须修的第二处** |
| 大小写归一 | `official_skin_ids()` / `skin_id()` | container 里的 prefab 名是小写（`char_1033_swire2_ambiencesynesthesia#4`），官方 id 是 `char_1033_swire2@ambienceSynesthesia#4`；运行时 `idx.skinFx[skin]` 是**精确**查表，所以必须换成官方拼写 |
| 热更覆盖层 | `Roots` / `pick()` / `scan_cabs()` / `container_index()` | 见 2.3 |

`INDEX_VERSION` 保持 **3**（纯增量字段，不破坏旧 index）。

### 2.3 热更覆盖层（本 fork 最大的坑）

**症状**：新皮肤（`@nlc#1`）在游戏里明明有特效，提取器却说 `skip (no such effect prefab in this client)`，或 `skinFx` 里根本没有这套皮肤。

**原因**：新皮肤的 `skinpack/*.ab` 与它引用的 effect bundle 都在 **`PersistentData/Bundles/`**，而 `fx.py` 原来只查 `StreamingAssets/AB/Windows/`。

**做法**（三处 + 一个缓存版本）：

```python
# fx.py：Roots 类
overlay = Path(base).parents[2] / 'PersistentData' / 'Bundles'   # …/Arknights_Data/PersistentData/Bundles
self.overlay = overlay if overlay.is_dir() else None
def newest_first(self): return [r for r in (self.overlay, self.base) if r]
def pick(self, rel):    return (self.overlay / rel) if (self.overlay and (self.overlay/rel).is_file()) else (self.base / rel)
```

接入点：

- `AssetEnv.load_rel()` → 走 `roots.pick(rel)`
- `scan_cabs()` → 遍历 `roots.newest_first()`，`setdefault` 保证同名 CAB **覆盖层胜出**
- `container_index()`（特效键索引）→ 同样遍历两层
- **缓存失效**：`.cache/fx/effects.json` 结构升级为 `{ format, version: 2, roots: [...], bundles: {rel: {root,size,mtime}} }`，`format/version/roots` 任一不符就整份作废重扫。否则改了代码也会读到旧索引，**看到完全一样的 skip 列表**。

**验证**：重跑 `--only fx --fx-set used` 后
- `container index: N bundles read`，N > 0（旧缓存已作废）
- `fx: <M> effect prefabs in the client` 的 M 上升
- 日志里**不再**出现 `skip … _nlc#1`
- `skinFx` 数量 273 → **276**（三套 nlc）

> 附：这些包是 **LZ4AK** 压缩，裸 UnityPy 会抛 `NotImplementedError: LZHAM`。仓库自带解码器 `tools/local-extract/aklz4.py`，**`import aklz4` 即注册**进 UnityPy。看到 LZHAM 报错不代表文件坏了。

### 2.4 客户端：特效键的皮肤替换

`public/js/render/vfx/wiring.js`

| 函数 | 作用 |
|---|---|
| `skinOfView(view)` / `skinFxOf(view)` / `skinKey(view, key)` | 取该视图（单位）穿着的皮肤 + 它的替换表 |
| `playOn(key, view, opts)` | **所有单位特效的唯一出口**；查表后先做一次皮肤替换，**替换键本地没有就回退基础键** |
| `keysFor(unitKey)` | 收集该单位的特效键（`idx.units[key].modes[].attack/combat`、`idx.skills`、`idx.talents`、`idx.funnels`），要把**皮肤键也预载**，避免晚加载导致首帧缺失 |
| `_fly` / `_bounce` / `funnelfx.js` 中的挂点 | 取挂点用 `skinOfView`（皮肤骨骼），否则位置会差一格 |
| **`playOn(key, view, { skinFrom })`** | 默认 `skinFrom = 被放置的视图`。**攻击命中行是播在「目标」身上的**，目标的皮肤不是施法者的 → 穿皮肤时命中特效永远播基础版。`_arrive()` 里对 `proj.onHit` 与 hit 行传 `skinFrom: src` 才修好 |

### 2.5 验证

```bash
# 1) 提取（必须 3.12 解释器；系统 python 3.11 会因 PEP 701 f-string 直接 import 失败）
.venv-extract/Scripts/python.exe tools/local-extract/extract.py \
  --only fx --fx-set used --game "<...>/Arknights_Data/StreamingAssets/AB/Windows"

# 2) 看数据
node -e "const j=require('./public/assets/local/fx/index.json');const s=j.skinFx['char_1040_blaze2@nlc#1'];console.log(Object.keys(s.replace).length)"
node -e "const f=require('./data/local-fx.json');console.log(!!f.groups['fx/prefabs']['blaze2_attack_01_hit_nlc#1'])"

# 3) 重启服务器 + Ctrl+Shift+R（0.3.0 启动时把 /data/*.json 固化进内容视图，不重启拿不到新清单）
```

游戏内：设置「官方特效 = 完整」→ 穿皮肤放技能看**命中/施法特效是否变皮肤版**。

### 2.6 ⚠️ 关键词：**新出的国家图书馆系列**（`@nlc#1`，本 fork 专门处理过的三套）

这三套是「**皮肤特效移植**」最典型的教科书案例，也是把 §2.3 的覆盖层 bug 暴露出来的直接原因。要复刻的人**先把这三套跑通**，其余皮肤基本就通了。

**三套皮肤与它们的差异**（同一个客户端版本、三种不同情况）：

| 皮肤 | `chatSkin` 的 `tokenSkinMap` | 特效 hooker 在哪 | 备注 |
|---|---|---|---|
| `char_1033_swire2@nlc#1`（盛世之象） | **有**：`token_10031_swire2_gdtrap → token_10031_swire2_gdtrap_nlc#1` | 覆盖层 `PersistentData/Bundles/skinpack/char_1033_swire2.ab` | 19 条 replace + 1 条 fakeProjectile；**酒瓶模型要从镜像补**（§3） |
| `char_1040_blaze2@nlc#1`（夜行烛火） | `null`（这套没有召唤物） | 覆盖层 `skinpack/char_1040_blaze2.ab`（11.7 MB） | **21 条 replace + 3 条 fakeProjectile**——替换条目最多，最适合当验证样本 |
| `char_2025_shu@nlc#1`（源远流长） | `null` | 覆盖层 `skinpack/char_2025_shu.ab`（9.7 MB） | 21 条 replace；她的「地板」还牵扯 §6/§7 |

**当时踩过的四个坑（都已修，复刻时按顺序确认）**：

1. **基础包里根本没有这三套**：`StreamingAssets/AB/Windows/skinpack/char_1040_blaze2.ab` 只有 `char_1040_blaze2_winter#5.prefab`，`nlc#1` 只在覆盖层 → 必须先做 §2.3 的 `Roots`/`pick()`，否则 `skinfx` 里永远缺这三套（表现为「游戏里明明有特效，提取器说没有」）。
2. **覆盖层的包是 LZ4AK**：裸 UnityPy 报 `NotImplementedError: LZHAM`，**不代表文件坏**；`import aklz4` 之后能正常读（bin 里 426 个基础包 + 覆盖层 4 个包全部解析成功）。
3. **replace 的目标键与基础键都要导出**：不做 §2.2 的 `skin_referenced()`，会看到几十行 `skip (no such effect prefab in this client) blaze2_attack_01_hit_nlc#1 …`，皮肤特效与原版特效**同时消失**。
4. **大小写**：prefab 名是小写 `char_1033_swire2_ambiencesynesthesia#4`，官方 id 是 `char_1033_swire2@ambienceSynesthesia#4`；运行时是精确查表 → 必须经 `skin_id()` 归一。nlc 系列本身是小写 `@nlc#1`，不受影响，但同一轮里 17 个音律联觉皮肤的键会错。

**验收数字**（本 fork 环境，客户端 `26-09-13` + 覆盖层 `26-10-14`）：

```text
fx: 276 battle skins with hooks (4438 replaced effect keys, 276 with mount points)
   # 273 → 276，多出来的三套就是 @nlc#1
data/local-fx.json: 17,726 entries；fx/prefabs 9,303 个键
skinFx['char_1040_blaze2@nlc#1'].replace = 21 条
```

**补充：客户端里没下全资源时的表现**。如果游戏客户端没更新到含这三套的版本（或者只开过没进过皮肤相关场景），本地就真的没有这些 prefab —— 这时的现象是「**在官方客户端里能看到特效，但本地扫描找不到**」。判定方法：全量扫 `skinpack/*.ab` 的 container 名，含 `nlc` 的 bundle 数应当 ≥ 4（`char_1040_blaze2` / `char_1033_swire2` / `char_2025_shu` / `token_10031_swire2_gdtrap`）。若为 0，就是资源没到位，等客户端更新即可，**不要改代码**。

---

## 3. 召唤物（token）皮肤模型

### 3.1 数据来源

官方 `skin_table.json` 的 `charSkins[skinId].tokenSkinMap = null | [{ tokenId, tokenSkinId }]`。
磁盘模型来自**公开镜像**（不是本地提取器）：

```
https://raw.githubusercontent.com/fexli/ArknightsResource/main/spine/<tokenId>/<stem>/{Front|Spine}/<stem>.{skel,atlas,png}
#   stem = tokenSkinId 的 '#' → '_'     （注意路径不是 spine/token/...）
```

### 3.2 三处改动

| 层 | 文件 | 做法 |
|---|---|---|
| 计划 | `tools/assets/plan.mjs` | 原来只取 `battleSpineSkinVariantsOnly[0]` → 改成**从 `.cache/skin-table.json` 的 `tokenSkinMap` 全量派生**（82 对）；每个变体独立 key `token:<id>:<stem>` 但**同 dir**，`fetch-assets` 才会全部下载；新增 `tokens[id].spineVariants` |
| 保命 | `tools/fetch-assets.mjs` | 把变体文件加进 `dl.preserved`（否则 `--prune` 会当 orphan 删掉）；**日常永远不要用 `--prune`**——`skins.mjs` 下载的 `spine/op/**`、`char/skin_avatar/**` 不在模板里，会被一起删 |
| 注入 | `tools/skins.mjs`（`tokenSkinEntries`/`resolveTokenSkinSpineFromDisk`） | 只有**磁盘上真有模型**才写 `chars[owner].skins[skin].tokens[tokenId] = { tokenSkinId, spine }` |
| 渲染 | `public/js/assets.js` | `tokenSkinSpine(m, tokenId, skinId)`；`spineEntry()` 的 token 分支：命中皮肤映射 → 用皮肤模型（`fallback` = token 自己的模型），否则原逻辑 |
| sim 透传 | `server/sim/battle/players.js` | `skin: extra.skin ?? extra.ownerUnit?.skin ?? null`；「token 先于主人出现」的 late link 也补 `t.skin`（**纯展示字段**，无皮肤时 `unitInfo.skin` 仍是 `undefined`，golden 零移动） |

### 3.3 owner 派生（不做就只有一半能用）

渲染侧取 `tokens[tokenId].owner` 决定「这个 token 是谁的皮肤」。池内 token 由 `03-operators.tokensUsedByPool` 给出 owner，**池外 28 个 token 的 owner 是 null** → 映射写了也不生效。

`tools/assets/plan.mjs` 的 `tokenSkinOwners(table)`：**仅当 owner 为空**时，用该 tokenSkinMap 所属皮肤 skinId 的 `charId` 反推填 owner；`chars[charId]` 不存在则不塞（并打一条汇总 note）。

效果：能真正画出来的从 22 对 → **62 对 / 48 套皮肤**。剩下 16 对因为「主人不在棋池」而无 `tokens` 条目。

---

## 4. 皮肤的技能动画与「持续施法姿态」

### 4.1 皮肤模型从来没有自己的技能片段

`tools/skins.mjs` 用 `rec.skills` 解析技能片段，而 `data/assets.json` 的 chars **没有 `skills` 字段** → `skillIndices` 永远 `[0]` → 皮肤只能演普攻（`via:'attack'`）。

修法：`resolveRoles(..., { numberedSkills: SKIN_NUMBERED_SKILLS })`，让 `anims.skills` 按编号全部解析出来（`skills['2'] = { begin: Skill_3_Begin, loop: Skill_3_Loop, end: Skill_3_End }`）。改完必须重跑 `node tools/skins.mjs inject`。

### 4.2 「技能期间不回待机」（如烛煌 S3）

`public/js/render/spine.js`：

- 断点：`_idleName()` 只在 `sk.idle` 存在时保持技能姿态；很多技能 `idle: null` → 攻击后一律回 `Idle`。
- 新增 `_skillLoopIsStance()`：`skillOn && has(begin) && has(loop) && loop !== roles.idle && loop !== roles.attack?.loop && via !== 'attack' && !_skillIsBuffOnly() && !hits[loop]`
  （**判据**：`data/assets.json` 里该 loop 动画**没有打击帧** → 它是「站姿」而不是「挥击」）
- `_idleName()` 命中则返回 `roles.skill.loop`；`toSkillIdle` 也要接受这种情形，否则每次攻击后会补播 `Skill_End`。
- 额外要求 `has(begin)`：排除「无 Begin 的一次性施法片段」（德克萨斯剑雨那类），否则会在技能期间循环播斩击。

影响面：约 42 个干员/敌人、63 条 (unit, skill)。

---

## 5. 位置类问题：偏一格 / 偏两格

这一类有**两个完全不同的成因**，症状却很像（「特效出现在不该出现的格子上」），务必先分清：

| 成因 | 经典案例 | 现象 | 修法 |
|---|---|---|---|
| **A. 挂点（mount point）取到了皮肤错误的静态值** | ⭐ **史尔特尔 `char_350_surtr` 穿皮肤开 S3 → 整个人/特效出现在「面前那一格」**（这是本 fork 遇到的最经典案例） | 只在**穿皮肤**时偏，且**约一格**；不穿皮肤正常 | 见 5.1 |
| **B. prefab 根节点自带平移与 anchor 叠加** | 黍 `char_2025_shu` 的天赋圈偏到左下方约 2 格 | **任何皮肤**都偏，且偏移量由 prefab 决定 | 见 5.2 |

### 5.1 史尔特尔：皮肤挂点的静态值与皮肤骨骼不一致

S3 的全部视觉是一个循环 `surtr_skill_03_buff`，它通过 `FollowMountPoint` 挂在 **`SpecialPoint1`**（mount 6）上。而 `SpecialPoint1` 有两份值：

- **骨骼里（liveBone）**：皮肤骨骼与默认模型的骨骼位置不同，**取骨骼是正确的**；
- **prefab 里的静态值兜底**：`base` 的 `x = +0.632`，皮肤 `it#1` 的 `x = −0.396`、`back` 的 `x = +1.068` —— 差约一格，而且**镜像到另一侧**。

所以「偏一格」的真实链路是：**皮肤生效后挂点仍按错误的一份（或旧视图）取值**，而不是模型被挪动。

**先做这条诊断**（一句话分辨 A/B）：

> 穿皮肤**待机**时是否也偏？
> - 待机就偏 → 素材/模型原点问题（基本不用管，是美术本身）；
> - **只在放技能时偏 → 就是 A（挂点解析拿到了错的静态值/错的视图）**。

**修法**（`public/js/render/vfx/wiring.js`）：

1. 取挂点一律走 **`skinOfView(view)`**，不要用 `skinOf(unitOf(view))`；
2. 检查三处调用点：`playOn`、`_fly`、`_bounce`，以及 `public/js/render/vfx/funnelfx.js` 的两处；
3. 若 `liveBone` 取不到，**优先回退到基础模型的静态值**，而不是皮肤 prefab 里那份对齐用的值（否则就会镜像到另一侧）。

```js
// 反例（会偏一格）：挂点读的是「皮肤」的静态兜底
const mount = skin.points?.SpecialPoint1 ?? base.points.SpecialPoint1;
// 正例：先取皮肤骨骼，取不到再回退基础
const mount = liveBone('SpecialPoint1') ?? base.points.SpecialPoint1;
```

> 顺带：史尔特尔这套还暴露了另一个 bug（**皮肤模型从来没有自己的技能片段**），修法见 §4.1。两者叠加时的表现是「穿皮肤放 S3 演的是普攻，而且位置还偏」。

### 5.2 黍：prefab 根节点自带平移

**原因**：prefab **根节点自带平移**（`shu_talent_buff_01` 根是 `[-1.94, -1, 0]`），客户端把根 transform 覆盖成落点，而本实现把根节点自带 TRS 与 anchor **叠加**了。

**修法**：`public/js/render/vfx/effect.js`

- `compileEffect()` 记录 `def.peNode`（根节点是否是 ParticleEffect）与 `def.rootAtPoint = def.peNode === 0 && def.spawn !== 0`
- `_matrices()`：当 `i === 0 && def.rootAtPoint` 时**只减掉规范位（base）**，保留动画曲线带来的位移，然后照旧 `+ anchor`。

收窄到「根是 ParticleEffect 且 `_spawnLocation !== NONE`」：全库 9105 个 prefab 里 325 个根有偏移，其中 253 个根上没有 ParticleEffect（projectile/trail，靠 `_fly` 定位，不应动），真正受影响的只有 **64 个**。

---

## 6. 天赋特效绑定（`uses: []` 的兜底）

**症状**：`index.json` 里天赋效果键存在，但客户端什么都不播。

**原因**：`units.<id>.talents[n] = { effects: [...], uses: [], unclassified: [...] }` —— 键在，**放置信息（uses）缺失** → `talentBindings()` 得到 `bindable = { ok:false, reason:'no-effects' }`。

**修法**：`public/js/render/vfx/talents.js` 的 `ownerFallbackUses()`，三重条件才兜底：

1. `uses` 为空；
2. 键名含 talent 段（`/(?:^|_)(?:talent|telent)(?:_|$)/i`）；
3. `prefabs[key]` 是 `looping:true` 且 `spawn` 存在且非 `CAMERA` / `TILE_CENTER`。

命中则合成 `{ role:'loop', keys:[key], from:'talent.unclassified', on:'owner' }`，只挂到 `when === 'passive'` 的节点。全库只有黍命中，324 个本来正确的天赋零变化。

> `[ASSUMED]`：这是命名启发式。若某天赋的特效键不带 `talent` 段，仍需在**提取侧**修 `fx.py`（`_buffs → templateKey → CreateEffect` 关联），代价是重跑一次 400MB 提取。

---

## 7. 常驻地面贴花（黍 S3「播种」十字）

**需求**：每播种一格留一格贴花，**持续到施放者离场**，**数量不设上限**。

`public/js/render/vfx/skills.js` 的绑定：

```js
skchr_shu_3: { healField: binding({ owner:'id', keys:['shu_talent_buff_02'], at:'point', tiles: SOW_TILES, hold:'owner', decal: true, skin: true }) }
// SOW_TILES = [[0,0],[1,0],[-1,0],[0,1],[0,-1]]，与 sim 的 SOW 一致；sim 只发中心格
```

`skillfx.js`：

- `_bound`：`hold:'owner'` 分支**不挂定时器、不入 `marks`**，handle 存进 `U.decals`；`_releaseU` / `up=false` / unseen / `wiring.death` 一起释放。
- 多落点：`spots = at:'point' && bind.tiles.length ? bind.tiles : [[0,0]]`，逐格 spawn、每格独立 mark。

`system.js`：新增 `plain` 计数（**非贴花**在册数），`spawn()` 用 `_room()` 判断预算 → **常驻贴花不占 `MAX_EFFECTS`**，否则 20+ 格会把全场一次性特效挤掉。

**别忘了 sim 侧的限制**：`op-shu.js` 只在「本次播种**新增**了格子」（`n > 0`）时才发 `healField`，`sown` 是永久 Set —— 所以贴花改常驻后，已经播过的格子不需要重复信号。

---

## 8. 通用坑清单（数据 / 工具）

| 坑 | 说明 |
|---|---|
| `fetch-assets` 会重建 `data/assets.json` | 顺序必须 `fetch-assets → skins inject`；服务器上**不要**跑 `npm run setup` |
| `--prune` | 会删掉不被模板引用的文件（`spine/op/**`、`char/skin_avatar/**` 都在其中）→ 不要用 |
| manifest 只有单个 `spineVariant` | 多套 token 变体靠**磁盘解析**（`resolveTokenSkinSpineFromDisk`），不要指望清单字段 |
| `data/*.json` 是生成物 | 永远改工具/研究表后重新生成，不手改 |
| Python 必须 3.12 | `fx.py` 用了 PEP 701 的嵌套 f-string；系统 3.11 会直接 `SyntaxError` |
| UnityPy 的 LZHAM 报错 | 是 LZ4AK，`import aklz4` 注册后正常 |
| 索引缓存 | `.cache/fx/effects.json` 不升级版本就不会重扫 → 改完代码看起来「没变化」 |
| golden | 任何 `server/sim/**` 改动都要 `npm run golden:update` 并在 commit 里点名场景 |

---

## 9. 排查手册（症状 → 原因 → 修法）

| 症状 | 最先查 | 原因 / 修法 |
|---|---|---|
| 穿了皮肤但特效全是最基础的 | `index.json` 里有没有该 skinId 的 `skinFx` | 客户端的 prefab 在覆盖层（§2.3）；或缺 replace 的基础键（§2.2 的第二处） |
| `skip (no such effect prefab ... _nlc#1)` 一片 | `container_index` 是否也接了覆盖层 | §2.3 + 缓存版本 2 |
| 皮肤特效出来了，但命中特效还是基础版 | `_arrive` 有没有传 `skinFrom: src` | §2.4 最后一行 |
| 召唤物（瓶子/盾/影子）还是原模型 | `data/assets.json` 的 `skins[..].tokens` 有没有条目 | 模型没下载 / owner 为 null（§3.3） |
| 穿皮肤放技能演的是普攻 | `assets.json` 的 `anims.skills` 是否为空 | §4.1，然后重跑 inject |
| 技能期间一直站在原地不回待机 | `anims.skills[n].idle/loop` | §4.2 |
| 特效/单位浮在别处 | 先分辨 §5 的 A/B：**待机就偏 → 素材**；**只在放技能时偏 → 挂点** | 穿皮肤偏约一格（经典案例：**史尔特尔 S3**）→ 挂点取了皮肤里那份静态兜底值（§5.1）；任何皮肤都偏 → prefab 根节点自带 pos（§5.2） |
| 国家图书馆（nlc）三套皮肤：特效不出来 / 提取器说没有 | `skinpack/*.ab` 的 container 里含 `nlc` 的 bundle 数 | 资源在覆盖层（§2.3）或客户端没下全（§2.6）；`skinFx` 里应有 276 套 |
| 天赋特效完全不播 | `talents[n].uses` / `unclassified` | §6 |
| 贴花 5 秒后消失 / 铺满后新的不出现 | 绑定里的 `holdS`、`MAX_EFFECTS` | §7 |
| 服务器上插件（DPS/战后统计）消失 | `tools/package.mjs` 的 `isPluginResource` | 上游默认排除 `plugins/`，需把 fork 自有插件加进白名单 |
| pm2 下服务不监听端口 | `server/http/boot.js` 的 `isProcessEntry` | PM2 fork 模式把 `argv[1]` 换成 `ProcessContainerFork.js`；改用 `pm_env.pm_exec_path` 比对 + wrapper 名兜底 |

---

## 10. 复刻建议顺序（照这个走不会乱）

1. **先拿下官方 VFX 本体**（上游 0.3.0 已有）：跑通 `--only fx --fx-set used`，确认游戏里默认特效正常；
2. **修提取器的覆盖层 + base 键 + 大小写**（§2.2 / §2.3）→ 重新提取，确认 `skinFx` 里有目标皮肤；
3. **接客户端的皮肤替换**（§2.4）→ 穿皮肤验证命中/施法特效；
4. **再做召唤物皮肤**（§3）：plan 全量派生 → fetch → inject → 渲染；
5. **再做技能动画/姿态**（§4）；
6. 最后做**位置类**（§5）与**常驻贴花**（§7）——这两类改动影响面最大，放最后回归。

回归用的测试（本仓库）：

```bash
node --test test/render/vfx-skins.test.js test/render/vfx-swire2.test.js \
  test/render/vfx-blaze2-s3.test.js test/render/vfx-talents.test.js \
  test/render/vfx-shu-cross.test.js test/render/vfx-effect-root-offset.test.js \
  test/render/spine-skill-stance.test.js test/skins.test.js test/sim/skins-token.test.js
```

---

## 11. 已知限制 / 未做

- `_fakeProjectileConfigs`（皮肤换弹道）**未接线**：需要 `_fly` 换 projectile key + 提取器爬 graphic projectile 的 effects；
- 天赋兜底是**命名启发式**（§6），不覆盖所有天赋；
- `char_1502_crosly` 的 `Skill_3_Loop`（无 Begin）未修（漏修，不是回归）；
- token 皮肤变体上游只有 12→70 套有模型文件，剩余 69 条映射缺素材；
- token 头像未换（只换模型）；
- 国家图书馆（nlc）三套皮肤的特效 hooker 只存在于**覆盖层**，换客户端版本后要重跑提取；
- 贴花仍计入 `MAX_PARTICLES`，20+ 格时理论上可能挤掉一次性的粒子特效。

---

## 12. 关键文件索引（按职责）

| 职责 | 文件 |
|---|---|
| 客户端「选哪个模型」 | `public/js/assets.js`（`spineEntry` / `tokenSkinSpine` / `avatarUrl`） |
| 特效键 → 皮肤替换 | `public/js/render/vfx/wiring.js`（`playOn` / `keysFor` / `skinOfView`） |
| 技能 → 特效键绑定 | `public/js/render/vfx/skills.js`（`FX_BINDINGS` / `FX_COVER`） |
| sim 事件 → 特效 | `public/js/render/vfx/skillfx.js`（`simFx` / `_bound`） |
| 天赋特效 | `public/js/render/vfx/talents.js`（`talentBindings` / `ownerFallbackUses`） |
| 特效编译/矩阵/预算 | `public/js/render/vfx/effect.js`、`system.js` |
| 骨骼动画状态机 | `public/js/render/spine.js`（`_idleName` / `_skillLoopIsStance` / `toSkillIdle`） |
| 特效提取 | `tools/local-extract/fx.py`（`skin_hooks` / `skin_referenced` / `Roots` / `container_index`） |
| 素材计划/下载 | `tools/assets/plan.mjs`、`tools/fetch-assets.mjs` |
| 皮肤/召唤物注入 | `tools/skins.mjs`（`inject` / `tokenSkinEntries` / `resolveTokenSkinSpineFromDisk`） |
| 皮肤选择与存储 | `public/js/ui/skins.js`、`server/lobby.js`（`room.skins`） |
| 打包白名单 | `tools/package.mjs`（`isPluginResource`） |
| PM2 启动判定 | `server/http/boot.js`（`isProcessEntry`） |
