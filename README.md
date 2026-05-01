# Listing Compass · 上币罗盘

OKX 内部上币决策支持 dashboard — demo 版本。

## 文件结构

```
listing-compass-website/
├── index.html       # 主页面(HTML + CSS + JS,约 89KB)
├── data.json        # 数据(207KB,前端 fetch 加载)
├── vercel.json      # Vercel 部署配置
├── .gitignore
└── README.md
```

## 本地运行

不能直接双击 `index.html` 打开(因为浏览器 `file://` 协议不允许 fetch),需起一个本地静态服务器:

```bash
# 方式 1: Python
cd listing-compass-website
python3 -m http.server 8000
# 然后访问 http://localhost:8000

# 方式 2: Node
npx serve .
```

## 部署到 Vercel

### 方式 A: 通过 Git 上传(推荐)

1. **本地建仓 + 推到 GitHub**
   ```bash
   cd listing-compass-website
   git init
   git add .
   git commit -m "init: listing compass demo v1"
   git branch -M main

   # 在 GitHub 上新建一个空仓库,假设叫 listing-compass
   git remote add origin git@github.com:<your-username>/listing-compass.git
   git push -u origin main
   ```

2. **Vercel 导入仓库**
   - 登录 https://vercel.com → New Project
   - Import Git Repository → 选 `listing-compass`
   - Framework Preset 选 **Other**(纯静态)
   - Root Directory 留空(默认根)
   - Build Command 留空
   - Output Directory 留空
   - 点 Deploy

   30 秒部署完,会给你一个 `https://listing-compass.vercel.app` 链接。

### 方式 B: Vercel CLI 直传(无需 Git)

```bash
npm i -g vercel
cd listing-compass-website
vercel
# 按提示登录、确认项目名、确认设置
# 第一次会问几个问题,默认全选 Yes
```

## 后续更新

修改完 `index.html` 或 `data.json` 后:

```bash
git add .
git commit -m "update: 描述本次改动"
git push
# Vercel 自动重新部署
```

## 数据来源

`data.json` 当前是 demo 数据,包含:
- `meta`: 数据时间窗口
- `kpi`: 4 个 KPI(L3/KOL/comp/gap)
- `today / week / month`: 三个时间窗口的聚合事件
- `ai_strict / ai_full`: AI 主题相关事件
- `ai_kol_consensus`: KOL 观点矩阵
- `ai_macro_warnings`: 宏观警报
- `raw_items_by_date`: 10 天 × 108 条原始事件(供前端按日期范围动态聚合)

后续接入 Bitable 后,可以把 `data.json` 替换为从 Bitable 读出的实时数据。

## 技术栈

- 纯 HTML + CSS + Vanilla JS,无构建工具
- 字体: Cormorant Garamond + Noto Serif SC + JetBrains Mono(Google Fonts)
- 设计语言: 暗色主题,金色强调(`#d4a14b`),衬线标题 + 等宽元数据
- 响应式: 支持桌面(1280+)、笔电(980-1280)、移动(<980)三档断点

## License

OKX 内部使用,不对外公开。
