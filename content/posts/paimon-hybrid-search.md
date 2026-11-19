---
title: Paimon（十）混合检索：候选召回与结果融合
date: "2026-11-19T17:39:00+08:00"
slug: paimon-hybrid-search
summary: 先用 SQL 结合全文与向量检索，观察两路候选怎样形成融合结果，再比较 RRF、归一化加权与倒数排名，以及候选范围、排序质量和查询成本之间的取舍。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [表的设计](/2026/11/09/paimon-table-design/) · [上一篇：全文索引：从词项匹配到相关性排序](/2026/11/19/paimon-full-text-index/)

全文索引提供词项匹配的证据，向量索引提供数值表示接近程度的证据。面对同一个查询，两条路线可能各有偏好，也可能共同找到一条记录。混合检索把这些候选放在一起，按选定规则融合，再决定最终返回哪些行。

这一篇继续使用 Data Evolution Append 表。先用一组可以核对结果的数据，看看全文、向量和融合查询的区别，再解释融合规则怎样影响排序。

## 先让一张表拥有两条检索路线

下面采用 Paimon 2.1 文档中的 **Spark SQL** 用法，假设已经配置 Paimon Catalog、SQL 扩展，以及全文和向量索引运行依赖。建表与存储的基础见[第七篇](/2026/11/19/paimon-vector/)，混合查询的接口见 [Paimon Hybrid Search](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/hybrid-search/)。

示例单独创建一张表。向量是人为构造的数值，用来演示候选和排序，不代表模型从这些文本生成的真实表示。实际应用需要在写入前生成相应向量。

```sql
USE paimon.default;

CREATE TABLE hybrid_samples (
    id BIGINT,
    label STRING,
    content STRING,
    embedding ARRAY<FLOAT>
        COMMENT '__VECTOR_FIELD;3'
) TBLPROPERTIES (
    'row-tracking.enabled' = 'true',
    'data-evolution.enabled' = 'true',
    'vector.file.format' = 'vortex',
    'ivf-flat.distance.metric' = 'cosine',
    'ivf-flat.nlist' = '1',
    'full-text.tokenizer' = 'whitespace',
    'full-text.stem' = 'false',
    'full-text.remove-stop-words' = 'false'
);

INSERT INTO hybrid_samples VALUES
    (1, 'A', 'paimon paimon guide',
        array(0.6f, 0.8f, 0.0f)),
    (2, 'B', 'paimon storage guide',
        array(0.8f, 0.6f, 0.0f)),
    (3, 'C', 'streaming table guide',
        array(1.0f, 0.0f, 0.0f)),
    (4, 'D', 'lake storage guide',
        array(0.0f, 1.0f, 0.0f));
```

等待写入完成后，分别建立两种索引。

```sql
CALL sys.create_global_index(
    table => 'default.hybrid_samples',
    index_column => 'embedding',
    index_type => 'ivf-flat'
);

CALL sys.create_global_index(
    table => 'default.hybrid_samples',
    index_column => 'content',
    index_type => 'full-text'
);
```

混合检索组织的是多条查询路线。这里需要的是已有的全文索引和向量索引，无须再构建第三份“混合索引”。本例的向量索引只有一个簇，方便核对候选；它不用于证明大规模 ANN 查询的性能。

## 分别查询，再看两路各自找到谁

先用词项 `paimon` 做全文检索，取两条候选。

```sql
SELECT id, label
FROM full_text_search(
    'hybrid_samples',
    'content',
    '{"match":{"query":"paimon"}}',
    2
)
ORDER BY __paimon_search_score DESC, id;
```

| id | label |
| --- | --- |
| 1 | A |
| 2 | B |

A 和 B 都包含查询词。它们的文本长度相同，A 的查询词词频更高，因此在这组样例中排在 B 前面。

再用 `[1, 0, 0]` 做向量检索，同样取两条候选。

```sql
SELECT id, label,
    round(__paimon_search_score, 3) AS score
FROM vector_search(
    'hybrid_samples',
    'embedding',
    array(1.0f, 0.0f, 0.0f),
    2
)
ORDER BY __paimon_search_score DESC, id;
```

| id | label | score |
| --- | --- | --- |
| 3 | C | 1.000 |
| 2 | B | 0.800 |

四条数据向量都是单位向量，与查询向量的余弦相似度分别为 `0.6`、`0.8`、`1.0`、`0.0`。所以全文路线给出 **A、B**，向量路线给出 **C、B**。B 在两路里都排第二，接下来观察融合会怎样处理它。

## 用 hybrid_search 合并两路结果

`hybrid_search` 接收表名、向量路线数组、全文路线数组、最终返回数量，以及融合规则。本例为两路分别设置 `limit=2`，最终最多返回三条，采用等权 RRF。

```sql
SELECT id, label,
    round(__paimon_search_score, 6) AS score
FROM hybrid_search(
    'hybrid_samples',
    array(named_struct(
        'field', 'embedding',
        'query_vector', array(1.0f, 0.0f, 0.0f),
        'limit', 2,
        'weight', 1.0f,
        'options', map('ivf.nprobe', '1')
    )),
    array(named_struct(
        'column', 'content',
        'query', '{"match":{"query":"paimon"}}',
        'limit', 2,
        'weight', 1.0f
    )),
    3,
    'rrf'
)
ORDER BY __paimon_search_score DESC, id;
```

| id | label | score |
| --- | --- | --- |
| 2 | B | 0.032258 |
| 1 | A | 0.016393 |
| 3 | C | 0.016393 |

B 从两路各自的第二位，变成了融合后的第一位；A、C 分数相同，按 `id` 展示。这里的分数已经是融合分数，不再是 BM25 或余弦相似度。后面用公式核对这三个值。 [混合查询的路线与参数](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/hybrid-search/#configure-routes)

<figure>
  <a href="/assets/images/paimon-hybrid-search/hybrid-routes.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-hybrid-search/hybrid-routes.webp" width="1254" height="1254" alt="混合检索的手绘流程，全文路线返回 A 和 B，向量路线返回 C 和 B，按内部行标识合并候选并用 RRF 融合，最终得到 B、A、C，再读回所需列" loading="lazy" decoding="async" /></a>
  <figcaption>A、B、C 是样例记录标签。实际融合按同一张表的内部 Row ID 对应记录，B 的两份贡献形成一条结果。示意图由 AI 生成。</figcaption>
</figure>

两条路线提供的是同一张表上的不同检索证据。融合时先按行标识合并重复候选，再累积相应贡献，最后选出结果并读取需要的列。它不会因为同一行命中两路，就输出两份记录。

## RRF 为什么会把 B 排到前面

BM25 与向量分数有不同的尺度。直接相加时，数值范围较大的路线可能占主导，即使这种数值差异并不代表更强的相关性证据。

RRF（Reciprocal Rank Fusion）使用每条路线中的**名次**计算贡献。设某行在路线 `i` 的名次为 `r_i`，路线权重为 `w_i`，融合分数为 `Σ w_i / (c + r_i)`；求和只覆盖返回了这行的路线，名次从 1 开始，`c` 是平滑常数。它减小头部名次之间的差距，让多路支持能够累积。 [RRF 的设计](https://cormack.uwaterloo.ca/cormack/cormacksigir09-rrf.pdf)

按本例两路等权、`c=60` 演算：

- **A** 只进入全文路线的第一位，贡献为 `1 / 61`。
- **C** 只进入向量路线的第一位，贡献同样为 `1 / 61`。
- **B** 在两路都是第二位，贡献为 `1 / 62 + 1 / 62`，大于前面两个单路贡献。

这就是 SQL 中融合分数的来源。未进入某路候选，并不意味着原始相似度为零；例如 A 仍有向量，但被向量路线的 Top-2 截断，RRF 只能使用这次返回的证据。 [Paimon 的融合计算](https://github.com/apache/paimon/blob/master/paimon-common/src/main/java/org/apache/paimon/globalindex/HybridSearchRanker.java)

RRF 的好处是无需把 BM25 与余弦分数校准到同一个数值尺度。代价是它不再保留原始分差：第一名只领先一点点，或者领先很多，都会先变成同样的名次关系。多条高度相似的路线还可能反复强化相同候选，增加路线不保证增加独立证据。

## 归一化加权，为什么可能得到另一种顺序

如果希望利用每条路线内部的分数差异，可以把上面 SQL 的最后一个参数改为 `weighted_score`，其余参数保持不变。Paimon 对**每条路线已经返回的候选**分别做 Min-Max 归一化，再乘权重求和。分数存在差异时，归一化形式是 `(score − min) / (max − min)`。 [Paimon 融合规则](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/hybrid-search/#choose-a-ranker)

在本例每路只有两条候选的条件下：

- **全文路线**中 A 分数更高，映射为 1；B 是这两条里的最低分，映射为 0。
- **向量路线**中 C 分数更高，映射为 1；B 同样映射为 0。
- **等权相加**后，A、C 各为 1，B 为 0。

| id | label | 融合分数 |
| --- | --- | --- |
| 1 | A | 1.000000 |
| 3 | C | 1.000000 |
| 2 | B | 0.000000 |

B 仍然命中了两路。这里的零表示它在各路已返回候选中的相对位置，不能解释为“不相关”或“没有命中”。

<figure>
  <a href="/assets/images/paimon-hybrid-search/rank-versus-score.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-hybrid-search/rank-versus-score.webp" width="1254" height="1254" alt="两种融合方式的手绘对比，相同的全文 A、B 和向量 C、B 候选，在 RRF 中 B 获得两份名次贡献；Min-Max 归一化后等权相加，则 A、C 各为一而 B 为零" loading="lazy" decoding="async" /></a>
  <figcaption>右侧是各路候选内部的归一化贡献。候选相同，融合规则仍会改变排序；该例不说明哪种规则普遍更好。示意图由 AI 生成。</figcaption>
</figure>

归一化解决数值尺度的问题，也引入了对候选分布的依赖。扩大候选范围后，最小值和最大值可能变化，原来某条记录的归一化分数也会变化。极端值还可能压缩其他候选之间的差距。融合后的值是本次查询中的相对评分，不是跨查询稳定的相关性概率。

Paimon 还提供 `mrr`，按 `Σ w_i / r_i` 累积倒数排名，相比带平滑常数的 RRF，更突出各路头部。在本例中，A、C 各得到一个第一名的贡献 1，B 得到两个第二名的贡献 `1/2 + 1/2`，三者同分。

这三种规则分别保留了不同的信息：RRF 使用平滑后的名次证据，归一化加权使用候选内部的相对分差，倒数排名更强调头部名次。权重表达路线的影响程度，具体取值应结合实际查询评估。

## 每路取多少，与最终返回多少是两个问题

SQL 中有三个 `limit`：两个位于路线内部，一个位于融合函数的第四个参数。前两个决定各路贡献多少候选，后一个决定最终保留多少条。

如果把两路的 `limit` 都缩到 1，全文只返回 A，向量只返回 C。此时即使最终要求三条，融合器也只能处理 A、C，无法重新找回没有进入任何候选集的 B。

两路使用相同的候选数量、最终最多返回三条时，可以对照下面的结果。

| 每路候选数 | 候选并集 | RRF 顺序 |
| --- | --- | --- |
| 1 | A、C | A、C |
| 2 | A、B、C | B、A、C |

所以，扩大最终返回数量不能替代扩大每路候选范围。反过来，更大的候选预算会增加索引搜索、候选传输和融合工作；向量侧的搜索预算还影响真实近邻能否进入这些候选。两路候选高度重叠时，并集也可能远小于数量之和。 [候选范围与融合边界](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/hybrid-search/#coverage-and-candidate-limits)

## 两条路线怎样保持可比较的查询范围

如果业务只允许搜索某个分类或时间范围，这个条件应定义两路共同的候选空间，再在范围内做各路 Top-K。仅在融合结果之后删除不满足条件的记录，会让本来有机会入选的记录被提前截断。具体执行还要确认过滤条件能否进入每条路线，以及是否需要读取普通列验证。过滤与回表的基础可以对照[第八篇](/2026/11/19/paimon-vector-index/)和[第九篇](/2026/11/19/paimon-full-text-index/)。

两路也有各自的索引覆盖范围、值版本和分析约定。全文索引尚未覆盖新文本，或者向量仍来自旧模型，都可能改变本次融合可用的证据。某条路线返回空集，需要结合覆盖与查询语义判断原因，不能只理解为“这批数据不相关”。 [混合查询的覆盖与过滤](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/hybrid-search/#row-filters)

这些候选还需要指向同一张表、同一套行标识。融合后的行标识与分数一起交给读取流程，再按需要取回内容等列；搜索内部的结果选择与最终展示顺序仍是两个环节，SQL 中应明确 `ORDER BY`。

## 总结

混合检索把词项匹配与向量接近程度作为不同来源的检索证据，先各自召回候选，再按同一行汇合并排序。它的作用是提供一种组合多条检索路线的方式；最终效果取决于候选质量、融合规则，以及这些证据是否覆盖了相同的数据范围。

- **候选覆盖与查询成本。** 扩大每路候选预算，有机会找回单路头部之外的记录，也增加搜索与融合工作。最终 K 不能弥补候选阶段已经丢失的信息。
- **尺度稳定与分差保留。** RRF 减少不同分数尺度的影响，同时舍弃原始分差；归一化加权保留相对分差，却更依赖候选集的分布。
- **互补证据与重复强化。** 不同路线可以补充彼此遗漏的记录；相似路线也可能反复放大同一偏好。应使用真实查询和相关性标注判断收益。
- **排序效果与数据一致性。** 权重与融合规则需要和索引覆盖、模型及分词版本一起管理。评估既要看结果相关性，也要看新鲜度、端到端延迟与维护成本。
