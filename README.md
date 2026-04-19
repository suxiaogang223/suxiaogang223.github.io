# xiaogang's blog

个人博客源码仓库。文章用 Markdown 编写，由自建的 Node.js 静态生成器渲染为纯静态 HTML，通过 GitHub Pages 发布到 <https://suxiaogang223.github.io>。

## 目录结构

```
content/
  site.json        站点元信息（标题、作者、链接等）
  posts/*.md       博客文章
  pages/about.md   About 页
src/
  assets/          样式、脚本、字体等静态资源
scripts/
  build.mjs        静态生成器入口
dist/              构建产物（git 忽略）
.github/workflows/
  pages.yml        GitHub Pages 部署工作流
```

## 写一篇文章

在 `content/posts/` 新建 `*.md`，front matter 示例：

```md
---
title: 谓词下推(一)：概念和原理
date: 2024-11-16
slug: pushdown1
summary: 从概念到复杂谓词过滤，解释谓词下推的基本原理。
tags:
  - bigdata
draft: false
---
```

文章 URL 为 `/<yyyy>/<mm>/<dd>/<slug>/`。

## 本地构建

```bash
npm ci
npm run build     # 输出到 dist/
npm run serve     # 构建后在 http://localhost:8000 预览
npm run clean     # 清理 dist/
```

需要 Node.js 22+。

## 部署

push 到 `main` 分支后，`.github/workflows/pages.yml` 会自动执行 `npm ci && npm run build`，并将 `dist/` 发布到 GitHub Pages。

## 路由

- `/` 首页
- `/archives/` 归档
- `/tags/`、`/tags/<tag>/` 标签
- `/about/` About
- `/<yyyy>/<mm>/<dd>/<slug>/` 文章页
- `rss.xml`、`sitemap.xml`、`404.html` 自动生成
