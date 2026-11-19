---
title: Paimon（九）全文索引：从词项匹配到相关性排序
date: "2026-11-19T09:09:00+08:00"
slug: paimon-full-text-index
summary: 先用 SQL 对比任意词匹配、全部词匹配和短语查询，再解释分词、倒排列表、词位置与 BM25，以及检索语义、索引体积和维护成本之间的取舍。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [表的设计](/2026/11/09/paimon-table-design/) · [上一篇：向量索引：从 Top-K 查询到候选筛选](/2026/11/19/paimon-vector-index/) · [下一篇：混合检索：候选召回与结果融合](/2026/11/19/paimon-hybrid-search/)

第八篇用向量比较数值表示的接近程度。很多查询还有更直接的要求：文本里是否出现某个词，几个词是否同时出现，或者它们是否组成一个短语？全文索引围绕这些文本条件组织数据，并为命中的记录计算相关性分数。本文以 Data Evolution Append 表上的全局全文索引为例。

## 先建表，写入五段短文本

下面使用 Paimon 2.1 文档中的 **Spark SQL** 写法，假设已配置 Paimon Catalog、SQL 扩展及全文索引运行依赖。环境准备见 [Spark SQL 快速开始](https://paimon.apache.org/docs/2.1/spark/quick-start/)，全文索引的使用条件见 [Paimon Full-Text Index](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/full-text/)。

为了能逐条核对命中结果，先用空格分隔的英文文本，选择 `whitespace` 分词并关闭词干处理，同时保留短语查询需要的词位置。

```sql
USE paimon.default;

CREATE TABLE full_text_samples (
    id BIGINT,
    content STRING
) TBLPROPERTIES (
    'row-tracking.enabled' = 'true',
    'data-evolution.enabled' = 'true',
    'full-text.tokenizer' = 'whitespace',
    'full-text.stem' = 'false',
    'full-text.with-position' = 'true'
);

INSERT INTO full_text_samples VALUES
    (1, 'paimon lake storage'),
    (2, 'paimon stream storage'),
    (3, 'lake paimon storage'),
    (4, 'paimon lakehouse storage'),
    (5, 'lake storage');
```

`content` 仍然是普通字符串列。表属性为后续全文索引指定分析方式，建表和写入不会自动建立索引。等待数据写入完成后，再为这一列构建索引。

```sql
CALL sys.create_global_index(
    table => 'default.full_text_samples',
    index_column => 'content',
    index_type => 'full-text'
);
```

这一步把文本转换为可搜索的词项，并建立词项到文档的查找结构。表中的原始字符串继续由数据文件保存，全文索引为它增加一条检索路径。

## 任意词匹配，与全部词匹配

先搜索 `paimon lake`，使用普通的 `match` 查询。

```sql
SELECT id, content
FROM full_text_search(
    'full_text_samples',
    'content',
    '{"match":{"query":"paimon lake"}}',
    10
)
ORDER BY id;
```

| id | content |
| --- | --- |
| 1 | paimon lake storage |
| 2 | paimon stream storage |
| 3 | lake paimon storage |
| 4 | paimon lakehouse storage |
| 5 | lake storage |

`match` 默认采用 OR：查询分析得到的词项中，命中任意一个就可以参与结果。第二行只有 `paimon`，第五行只有 `lake`，也都会返回。这里把 K 设为 10，大于样例总行数，再按 ID 排序，先观察完整的命中集合。 [Match 查询语义](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/full-text/#match)

如果要求两个词都出现，需要明确指定 AND。

```sql
SELECT id, content
FROM full_text_search(
    'full_text_samples',
    'content',
    '{"match":{"query":"paimon lake","operator":"And"}}',
    10
)
ORDER BY id;
```

| id | content |
| --- | --- |
| 1 | paimon lake storage |
| 3 | lake paimon storage |

这次只留下同时包含 `paimon` 和 `lake` 的两行。但它们的词序不同，AND 仍然都会命中：它约束词项是否存在，尚未要求这些词以什么顺序出现。

## 倒排索引怎样从词找到记录

如果直接扫描字符串，查询要逐条检查文本。倒排索引把这个方向反过来：先记录“某个词出现在哪些文档里”，查询再从词出发寻找候选。

前面的数据可以得到两条这样的倒排列表。

- **`paimon`** 出现在文档 1、2、3、4。
- **`lake`** 出现在文档 1、3、5。

OR 可以合并两份列表，AND 可以求交集。实际索引还会保存词典、编码后的文档标识，以及评分和位置判断所需的信息，不必为了判断是否出现某个词，先把所有原文都读出来。 [倒排记录中的标识、词频与位置](https://docs.rs/tantivy/latest/tantivy/schema/enum.IndexRecordOption.html)

<figure>
  <a href="/assets/images/paimon-full-text-index/inverted-postings.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-full-text-index/inverted-postings.webp" width="1254" height="1254" alt="全文倒排索引的手绘图，五段文本经过分词形成 paimon 和 lake 的倒排列表，OR 合并得到五篇文档，AND 求交得到文档一和三" loading="lazy" decoding="async" /></a>
  <figcaption>D 编号用来对应样例文档，不是 Paimon 的内部 Row ID，也不表示索引文件的字节布局。示意图由 AI 生成。</figcaption>
</figure>

这种组织方式把文本分析与索引写入的成本提前支付，换取后续的查找能力。候选确定之后，Paimon 再通过内部行标识读取请求的业务列。文档标识、内部 Row ID 与业务列 `id` 处在不同层次，不能直接按数值互相替代。

## 短语查询为什么还要保存位置

如果希望 `paimon lake` 以这个顺序相邻出现，可以使用 `match_phrase`。

```sql
SELECT id, content
FROM full_text_search(
    'full_text_samples',
    'content',
    '{"match_phrase":{"query":"paimon lake"}}',
    10
)
ORDER BY id;
```

| id | content |
| --- | --- |
| 1 | paimon lake storage |

第一行中，`paimon` 在位置 0，`lake` 在位置 1；第三行的顺序相反。只知道两个词都出现过，无法区分这两种情况，索引还需要保存各词的出现位置。

<figure>
  <a href="/assets/images/paimon-full-text-index/term-positions.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-full-text-index/term-positions.webp" width="1254" height="1254" alt="词位置的手绘对比，文档一中 paimon 和 lake 位于零和一，文档三中顺序相反；AND 两篇都命中，短语查询只命中文档一" loading="lazy" decoding="async" /></a>
  <figcaption>本例的位置按空格分词后的词序表示。真实位置来自分析器，不是原文的字节偏移。示意图由 AI 生成。</figcaption>
</figure>

开头的 `full-text.with-position=true` 为这种判断保留信息。默认的短语查询不放宽位置要求；需要允许间隔或位置调整时，还可以使用短语查询的容差规则。保留位置会增加索引体积和写入、解码的工作，只做词项存在性判断的场景，对这部分信息的需求就不同。 [短语与位置要求](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/full-text/#phrase)

## 分词决定搜索单位，全文查询不等于 LIKE

样例中的第四行包含 `lakehouse`，但它没有独立的 `lake` 词项。可以用两条查询对照这件事。

```sql
SELECT id
FROM full_text_search(
    'full_text_samples',
    'content',
    '{"match":{"query":"lake"}}',
    10
)
ORDER BY id;

SELECT id
FROM full_text_samples
WHERE content LIKE '%lake%'
ORDER BY id;
```

| 查询 | 返回的 id，按升序 |
| --- | --- |
| 全文匹配词项 `lake` | 1、3、5 |
| `LIKE '%lake%'` | 1、3、4、5 |

两条查询使用的判断单位不同。在本例的分词规则下，`lakehouse` 是一个完整词项；`LIKE` 则判断原始字符串中是否包含对应片段。选择哪种查询，首先取决于希望表达什么含义，不能只把全文索引看成字符串扫描的等价替换。

完整的文本分析通常还包含大小写归一化、词干处理、停用词过滤等步骤。它们会改变索引保存的词项，也会影响查询文本如何解释。建索引与查询需要采用兼容的分析规则，才能让两端的词项对应起来。 [文本分析与词项生成](https://docs.rs/tantivy/latest/tantivy/tokenizer/index.html)

空格分词只是方便解释这个样例。处理其他文本时，需要重新选择搜索单位。

- **按语言分词。** 中文可以选择 `jieba` 一类分词方式，把连续字符划分成词。词典、专有名称和歧义切分会影响能否命中，需要用真实查询验证。
- **按字符片段建索引。** N-gram 产生连续的短字符片段，适合部分片段检索，但会增加词项和倒排记录，也会改变匹配与评分的含义。它不能仅凭名字就视为任意 `LIKE` 的等价实现。
- **控制归一化。** 合并词形、忽略大小写或去掉停用词，可以减少表达差异；错误码、型号和大小写敏感的标识，则可能需要保留这些区别。

这些选择应在首次构建前明确。已有索引保存了当时的分析配置，修改表属性不会把旧文本重新分词；改变已有数据的分析方式，需要按相应范围重建索引。 [Paimon 分词配置与重建](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/full-text/#build-full-text-index)

## 从命中集合到相关性排序

前面的查询按 ID 展示，是为了比较哪些记录命中。实际搜索页面通常还需要按相关性排序，可以读取分数并显式排序。

```sql
SELECT id, content, __paimon_search_score AS score
FROM full_text_search(
    'full_text_samples',
    'content',
    '{"match":{"query":"paimon lake"}}',
    3
)
ORDER BY __paimon_search_score DESC, id;
```

这次最多选择三条评分靠前的记录。`full_text_search` 负责 Top-K 选择，`ORDER BY` 负责展示顺序；前面的按 ID 排序，也只是在排已经选出的结果，无法把 Top-K 之外的记录补回来。

BM25 评分可以从三个因素理解。

- **词的区分度。** 在很多文档中都出现的词，通常没有只在少数文档中出现的词那么能区分内容。
- **文档内词频。** 同一个词出现更多次，可能增加相关性，但收益会逐渐饱和，不是简单地按次数线性累加。
- **文本长度。** 长文本更容易包含更多查询词，长度归一化用来平衡这种影响，避免只凭篇幅占优势。 [BM25 评分构成](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/similarities/BM25Similarity.html)

相关性分数依赖分析后的词项、文本长度和语料统计。它不是概率，也不适合直接与向量余弦分数相加，或把某个固定阈值无条件套到不同查询和索引上。匹配条件决定哪些文本有资格参与，评分决定它们怎样排序，这两层需要分别理解。

全文索引也不意味着只处理 K 篇文档。常见词可能对应很长的倒排列表，查询组合、短语验证和评分仍然需要工作；返回十条结果，并不能说明只读了十条索引记录。

## 放回 Paimon 表里，还要协调哪些工作

全文索引与第八篇的向量索引共享全局索引和行读取的基础。索引搜索产生内部行标识与分数，表再在相应快照中读取需要的列。分片搜索、候选合并和回表都有成本；本篇集中讨论文本语义，行读取的组织方式可以对照[上一篇的回表流程](/2026/11/19/paimon-vector-index/)。

如果查询还带分类、时间等条件，需要在符合条件的范围内选择 Top-K。能够精确回答条件的标量索引可以提供行集合，其他条件则可能增加数据读取，无法参与搜索的条件还可能留到搜索后处理。与第八篇一样，先取全局 Top-K 再过滤，不能替代目标范围内的 Top-K。 [全文查询的行过滤](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/full-text/#row-filters)

持续变化的数据还需要协调三类进度。

- **追加文本的覆盖。** 已建索引不会自动覆盖后来的新行。继续构建索引，或在支持的路径中读取未覆盖文本并建立临时索引，都会增加工作；只搜索已覆盖范围则可能漏掉新内容。
- **已有文本的更新。** Row ID 没变，不代表索引保存的词项已经变了。需要按索引更新策略处理旧条目，并刷新相应范围。
- **删除与空间回收。** 查询要排除失效记录，索引和数据文件内的空间回收则需要结合维护与历史引用处理。

覆盖范围完整、词项反映最新值、分词规则一致，是不同的检查。修改分析方式时尤其要考虑旧索引与新索引的切换，不能仅凭一次成功构建就认为所有历史文本都按新规则分析过。 [覆盖范围与值的新鲜度](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/manage-indexes/#coverage-and-freshness)

## 总结

从 SQL 看，全文索引让字符串列支持词项、组合条件和短语检索，并按相关性选择结果。背后是分词、倒排列表、词频与位置共同构成的搜索结构，把反复扫描原文的工作转化为索引构建、查找和维护。

- **召回范围与匹配含义。** 分词和归一化能减少表达差异，也可能合并本来需要区分的内容。搜索单位应围绕语言和查询目的选择。
- **查询能力与索引体积。** 文档标识支持定位，词频支持评分，位置支持短语；保留更多信息，也需要更多存储、写入和解码工作。
- **结果相关性与执行成本。** Top-K 减少输出量，但常见词、复杂条件和短语验证仍可能处理大量候选。需要把评分、过滤和回表一起评估。
- **数据新鲜度与维护成本。** 追加、更新和分析规则变化都需要协调索引进度。更及时、更一致的结果，需要相应的构建、重建或补充读取成本。

下一篇用 SQL 组合全文与向量检索，对比候选融合后的结果，再解释名次、分数和候选预算怎样影响排序。 [下一篇：混合检索：候选召回与结果融合](/2026/11/19/paimon-hybrid-search/)
