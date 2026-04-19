# SPEC: MuType 风格博客站点重建方案

## Summary

本仓库从 Hexo 迁移为一个 MuType docs 视觉语言的轻量博客站点。文章使用 Markdown 编写，自建 Node.js 静态生成器输出纯静态 HTML 到 `dist/`，再由 GitHub Pages 发布。

目标：

- 视觉风格继承 `/Users/xiaogangsu/code/mutype/docs` 的 Emacs/buffer 气质
- 标准博客结构：首页、文章页、归档、标签、About
- 界面支持中英切换，文章正文先只维护中文
- 不使用 Hexo、主题子模块或现成博客框架

## Content Model

全站配置位于 `content/site.json`，包含：

- `title`
- `description`
- `url`
- `author`
- `email`
- `github`
- `subtitle_zh`
- `subtitle_en`

文章位于 `content/posts/*.md`，front matter 格式：

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

About 页位于 `content/pages/about.md`。

## Build

构建脚本为 `scripts/build.mjs`，职责：

- 读取 `content/`
- 使用 `gray-matter` 解析 front matter
- 使用 `marked` 渲染 Markdown
- 生成 `dist/` 下的首页、文章页、归档页、标签页、About 页
- 生成 `rss.xml`、`sitemap.xml`、`404.html`
- 复制 `src/assets/` 到 `dist/assets/`
- 生成 `.nojekyll`

构建命令：

```bash
npm run build
```

## Routing

- `/`
- `/archives/`
- `/tags/`
- `/tags/<tag>/`
- `/about/`
- `/<yyyy>/<mm>/<dd>/<slug>/`
- `/about/me.html` 跳转到 `/about/`

旧文章 URL 保持不变。

## UI

视觉和交互遵循 MuType docs 风格：

- 顶部 `header-line`
- 单列 `buffer`
- 底部固定 `mode-line` 和 minibuffer
- 等宽字体
- 亮/暗主题切换
- 中英 UI 切换
- 文章正文不参与翻译

## Deployment

GitHub Actions workflow 位于 `.github/workflows/pages.yml`：

- push 到 `main` 触发
- Node.js 22
- `npm ci`
- `npm run build`
- 上传 `dist/` 到 GitHub Pages

## Out of Scope

第一版不做评论系统、站内搜索、分页、完整文章双语、CMS 或数据库。
