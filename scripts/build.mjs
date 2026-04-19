import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { marked } from "marked";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const contentDir = path.join(rootDir, "content");
const postsDir = path.join(contentDir, "posts");
const pagesDir = path.join(contentDir, "pages");
const assetsDir = path.join(rootDir, "src", "assets");
const distDir = path.join(rootDir, "dist");

marked.setOptions({
  gfm: true,
  breaks: false,
});

const I18N = {
  zh: {
    homeTitle: "首页",
    archivesTitle: "归档",
    tagsTitle: "标签",
    aboutTitle: "关于",
    recentPosts: "最近文章",
    archivePreview: "归档预览",
    tagsPreview: "标签预览",
    aboutPreview: "关于",
    allPosts: "全部文章",
    allTags: "全部标签",
    published: "发布于",
    readingTime: "分钟阅读",
    taggedWith: "标签",
    noTags: "暂无标签",
    readPost: "阅读文章",
    returnHome: "返回首页",
    notFoundTitle: "页面不存在",
    notFoundDescription: "你访问的页面不存在或已经移动。",
  },
  en: {
    homeTitle: "Home",
    archivesTitle: "Archives",
    tagsTitle: "Tags",
    aboutTitle: "About",
    recentPosts: "Recent Posts",
    archivePreview: "Archive Preview",
    tagsPreview: "Tags Preview",
    aboutPreview: "About",
    allPosts: "All Posts",
    allTags: "All Tags",
    published: "Published",
    readingTime: "min read",
    taggedWith: "Tagged",
    noTags: "No tags yet",
    readPost: "Read post",
    returnHome: "Back home",
    notFoundTitle: "Page not found",
    notFoundDescription: "The page you visited does not exist or has moved.",
  },
};

const ui = (key, fallbackLang = "zh") => I18N[fallbackLang][key] ?? key;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}

function stripHtml(value = "") {
  return String(value).replace(/<[^>]*>/g, " ");
}

function normalizeDate(value, filename) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  throw new Error(`${filename}: date must use YYYY-MM-DD`);
}

function assertRequiredString(data, field, filename) {
  if (!data[field] || typeof data[field] !== "string") {
    throw new Error(`${filename}: front matter field "${field}" is required`);
  }
  return data[field];
}

function tagSlug(tag) {
  return encodeURIComponent(String(tag).trim().toLowerCase());
}

function postUrl(post) {
  const [year, month, day] = post.date.split("-");
  return `/${year}/${month}/${day}/${post.slug}/`;
}

function absoluteUrl(site, urlPath) {
  return new URL(urlPath, site.url).toString();
}

function readingTime(markdown) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/[#>*_\-[\]()]/g, " ")
    .trim();
  const latinWords = text.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const cjkChars = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return Math.max(1, Math.ceil((latinWords + cjkChars / 2) / 220));
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await copyDir(src, dest);
      } else if (entry.isFile()) {
        await fs.copyFile(src, dest);
      }
    }),
  );
}

async function writeFileByUrl(urlPath, content) {
  const cleanPath = urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath;
  const dest = path.join(distDir, cleanPath.replace(/^\/+/, ""));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content);
}

async function readSiteConfig() {
  const raw = await fs.readFile(path.join(contentDir, "site.json"), "utf8");
  const site = JSON.parse(raw);
  for (const field of ["title", "description", "url", "author", "github", "subtitle_zh", "subtitle_en"]) {
    if (!site[field] || typeof site[field] !== "string") {
      throw new Error(`content/site.json: "${field}" is required`);
    }
  }
  site.url = site.url.endsWith("/") ? site.url : `${site.url}/`;
  return site;
}

async function readPosts() {
  const files = (await fs.readdir(postsDir)).filter((file) => file.endsWith(".md"));
  const posts = [];
  for (const file of files) {
    const fullPath = path.join(postsDir, file);
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = matter(raw);
    const data = parsed.data;
    const post = {
      sourcePath: fullPath,
      title: assertRequiredString(data, "title", file),
      date: normalizeDate(data.date, file),
      slug: assertRequiredString(data, "slug", file),
      summary: assertRequiredString(data, "summary", file),
      tags: Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : [],
      draft: Boolean(data.draft),
      markdown: parsed.content.trim(),
      html: marked.parse(parsed.content.trim()),
    };
    post.url = postUrl(post);
    post.readingMinutes = readingTime(post.markdown);
    posts.push(post);
  }

  return posts
    .filter((post) => !post.draft)
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

async function readAbout() {
  const raw = await fs.readFile(path.join(pagesDir, "about.md"), "utf8");
  const parsed = matter(raw);
  return {
    title: parsed.data.title || "About",
    summary: parsed.data.summary || "",
    html: marked.parse(parsed.content.trim()),
  };
}

function navHtml(current) {
  const items = [
    ["/", "nav_home", "首页"],
    ["/archives/", "nav_archives", "归档"],
    ["/tags/", "nav_tags", "标签"],
    ["/about/", "nav_about", "关于"],
  ];
  return `<nav class="header-nav" aria-label="Primary">
${items
  .map(([href, key, label]) => {
    const active = current === href ? ' aria-current="page"' : "";
    return `  <a href="${href}" data-i18n="${key}"${active}>${label}</a>`;
  })
  .join("\n")}
</nav>`;
}

function layout(site, options) {
  const {
    title,
    description,
    canonicalPath,
    current = "",
    body,
    ogType = "website",
    titleEn,
    descriptionEn,
    statusLeft = "blog",
    statusCenter = canonicalPath,
    statusRightHtml,
    minibuffer = "content/posts/*.md -> npm run build",
  } = options;
  const canonical = absoluteUrl(site, canonicalPath);
  const pageTitle = title === site.title ? site.title : `${title} | ${site.title}`;
  const pageTitleEn =
    titleEn && titleEn !== site.title ? `${titleEn} | ${site.title}` : titleEn || pageTitle;
  const desc = description || site.description;
  const descEn = descriptionEn || desc;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title data-page-title-zh="${escapeAttr(pageTitle)}" data-page-title-en="${escapeAttr(pageTitleEn)}">${escapeHtml(pageTitle)}</title>
    <meta name="description" content="${escapeAttr(desc)}" data-page-description-zh="${escapeAttr(desc)}" data-page-description-en="${escapeAttr(descEn)}" />
    <meta property="og:type" content="${escapeAttr(ogType)}" />
    <meta property="og:title" content="${escapeAttr(pageTitle)}" data-page-title-zh="${escapeAttr(pageTitle)}" data-page-title-en="${escapeAttr(pageTitleEn)}" />
    <meta property="og:description" content="${escapeAttr(desc)}" data-page-description-zh="${escapeAttr(desc)}" data-page-description-en="${escapeAttr(descEn)}" />
    <meta property="og:url" content="${escapeAttr(canonical)}" />
    <meta property="og:site_name" content="${escapeAttr(site.title)}" />
    <meta name="twitter:card" content="summary" />
    <link rel="canonical" href="${escapeAttr(canonical)}" />
    <link rel="alternate" type="application/rss+xml" title="${escapeAttr(site.title)}" href="/rss.xml" />
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/assets/style.css" />
    <script>
      (() => {
        try {
          const theme = window.localStorage.getItem("blog:theme");
          if (theme === "light" || theme === "dark") {
            document.documentElement.setAttribute("data-theme", theme);
          }
        } catch (e) {}
      })();
    </script>
    <script src="/assets/app.js" defer></script>
  </head>
  <body data-page="${escapeAttr(current || canonicalPath)}">
    <a class="skip-link" href="#content" data-i18n="skip_to_content">跳到正文</a>

    <header class="header-line" role="banner">
      <div class="header-line__left">
        <a class="buffer-name" href="/">*xiaogang-blog*</a>
        <span class="header-sep">-</span>
        <span class="header-hint">📖, 🎬 and code</span>
      </div>
      ${navHtml(current)}
      <div class="header-line__right" aria-label="Controls">
        <button class="toggle-btn" id="theme-toggle" type="button">主题: ...</button>
        <button class="toggle-btn" id="lang-toggle" type="button">语言: ...</button>
      </div>
    </header>

    <main id="content" class="buffer" role="main">
${body}
    </main>

    <footer class="emacs-bars" role="contentinfo">
      <div class="mode-line">
        <div class="mode-line__left">
          <span data-i18n="ml_major">blog</span>
          <span class="mode-line__sep">:</span>
          <span>${escapeHtml(statusLeft)}</span>
        </div>
        <div class="mode-line__center" id="mode-path">${escapeHtml(statusCenter)}</div>
        <div class="mode-line__right">${statusRightHtml ?? `<a href="/rss.xml">RSS</a><span class="mode-line__sep">|</span><a href="${escapeAttr(site.github)}" rel="me">GitHub</a>`}</div>
      </div>
      <div class="minibuffer" id="minibuffer" data-default-message="${escapeAttr(minibuffer)}">${escapeHtml(minibuffer)}</div>
    </footer>
  </body>
</html>`;
}

function postCard(post, compact = false) {
  const tags = post.tags
    .map((tag) => `<a class="tag" href="/tags/${tagSlug(tag)}/">${escapeHtml(tag)}</a>`)
    .join(" ");
  return `<article class="post-card">
  <div class="post-card__meta">
    <span data-i18n="published">${ui("published")}</span> ${escapeHtml(post.date)}
    <span class="dot">.</span>
    ${post.readingMinutes} <span data-i18n="reading_time">${ui("readingTime")}</span>
  </div>
  <h3><a href="${post.url}">${escapeHtml(post.title)}</a></h3>
  ${compact ? "" : `<p>${escapeHtml(post.summary)}</p>`}
  <div class="post-card__footer">
    <a class="btn btn--ghost" href="${post.url}" data-i18n="read_post">${ui("readPost")}</a>
    <span class="tag-list">${tags}</span>
  </div>
</article>`;
}

function hero(site) {
  return `<section class="hero section--intro">
  <h1 class="hero__title">${escapeHtml(site.title)}</h1>
  <figure class="epigraph" aria-label="Epigraph">
    <blockquote class="epigraph__quote">
      <p>菩提本无树，</p>
      <p>明镜亦非台；</p>
      <p>本来无一物，</p>
      <p>何处惹尘埃？</p>
    </blockquote>
    <figcaption class="epigraph__caption">
      <span class="epigraph__author" data-i18n="epigraph_author">六祖慧能</span>
      <span class="epigraph__translation" data-i18n="epigraph_translation">Originally there is not a single thing - where could dust alight?</span>
    </figcaption>
  </figure>
  <p class="hero__subtitle" data-i18n="hero_subtitle">${escapeHtml(site.subtitle_zh)}</p>
  <div class="hero__meta">
    <span>Markdown</span>
    <span class="dot">.</span>
    <span data-i18n="hero_meta_static">静态生成</span>
    <span class="dot">.</span>
    <span>GitHub Pages</span>
  </div>
  <div class="hero__actions">
    <a class="btn" href="/archives/" data-i18n="nav_archives">归档</a>
    <a class="btn btn--ghost" href="/about/" data-i18n="nav_about">关于</a>
  </div>
</section>`;
}

function renderHome(site, posts, tagCounts, about) {
  const recent = posts.slice(0, 5).map((post) => postCard(post)).join("\n");
  const archiveItems = posts
    .slice(0, 8)
    .map((post) => `<li><time>${escapeHtml(post.date)}</time><a href="${post.url}">${escapeHtml(post.title)}</a></li>`)
    .join("\n");
  const tagItems = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => `<a class="tag" href="/tags/${tagSlug(tag)}/">${escapeHtml(tag)} (${count})</a>`)
    .join(" ");

  const body = `${hero(site)}

<section class="section">
  <h2 data-i18n="recent_posts">${ui("recentPosts")}</h2>
  <div class="post-list">${recent}</div>
</section>

<section class="section split">
  <div>
    <h2 data-i18n="archive_preview">${ui("archivePreview")}</h2>
    <ul class="archive-list">${archiveItems}</ul>
  </div>
  <div>
    <h2 data-i18n="tags_preview">${ui("tagsPreview")}</h2>
    <div class="tag-list">${tagItems || `<span class="muted" data-i18n="no_tags">${ui("noTags")}</span>`}</div>
  </div>
</section>

<section class="section">
  <h2 data-i18n="about_preview">${ui("aboutPreview")}</h2>
  <div class="callout">
    <p>${escapeHtml(about.summary)}</p>
    <a class="btn btn--ghost" href="/about/" data-i18n="nav_about">关于</a>
  </div>
</section>`;

  return layout(site, {
    title: site.title,
    description: site.description,
    titleEn: site.title,
    descriptionEn: site.subtitle_en,
    canonicalPath: "/",
    current: "/",
    body,
    statusLeft: "home",
    statusCenter: `posts: ${posts.length} | tags: ${tagCounts.size} | latest: ${posts[0]?.date ?? "none"}`,
    minibuffer: "new post: add content/posts/*.md, then npm run build",
  });
}

function renderPost(site, post) {
  const tags = post.tags
    .map((tag) => `<a class="tag" href="/tags/${tagSlug(tag)}/">${escapeHtml(tag)}</a>`)
    .join(" ");
  const body = `<article class="post">
  <header class="post__header">
    <div class="post__meta">
      <span data-i18n="published">${ui("published")}</span> ${escapeHtml(post.date)}
      <span class="dot">.</span>
      ${post.readingMinutes} <span data-i18n="reading_time">${ui("readingTime")}</span>
    </div>
    <h1>${escapeHtml(post.title)}</h1>
    <p class="post__summary">${escapeHtml(post.summary)}</p>
    <div class="tag-list">${tags}</div>
  </header>
  <div class="prose">
${post.html}
  </div>
  <nav class="post-nav">
    <a class="btn btn--ghost" href="/" data-i18n="return_home">${ui("returnHome")}</a>
    <a class="btn btn--ghost" href="/archives/" data-i18n="nav_archives">归档</a>
  </nav>
</article>`;

  return layout(site, {
    title: post.title,
    description: post.summary,
    canonicalPath: post.url,
    current: "",
    body,
    ogType: "article",
    statusLeft: "post",
    statusCenter: `${post.date} | ${post.readingMinutes} min | ${post.tags.length ? post.tags.map((tag) => `#${tag}`).join(" ") : "untagged"}`,
    statusRightHtml: `<a href="/archives/">archives</a><span class="mode-line__sep">|</span><a href="/tags/">tags</a>`,
    minibuffer: `source: content/posts/${post.slug}.md`,
  });
}

function renderArchives(site, posts) {
  const byYear = new Map();
  for (const post of posts) {
    const year = post.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(post);
  }
  const sections = [...byYear.entries()]
    .map(([year, items]) => `<section class="section ${year === posts[0]?.date.slice(0, 4) ? "section--intro" : ""}">
  <h2>${escapeHtml(year)}</h2>
  <ul class="archive-list">
${items.map((post) => `    <li><time>${escapeHtml(post.date)}</time><a href="${post.url}">${escapeHtml(post.title)}</a></li>`).join("\n")}
  </ul>
</section>`)
    .join("\n");

  const body = `<header class="page-header">
  <h1 data-i18n="archives_title">${ui("archivesTitle")}</h1>
  <p data-i18n="all_posts">${ui("allPosts")}</p>
</header>
${sections}`;

  return layout(site, {
    title: ui("archivesTitle"),
    description: `Archives for ${site.title}`,
    titleEn: ui("archivesTitle", "en"),
    descriptionEn: `Archives for ${site.title}`,
    canonicalPath: "/archives/",
    current: "/archives/",
    body,
    statusLeft: "archives",
    statusCenter: `posts: ${posts.length} | years: ${byYear.size}`,
    minibuffer: "archive is generated from content/posts/*.md",
  });
}

function renderTagsIndex(site, tagCounts) {
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => `<a class="tag tag--large" href="/tags/${tagSlug(tag)}/">${escapeHtml(tag)} (${count})</a>`)
    .join(" ");
  const body = `<header class="page-header">
  <h1 data-i18n="tags_title">${ui("tagsTitle")}</h1>
  <p data-i18n="all_tags">${ui("allTags")}</p>
</header>
<section class="section section--intro">
  <div class="tag-list">${tags || `<span class="muted" data-i18n="no_tags">${ui("noTags")}</span>`}</div>
</section>`;

  return layout(site, {
    title: ui("tagsTitle"),
    description: `Tags for ${site.title}`,
    titleEn: ui("tagsTitle", "en"),
    descriptionEn: `Tags for ${site.title}`,
    canonicalPath: "/tags/",
    current: "/tags/",
    body,
    statusLeft: "tags",
    statusCenter: `tags: ${tagCounts.size} | posts: ${[...tagCounts.values()].reduce((sum, count) => sum + count, 0)}`,
    minibuffer: "tags are generated from post front matter",
  });
}

function renderTagPage(site, tag, posts) {
  const body = `<header class="page-header">
  <h1>#${escapeHtml(tag)}</h1>
  <p><span data-i18n="tagged_with">${ui("taggedWith")}</span> ${escapeHtml(tag)}</p>
</header>
<section class="section section--intro">
  <div class="post-list">
${posts.map((post) => postCard(post)).join("\n")}
  </div>
</section>`;

  return layout(site, {
    title: `#${tag}`,
    description: `${tag} posts for ${site.title}`,
    titleEn: `#${tag}`,
    descriptionEn: `${tag} posts for ${site.title}`,
    canonicalPath: `/tags/${tagSlug(tag)}/`,
    current: "/tags/",
    body,
    statusLeft: `tag:${tag}`,
    statusCenter: `posts: ${posts.length}`,
    statusRightHtml: `<a href="/tags/">all tags</a><span class="mode-line__sep">|</span><a href="/rss.xml">RSS</a>`,
    minibuffer: `filter: #${tag}`,
  });
}

function renderAbout(site, about) {
  const body = `<article class="post">
  <header class="page-header">
    <h1 data-i18n="about_title">${ui("aboutTitle")}</h1>
    <p>${escapeHtml(about.summary)}</p>
  </header>
  <div class="prose">
${about.html}
  </div>
</article>`;

  return layout(site, {
    title: about.title,
    description: about.summary || site.description,
    titleEn: "About",
    descriptionEn: "About xiaogang and this blog.",
    canonicalPath: "/about/",
    current: "/about/",
    body,
    statusLeft: "about",
    statusCenter: "source: content/pages/about.md",
    minibuffer: "edit about: content/pages/about.md",
  });
}

function renderNotFound(site) {
  const body = `<section class="section section--intro">
  <h1 data-i18n="not_found_title">${ui("notFoundTitle")}</h1>
  <p data-i18n="not_found_description">${ui("notFoundDescription")}</p>
  <a class="btn" href="/" data-i18n="return_home">${ui("returnHome")}</a>
</section>`;
  return layout(site, {
    title: ui("notFoundTitle"),
    description: ui("notFoundDescription"),
    titleEn: ui("notFoundTitle", "en"),
    descriptionEn: ui("notFoundDescription", "en"),
    canonicalPath: "/404.html",
    current: "",
    body,
    statusLeft: "404",
    statusCenter: "not found",
    statusRightHtml: `<a href="/">home</a><span class="mode-line__sep">|</span><a href="/archives/">archives</a>`,
  });
}

function redirectPage(target) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${escapeAttr(target)}" />
    <link rel="canonical" href="${escapeAttr(target)}" />
    <title>Redirecting...</title>
  </head>
  <body>
    <p>Redirecting to <a href="${escapeAttr(target)}">${escapeHtml(target)}</a>.</p>
  </body>
</html>`;
}

function rss(site, posts) {
  const items = posts
    .slice(0, 20)
    .map((post) => `<item>
  <title>${escapeHtml(post.title)}</title>
  <link>${escapeHtml(absoluteUrl(site, post.url))}</link>
  <guid>${escapeHtml(absoluteUrl(site, post.url))}</guid>
  <pubDate>${new Date(`${post.date}T00:00:00Z`).toUTCString()}</pubDate>
  <description>${escapeHtml(post.summary)}</description>
</item>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
<channel>
  <title>${escapeHtml(site.title)}</title>
  <link>${escapeHtml(site.url)}</link>
  <description>${escapeHtml(site.description)}</description>
${items}
</channel>
</rss>`;
}

function sitemap(site, urls) {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((urlPath) => `  <url><loc>${escapeHtml(absoluteUrl(site, urlPath))}</loc></url>`)
  .join("\n")}
</urlset>`;
}

async function main() {
  const site = await readSiteConfig();
  const [posts, about] = await Promise.all([readPosts(), readAbout()]);

  const tagCounts = new Map();
  const postsByTag = new Map();
  for (const post of posts) {
    for (const tag of post.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      if (!postsByTag.has(tag)) postsByTag.set(tag, []);
      postsByTag.get(tag).push(post);
    }
  }

  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });
  await copyDir(assetsDir, path.join(distDir, "assets"));
  await fs.writeFile(path.join(distDir, ".nojekyll"), "\n");

  await writeFileByUrl("/", renderHome(site, posts, tagCounts, about));
  await writeFileByUrl("/archives/", renderArchives(site, posts));
  await writeFileByUrl("/tags/", renderTagsIndex(site, tagCounts));
  await writeFileByUrl("/about/", renderAbout(site, about));
  await writeFileByUrl("/404.html", renderNotFound(site));
  await writeFileByUrl("/about/me.html", redirectPage("/about/"));

  for (const post of posts) {
    await writeFileByUrl(post.url, renderPost(site, post));
  }

  for (const [tag, taggedPosts] of postsByTag.entries()) {
    await writeFileByUrl(`/tags/${tagSlug(tag)}/`, renderTagPage(site, tag, taggedPosts));
  }

  const urls = [
    "/",
    "/archives/",
    "/tags/",
    "/about/",
    ...posts.map((post) => post.url),
    ...[...postsByTag.keys()].map((tag) => `/tags/${tagSlug(tag)}/`),
  ];
  await fs.writeFile(path.join(distDir, "rss.xml"), rss(site, posts));
  await fs.writeFile(path.join(distDir, "sitemap.xml"), sitemap(site, urls));

  console.log(`Built ${posts.length} posts into dist/`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
