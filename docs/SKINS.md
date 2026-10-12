# 干员换装（皮肤）

干员调配详情页的「换装」区块：给某个棋子挑一套官方时装，模型与头像随之替换；选择对队友可见（服务端放进
`m.public.players[].skins`）。实现刻意做成「素材缺失也能用」：目录照常列出全部皮肤，模型文件不在磁盘上的那套
选中后回退到干员自己的模型，绝不出现空壳棋子。

## 数据流

```
data/skins.json                目录：每名干员的皮肤 id / 名称 / 系列（无 URL）
        │
        ├── data/assets.json 的 chars[charId].skins[skinId] = { name, group, avatar, spine? }
        │        ↑ 只有真的把模型下载到 public/assets/spine/op/<charId>/<stem>/{front,back}/ 之后才带 spine
        │
        └── public/js/ui/skinPicker.js   详情页的「换装」区块（挑一套 / 恢复默认）
                 │
                 ▼
        public/js/ui/skins.js   localStorage + room.skins（公开）
                 │
                 ▼
   server/lobby.js skins() → seat.skins → PlayerState.setSkins()
                 │
                 ├── battleInput().units[].skin → sim Unit.skin → snapshot unitInfo.skin（undefined 会被 JSON 丢掉）
                 └── pieceView().skin（备战区的棋子）
                 │
                 ▼
   render/app/info.js renderInfo(u).skin、render/app.js pieceInfo().skin
                 │
                 ▼
   render/units.js _loadSpine / _loadPicture / _wantsBack → assets.js spineEntry(id, {skin}) / avatarUrl(id, {skin})
```

两条键语义，混用会静默失败：

- **选择**按棋子 id 存（`chess_char_1_01_a`），`room.skins` 的键也是棋子 id；
- **目录与素材清单**按干员 id 分组（`data/skins.json` 与 `data/assets.json` 的 `chars[char_000_xxx]`）。

服务端两侧都归一化（`lobby.js freezeSkins`、`player/basics.js setSkins`），渲染侧由 `skinFor(baseId|pieceId|diy.charId)` 兜底。

## 已实现

| 位置 | 内容 |
|---|---|
| `data/skins.json` | 目录：172 名干员 / 271 套（含 id、名称、系列，无 URL） |
| `shared/protocol.js` | `SKIN_LIMITS`、`isSkinId`（**不能用 `isId`**：皮肤 id 带 `@` `#` `+`）、`isSkinSelection`、`C2S['room.skins']` |
| `public/js/ui/skins.js` | store + localStorage + `installSkinsSync`（`room.skins`，welcome 重发、编辑去抖、RATE 重试） |
| `public/js/ui/skinPicker.js` | 「换装」区块：头像、名称、系列、已装配/未安装标记、未安装时的提示 |
| `public/js/screens/loadout.js` | 详情页在「特质」之后插入 `<SkinSection/>` |
| `public/js/assets.js` | `spineEntry(m, id, {skin})`（带 `fallback`）、`avatarUrl(m, id, {skin})`、`hasBackSpine(m, id, skinId)`、`unitPictureUrl(m, id, opts)` |
| `public/js/render/{app.js,app/info.js,units.js}` | `skin` 进 `renderInfo` / `pieceInfo` / 视图签名；模型与头像按 skin 解析，`hasBack` 也带 skin |
| `public/js/data.js` | `DATA_FILES.skins = 'skins.json'` |
| `public/js/ui/gameComponents.js` | `GAME_FILES` 加 `'skins'`（对局中也能打开干员调配） |
| `public/js/main.js` | `installSkinsSync({ net })` |
| `server/{net.js,lobby.js}` | `session.skins`、`freezeSkins`、`case 'room.skins'`、`skins()`、seats / `humanSeat` 带上 skins |
| `server/match/match/{platform.js,views.js}` | `Match.setSkins()`（无阶段门）、`publicView().players[].skins`（空则整个字段省略） |
| `server/match/{PlayerState.js,player/basics.js,player/round.js,player/views.js}` | ctor 恢复 seat.skins、`setSkins`、`skinFor`、battleInput / pieceView 带 skin |
| `server/sim/{units.js,battle/players.js,snapshot.js}` | `Unit.skin`、部署时透传、`unitInfo.skin`（**`undefined` 而非 `null`**：`JSON.stringify` 丢掉它，没有皮肤的对局线格式不变） |
| `public/css/screens/loadout.css` | `.lo-skins` / `.lo-skin*`（单行列表，与 `.lo-mods` 同一观感） |
| `public/i18n/{en,ja,ko,zh-TW}.json` | 9 条新字符串 |
| `test/skins.test.js` | 目录形状、协议合法性、清单一致性、素材缺失时的回退 |

## 皮肤素材：`tools/skins.mjs`

上游地址**已经带在研究表里**：`docs/research/08-skins.json` 的每套皮肤都有 `avatar.url`（`yuanyan3060/ArknightsGameResource` 的 `avatar/<avatarId>.png`，`#` 写成 `%23`）与 `battleSpine.{front,back}.{skel,atlas,png}.url`（`fexli/ArknightsResource` 的 `spine/<charId>/<stem>/Front|Back/`）。271 套里 **174 套有模型**，其余上游本来就没有模型（只有名字与头像）。

### 一次跑完的步骤

```powershell
cd G:\卫\Stronghold-Protocol

# 0. 研究表放进本仓库（不在的话脚本会退回读纸鸢那份）
New-Item -ItemType Directory -Force docs\research | Out-Null
Copy-Item 'G:\卫\纸鸢\Stronghold-Protocol\docs\research\08-skins.json' 'docs\research\08-skins.json'

# 1. 本地资源库导入（模型 + 头像 + 半身立绘），或联网下载
node tools/skins.mjs sync            # 目录按本地库重建（523 套，官方名字）
node tools/skins.mjs local           # public/assets：模型 / 头像
node tools/skins.mjs portraits       # 半身立绘（上游 180×360；本地库那份是全分辨率，只作回退）
node tools/skins.mjs normalize       # 把图集里的页名对齐磁盘文件名（缺这一步 pixi-spine 会报 baseTexture）
node tools/skins.mjs inject          # 写 data/assets.json（含 anims 与立绘）
node tools/skins.mjs verify          # 复查：列出 / 可绘制 / 头像 / 立绘 / 坏掉

# 2. 想联网下载而不是用本地库时
node tools/skins.mjs layout && node tools/skins.mjs fetch && node tools/skins.mjs inject
```

资源在项目里的位置与来源：

| 内容 | 项目路径 | 来源 |
|---|---|---|
| 战斗 Spine（front/back 三件套） | `public/assets/spine/op/<干员id>/<stem>/{front,back}/` | 本地库 `spine/operator/battle/<皮肤id>/{front,back}/`，或上游 fexli 仓库 |
| 180×180 头像 | `public/assets/char/skin_avatar/<stem>.png` | 本地库 `operator/avatars/<皮肤id>.png` |
| 半身立绘（商店/购买卡、详情页大图） | `public/assets/char/skin_portrait/<stem>.png` | **上游 yuanyan3060 仓库的 180×360 裁切版**（`portraits --source=net`，100–140 KB）；本地库的 `operator/arts/<皮肤id>.png` 是全分辨率全身图，尺寸对不上卡片，只作回退 |

半身立绘为什么不能直接用本地库：游戏卡绘制区是 **180×360**，上游 `portrait/` 里就是裁到这个尺寸的成图；而
`operator/arts/` 里是 1024×1024 乃至 6 MB 的全身立绘，塞进卡片会明显过满、整体 502 MB（换成裁切版约 61 MB）。

```powershell
node tools/skins.mjs portraits --overwrite=big   # 下载 180×360 版；尺寸不是 180×360 的旧图会被替换
node tools/skins.mjs inject                       # 把立绘写进 data/assets.json
```

判定按**像素**而不是体积：一张 180×180 的头像、或库里那张 1024×1024 的全身图，都算“尺寸不对”需要替换。
`--source=net`（默认）走 jsDelivr 优先、raw 兜底；`--source=mirror --proxy=<前缀>` 走 GitHub 前缀镜像；
`--concurrency=`（默认 8）与 `--timeout=`（默认 25000 ms，每批会打印进度）用于网络不畅时调参。

目录里为什么会有进不了游戏的皮肤：本地库有 372 名干员 / 523 套，而本作棋子表只有 174 名能出场（273 套皮肤）。
`sync --only=chess` 会把这些异格/未实装干员剔掉；不剔除也不影响游戏——它们只在「已拥有干员」的换装列表里
显示为未安装条目，永远不会被选中。

## 皮肤模型为什么必须跑 `normalize`

本地库里的图集**第一行是空行**（实测 1956/1956 全是这样），而 pixi-spine 是逐行读图集的：它把**第一行**当作贴图页文件名。
空行 → 页名成了 `""` → 它拿「目录本身」去要纹理 → 拿到 null → 整条骨骼被丢弃，**静默回退到干员默认模型**
（浏览器里只会看到 `Spine: error in texture loader … reading 'baseTexture'`）。

所以 `local` / `portraits` 之后**必须**跑一次 `normalize`，它会把开头空行去掉、并把图集里的页名对齐成磁盘文件名：

```powershell
node tools/skins.mjs normalize    # 去掉开头空行 + 页名对齐（改完硬刷新浏览器，.atlas 可能被缓存）
node tools/skins.mjs verify
```

`test/skins.test.js` 里有一条断言盯住这件事（首行必须非空、页名必须真实存在），忘了跑 `normalize` 会直接红。

命名规律：皮肤 id `char_1012_skadi2@boc#4` → URL `portrait/char_1012_skadi2_boc%234.png`（`@`→`_`，`#` 必须
百分号编码），否则 404；`tools/skins.mjs` 里的 `skinPortraitUrl()` 就是这个规则。

### 命令细节

| 命令 | 说明 |
|---|---|
| `plan` | 只打印。默认给统计（271 套 / 1315 文件 / 磁盘已有几个）；加 `--chars=` 或 `--limit=` 才逐条列 URL 与落地路径（并标出该套用的是哪种上游布局） |
| `layout` | 探测每个皮肤的上游布局并记住（`.cache/skins-layout.json`）。**上游不是统一的**：有的干员是 `char_x/<stem>/{Front,Back}/`，有的只有 `char_x/<stem>/Spine/`（实测 5 名干员 32 个目录里 13 个是单文件夹），研究表一律按 Front/Back 写，所以不探测就必然有一批 404 |
| `fetch` | 先自动探测缺失的布局，再下载头像与模型；`--concurrency=N`（默认 8）、`--force`、`--side=front\|back`、`--chars=`/`--limit=`。开跑前试写一次 `public/assets`，写不进去立刻停手并给 `icacls … /reset` 提示 |
| `inject` | 把磁盘上真有文件的皮肤写进 `data/assets.json`（含 `anims` 解析）；`--dry-run`、`--no-spine`、`--manifest=` |
| `verify` | 按客户端 `validSpine()` 的规则复查：skel/atlas/贴图在盘、`anims` 已解析；`--fix` 把缺 `anims` 的条目就地补上（只重解析 anims，不动别的字段） |

**下载源的优先级**（`candidates()`）：commit 固定的 jsDelivr → 分支名 jsDelivr → 资产管线那套 jsDelivr 回退 → GitHub 原始源（mirror 模式下前缀代理优先）。原因：`raw.githubusercontent.com` 在国内线路上连不上（实测连接超时），而 jsDelivr 对这 18 GB 的仓库也能正常取文件——**前提是路径对**（路径错是 404，不会假成功）。`fetch` 启动时会用 GitHub API 取一次模型仓库的 HEAD commit，给 jsDelivr 多一条固定版本地址。

**`inject` 会把模型的 `anims` 一起解析出来**（读图集的 pages/regions → 解析 skel → `tools/assets/anim-roles.mjs` 的 `resolveRoles`），所以客户端 `validSpine()` 能接受这些模型，棋子会真的换成皮肤。骨骼解析失败或文件不全的那几套只写头像与名字（客户端回退到干员默认模型），原因会逐条打印。

落地位置：头像 `public/assets/char/skin_avatar/<stem>.png`，模型 `public/assets/spine/op/<charId>/<stem>/{front,back}/<stem>.{skel,atlas,png}`，其中 `stem = skinId.replace(/@/g,'_').replace(/#/g,'_')`。

### 注意

- **失败的三种分类**（`fetch` 结束时按数量打印）：
  - `404×N` —— 上游确实没有这个文件（例如某套皮肤没有 Back 模型），跳过即可，不是错误；
  - `NET×N` / `HTTP×N` —— 网络问题，重跑一次或 `--source=mirror`；
  - `WRITE×N` —— 写盘被拒（目录权限 / 沙箱）：`icacls "<项目>\public\assets" /reset` 恢复继承后再跑。
- **顺序**：`tools/fetch-assets.mjs` 重新生成清单时会丢掉它不认识的字段，所以是 `fetch-assets` → `skins inject`；`npm run assets` 之后要再 `inject` 一次。
- `public/assets/` 不进 git（AGENTS.md）：模型随完整包分发或各人自己下载。
- 上游没有模型的 97 套永远只有头像与名字，这是数据事实，不是失败。
- 贴图页面可能是很大的 PNG（个别皮肤单页几百 KB 到数 MB）；`fetch` 会原样下载，按需再压缩（主素材管线把大图转 WebP，皮肤目前不做这一步）。
