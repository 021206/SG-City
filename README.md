# SG-City

新加坡离线三维城市查看器，用于道路工程方案比选与空间协调。项目使用本地 Node.js 静态服务器和 WebGL 渲染，无需安装前端依赖；数据生成后可在本机离线查看。

## 项目说明

- 道路平面几何：LTA **Road Section Line（2026-09，SVY21 / EPSG:3414）**，已转换为 WGS84。
- 补充数据：OpenStreetMap 提供路名、路宽估算、桥隧属性、建筑、水域和地名；Mapzen 提供展示级地形。
- 当前包含 6 个图层：地形/地块、水面、道路、方案连接（待核实）、地铁/轻轨、建筑。
- 支持地名搜索、道路筛选、单条中心线高亮、日夜切换及视角分享链接。
- 橙色虚线表示“方案连接／待核实”，不属于现状道路，可在左侧关闭。

**覆盖范围：当前不是整个新加坡。** 数据范围为经度 `103.795–103.950`、纬度 `1.242–1.335`，约 17.3 × 10.3 公里，超出范围的区域不会显示。

**精度边界：本项目用于方案比选与空间协调，不是测量控制成果。** 路宽、桥梁高程、地形和建筑高度含估算值；地块为视觉生成面，不是法定地籍。不可直接用于施工放样、定量土方分析或工程验收。

## 运行环境

- Windows
- Node.js 20 或更高版本（推荐）
- 已生成的 `LocalData/SGCityData/` 数据目录

检查 Node.js：

```bat
node --version
```

本项目无需执行 `npm install`。

## 启动项目

### 方式一：CMD（推荐）

```bat
cd /d E:\SG-City
node WebViewer\server.mjs 8765
```

### 方式二：PowerShell

```powershell
Set-Location E:\SG-City
node .\WebViewer\server.mjs 8765
```

### 方式三：Git Bash

```bash
cd /e/SG-City
node WebViewer/server.mjs 8765
```

### 也可以使用 npm 脚本

```bat
cd /d E:\SG-City
npm run viewer
```

`npm run viewer` 默认使用 **8765** 端口。

启动成功后，终端会显示：

```text
SG-City web viewer running at http://127.0.0.1:8765/
```

然后在浏览器打开：

**http://127.0.0.1:8765/**

## 停止、重启与端口修改

- **停止服务**：在启动终端按 `Ctrl+C`，或直接关闭该终端窗口。
- **重启服务**：重新执行上面的启动命令。
- **终端必须保持运行**：关闭终端后，网址就无法继续访问；重启电脑后也需要重新启动服务。
- 如果只在本机使用，网址是 `127.0.0.1`，不是公网链接，其他电脑不能通过它访问。

如果 8765 端口被占用，可以换成其他端口，例如 8766：

```bat
node WebViewer\server.mjs 8766
```

对应网址改为：

**http://127.0.0.1:8766/**

## 日常更新

- 只修改 `WebViewer/` 下的页面或脚本：保留服务运行，刷新浏览器即可。
- 修改数据管线或原始数据：需要重新生成数据，然后再刷新浏览器。

离线重建与校验：

```bat
cd /d E:\SG-City
node Tools\data_pipeline\build_p0.mjs --offline
node Tools\validation\validate_tiles.mjs
npm test
```

`--offline` 表示不下载新数据，因此以下原始输入必须已经存在：

- `LocalData/raw/sg-southcore-osm.json`
- `LocalData/raw/lta/RoadSectionLine_Sep2026/`
- `LocalData/raw/terrain/` 中的地形瓦片

注意：`LocalData/` 已列入 `.gitignore`。从 Git 仓库重新克隆项目后，需要另行恢复原始数据并重新生成 `LocalData/SGCityData/`，不能直接启动一个缺少数据的空目录。

## 基本操作

- 左键拖拽：旋转视角
- 右键拖拽：平移
- 滚轮：缩放
- 双击：复位视角
- 搜索地名或路名：飞往并高亮
- 右侧选择道路：以单条中心线高亮并飞往
- `Esc`：清除高亮

工程分享链接支持组合视角和道路：

```text
http://127.0.0.1:8765/#cam=x,z,距离&road=道路英文名称
```

示例：

```text
http://127.0.0.1:8765/#cam=-6312,-4469,1700&road=Adam%20Road
```

## 主要目录

```text
WebViewer/                 浏览器查看器与本地服务器
Tools/data_pipeline/      数据下载、转换和 GLB 生成流程
Tools/validation/         数据校验与单元测试
LocalData/raw/            原始离线数据（不入库）
LocalData/SGCityData/     已生成的查看器数据（不入库）
DataManifest/             数据来源及限制说明
Source/、Content/         UE 工程相关内容，启动网页版时无需使用
```
