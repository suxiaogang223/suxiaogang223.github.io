---
title: Paimon（一）表的设计
date: 2026-11-09
slug: paimon-table-design
summary: 先认识 Schema、快照、Manifest 和数据文件的关系，再用订单更新理解表类型、主键表的 LSM 与读写取舍。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [表的查询流程](/2026/11/09/paimon-table-query/) · [表的写入流程](/2026/11/09/paimon-table-write/)

Paimon 把一张逻辑表组织成一组数据文件和元数据文件。数据文件承载记录，元数据描述表的结构、文件的归属，以及每次提交后的表状态。计算引擎通过 Catalog 找到表，再沿着这些元数据读取所需的数据。

理解这套组织关系之后，才能继续讨论更新：一条新记录写到哪里，旧版本如何处理，为什么同一条查询有时需要合并多个文件。本文先看表的整体构成，再用订单的创建和付款展开。 [Paimon 基本概念](https://paimon.apache.org/docs/2.1/concepts/basic-concepts/)

## 一张表由哪些部分构成

可以先把一张 Paimon 表分成四个部分。

- **Schema 描述表的定义。** 包括列名、类型、分区键、主键和表选项。表结构变化后，Schema 也会有新的版本，读取时需要用相应的定义解释文件中的记录。 [Schema](https://paimon.apache.org/docs/2.1/concepts/spec/schema/)
- **Snapshot 描述一次已提交的表状态。** 它引用 Schema 和文件清单等元数据，是读取这次表状态的入口。选择不同的快照，就可能读到不同时间的结果。 [Snapshot](https://paimon.apache.org/docs/2.1/concepts/spec/snapshot/)
- **Manifest List 和 Manifest 组织文件清单。** Manifest List 引用 Manifest；Manifest 记录数据文件的增加和移除，以及分区、桶和文件统计信息。读取时据此确定有效文件，也能提前排除一部分无关数据。 [Manifest](https://paimon.apache.org/docs/2.1/concepts/spec/manifest/)
- **数据文件保存实际记录。** 普通数据文件可以采用 Parquet 等列式格式。如何把记录组织进这些文件、读取时是否需要合并版本，则与表类型和存储布局有关。 [Data Files](https://paimon.apache.org/docs/2.1/concepts/spec/datafile/)

<figure>
  <a href="/assets/images/paimon-table-design/table-composition.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-table-design/table-composition.webp" width="1254" height="1254" alt="Paimon 表整体构成的手绘图，Snapshot 分别引用 Schema 和 Manifest List，Manifest List 引用 Manifest，Manifest 指向按分区和桶组织的数据文件" loading="lazy" decoding="async" /></a>
  <figcaption>常规布局下的主要引用关系。Schema 解释记录，快照和文件清单确定读取范围，数据文件承载记录。示意图由 AI 生成。</figcaption>
</figure>

启用相应功能时，表中还会有索引文件、删除信息或变更日志文件，它们也有各自的元数据引用。例如 DV 用文件内位置描述哪些行已经失效。理解基础结构时，先抓住“表定义、已提交状态、文件清单、实际数据”这四部分，后面再逐步加入这些辅助文件。 [Paimon 存储布局](https://paimon.apache.org/docs/2.1/concepts/spec/)

## 分区和桶怎样组织文件

分区和桶描述的是数据文件怎样分组。分区按日期、地区等字段划分数据，查询带上相应条件时，就有机会跳过其他分区；维护任务也可以只处理某个分区。分区是可选的，具体选择应结合查询和数据管理的需要。

桶在分区内进一步组织文件。固定分桶可以按桶键的哈希分配记录，让数据和读写工作分散到多个桶；其他分桶方式有不同的分配和维护成本。对本文后面使用的常规主键表，同一个桶内的版本需要一起管理。Append 表也有自己的文件布局，因此看到桶目录时，还需要结合表类型理解它的作用。 [数据文件布局](https://paimon.apache.org/docs/2.1/concepts/spec/datafile/) · [主键表数据分布](https://paimon.apache.org/docs/2.1/primary-key-table/data-distribution/)

## 快照怎样把文件组织成表状态

一次提交可以新增数据文件，也可以把旧文件从当前表状态中移除。Paimon 通过新的快照和相关清单发布这些变化。查询从选定快照出发解析有效文件，而存储目录中可能同时存在其他快照使用的文件。 [Paimon Snapshot](https://paimon.apache.org/docs/2.1/concepts/spec/snapshot/)

假设快照 10 引用文件 A 和 B。一次文件整理用 C 替换 A，新发布的快照 11 就引用 B 和 C。B 可以被两个快照共享；A 仍然属于旧快照描述的状态。

<figure>
  <a href="/assets/images/paimon-table-design/snapshot-files.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-table-design/snapshot-files.webp" width="1536" height="1024" alt="两份手绘文件清单，snapshot 10 引用文件 A 和 B，snapshot 11 引用文件 B 和 C，两个快照共享文件 B" loading="lazy" decoding="async" /></a>
  <figcaption>快照 11 用 C 替换 A，B 仍然被两个快照引用。示意图由 AI 生成。</figcaption>
</figure>

这说明快照可以通过引用关系复用已有文件。保留快照 10 及其需要的文件，就还能读取当时的表状态。历史保留得越久，旧文件占用的空间也可能越多；清理历史可以回收不再需要的文件，同时缩短可查询的历史范围。 [Paimon 基本概念](https://paimon.apache.org/docs/2.1/concepts/basic-concepts/)

这些结构说明了表怎样定义和发布数据。接下来再看业务语义：连续写入同一个订单的变化，表应该逐条保留事件，还是返回订单的当前状态？

## 用订单表看 Append 表和主键表的设计目的

假设订单表包含 `dt`、`id`、`status`、`amount`，分别表示创建日、订单 ID、状态和金额。订单 `123` 在 10 月 8 日创建，状态为 `open`；第二天付款，状态变成 `paid`。创建日仍是 `2026-10-08`。

```sql
SELECT id, status, amount
FROM orders
WHERE dt = '2026-10-08'
  AND id = 123
  AND status = 'paid';
```

这条 SQL 希望查询订单当前的付款状态。相同的业务变化，也可以用来分析创建到付款的过程。两种目的，对应不同的表设计。

**Append 表面向不断追加的明细数据。** 访问日志、用户行为、交易流水这类数据，通常希望每次发生的事情都能独立保留，后续按时间、用户或业务维度做统计。订单创建和付款分别写成两条事件，就可以分析从创建到付款花了多久、哪个环节流失最多。Append 表直接保存这些输入，写入和扫描省去了按主键合并版本的工作，适合持续写入和批量分析。重复上报的事件需要在采集或计算链路中去重。如果要从事件明细还原订单当前状态，还需要按业务顺序归并。 [Paimon Append 表](https://paimon.apache.org/docs/2.1/append-table/)

**主键表面向同一业务对象的持续更新。** 数据库 CDC 同步、订单状态维护、用户画像拼接，都需要把后续变化应用到已有对象上。用订单的主键标识同一笔订单，创建时写入 `open`，付款后写入 `paid`，查询就能得到更新后的状态。Paimon 把按键合并交给表的读写链路，应用可以持续写入变更。代价是系统要维护记录顺序，并承担版本合并、compaction 和额外存储的开销。 [Paimon 主键表](https://paimon.apache.org/docs/2.1/primary-key-table/)

主键表可以根据业务需求选择合并规则。 [Merge engines](https://paimon.apache.org/docs/2.1/primary-key-table/merge-engine/)

- **`deduplicate`** 保留最新整行，适合 CDC 同步这类每次带来完整新版本的场景。
- **`partial-update`** 把不同写入更新的字段合并起来，适合多个来源分别更新用户画像的不同字段。
- **`aggregation`** 按字段配置的聚合函数合并贡献，适合按账户累加金额或计数。
- **`first-row`** 保留首次写入的记录，适合按事件 ID 去重并保留首次收到的内容。

这里有三个不同的设计问题：

- **表类型**决定怎样解释输入。订单事件要逐条保留，还是归并成订单当前状态？
- **合并规则**决定同键输入得到什么结果。是替换整行、拼接字段，还是累加贡献？
- **读写模式**决定怎样处理物理版本，以及把成本放在写入侧还是查询侧。MOR、COW 和 MOW 在这一层做取舍。

后面比较三种模式时，都使用同一个 `deduplicate` 例子。只要查询包含同一批已提交变更，都应得到 `paid`；变化的是为得到这个结果需要做多少工作。 [Paimon Table Mode](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/)

## 订单的更新怎样落到同一个桶

这张表用创建日 `dt` 分区，按 `id` 的哈希分成两个固定桶。查询带 `dt` 可以跳过其他日期。同一笔订单的后续版本保留创建日，会继续写到同一个分区和桶，后面介绍的 LSM tree 就在这个范围内维护版本。这个例子里，分区、主键和桶分别承担下面的职责。 [分桶与数据布局](https://paimon.apache.org/docs/2.1/primary-key-table/data-distribution/)

<figure>
  <a href="/assets/images/paimon-table-design/partition-buckets.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-table-design/partition-buckets.webp" width="1536" height="1024" alt="手绘示意图，orders 表下面有两个日期分区，每个日期分区下面各有 bucket-0 和 bucket-1" loading="lazy" decoding="async" /></a>
  <figcaption>每个日期分区里的两个桶分别维护自己的文件。示意图由 AI 生成。</figcaption>
</figure>

- **分区键 `dt`** 按订单创建日组织数据，便于按日期裁剪和维护。
- **主键 `(dt, id)`** 标识一个分区里的订单，让后续版本能和已有记录对应。
- **桶键 `id`** 在每个日期分区里把订单分配到两个固定桶，分摊读写和合并工作。

这里的主键是 `(dt, id)`。如果付款事件误把 `dt` 填成 10 月 9 日，它就成了另一个 key，两个分区里会各有一个 `123`。如果业务确实要把同一个 `id` 从旧分区移到新分区，更新时就要定位并处理旧分区里的记录。通过索引追踪位置可以降低查找范围，但要承担索引的维护和恢复成本。 [分区字段选择](https://paimon.apache.org/docs/2.1/primary-key-table/data-distribution/#pick-partition-fields) · [跨分区 Upsert](https://paimon.apache.org/docs/2.1/primary-key-table/data-distribution/#cross-partitions-upsert)

桶数也决定每个 LSM tree 要处理多少数据。桶太少，数据可能集中在少量桶里。每个分区数据本来就少时，桶太多又容易产生小文件。固定分桶的路由容易计算，但数据量和分布变化后可能需要调整布局。动态分桶可以逐步分配新桶，代价是要维护 key 到桶的映射。 [主键表分桶](https://paimon.apache.org/docs/2.1/primary-key-table/data-distribution/) · [Append 表布局](https://paimon.apache.org/docs/2.1/append-table/#choose-a-layout)

## 一个桶里的 LSM tree

Paimon 主键表把更新先写成新记录。假设 `open` 已经在文件 A 里，付款后可以把 `paid` 送到写缓冲，排序后刷出文件 B。写入时可以把一批有序记录一起落盘，旧版本由后续的读取或 compaction 处理。常规主键表的 LSM tree 以 `(partition, bucket)` 为范围，每个桶维护自己的文件层级。 [Paimon LSM Tree](https://paimon.apache.org/docs/2.1/primary-key-table/#lsm-trees)

**L0 接收刚刷出的文件。** 每个文件内部按主键有序，单独算一个 sorted run。Run 表示一组整体有序的记录，可以由一个文件或多个主键范围不重叠的文件组成。两个 L0 文件的主键范围可以重叠，因此两个文件里都可能有 `123`。**L1 及更高层中，每个非空层各有一个 run**，同层内的文件按主键范围排列，区间不重叠。比如某层两个文件的范围分别是 `[100, 159]` 和 `[160, 220]`，查 `123` 时，这层只需检查第一个文件。不同层之间仍然可以有相同的 key。层级组织的是文件及其顺序关系，文件仍保存在表的存储中。 [Sorted Runs](https://paimon.apache.org/docs/2.1/primary-key-table/#sorted-runs)

<figure>
  <a href="/assets/images/paimon-table-design/lsm-levels.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-table-design/lsm-levels.webp" width="1536" height="1024" alt="一个桶内的手绘 LSM 示意图，两个 L0 文件都含有主键 123，归并后形成主键范围互不重叠的高层文件" loading="lazy" decoding="async" /></a>
  <figcaption>L0 的两个文件可以包含同一个 key。图中示意一次输出到 L1 的 compaction。示意图由 AI 生成。</figcaption>
</figure>

**Compaction 选出一批 runs 做有序归并。** 如果 A 和 B 都被选中，归并读到同一个主键时会应用 merge engine。对这张订单表，输出里只留下 `paid`。选择哪些 runs、输出到哪一层，跟文件大小和 run 数量有关。输出可以跨层，full compaction 会把选中桶的 runs 合到最高层。 [Paimon Compaction](https://paimon.apache.org/docs/2.1/primary-key-table/compaction/)

这也解释了 LSM 的取舍。更新可以先批量写新文件，但重叠的 runs 多了，一次查询就可能读多个文件来找同一个 key，这是**读放大**。频繁归并可以减少重叠，但同一份数据可能被多次写进新的文件，这是**写放大**。新旧文件还可能同时占用存储，旧快照也可能继续引用被替换的文件。 [Paimon Compaction](https://paimon.apache.org/docs/2.1/primary-key-table/compaction/) · [快照与文件生命周期](https://paimon.apache.org/docs/2.1/concepts/basic-concepts/#follow-a-record-through-snapshots)

## 同一笔订单更新的读写开销

<figure>
  <a href="/assets/images/paimon-table-design/mor-cow-mow.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-table-design/mor-cow-mow.webp" width="1254" height="1254" alt="同一订单从 open 更新为 paid 的三种模式对比，MOR 查询时读多个版本归并，COW 写入时重写文件，MOW 写入时查旧行并维护 DV，查询时跳过失效行" loading="lazy" decoding="async" /></a>
  <figcaption>文件里的短线表示其他未变化的订单，COW 重写时也要处理它们。示意图由 AI 生成。</figcaption>
</figure>

### MOR 把部分合并留到查询时

**Merge on Read 在查询时合并尚未归并的版本。** 付款后，A 和 B 可以同时留在当前快照里。查询读到重叠的 key 范围时，把两个版本归并成 `paid`。写入可以先提交新文件，后台 compaction 再逐步减少重叠，比较适合更新频繁、希望写入尽快可见的表。

重叠多时，查询要多读文件并花 CPU 和内存做归并。像 `status` 这种会随版本变化的列，也要等确定当前版本后才能安全地过滤相关记录。如果查询选择只读已完成完整合并的数据，可以减少归并工作，代价是数据新鲜度取决于合并进度。 [MOR](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/#merge-on-read) · [MOR Read Optimized](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/#mor-read-optimized)

### COW 在写入侧先做完整合并

**Copy on Write 在写入侧先生成合并后的数据文件。** 对本文的主键表，可以通过受影响桶的完整合并来得到这种读取效果。假设这次归并处理了 A 和 B，合并后的快照就用文件 C 替换它们，查询直接读 C。 [Paimon COW](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/#copy-on-write)

读取时省去了版本归并，代价是只改一个订单，也可能重新写出同桶里大量没有变化的记录。小批更新越频繁，写放大和提交等待越明显。低频批量更新、随后反复扫描同一批数据时，完整合并的成本更容易摊开。

### MOW 用 DV 标记保留文件里的旧行

**Merge on Write 在写入侧处理新旧版本的关系。** Paimon 的 DV 路径会在合并时查找旧版本。假设 A 没有被这次 compaction 重写，旧 `open` 行在 A 的第 42 号位置，Paimon 就把这个位置写入 A 的 Deletion Vector（DV）。新快照引用新版本，也引用带 DV 的 A。查询直接跳过 A 里的旧行。 [Paimon MOW](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/#merge-on-write)

处理完旧版本关系后，查询可以独立读取文件并应用 DV，减少读时版本归并。代价是写入侧要查旧 key、维护删除信息，查询也要加载并应用 DV。索引和数据没有缓存时，旧版本查找还会带来额外 I/O。采用异步合并时，系统还要协调新文件和旧行失效标记的可见性。等待合并完成会增加提交延迟，把未合并数据交给查询处理则增加读时开销。 [Lookup Compaction](https://paimon.apache.org/docs/2.1/primary-key-table/compaction/#lookup-compaction) · [DV 可见性](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/#merge-on-write)

## 从表的构成回到设计选择

对这张订单表，Schema 定义字段和键，分区与桶组织文件，LSM 管理同键的物理版本，merge engine 定义合并结果，MOR、COW、MOW 分摊处理版本的成本。文件的增加、替换和失效信息，最终通过快照及相关清单组成可读取的表状态。

这里的 LSM 和合并规则围绕常规主键表展开。后面介绍 Data Evolution 时，还会看到通过行标识关联不同列文件的组织方式。图片、灵活的扩展属性和向量会进一步带来 BLOB、VARIANT、VECTOR 的存储需求。它们都可以放回这套整体结构中理解：表怎样定义数据，文件怎样承载数据，快照怎样确定读取的状态。 [Paimon 基本概念](https://paimon.apache.org/docs/2.1/concepts/basic-concepts/)

下一篇继续看订单查询，沿着快照和文件清单，解释怎样用 `dt` 和 `id` 缩小扫描范围，再从有序文件中得到合并后的记录。 [表的查询流程](/2026/11/09/paimon-table-query/)
