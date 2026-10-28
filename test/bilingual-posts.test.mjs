import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('English sidecars translate one article without duplicating posts or changing untranslated articles', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'blog-bilingual-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const directory of ['scripts', 'src']) {
    await cp(path.join(root, directory), path.join(fixture, directory), { recursive: true });
  }
  await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
  await mkdir(path.join(fixture, 'content/posts'), { recursive: true });
  await mkdir(path.join(fixture, 'content/pages'), { recursive: true });
  await cp(path.join(root, 'content/site.json'), path.join(fixture, 'content/site.json'));
  await writeFile(path.join(fixture, 'content/pages/about.md'), '---\ntitle: About\nsummary: About\n---\nAbout this blog.');
  const post = (title, slug, draft = false) => `---\ntitle: ${title}\nsummary: ${title} summary\ndate: 2026-10-28\nslug: ${slug}\ntags: [photography]\ndraft: ${draft}\n---\n${title} body.\n`;
  await writeFile(path.join(fixture, 'content/posts/example.md'), post('中文摄影教程', 'example'));
  await writeFile(path.join(fixture, 'content/posts/example.en.md'), '---\ntitle: Photography tutorial\nsummary: Start with your GitHub account.\n---\n## Create an account\nEnglish body.\n');
  await writeFile(path.join(fixture, 'content/posts/older.md'), post('Older article', 'older'));
  await writeFile(path.join(fixture, 'content/posts/draft.md'), post('Draft article', 'draft', true));
  await writeFile(path.join(fixture, 'content/posts/draft.en.md'), '---\ntitle: Draft translation\nsummary: Still a draft.\n---\nUnpublished.\n');

  const output = execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: fixture, encoding: 'utf8' });
  assert.match(output, /Built 2 posts/);
  const article = await readFile(path.join(fixture, 'dist/2026/10/28/example/index.html'), 'utf8');
  assert.match(article, /data-content-lang="zh" lang="zh-CN"/);
  assert.match(article, /data-content-lang="en" lang="en" hidden/);
  assert.match(article, /data-page-title-en="Photography tutorial/);
  assert.match(article, /data-page-description-en="Start with your GitHub account/);
  assert.match(article, /<h2>Create an account<\/h2>/);
  for (const filename of ['index.html', 'archives/index.html', 'tags/photography/index.html']) {
    const listing = await readFile(path.join(fixture, 'dist', filename), 'utf8');
    assert.match(listing, /中文摄影教程/);
    assert.match(listing, /Photography tutorial/);
    assert.doesNotMatch(listing, /Draft translation|Draft article/);
  }
  const older = await readFile(path.join(fixture, 'dist/2026/10/28/older/index.html'), 'utf8');
  assert.match(older, /Older article body/);
  assert.doesNotMatch(older, /data-content-lang/);
  const rss = await readFile(path.join(fixture, 'dist/rss.xml'), 'utf8');
  const sitemap = await readFile(path.join(fixture, 'dist/sitemap.xml'), 'utf8');
  assert.equal((rss.match(/<item>/g) || []).length, 2);
  assert.equal((sitemap.match(/\/2026\/10\/28\/example\//g) || []).length, 1);
});
