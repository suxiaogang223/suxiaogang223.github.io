---
title: Paimon（五）BLOB：大对象文件的设计
date: 2026-11-19
slug: paimon-blob
summary: 先用 SQL 写入和读取二进制内容，再解释 BLOB 条目、长度索引和文件尾怎样配合，以及批量存储、随机读取与空间回收之间的取舍。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [上一篇：行标识与 Data Evolution](/2026/11/18/paimon-data-evolution/) · [下一篇：VARIANT：灵活结构与列式读取](/2026/11/19/paimon-variant/)

图片、音频、视频和文档，通常可以表示为长度不一的字节序列。先看怎样把一段字节写进 Paimon，再讨论它为什么适合单独组织成 BLOB 文件。

## 先把两段字节写进表

下面使用 **Spark SQL**，假设已配置 Paimon Catalog 并选中 `paimon.default`。示例采用启用 Data Evolution 的 Append 表，内容由 Paimon 管理。

```sql
USE paimon.default;

CREATE TABLE blob_samples (
    id BIGINT,
    name STRING,
    content BINARY COMMENT '__BLOB_FIELD'
) TBLPROPERTIES (
    'row-tracking.enabled' = 'true',
    'data-evolution.enabled' = 'true'
);

INSERT INTO blob_samples VALUES
    (1, 'sample-a', X'010203'),
    (2, 'sample-b', X'0405');
```

`X'010203'` 表示三个字节。这里用短内容展示读写，不代表真实图片或文档。实际写入可以由数据处理任务提供完整内容，文件格式负责保存这些字节，不会自动识别它们的媒体含义。

`BINARY` 是 Spark SQL 使用的二进制类型；`__BLOB_FIELD` 是 Paimon 的声明标记，将这一列转换为 BLOB，并采用托管内容文件。行跟踪和 Data Evolution 负责维持普通列与内容数据的对应关系。`id` 是普通列，重复插入同一个值仍会追加新行。 [BLOB 建表与写入](https://paimon.apache.org/docs/2.1/multimodal-table/blob/#creating-a-table)

## 读取内容，与只读普通列有什么区别

写入完成后，可以把内容转成十六进制文本，方便观察返回的字节。

```sql
SELECT id, hex(content) AS content_hex
FROM blob_samples
ORDER BY id;
```

| id | content_hex |
| --- | --- |
| 1 | 010203 |
| 2 | 0405 |

`hex` 只是为了显示结果；读取 `content` 时返回的是字节内容，应用可以再按图片、音频等格式处理它。

如果只查看名称，可以不请求内容列。

```sql
SELECT id, name
FROM blob_samples
ORDER BY id;
```

| id | name |
| --- | --- |
| 1 | sample-a |
| 2 | sample-b |

这条查询只需要普通列，可以跳过 BLOB 内容。这里也能看到两层不同的工作：表的读路径找到目标记录，内容文件的读路径再定位所需字节。 [BLOB 查询](https://paimon.apache.org/docs/2.1/multimodal-table/blob/#querying-blob-data)

Paimon 的 BLOB 格式把多条变长内容写入同一个文件，再用索引描述各条内容的边界，让批量存储和按位置读取可以配合起来。下面聚焦常规 `.blob` 文件的布局，解释刚才的读取怎样找到内容，以及这种组织方式的成本。 [BLOB 文件格式](https://paimon.apache.org/docs/2.1/concepts/spec/fileformat/#blob)

## 为什么把大对象单独组织成文件

BLOB 是表中表达大块二进制内容的逻辑类型，BLOB 文件则是承载这些内容的物理格式。采用分离存储时，普通列使用常规数据文件，大对象使用专门的内容文件，表的元数据再把两部分关联起来。 [BLOB 存储布局](https://paimon.apache.org/docs/2.1/multimodal-table/blob/#storage-layout)

这种组织方式有几个目的。

- **让两类数据采用合适的文件布局。** 普通字段适合列式扫描、编码和统计，大对象更关注连续传输、内容定位和独立访问。
- **减少不需要的内容读取。** 只请求普通列时，可以跳过大对象内容；请求 BLOB 时，再访问相应的内容文件。
- **在文件数量和访问粒度之间取得平衡。** 多个对象可以打包进一个文件，用文件内索引定位各自的内容，避免每个对象都需要独立的存储文件。

普通二进制列同样能够保存字节，列式格式本身也能裁剪未请求的列。专门的 BLOB 布局进一步提供了内容文件的独立组织方式，便于分别考虑文件大小、内容读取与复用的成本。是否值得采用，要结合对象大小和访问方式判断。

## 文件由数据区、长度索引和尾部组成

一个常规 BLOB 文件承载同一个逻辑字段的多条值，整体可以看成三部分。

| 部分 | 保存什么 | 作用 |
| --- | --- | --- |
| 数据区 | 按顺序写入的多个 Entry | 承载实际二进制内容与记录信息 |
| 长度索引 | 各条目的长度信息 | 还原条目边界，定位目标内容 |
| 文件尾 | 索引长度和格式版本 | 从文件末尾找到索引，并解释文件结构 |

<figure>
  <a href="/assets/images/paimon-blob/file-layout.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-blob/file-layout.webp" width="1254" height="1254" alt="BLOB 文件结构的手绘图，数据区包含多个变长 Entry，之后是长度索引和保存索引长度与版本的文件尾，单个 Entry 包含标识、二进制内容、长度和 CRC32" loading="lazy" decoding="async" /></a>
  <figcaption>数据区顺序承载内容，索引记录边界，文件尾提供索引的入口。示意图由 AI 生成。</figcaption>
</figure>

对于普通的非空标量 BLOB，一个 Entry 包含记录标识、变长的内容、长度以及 CRC32 校验信息。内容长度不固定，不能只靠“第几个条目”乘一个固定大小来确定位置，因此文件还需要记录各条目的长度。

写入时可以先顺序输出一条内容，再写入它的长度和校验信息。写入者同时收集各条目的长度，完成内容写入后，把紧凑编码的长度索引和尾部信息追加到文件末尾。这让内容的写入顺序与索引的生成顺序保持一致，无需为每条新内容反复修改文件前面的索引。 [BLOB 结构说明](https://paimon.apache.org/docs/2.1/concepts/spec/fileformat/#blob)

长度信息和校验信息承担不同的职责。长度描述记录占用的范围；CRC32 为内容完整性检查提供依据。能确定一段字节在哪里，并不能同时说明它的内容是否完整。

## 怎样定位并读取一个 BLOB

读取目标条目时，可以沿着下面的顺序理解。

1. **读文件尾。** 取得格式版本和索引长度，确定索引在文件中的位置。
2. **加载长度索引。** 还原条目的长度序列，结合条目顺序得到各自的起始位置与字节范围。
3. **访问目标内容。** 定位到需要的 Entry，再读取相应的内容字节。

<figure>
  <a href="/assets/images/paimon-blob/positional-read.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-blob/positional-read.webp" width="1254" height="1254" alt="读取一个 BLOB 的手绘流程，先读文件尾，再加载长度索引，最后定位并读取目标 Entry，无需扫描前面的大对象内容" loading="lazy" decoding="async" /></a>
  <figcaption>随机访问依赖长度索引；定位后可以直接访问目标范围。示意图由 AI 生成。</figcaption>
</figure>

这样，访问靠后的条目时，可以跳过前面的大对象内容。代价是仍要读取和解释索引，并建立条目到字节位置的映射。对象数量很多时，索引本身也需要内存和加载时间，不能只比较最终返回了多少内容。

定位到内容之后，读取完整值、流式消费和按范围读取会有不同的资源需求。完整值需要承受其内存和传输开销；流式处理可以逐步消费字节。底层存储的请求粒度、缓存和批量读取策略也会影响实际 I/O。 [BLOB 的读取方式](https://paimon.apache.org/docs/2.1/pypaimon/blob/)

此外，定位一个 BLOB 的字节范围，与在内容内部定位某段语义是两件事。读取图片中的区域、视频中的某帧，还需要对应编码格式和解码过程的支持。文件层提供内容访问的基础，无法仅凭长度索引完成这些内容处理。

## 文件内索引解决的是位置问题

这里的索引回答的是“某个条目的字节在哪里”。它不根据内容含义寻找对象，也不会因为内容包含某个词或某种图像就自动命中。

表级读取先确定需要访问哪些文件和记录，BLOB 格式再负责定位文件内的相应内容。可以利用时间、类别等普通字段及相关索引缩小候选范围；需要基于文本或图像语义检索时，则要使用相应的全文、向量或其他检索结构。 [BLOB 读取与过滤](https://paimon.apache.org/docs/2.1/multimodal-table/blob/#limitations)

文件内位置还可以进一步表达为文件地址、偏移和长度，形成供后续读取使用的 Descriptor。只传递这样的描述信息，可以把内容加载推迟到真正消费时，但引用的文件及其字节范围必须继续可读。内容位置与内容生命周期需要一起管理。 [BLOB 内容引用](https://paimon.apache.org/docs/2.1/multimodal-table/blob-references/)

## 打包与随机访问，各自付出什么成本

把多个对象放在一个文件里，可以减少文件管理开销，让写入更多地采用连续输出；长度索引又保留了按条目访问的能力。文件大小需要在几种成本之间权衡。

- **文件过碎。** 文件数量增加，打开文件、发起请求和维护元数据的开销也会增加。
- **单文件条目过多。** 长度索引需要描述更多位置，读取与处理索引也有成本。零散访问时，打包并不会自动把所有内容访问合成一次存储请求。
- **内容发生更新或删除。** 新版本可以由新的内容文件承载，但旧文件可能仍由其他记录或历史快照引用。回收内部失效内容，通常需要结合文件整理和引用关系处理。

因此，一个逻辑值被删除，与它占用的物理空间可以立即释放，并不是同一步操作。尤其当文件中仍有其他有效内容时，存储回收需要由表层的版本和维护机制协调。BLOB 格式提供记录与索引的组织方式，快照、可见性和文件清理由表的其他部分管理。 [文件与快照生命周期](https://paimon.apache.org/docs/2.1/concepts/basic-concepts/)

同样的边界描述思路也适用于集合。`ARRAY<BLOB>` 需要记录元素顺序和长度，包含 BLOB 值的 `MAP` 还需要保存键与值的对应关系。外层索引定位一条记录，记录内部的结构再描述其中的元素边界。空值、空集合与空内容也需要分别表达，才能在读取时恢复原来的逻辑值。 [BLOB 集合编码](https://paimon.apache.org/docs/2.1/concepts/spec/fileformat/#blob)

## 总结

BLOB 格式用顺序排列的内容和长度索引，把批量存储与按条目访问结合起来。它既能减少一对象一文件带来的管理开销，又能在需要时定位单份内容；与普通列分开组织后，还可以按需加载和复用大对象。

这种设计提供的是内容的存储与定位能力。索引加载、零散读取和文件整理仍有成本，内容检索、版本可见性和空间回收还需要其他层次配合。它的作用是在较少的文件中保留可定位的内容边界，让大对象能够更有效地参与表的读写流程。
