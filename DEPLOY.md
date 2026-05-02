# 部署 Checklist

跟着做就行。

## 1. 上传代码到 GitHub

打开 https://github.com/Chow1996/compasstowealth

需要上传/修改的 4 个文件:

| 文件 | 操作 | 说明 |
|---|---|---|
| `package.json` | **新增** | Node 依赖声明,@supabase/supabase-js |
| `api/data.js` | **新增** | Vercel 函数,实时查 Supabase |
| `index.html` | **覆盖** | 改了 1 个函数(loadData),其他没动 |
| `DEPLOY.md` | **新增**(可选) | 这个文件 |

**最简单的上传方式**(网页拖拽,不用命令行):

1. 打开 GitHub 仓库主页
2. 点 `Add file` → `Upload files`
3. 把以下 4 个文件从你 Mac `~/Desktop/compasstowealth-dashboard/` 拖进去
   - `package.json`
   - `api/` 整个目录(里面有 data.js)
   - `index.html`
   - `DEPLOY.md`(可选)
4. 下面填一句 commit message: `connect supabase via vercel api`
5. 点 `Commit changes`

GitHub 会自动通知 Vercel,Vercel 开始 redeploy。

## 2. 在 Vercel 配环境变量

打开你的 Vercel Dashboard → 找到 `compasstowealth` 项目:

```
Settings → Environment Variables → Add New
```

加 2 个:

| Name | Value | Environment |
|---|---|---|
| `SUPABASE_URL` | `https://odnbppebduxavyewuafu.supabase.co` | Production |
| `SUPABASE_ANON_KEY` | (你 .env 里那个 eyJ... 的 anon key) | Production |

点 Save 之后,**触发一次 redeploy**:
- Deployments 标签 → 最近的 deployment → 右边三个点 `⋯` → Redeploy

## 3. 验证

1. 等 1-2 分钟 Vercel 部署完
2. 浏览器打开 https://compasstowealth.vercel.app/api/data
3. 应该看到一坨 JSON(meta / today / week / kpi / 等),不是 404
4. 然后打开 https://compasstowealth.vercel.app/
5. 网页右上角日期应该显示当天(而不是 2026-04-26 老的)
6. 打开浏览器 Console (F12 → Console),应看到 `✓ loaded data from /api/data`

## 4. 数据空区块说明

以下区块**目前是空数组**(后续 agent 加 LLM 步骤后填):
- `tg_today` (TG 信号)
- `ai_kol_consensus` (KOL 跨日共识聚合)
- `ai_macro_warnings` (宏观警示)
- `latest.tg / latest.st`

页面上对应区块会显示"暂无数据"或者直接空白,正常的。

## 5. 故障排查

**症状**:网页打开还是老数据
- 检查 Vercel Deployments 是否成功(绿勾)
- 强刷一下 Cmd+Shift+R(绕过缓存)
- F12 Console 看是不是 fallback 到 `./data.json` 了

**症状**:`/api/data` 返回 500
- Vercel Functions 日志:Vercel Dashboard → 项目 → Logs → 找最近的 /api/data 请求
- 大概率是环境变量没配 or supabase RLS policy 没让 anon 读

**症状**:`/api/data` 返回 401/403
- Supabase anon key 失效或写错了,重新去 Supabase 复制

## 6. 后续 agent 跑出新数据后

agent 在你 Mac 上跑(`python3 run_daily.py`)→ 写 Supabase → 网页打开就是新数据,**不用再上传任何文件**。

Vercel API 函数有 5 分钟边缘缓存,新数据最多延迟 5 分钟显示。要立即看新数据可以强刷。
