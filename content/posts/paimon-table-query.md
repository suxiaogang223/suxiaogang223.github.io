---
title: Paimon（二）表的查询流程
date: "2026-11-09T09:02:00+08:00"
slug: paimon-table-query
summary: 沿着一条订单查询，串起快照、Manifest、分区和桶裁剪、扫描任务，以及主键版本合并与过滤的顺序。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [上一篇：表的设计](/2026/11/09/paimon-table-design/) · [下一篇：表的写入流程](/2026/11/09/paimon-table-write/)

第一篇建立了主键为 `(dt, id)` 的 `orders` 表，并依次写入订单 `123` 的创建和付款记录。这一篇先看查询结果，再沿着查询解释快照、裁剪和版本合并怎样配合。

## 同一个订单，为什么只查到付款后的状态

下面继续采用 Spark SQL，在第一篇两次写入已经完成的基础上执行。独立阅读时，可以先使用[第一篇的建表与写入语句](/2026/11/09/paimon-table-design/)。

```sql
SELECT id, status, amount
FROM orders
WHERE dt = '2026-10-08'
  AND id = 123
  AND status = 'paid';
```

预期结果是付款后的状态。

| id | status | amount |
| --- | --- | --- |
| 123 | paid | 10 |

再把状态条件改为 `open`。

```sql
SELECT id, status, amount
FROM orders
WHERE dt = '2026-10-08'
  AND id = 123
  AND status = 'open';
```

这次结果为 **0 行**。即使旧文件里还存在 `open`，它也不再是这笔订单的当前状态。查询必须先判断版本关系，才能决定状态条件是否成立。

## 从 SQL 走到文件读取

下面以仍需读时合并的 MOR 路径为例，合并规则使用 `deduplicate`，选定的快照已包含付款。读取要同时做到两件事：减少无关数据的扫描，并保留判断当前版本所需的信息。

<figure>
  <a href="/assets/images/paimon-table-query/query-flow.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-table-query/query-flow.webp" width="1254" height="1254" alt="MOR 查询的手绘流程，从 Snapshot 和 Manifest 到分区与桶裁剪，把 A、B 两个版本组织进同一扫描任务，按主键合并后再过滤状态，得到订单 123 的 paid 记录" loading="lazy" decoding="async" /></a>
  <figcaption>以 MOR 下的 deduplicate 表为例。先保留完整的同键版本，再判断合并后的状态。示意图由 AI 生成。</figcaption>
</figure>

## 先确定这次读哪个表状态

找到表后，查询选定要读取的快照，后续文件规划和读取都围绕这个状态展开。例如选中付款后的快照，即使执行期间又提交了退款更新，这次读取仍按已经选定的状态处理。新的提交留给后续选择相应快照的查询。 [Paimon Snapshot](https://paimon.apache.org/docs/2.1/concepts/spec/snapshot/)

快照选定之后，查询沿着第一篇的引用关系找到 Schema、Manifest List 和 Manifest。目录中即使还有其他数据文件，也要根据这次快照的元数据判断是否属于读取范围。历史文件如何保留，已经在第一篇讨论；这里继续看确定范围之后怎样规划扫描。

## 用查询条件缩小候选文件范围

这条 SQL 的三个条件，能提前发挥的作用不同。

- **`dt = '2026-10-08'`** 可以排除其他日期的分区。
- **`id = 123`** 给出了完整的固定桶键，可以定位相应的桶。桶内文件的主键范围还能帮助排除不可能含有这个 key 的文件。
- **`status = 'paid'`** 要判断的是订单当前状态。对仍需合并的文件，这个条件需要等到版本关系确定后再应用。 [Paimon 数据分布](https://paimon.apache.org/docs/2.1/primary-key-table/data-distribution/) · [MOR 过滤](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/#merge-on-read)

Manifest 中的分区和文件统计，让查询可以在读取数据之前缩小候选范围。范围覆盖 `123` 的文件仍可能不含这个 key，因此裁剪后留下的文件还需要继续读取和判断。 [Paimon Manifest](https://paimon.apache.org/docs/2.1/concepts/spec/manifest/)

列裁剪则减少要读取和解码的列。除了输出列 `id`、`status`、`amount`，读取阶段还要保留完成过滤与版本归并所需的信息，例如完整主键和版本顺序。合并结束后，这些内部信息才可以从最终输出中去掉。

## 为什么状态过滤要等到版本合并之后

开头两条查询的差异，在文件层体现为版本处理的先后。假设旧版 `open` 在 A 文件，新版 `paid` 在 B 文件。如果先用 `status = 'open'` 把 B 排除，后续就只能读到旧版，错误地把订单当作未付款。

正确顺序是把 A 和 B 中同键的记录一起处理，得到当前的 `paid`，再判断是否满足 `status = 'open'`，结果应为空。换回原查询的 `status = 'paid'`，才会返回这笔订单。 [Paimon MOR](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/#merge-on-read)

这里的分区字段和主键不会随状态变化，用它们裁剪仍能保留同键的新旧版本。可变字段的过滤则要结合合并规则判断能否提前。查询优化既要减少读取，也要保持这些版本关系完整。

## 把候选文件组织成扫描任务

裁剪后的文件会被组织成扫描任务，也就是 splits。一个任务可以涉及多个文件。对需要读时归并的主键表，同一桶内主键范围重叠的输入，要在相应的归并范围内一起处理。图中的 A 和 B 就属于这样的输入，独立输出它们会返回订单的两个版本。 [Paimon Sorted Runs](https://paimon.apache.org/docs/2.1/primary-key-table/#sorted-runs)

任务划分还影响并行度。能独立读取的文件更容易拆开执行，需要归并的范围则要保留必要的协作。任务过细会增加调度和文件打开的开销，过粗又可能让少数任务处理过多数据。Compaction 改变文件大小和重叠程度，也会影响后续查询的任务划分。 [Paimon Compaction](https://paimon.apache.org/docs/2.1/primary-key-table/compaction/)

## 从有序记录得到查询结果

扫描任务推进各个有序输入，把相同主键的记录放到一起，再按版本顺序应用 merge engine。这里使用 `deduplicate`，因此订单 `123` 的 `open` 被后来的 `paid` 替换。随后判断状态条件，只把满足条件的业务列输出。删除记录也参与这一步，使对应 key 从逻辑结果中消失。 [Paimon 主键表](https://paimon.apache.org/docs/2.1/primary-key-table/)

如果读取的文件已经完成版本整理，就可以省去这部分跨文件归并。带 Deletion Vector（DV）的文件还需要跳过已失效的位置。第一篇比较的几种读写模式，在这里体现为不同的实际读取工作；查询仍要得到选定快照所定义的逻辑结果。 [Paimon Table Mode](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/)

## 总结

Paimon 的读路径把物理文件还原为选定表状态下的逻辑记录。快照确定读取范围，裁剪减少无关 I/O，扫描任务分摊执行工作，版本处理保证同一主键的变化得到正确结果。这些环节共同支撑了持续更新数据上的一致查询。

减少扫描必须以保留正确的版本关系为前提。能提前使用的条件和能拆出的并行任务，都受到物理布局与合并规则约束。理解这条边界，才能判断查询成本来自无关数据读取、版本归并，还是任务组织，并进一步选择改善文件布局或调整读写成本的分配。

下一篇看写入怎样生成这些文件，以及文件和删除信息怎样进入已提交的表状态。 [下一篇：表的写入流程](/2026/11/09/paimon-table-write/)
