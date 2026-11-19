---
title: Paimon（十一）持续更新下的索引维护：覆盖、刷新与可见性
date: "2026-11-19T18:08:00+08:00"
slug: paimon-index-maintenance
summary: 用 SQL 对比追加、更新和删除后的查询结果，区分索引覆盖、值的新鲜度与逻辑删除，再讨论持续写入时怎样安排索引维护，以及新鲜度、查询延迟和维护成本之间的取舍。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [表的设计](/2026/11/09/paimon-table-design/) · [上一篇：混合检索：候选召回与结果融合](/2026/11/19/paimon-hybrid-search/)

前面几篇在数据写好、索引建好之后做检索。真实的表还会继续变化：新文档进入，已有内容被修正，一些记录被删除。索引维护要解决的，就是这些变化怎样进入检索结果。

先从三个操作看起。它们会分别引出三个问题：**新增行是否被索引覆盖，已有行的索引值是否仍然最新，删除行是否还会成为有效结果。**

## 准备一张会继续变化的表

本文采用 Paimon 2.1 文档中的 **Spark SQL**，假设已经配置 Paimon Catalog、SQL 扩展及全文、向量索引依赖。范围沿用前几篇的 **Data Evolution Append 表**。主键表的更新与索引机制需要单独讨论，不能直接套用这里的行为。

创建独立的样例表，先写入两条记录。`id` 是普通业务列；本例让它保持唯一，方便选择待修改的行，它并不是主键，也不是 Paimon 内部的 RowID。

```sql
USE paimon.default;

CREATE TABLE evolving_docs (
    id BIGINT,
    content STRING,
    embedding ARRAY<FLOAT>
        COMMENT '__VECTOR_FIELD;3'
) TBLPROPERTIES (
    'row-tracking.enabled' = 'true',
    'data-evolution.enabled' = 'true',
    'deletion-vectors.enabled' = 'true',
    'vector.file.format' = 'vortex',
    'ivf-flat.distance.metric' = 'cosine',
    'ivf-flat.nlist' = '1',
    'vector-index.search-mode' = 'fast',
    'full-text-index.search-mode' = 'fast',
    'full-text.tokenizer' = 'whitespace',
    'full-text.stem' = 'false',
    'full-text.remove-stop-words' = 'false'
);

INSERT INTO evolving_docs VALUES
    (1, 'lake guide', array(0.0f, 1.0f, 0.0f)),
    (2, 'paimon guide', array(0.8f, 0.6f, 0.0f));

CALL sys.create_global_index(
    table => 'default.evolving_docs',
    index_column => 'embedding',
    index_type => 'ivf-flat'
);

CALL sys.create_global_index(
    table => 'default.evolving_docs',
    index_column => 'content',
    index_type => 'full-text'
);
```

每个步骤都等待前一个语句完成，实验期间没有其他写入或索引构建任务。向量是手工构造的单位向量，用来核对结果，不表示真实文本的模型输出；一个簇的 IVF-FLAT 也只是为了让这个微型例子容易检查。[向量索引的构建和查询接口](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/vector/)见官方文档。

下面的结果是根据样例数据推导的**预期结果**，不是一次集群运行的日志。比较向量相似度时，查询向量固定为 `[1, 0, 0]`，余弦相似度恰好等于各行向量的第一个分量。

## 追加之后：表里有了，检索为什么还找不到

在已经建立索引的表中，再追加一行。暂时不运行索引构建。

```sql
INSERT INTO evolving_docs VALUES
    (3, 'paimon realtime', array(1.0f, 0.0f, 0.0f));

SELECT id, content FROM evolving_docs ORDER BY id;
```

| id | content |
| --- | --- |
| 1 | lake guide |
| 2 | paimon guide |
| 3 | paimon realtime |

普通扫描已经能够读取新提交的数据。现在执行向量 Top-1：

```sql
SELECT id, round(__paimon_search_score, 3) AS score
FROM vector_search(
    'evolving_docs', 'embedding',
    array(1.0f, 0.0f, 0.0f), 1
)
ORDER BY __paimon_search_score DESC, id;
```

| id | score |
| --- | --- |
| 2 | 0.800 |

刚写入的第三行与查询向量完全相同，但这里显式设置了 `fast`：检索只在已有索引覆盖的范围内进行。第三行尚未进入索引，因此没有参加这一次候选选择。

把向量检索切换为能够检查覆盖缺口的模式，再执行上面的同一条查询。

```sql
ALTER TABLE evolving_docs SET TBLPROPERTIES (
    'vector-index.search-mode' = 'full'
);
```

| id | score |
| --- | --- |
| 3 | 1.000 |

在这里，查询发现新行没有被索引覆盖，于是读取缺口中的原始向量计算距离，并与索引结果一起选择 Top-K。这个过程增加查询工作量；它没有替后台建立一份可供后续查询复用的持久索引。

另一个选择，是把新增范围补进索引。

```sql
CALL sys.create_global_index(
    table => 'default.evolving_docs',
    index_column => 'embedding',
    index_type => 'ivf-flat'
);

CALL sys.create_global_index(
    table => 'default.evolving_docs',
    index_column => 'content',
    index_type => 'full-text'
);

ALTER TABLE evolving_docs SET TBLPROPERTIES (
    'vector-index.search-mode' = 'fast'
);
```

补建完成后，同一条向量查询在 `fast` 下也应返回第三行，分数为 `1.000`。全文索引也需要补建自己的覆盖范围，建立向量索引不会顺便更新全文索引。[全局索引管理文档](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/manage-indexes/)说明了构建与数据写入分离，以及不同检索模式的覆盖行为。

<figure>
  <a href="/assets/images/paimon-index-maintenance/append-coverage.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-index-maintenance/append-coverage.webp" alt="追加数据已经进入表，但已有索引只覆盖原有行；查询补查和后台补建分别承担开销" width="1254" height="1254" loading="lazy" decoding="async" /></a>
  <figcaption>数据提交、查询时补查、后台补建是不同的工作。示意图由 AI 生成。</figcaption>
</figure>

“补查”还取决于索引类型。向量可以对缺口计算原始距离；全文检索需要保留分词与评分语义，缺口处理涉及为这些文本临时建立全文检索结构，不能简单换成 `LIKE`。具体接口的支持范围要按所用版本确认。[全文索引文档](https://paimon.apache.org/docs/2.1/multimodal-table/global-index/full-text/)介绍了相应的检索语义。

覆盖缺口被补上，也不代表任意 ANN 查询都变成了精确搜索。已有索引范围中的近似召回取舍，仍然存在。

## 更新之后：同一个 RowID，不代表同一份索引内容

接着把第三行改成归档文档，同时替换它的向量。默认策略会拒绝更新已经建立全局索引的列。本例显式选择 `DROP_PARTITION_INDEX`：更新时撤下受影响分区的索引，随后重建。

```sql
ALTER TABLE evolving_docs SET TBLPROPERTIES (
    'global-index.column-update-action' = 'DROP_PARTITION_INDEX'
);

UPDATE evolving_docs
SET content = 'archive guide',
    embedding = array(0.6f, 0.8f, 0.0f)
WHERE id = 3;

SELECT id, content FROM evolving_docs ORDER BY id;
```

| id | content |
| --- | --- |
| 1 | lake guide |
| 2 | paimon guide |
| 3 | archive guide |

这是无分区表，受影响的范围就是这张表的相应索引。策略按分区撤下索引，维护成本可能大于这次修改的一行；不能把它理解成只删除一个词项或一个向量。

此时数据更新已经可见，但索引重建尚未完成。接下来重新运行上一节的两条 `create_global_index`，为当前数据构建两种索引。**在这个空窗期，不应把 `fast` 检索当作覆盖全表的结果。**

重建完成后，全文检索查询词 `paimon`：

```sql
SELECT id, content
FROM full_text_search(
    'evolving_docs', 'content',
    '{"match":{"query":"paimon"}}', 10
)
ORDER BY id;
```

| id | content |
| --- | --- |
| 2 | paimon guide |

第三行已经不含 `paimon`。再执行前面的向量 Top-1，也应返回第二行，分数为 `0.800`；第三行的新分数为 `0.600`，不再排第一。

为什么不能只检查覆盖范围？Data Evolution 更新值时可以保持 RowID 不变。假如第三行的旧索引被保留，它依然“覆盖这一个 RowID”，却可能保存着旧词项或旧向量。范围检查能发现少了一段行号，无法发现同一行号对应的内容已经变了。

<figure>
  <a href="/assets/images/paimon-index-maintenance/value-freshness.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-index-maintenance/value-freshness.webp" alt="同一 RowID 的文本从 paimon guide 更新为 archive guide，覆盖范围不变但词项索引需要刷新" width="1254" height="1254" loading="lazy" decoding="async" /></a>
  <figcaption>图中右侧表示更新后索引应有的内容。RowID 对齐解决定位问题，索引刷新解决值的新鲜度问题。示意图由 AI 生成。</figcaption>
</figure>

更新策略体现了三种选择：

- **拒绝更新**：保住已有索引与列值之间的关系，代价是限制写入。
- **撤下后重建**：允许更新，避免继续依赖旧值，代价是重建工作和索引覆盖的空窗期。本例采用这一种。
- **保留旧索引后刷新**：允许维护异步追赶，但应用需要承担过期候选与排序偏差，直到刷新完成。

最后一种不能靠切换 `full` 或 `detail` 自动修复。增量构建能否识别已覆盖行的变化，还取决于构建端与索引中的来源元数据；不能把“再调用一次构建”当作通用的值刷新保证。需要替换的范围应有明确的刷新或撤下重建流程。

## 删除之后：失效不等于立刻从文件中抹去

在两种索引都重建完成后，删除第二行。这一步之后先不重建索引。

```sql
DELETE FROM evolving_docs WHERE id = 2;

SELECT id, content FROM evolving_docs ORDER BY id;
```

| id | content |
| --- | --- |
| 1 | lake guide |
| 3 | archive guide |

再次执行前面的检索，预期变化如下。

| 查询 | 删除前 | 删除后 |
| --- | --- | --- |
| 全文查询 `paimon` | 第二行 | 空结果 |
| 向量 Top-1 | 第二行，0.800 | 第三行，0.600 |

删除标记参与当前快照中的行有效性判断，检索不能继续把已删除行当作有效结果。它不要求每删一行，就立即重写所有索引文件。Paimon 的[向量检索测试](https://github.com/apache/paimon/blob/5a82d2a6c/paimon-core/src/test/java/org/apache/paimon/table/source/VectorSearchBuilderTest.java)和[全文检索测试](https://github.com/apache/paimon/blob/5a82d2a6c/paimon-core/src/test/java/org/apache/paimon/table/source/FullTextSearchBuilderTest.java)也分别覆盖了建立索引后再删除行的场景。

这里启用的 Deletion Vector 记录逻辑删除。被删除位置仍可能存在于数据文件和索引结构中，读者根据快照中的删除信息排除它。旧内容什么时候真正回收，则属于后续维护和历史版本清理的职责。Data Evolution 的[删除与维护说明](https://paimon.apache.org/docs/2.1/multimodal-table/data-evolution/)介绍了这一层区别。

<figure>
  <a href="/assets/images/paimon-index-maintenance/delete-visibility.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-index-maintenance/delete-visibility.webp" alt="当前快照的删除标记排除失效候选，旧数据和索引文件由后续维护与历史清理回收" width="1254" height="1254" loading="lazy" decoding="async" /></a>
  <figcaption>逻辑有效性与物理回收分开。图中的筛选表达职责，不表示具体执行算子的先后顺序。示意图由 AI 生成。</figcaption>
</figure>

对普通更新和删除来说，稳定 RowID 有助于保留行之间的对应关系。若某种维护会重新分配 RowID，就必须同时处理依赖旧 RowID 的索引或外部引用；不能把它当作普通文件合并处理。

## 持续更新时，怎样判断检索已经追上

把上述操作放进持续运行的任务，至少需要区分三个进度：数据提交到了哪里，索引覆盖到了哪里，索引值刷新到了哪个数据版本。第三个进度不能由覆盖率替代。

可以通过系统表观察持久索引的覆盖范围。

```sql
SELECT index_type, index_field_name,
    row_range_start, row_range_end
FROM `evolving_docs$table_indexes`
WHERE index_field_name IS NOT NULL
ORDER BY index_field_name, row_range_start;
```

这里没有列出固定的行号和文件数，因为它们依赖实际写入与构建的文件划分。这个查询回答“哪些列、哪些 RowID 范围已有索引”；它不能单独证明这些行的索引值已经反映最新修改。

对于业务上的“可以检索了”，更有用的约定是：某批数据提交完成后，相关索引的覆盖和必要刷新也完成，应用再把这批数据标记为检索就绪。这个标记需要由写入与维护流程协调。已经提交的数据仍可能被普通读者看到，应用层等待不会把它变成一个尚未提交的快照。

混合检索尤其需要明确这个约定。如果全文索引已经追上，向量索引还停在旧数据，两路候选所依据的信息就不同。RRF 或加权融合能组合已有证据，却无法恢复某一路根本没有召回的最新记录。检查两路各自的覆盖与刷新进度，是融合之前的工作。

内容版本也不是唯一的版本。分词规则改变，需要让旧文本按新规则重新建立索引；向量模型改变，需要重新生成相应的向量，再建立匹配的索引。仅仅把旧向量重新索引，不能让它获得新模型的表示含义。是否就绪，应当包含使用了哪套分词或模型规则。

## 总结

Paimon 把数据演进、索引构建和物理清理拆开，使它们可以按不同节奏运行。它的价值是让持续写入不必总是等待重型索引工作；代价是应用需要明确自己接受怎样的检索新鲜度。

- **新增行**带来覆盖缺口。查询时补查可以更早纳入这些行，但增加查询开销；后台补建把工作移出查询路径，但需要维护资源，并留下追赶时间。
- **已有行更新**带来值的新鲜度问题。拒绝修改、撤下重建、保留后刷新，各自在写入自由度、检索可用性与过期风险之间取舍。覆盖完整并不能替代刷新。
- **删除行**先解决当前查询中的有效性，后解决旧文件的回收。这样减少了同步重写，但删除标记、历史保留和后续维护也需要成本。
- **混合检索与规则升级**需要协调多份进度。维护间隔越短，结果通常越新，构建和调度成本也越高；间隔越长，系统越需要明确的补查策略或检索就绪约定。

持续更新下，索引的作用是让最新数据能够以可控成本进入检索。衡量它时，除了查询有多快，还要说明结果覆盖了哪批数据、依据哪一版内容，以及为追上这些变化付出了多少维护工作。
