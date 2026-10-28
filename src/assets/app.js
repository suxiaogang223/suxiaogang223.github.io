const THEME_STORAGE_KEY = "blog:theme";
const LANG_STORAGE_KEY = "blog:lang";

const THEME_CHOICES = ["light", "dark"];
const LANG_CHOICES = ["zh", "en"];

const I18N = {
  zh: {
    skip_to_content: "跳到正文",
    nav_home: "首页",
    nav_archives: "归档",
    nav_tags: "标签",
    nav_about: "关于",
    theme_label: "主题",
    theme_light: "明亮",
    theme_dark: "暗色",
    lang_label: "语言",
    lang_zh: "中文",
    lang_en: "EN",
    ml_major: "blog",
    epigraph_author: "六祖慧能",
    epigraph_translation: "",
    hero_subtitle: "记录数据系统、存储格式、查询优化和工程实践。",
    hero_meta_static: "静态生成",
    recent_posts: "最近文章",
    archive_preview: "归档预览",
    tags_preview: "标签预览",
    about_preview: "关于",
    archives_title: "归档",
    tags_title: "标签",
    about_title: "关于",
    all_posts: "全部文章",
    all_tags: "全部标签",
    published: "发布于",
    reading_time: "分钟阅读",
    tagged_with: "标签",
    no_tags: "暂无标签",
    read_post: "阅读文章",
    return_home: "返回首页",
    not_found_title: "页面不存在",
    not_found_description: "你访问的页面不存在或已经移动。",
    minibuffer_default: "new post: add content/posts/*.md, then npm run build",
  },
  en: {
    skip_to_content: "Skip to content",
    nav_home: "Home",
    nav_archives: "Archives",
    nav_tags: "Tags",
    nav_about: "About",
    theme_label: "Theme",
    theme_light: "Light",
    theme_dark: "Dark",
    lang_label: "Lang",
    lang_zh: "中文",
    lang_en: "EN",
    ml_major: "blog",
    epigraph_author: "Huineng",
    epigraph_translation: "Originally there is not a single thing - where could dust alight?",
    hero_subtitle: "Notes on data systems, storage formats, query optimization, and engineering practice.",
    hero_meta_static: "Static generated",
    recent_posts: "Recent Posts",
    archive_preview: "Archive Preview",
    tags_preview: "Tags Preview",
    about_preview: "About",
    archives_title: "Archives",
    tags_title: "Tags",
    about_title: "About",
    all_posts: "All Posts",
    all_tags: "All Tags",
    published: "Published",
    reading_time: "min read",
    tagged_with: "Tagged",
    no_tags: "No tags yet",
    read_post: "Read post",
    return_home: "Back home",
    not_found_title: "Page not found",
    not_found_description: "The page you visited does not exist or has moved.",
    minibuffer_default: "new post: add content/posts/*.md, then npm run build",
  },
};

function detectLanguage() {
  const preferred = navigator.languages?.[0] || navigator.language || "zh";
  return preferred.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function prefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore private mode and disabled storage.
  }
}

function clamp(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function resolvedTheme(choice) {
  if (choice === "light" || choice === "dark") return choice;
  return prefersDark() ? "dark" : "light";
}

function applyTheme(choice) {
  document.documentElement.setAttribute("data-theme", resolvedTheme(choice));
}

function applyLanguage(lang) {
  const dict = I18N[lang];
  document.documentElement.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
  document.documentElement.setAttribute("data-lang", lang);

  document.querySelectorAll("[data-content-lang]").forEach((node) => {
    node.hidden = node.getAttribute("data-content-lang") !== lang;
  });

  document.querySelectorAll("[data-page-title-zh][data-page-title-en]").forEach((node) => {
    const value = node.getAttribute(`data-page-title-${lang}`);
    if (!value) return;
    if (node.tagName === "TITLE") {
      document.title = value;
    } else {
      node.setAttribute("content", value);
    }
  });

  document.querySelectorAll("[data-page-description-zh][data-page-description-en]").forEach((node) => {
    const value = node.getAttribute(`data-page-description-${lang}`);
    if (value) node.setAttribute("content", value);
  });

  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (!key || !(key in dict)) return;
    if (node.hasAttribute("data-i18n-html")) {
      node.innerHTML = dict[key];
    } else {
      node.textContent = dict[key];
    }
  });
}

function labelTheme(dict, theme) {
  return `${dict.theme_label}: ${theme === "dark" ? dict.theme_dark : dict.theme_light}`;
}

function labelLang(dict, lang) {
  return `${dict.lang_label}: ${lang === "zh" ? dict.lang_zh : dict.lang_en}`;
}

function flashMinibuffer(message) {
  const minibuffer = document.getElementById("minibuffer");
  if (!minibuffer) return;
  minibuffer.textContent = message;
  window.clearTimeout(flashMinibuffer.timer);
  flashMinibuffer.timer = window.setTimeout(() => {
    const lang = document.documentElement.getAttribute("data-lang") || "zh";
    minibuffer.textContent = minibuffer.dataset.defaultMessage || I18N[lang].minibuffer_default;
  }, 1400);
}

function init() {
  const requestedLang = new URLSearchParams(window.location.search).get("lang");
  let lang = clamp(requestedLang, LANG_CHOICES, clamp(storageGet(LANG_STORAGE_KEY), LANG_CHOICES, detectLanguage()));
  let theme = clamp(storageGet(THEME_STORAGE_KEY), THEME_CHOICES, resolvedTheme(null));

  const themeBtn = document.getElementById("theme-toggle");
  const langBtn = document.getElementById("lang-toggle");

  applyTheme(theme);
  applyLanguage(lang);

  const renderControls = () => {
    const dict = I18N[lang];
    const currentTheme = resolvedTheme(theme);
    if (themeBtn) {
      themeBtn.textContent = labelTheme(dict, currentTheme);
      themeBtn.setAttribute("aria-label", themeBtn.textContent);
    }
    if (langBtn) {
      langBtn.textContent = labelLang(dict, lang);
      langBtn.setAttribute("aria-label", langBtn.textContent);
    }
  };

  renderControls();
  themeBtn?.addEventListener("click", () => {
    const current = resolvedTheme(theme);
    theme = current === "dark" ? "light" : "dark";
    storageSet(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
    renderControls();
    flashMinibuffer(themeBtn.textContent);
  });

  langBtn?.addEventListener("click", () => {
    lang = lang === "zh" ? "en" : "zh";
    storageSet(LANG_STORAGE_KEY, lang);
    const url = new URL(window.location.href);
    if (url.searchParams.has("lang")) {
      url.searchParams.set("lang", lang);
      window.history.replaceState(null, "", url);
    }
    applyLanguage(lang);
    renderControls();
    flashMinibuffer(langBtn.textContent);
  });
}

init();
