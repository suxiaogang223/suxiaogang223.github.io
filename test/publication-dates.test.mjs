import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function fixtureFor(t) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'blog-publication-dates-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const directory of ['scripts', 'src']) {
    await cp(path.join(root, directory), path.join(fixture, directory), { recursive: true });
  }
  await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
  await mkdir(path.join(fixture, 'content/posts'), { recursive: true });
  await mkdir(path.join(fixture, 'content/pages'), { recursive: true });
  await cp(path.join(root, 'content/site.json'), path.join(fixture, 'content/site.json'));
  await writeFile(path.join(fixture, 'content/pages/about.md'), '---\ntitle: About\nsummary: About\n---\nAbout.');
  return fixture;
}

function post(slug, date) {
  return `---\ntitle: ${slug}\nsummary: ${slug} summary\ndate: ${date}\nslug: ${slug}\ntags: [dates]\n---\n${slug} body.\n`;
}

test('publication timestamps order listings and RSS by instant while preserving calendar URLs', async (t) => {
  const fixture = await fixtureFor(t);
  const posts = [
    ['a-earlier', '"2026-11-19T09:01:00+08:00"'],
    ['z-later', '"2026-11-19T09:02:00+08:00"'],
    ['m-latest', '"2026-11-19T01:03Z"'],
    ['near-midnight', '"2026-11-19T00:05:00+08:00"'],
    ['legacy', '2026-11-18'],
  ];
  for (const [slug, date] of posts) {
    await writeFile(path.join(fixture, 'content/posts', `${slug}.md`), post(slug, date));
  }
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: fixture });

  const expected = ['m-latest', 'z-later', 'a-earlier', 'near-midnight', 'legacy'];
  for (const filename of ['index.html', 'archives/index.html', 'tags/dates/index.html', 'rss.xml']) {
    const html = await readFile(path.join(fixture, 'dist', filename), 'utf8');
    const urls = [...html.matchAll(/\/2026\/11\/\d{2}\/([a-z-]+)\//g)].map((match) => match[1]);
    assert.deepEqual([...new Set(urls)], expected, filename);
  }
  const article = await readFile(path.join(fixture, 'dist/2026/11/19/near-midnight/index.html'), 'utf8');
  assert.match(article, /<time datetime="2026-11-19T00:05:00\+08:00">2026-11-19 00:05<\/time>/);
  const archives = await readFile(path.join(fixture, 'dist/archives/index.html'), 'utf8');
  assert.match(archives, /2026-11-19 09:02/);
  assert.match(archives, /<time datetime="2026-11-18T00:00:00Z">2026-11-18<\/time>/);
  const rss = await readFile(path.join(fixture, 'dist/rss.xml'), 'utf8');
  assert.match(rss, /<pubDate>Thu, 19 Nov 2026 01:02:00 GMT<\/pubDate>/);
  assert.match(rss, /<pubDate>Wed, 18 Nov 2026 16:05:00 GMT<\/pubDate>/);
});

test('invalid or timezone-free publication timestamps fail the build', async (t) => {
  const fixture = await fixtureFor(t);
  for (const date of [
    '"2026-11-19T09:01"',
    '"2026-02-30T09:01:00+08:00"',
    '"2026-11-19T24:01:00+08:00"',
    '2026-11-19T09:01:00+08:00',
  ]) {
    await writeFile(path.join(fixture, 'content/posts/invalid.md'), post('invalid', date));
    assert.throws(
      () => execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: fixture, stdio: 'pipe' }),
      (error) => /invalid\.md: date must use/.test(error.stderr.toString()),
      date,
    );
  }
});
