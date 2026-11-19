---
title: Paimon（七）VECTOR：向量表示与存储
date: "2026-11-19T09:07:00+08:00"
slug: paimon-vector
summary: 从建表、写入和查询向量的 SQL 出发，解释 VECTOR 的定长约束、距离度量和独立存储，以及维度、精度与读写成本之间的取舍。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [表的设计](/2026/11/09/paimon-table-design/) · [上一篇：VARIANT：灵活结构与列式读取](/2026/11/19/paimon-variant/) · [下一篇：向量索引：从 Top-K 查询到候选筛选](/2026/11/19/paimon-vector-index/)

一条向量怎样写进 Paimon 表，查出来又是什么样子？先看一组建表、写入和查询的 SQL，再从这些操作解释 VECTOR 的表示与存储。

## 先建一张带向量列的表

下面采用 Paimon 2.1 文档中的 **Spark SQL** 写法，假设已配置名为 `paimon` 的 Paimon Catalog。环境配置见 [Spark SQL 快速开始](https://paimon.apache.org/docs/2.1/spark/quick-start/)。为了能完整展示每个值，示例只使用三维向量；实际维度由模型的输出决定。

```sql
USE paimon.default;

CREATE TABLE vector_samples (
    id BIGINT,
    label STRING,
    embedding ARRAY<FLOAT>
        COMMENT '__VECTOR_FIELD;3'
) TBLPROPERTIES (
    'row-tracking.enabled' = 'true',
    'data-evolution.enabled' = 'true',
    'vector.file.format' = 'vortex'
);
```

`id` 和 `label` 是普通列。`embedding` 在 Spark SQL 中使用数组语法，但 `__VECTOR_FIELD;3` 是 Paimon 识别的声明标记：它把这一列转换为逻辑类型 `VECTOR<FLOAT, 3>`，也就是由三个浮点数组成的定长向量。这里的 `COMMENT` 因而参与了类型声明。 [VECTOR 的 SQL 建表方式](https://paimon.apache.org/docs/2.1/multimodal-table/vector/#create-table)

三个表属性让这个例子同时使用专用向量存储。

- **`row-tracking.enabled`** 开启行跟踪，为不同列文件中的数据建立行对应关系。内部 Row ID 与这里的用户列 `id` 有各自的职责。
- **`data-evolution.enabled`** 使用 Data Evolution 布局，让不同列的数据能够分别组织和演进。
- **`vector.file.format`** 指定专用向量文件的格式；这里使用 `vortex`，把向量与普通列分开存储。

因此，这段 SQL 同时表达了两个选择：向量列采用什么类型，以及它在文件中怎样存放。后面分别展开这两个层次。 [专用向量存储的配置](https://paimon.apache.org/docs/2.1/multimodal-table/vector/#dedicated-vector-file-storage)

## 写入两条向量，再读出来

```sql
INSERT INTO vector_samples VALUES
    (1, 'sample-a', array(
        CAST(0.2 AS FLOAT),
        CAST(-0.1 AS FLOAT),
        CAST(0.7 AS FLOAT)
    )),
    (2, 'sample-b', array(
        CAST(0.1 AS FLOAT),
        CAST(0.0 AS FLOAT),
        CAST(0.8 AS FLOAT)
    ));

SELECT id, label, embedding
FROM vector_samples
ORDER BY id;
```

查询结果可以理解为下面两行，浮点数的显示形式可能因客户端而异。

| id | label | embedding |
| --- | --- | --- |
| 1 | sample-a | [0.2, -0.1, 0.7] |
| 2 | sample-b | [0.1, 0.0, 0.8] |

这组数值只用于演示读写。实际应用通常先用模型生成向量，再把生成结果写入表；上面的 `INSERT` 负责保存传入的数值，不会自动为内容调用模型。查询时，普通列和向量列仍属于同一条逻辑记录，即使底层采用了不同文件。

到这里可以看到，VECTOR 让表的一列保存一整组定长数值。接下来需要解释：这组数值如何用于比较，为什么要约束长度，以及独立文件怎样影响读取。

## 向量表示怎样把内容变成可计算的数据

文本、图像和音频可以通过模型转换为一组数值。后续任务比较这些数值的方向、距离或内积，用来衡量内容之间的关系。存储层需要保存的，既包括这些数值，也包括理解它们所需的维度、元素类型和相关约定。

一个 `d` 维向量可以写成 `[x1, x2, …, xd]`。在 Embedding 场景中，这些数值由编码模型产生，训练目标影响哪些关系能够在这个表示空间中被比较。单独一个维度通常不对应可以直接命名的业务属性，比较也往往需要利用整组数值。

这套表示把复杂内容的比较，转化为数值计算。查询内容与被检索内容需要进入兼容的表示空间，比较结果才有预期含义。 [向量空间与语义检索](https://sbert.net/examples/sentence_transformer/applications/semantic-search/README.html)

<figure>
  <a href="/assets/images/paimon-vector/vector-representation.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-vector/vector-representation.webp" width="1254" height="1254" alt="内容经过编码模型形成固定维度的数值向量，下方用方向和长度的几何示意说明数值比较，表示空间与度量规则需要匹配" loading="lazy" decoding="async" /></a>
  <figcaption>数值与几何图形用于说明表示方式，不代表真实模型输出或高维空间的完整结构。示意图由 AI 生成。</figcaption>
</figure>

维度相同，只能说明两条向量具有相同数量的元素。它们是否可比，还取决于编码方案、模型版本、输入预处理和归一化约定。查询端与数据端可以使用为同一空间配套训练的不同编码路径，但不能仅凭长度一致就混合任意来源的向量。

表示与原始内容之间的对应关系也需要保留。模型升级或处理规则变化时，即使输出维度没变，坐标的含义仍可能变化。记录生成方式，并在切换表示时协调旧数据的重算与使用范围，才能继续解释比较结果。

## 固定维度和元素类型，为什么值得成为类型约束

建表时的 `__VECTOR_FIELD;3` 把维度固定为 3，`ARRAY<FLOAT>` 则提供元素类型。Paimon 的逻辑类型 `VECTOR<t, d>` 把这两项约束放在一起：同一列中的每个非空值都应包含约定数量、相应类型的数值。第二条记录中的 `0.0` 也占据一个维度；稠密表示在逻辑上为每个维度保留位置。

这种约束有两个作用。首先，维度不匹配能够在数据进入计算前被识别；其次，存储与计算可以围绕固定形状组织批次，减少对每条记录长度的反复判断。与变长数组相比，定长表示还为省去逐行的变长边界信息提供了条件。 [VECTOR 类型设计](https://paimon.apache.org/docs/2.1/multimodal-table/vector/#vector-data-type)

Paimon 允许向量值本身为空，但非空 VECTOR 的元素不能为空。缺失向量与全零向量也有不同含义：前者表示没有这份数值表示，后者是一条具体的数值向量。随意用零值替代缺失，会改变距离计算；零向量还无法直接参与需要除以向量长度的余弦归一化。 [Paimon 数据类型](https://paimon.apache.org/docs/2.1/concepts/data-types/#multimodal-types)

固定维度提供的是形状约束。数值是否由合适的模型生成、两端使用的处理规则是否兼容，仍需要数据生产与消费流程共同保证。

## 距离度量决定怎样解释这些数值

前面的 `SELECT` 读取了已经保存的数值，还没有比较哪条记录与查询内容更接近。要做这种比较，需要先由兼容的编码方案生成查询向量，再选定度量规则。

同一组向量，采用不同度量，可能得到不同的排序。常见的三种比较方式可以这样理解。

| 度量 | 比较的内容 | 排序方向 |
| --- | --- | --- |
| L2 距离 | 对应维度的差异，汇总为几何距离 | 距离越小越近 |
| 内积 | 对应维度乘积之和，受到方向与向量长度影响 | 内积越大通常排得越前 |
| 余弦相似度 | 非零向量之间的夹角关系，消除长度的直接影响 | 相似度越大越接近 |

对两条都已归一化为单位长度的向量，余弦相似度与内积相同，平方 L2 距离也可以通过 `L2² = 2 − 2 × 内积` 换算。这个关系依赖归一化条件，不能直接套到任意向量上。 [距离与归一化](https://github.com/facebookresearch/faiss/wiki/MetricType-and-distances)

因此，归一化会影响比较含义。是否应保留向量长度、使用哪种度量，要与模型的训练和任务目标匹配。数值被正确存下来之后，仍需要正确的比较约定，才能得到有意义的结果。

## 向量怎样组织进数据文件

一批固定维度的向量，解码后可以看成 `N 行 × d 维` 的数值矩阵。每一行对应一条记录，计算时按批次处理这些数值。固定形状有利于批量运算和数据交换，但磁盘上的编码、压缩与分块仍会影响真实布局，不能把矩阵示意直接当成文件的字节排列。

如果只计算未经压缩的数值负载，其大小是 `N × d × 每个元素的字节数`。例如，一条 768 维的 32 位浮点向量，需要 `768 × 4 = 3072` 字节，也就是 3 KiB；这还没有包含文件元数据、空值信息、其他列和可能存在的索引。维度和记录数增加时，读取带宽与计算量也会随之增长。

文件的无损压缩与表示的精度调整也需要分别考虑。无损编码在还原后保留原数值；降低数值精度或另行量化，则可能改变坐标和比较结果。后者能够节省空间与带宽，但需要评估误差，不能把它当作透明的文件压缩。 [向量量化与精度](https://sbert.net/examples/sentence_transformer/applications/embedding-quantization/README.html)

Paimon 在 Data Evolution 布局中提供专用向量文件，将向量列与普通列分别组织。普通列和专用文件通过行标识及行范围建立对应关系，读取时再组合需要的部分。逻辑上的 VECTOR 类型与是否采用专用文件，是两个需要分别考虑的设计层次。 [专用向量存储](https://paimon.apache.org/docs/2.1/multimodal-table/vector/#dedicated-vector-file-storage)

<figure>
  <a href="/assets/images/paimon-vector/vector-storage.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-vector/vector-storage.webp" width="1254" height="1254" alt="Data Evolution 中的专用向量存储示意，普通列文件与向量文件按行标识对齐，向量解码后可按 N 行乘 d 维的矩阵批量处理，只读取普通列时可以跳过向量" loading="lazy" decoding="async" /></a>
  <figcaption>图示采用专用向量文件，行号和矩阵用于说明逻辑对应关系，不表示实际字节布局。示意图由 AI 生成。</figcaption>
</figure>

回到开头的表，如果只想查看普通列，可以这样查询。

```sql
SELECT id, label
FROM vector_samples
ORDER BY id;
```

结果仍是两条记录，但没有请求 `embedding`。在示例采用的专用文件布局下，读取端可以跳过向量文件；而前面的 `SELECT id, label, embedding` 则需要把普通列与向量数据按内部行标识组合起来。

分开组织后，处理向量时可以集中读取相关数值。重新生成向量列时，其他未变化的列和内容文件有机会继续复用。代价是读取与维护需要协调不同文件的行范围、版本和对应关系。 [列文件的对齐与读取](https://paimon.apache.org/docs/2.1/multimodal-table/data-evolution-file-layout/)

文件大小也需要结合访问方式选择。连续读取大量向量，可以摊薄文件打开和存储请求的成本；只访问少数记录时，分块、解码和请求粒度则会影响读取放大。更新同样按文件及行范围组织，不能仅根据命中了几条记录来估算写入量。

## 保存向量与减少搜索候选，各自解决什么问题

向量类型提供形状与元素约束，文件布局负责持久化、批量读取和数据对齐。相似度索引则进一步决定怎样缩小需要比较的候选范围。Paimon 的向量存储与相似度索引有各自的配置和生命周期，写入向量数据本身并不等于已经构建好搜索结构。 [向量存储与搜索](https://paimon.apache.org/docs/2.1/multimodal-table/vector/)

即使数据组织得适合批量计算，逐一比较 `N` 条 `d` 维向量，主要的距离计算仍然随着 `N × d` 增长。存储布局能够改善这些数值怎样被加载，却不能仅凭固定维度或独立文件就消除候选比较。这也是后续需要继续讨论索引的原因。

## 总结

从 SQL 看，我们创建了一列三维浮点向量，写入两条记录，再选择读取整行或只读取普通列。这些操作背后，VECTOR 用固定形状约束数值，专用文件让普通列与向量分别组织，行跟踪维持它们在表中的对应关系。实际设计需要权衡下面几组收益与成本。

- **表示能力与维度成本。** 维度增加可能保留更多任务所需的信息，同时增加存储、传输和计算量。更多维度是否改善效果，需要结合模型和任务验证。
- **数值精度与资源占用。** 降低数值精度或对表示另行量化，可以减少数据量，但可能引入误差并改变比较结果。节省的资源与结果质量需要一起评估，不能只看文件大小。
- **独立管理与读取协调。** 专用文件有利于按需读取和复用其他列，但需要维护行对齐、列版本和文件范围。连续扫描与零散访问，也会面对不同的读取放大。
- **表示更新与计算一致性。** 新模型可以带来新的表示能力，也可能要求重算已有数据并协调切换。维度、生成方式、预处理和度量约定需要共同管理，才能让存储中的数值始终具有明确含义。

下一篇用 SQL 建立向量索引、查询 Top-K，再解释候选筛选、行读取与索引维护的设计取舍。 [下一篇：向量索引：从 Top-K 查询到候选筛选](/2026/11/19/paimon-vector-index/)
