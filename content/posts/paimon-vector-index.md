---
title: Paimon（八）向量索引：从 Top-K 查询到候选筛选
date: "2026-11-19T09:08:00+08:00"
slug: paimon-vector-index
summary: 先用 SQL 建立向量索引、查询 Top-K 并加入分类过滤，再解释 IVF、量化、图搜索与 Row ID 回表，以及召回率、读取成本和索引新鲜度之间的取舍。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [表的设计](/2026/11/09/paimon-table-design/) · [上一篇：VECTOR：向量表示与存储](/2026/11/19/paimon-vector/) · [下一篇：全文索引：从词项匹配到相关性排序](/2026/11/19/paimon-full-text-index/)

第七篇把向量写进了表。接下来，如果给出一条查询向量，希望找到最接近的两条记录，应该怎样写 SQL？向量索引负责减少需要比较的数据，表的读取流程则负责把命中的记录取回来。本文以 Data Evolution Append 表上的全局向量索引为例。

## 先准备四条可以手算的向量

下面采用 Paimon 2.1 文档中的 **Spark SQL** 用法，假设已经配置 Paimon Catalog、SQL 扩展和对应的向量索引运行依赖。环境准备见 [Spark SQL 快速开始](https://paimon.apache.org/docs/2.1/spark/quick-start/)，索引依赖与使用条件见 [Paimon 向量索引](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/vector/)。

示例另外建一张表，不依赖第七篇已经写入的数据。三维数值是人为构造的，方便检查结果；实际应用需要使用兼容的模型和处理规则生成数据向量与查询向量。

```sql
USE paimon.default;

CREATE TABLE vector_index_samples (
    id BIGINT,
    label STRING,
    category STRING,
    embedding ARRAY<FLOAT>
        COMMENT '__VECTOR_FIELD;3'
) TBLPROPERTIES (
    'row-tracking.enabled' = 'true',
    'data-evolution.enabled' = 'true',
    'vector.file.format' = 'vortex',
    'ivf-flat.distance.metric' = 'cosine',
    'ivf-flat.nlist' = '1'
);

INSERT INTO vector_index_samples VALUES
    (1, 'A', 'electronics', array(1.0f, 0.0f, 0.0f)),
    (2, 'B', 'books', array(0.8f, 0.6f, 0.0f)),
    (3, 'C', 'books', array(0.6f, 0.8f, 0.0f)),
    (4, 'D', 'electronics', array(0.0f, 1.0f, 0.0f));
```

向量列与独立文件的声明沿用第七篇。这里增加的两个属性，分别为后续 IVF-FLAT 索引选择余弦度量和一个聚类簇。数值后的 `f` 表示 Spark SQL 的 FLOAT 字面量。

**表属性描述建索引时的选择，建表和写入本身还没有产生索引。** 本例只建一个簇，是为了展示完整流程，不能用它说明多簇索引的加速效果。索引也可以建立在普通的 `ARRAY<FLOAT>` 列上；专用向量文件与搜索索引有各自的用途。 [向量存储与搜索](https://paimon.apache.org/docs/2.1/multimodal-table/vector/)

## 建索引，再查询 Top-2

等待写入完成后，对 `embedding` 建立 IVF-FLAT 全局索引。

```sql
CALL sys.create_global_index(
    table => 'default.vector_index_samples',
    index_column => 'embedding',
    index_type => 'ivf-flat'
);
```

索引构建完成后，用查询向量 `[1, 0, 0]` 搜索两条近邻。

```sql
SELECT
    id,
    label,
    round(__paimon_search_score, 3) AS score
FROM vector_search(
    'vector_index_samples',
    'embedding',
    array(1.0f, 0.0f, 0.0f),
    2
)
ORDER BY __paimon_search_score DESC, id;
```

| id | label | score |
| --- | --- | --- |
| 1 | A | 1.000 |
| 2 | B | 0.800 |

这里选择余弦度量，分数越大越相似。四条数据向量和查询向量都具有单位长度，因此可以直接用内积核对：A、B、C、D 的余弦相似度分别为 `1.0`、`0.8`、`0.6`、`0.0`。示例结果按三位小数展示，排序仍使用原始分数。

`vector_search` 的最后一个参数指定 Top-K。`ORDER BY` 明确结果的展示顺序；选出哪些行和把这些行按什么顺序返回，是两个环节。普通的 `SELECT embedding FROM ...` 只读取向量值，不会自动变成近邻检索。 [向量搜索 SQL](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/vector/#vector-search) · [分数与结果顺序](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/manage-indexes/#read-scored-results)

## IVF 怎样减少需要比较的向量

最直接的做法，是读取每条向量，计算它与查询向量的相似度，再选出 Top-K。这能形成精确对照，但主要计算量会随记录数与维度的乘积增长。

IVF（Inverted File）先把向量组织进若干聚类簇，每个簇有代表它的中心。查询先比较这些中心，选择一部分簇，再到选中的簇里比较候选向量。它把一次面向全部数据的比较，拆成了**粗筛簇、细查候选**两个阶段。 [IVF-FLAT 的构建与搜索](https://paimon.apache.org/docs/vector-index/ivf-flat.html)

<figure>
  <a href="/assets/images/paimon-vector-index/ivf-candidates.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-vector-index/ivf-candidates.webp" width="1254" height="1254" alt="IVF 候选筛选的手绘图，向量分为四个簇，查询先选择部分簇，再比较簇内记录；边界附近的近邻可能位于未选择的簇，扩大探测范围会增加计算" loading="lazy" decoding="async" /></a>
  <figcaption>几何关系用于解释候选筛选，不对应前面的单簇 SQL 数据，也不表示真实高维空间的完整结构。示意图由 AI 生成。</figcaption>
</figure>

两个参数控制不同阶段的工作。

- **`nlist` 决定建多少个簇。** 簇划分得更细，每个簇的候选通常更少，但训练、中心比较和簇管理也有成本。数据分布变化后，原来的聚类不一定继续适合。
- **`nprobe` 决定查询探测多少个簇。** 探测更多簇，通常更容易找回真实近邻，同时增加索引读取和距离计算。它与最终返回几条记录的 K 有不同含义。

IVF-FLAT 在选中的簇里保留并比较浮点向量，但“簇内比较准确”不代表“全局一定准确”。真实近邻可能落在没有探测的簇中，这就是候选筛选带来的近似性。前面的单簇例子包含全部四条向量，方便核对结果；生产环境通过少查一部分簇获得的收益，也正是在这里引入漏检的可能。

## 压缩表示与图搜索，改变了哪部分成本

Paimon 提供多种向量索引。它们可以从两个问题理解：怎样找到候选，以及怎样保存和比较候选的数值。

| 索引 | 组织与比较方式 | 主要取舍 |
| --- | --- | --- |
| IVF-FLAT | 选簇后比较浮点向量 | 表示直接，但索引体积和候选扫描量较大 |
| IVF-PQ | 选簇后比较分段量化的短编码 | 减少存储和读取，增加码本训练与近似距离误差 |
| IVF-SQ | 选簇后比较逐维量化的表示 | 用较低精度换取更紧凑的候选扫描，需要评估量化误差 |
| IVF-RQ | 选簇后比较旋转后的残差量化表示 | 调整编码宽度来权衡存储、计算和召回效果 |
| DiskANN | 沿图的邻接关系寻找候选，并结合数值读取与重排 | 减少全面扫描，需要图构建、缓存和按需读取配合 |

PQ 把向量拆成多段，每段用码本中的代表值编码。查询可以通过查表累加近似距离，减少逐条读取完整浮点向量的开销。量化改变的是索引中的数值表示；它不会自动把原表的 VECTOR 列改写成同样的编码。 [IVF-PQ 的表示与比较](https://paimon.apache.org/docs/vector-index/ivf-pq.html)

DiskANN 则利用图边导航，让搜索从已有候选逐步接近查询向量，有限的遍历预算会影响最终找到哪些节点。磁盘上的图与向量读取还受到存储延迟、请求次数和缓存命中的影响。图索引同样需要空间与构建资源，不能仅凭名字推断它一定更省磁盘，或适合直接从远端零散读取。 [DiskANN 的设计取舍](https://paimon.apache.org/docs/vector-index/diskann.html)

重排可以读取候选的原始向量，重新计算相似度，改善量化造成的排序误差；但未进入候选集的真实近邻，不会仅靠重排自动出现。因此，候选搜索范围、编码精度和重排数量要分别考虑。

## 加上分类条件，Top-K 的含义也变了

回到 SQL。如果只想在 `books` 中找最接近的两条记录，可以先为分类列建立标量索引，让这类条件能够提供候选行范围。

```sql
CALL sys.create_global_index(
    table => 'default.vector_index_samples',
    index_column => 'category',
    index_type => 'btree'
);

SELECT
    id,
    label,
    round(__paimon_search_score, 3) AS score
FROM vector_search(
    'vector_index_samples',
    'embedding',
    array(1.0f, 0.0f, 0.0f),
    2
)
WHERE category = 'books'
ORDER BY __paimon_search_score DESC, id;
```

| id | label | score |
| --- | --- | --- |
| 2 | B | 0.800 |
| 3 | C | 0.600 |

这次要找的是分类范围内的 Top-2。先对全表选出 A、B，再在应用里删除不属于 `books` 的 A，只会留下 B；它无法替代在 B、C 中搜索近邻。上面的简单分类等值条件可以参与搜索范围的确定，标量索引与向量索引分别承担过滤和相似度比较。 [标量过滤与向量搜索](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/vector/#vector-search)

<figure>
  <a href="/assets/images/paimon-vector-index/filter-before-topk.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-vector-index/filter-before-topk.webp" width="1254" height="1254" alt="过滤顺序的手绘对比，全局 Top-2 为 A 和 B，之后只留 books 只能得到 B；在 books 的 B 和 C 中选择 Top-2 则得到两条记录" loading="lazy" decoding="async" /></a>
  <figcaption>比较两种不同的查询含义。图中的理想排序用于解释范围，ANN 搜索仍需要评估召回效果。示意图由 AI 生成。</figcaption>
</figure>

过滤也会改变性能。条件很严格时，搜索过程可能需要查看更多簇或节点，才能凑足有效候选；某些条件还需要读取普通列确认。不能只用无过滤的查询速度，估算带复杂条件的检索成本。放大候选数量后再过滤可以缓解结果不足，但有限的放大倍数仍不能保证覆盖目标范围内的全部近邻。

## 索引怎样把命中结果交回 Paimon 表

前面的结果既有向量分数，也有普通列 `id`、`label`。索引首先找到的是内部 Row ID 及其分数，表再根据这些行标识读取所需列。业务列 `id` 与 Paimon 的 Row ID 没有固定的换算关系。 [全局索引与行读取](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/)

数据较多时，索引可以按行范围组织成多个分片，各分片搜索候选，再合并为本次请求的 Top-K。**索引分片和 IVF 的簇也有不同职责**：分片划分索引构建与读取的范围，簇在一份索引内部按向量关系缩小搜索范围。

<figure>
  <a href="/assets/images/paimon-vector-index/index-to-rows.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-vector-index/index-to-rows.webp" width="1254" height="1254" alt="Paimon 向量搜索与回表的手绘图，查询搜索多个索引分片，合并内部 Row ID 和分数，再在查询快照对应的数据文件中定位记录并读取请求的列" loading="lazy" decoding="async" /></a>
  <figcaption>字母表示不同分片内的示意行标识，与 SQL 中的业务 ID 无关；实际读取还需结合覆盖范围和可见性处理。示意图由 AI 生成。</figcaption>
</figure>

这份分工让索引可以专注于候选生成，表继续管理列数据、快照和逻辑行。代价是搜索之后还可能发生回表 I/O。候选越分散，定位、文件打开和按需读取越可能影响延迟；只请求必要的列，可以减少这一步的数据量。即使索引搜索很快，端到端查询仍要把这些工作算进去。

## 表已经更新，索引是否也跟上了

开头先写入，再执行建索引，保证演示时已有数据进入索引范围。持续写入时，这两个进度需要分别观察。

- **追加新行。** 已有索引文件不会自动覆盖后来追加的行。需要继续构建索引，或在支持的搜索路径中补扫尚未覆盖的数据。只搜索已覆盖范围更省工作，也可能漏掉新记录。
- **更新已有向量。** 行标识仍然存在，不代表索引保存的数值已经更新。需要按索引更新策略处理旧条目并刷新索引；单纯确认 Row ID 范围完整，无法判断向量值是否过期。
- **删除记录。** 使用 DV 的路径需要依据查询快照排除失效行，避免删除结果占用 Top-K 名额。逻辑删除与索引文件内数据的物理回收，仍有不同进度。

补扫解决未覆盖范围的问题，不能自动修复同一 Row ID 上已经过期的向量，也不会让已建索引部分的 ANN 搜索变成精确搜索。查询需要明确包含哪批数据、采用什么索引版本，以及是否允许用额外扫描换取新数据的可见性。 [索引覆盖与值的新鲜度](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/manage-indexes/#coverage-and-freshness) · [删除与向量索引](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/vector/#python-tables-with-deletion-vectors)

## 怎样判断节省的工作是否值得

先固定数据快照、查询向量、度量和过滤条件，用全量精确比较得到对照结果，再评估近似索引。Recall@K 衡量精确 Top-K 中有多少条被找回；例如精确 Top-10 中找回八条，这次查询的 Recall@10 就是 `0.8`。

评估时需要一起记录召回率、尾部延迟、读取字节、内存与索引构建成本。小样本、无过滤和热缓存下的结果，不能直接代表真实负载。改变模型、数据分布、过滤选择性或存储介质后，也需要重新确认原来的取舍。 [向量索引的评估顺序](https://paimon.apache.org/docs/vector-index/)

## 总结

从 SQL 看，向量索引让表能够执行 Top-K 相似度查询，并与普通字段的过滤条件配合。背后是候选生成、分数计算、结果归并与行读取共同完成的流程。它把逐条比较全部向量的工作，换成了需要构建、存储和维护的搜索结构。

- **召回率与搜索开销。** 少访问一些簇或节点，可以节省计算和 I/O，也可能漏掉真实近邻。K、搜索预算和候选重排数量需要分别选择。
- **索引体积与数值误差。** 量化减少存储和读取，却可能改变距离与排序；保留更高精度或读取原向量重排，则要承担更多资源消耗。
- **候选筛选与完整查询成本。** 分类过滤、候选归并和回表都会影响延迟。索引内部的搜索速度，只覆盖查询成本的一部分。
- **数据新鲜度与维护成本。** 追加、更新和删除需要协调索引覆盖、值版本与可见性。更及时的结果，通常意味着更频繁的索引构建，或更多补充读取。

下一篇用 SQL 对比词项匹配与短语查询，再解释全文索引的分词、倒排列表、相关性评分和维护成本。 [下一篇：全文索引：从词项匹配到相关性排序](/2026/11/19/paimon-full-text-index/)
