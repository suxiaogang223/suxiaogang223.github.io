---
title: Paimon（三）表的写入流程
date: 2026-11-09
slug: paimon-table-write
summary: 从订单的写入、删除和字段合并 SQL 出发，解释路由、缓冲、有序文件与快照提交，以及版本处理的性能取舍。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [上一篇：表的查询流程](/2026/11/09/paimon-table-query/) · [下一篇：行标识与 Data Evolution](/2026/11/18/paimon-data-evolution/)

第二篇从快照找到文件 A 和 B，再把订单 `123` 的多个版本归并成结果。这一篇回到文件产生之前：输入的记录怎样被整理，什么时候对查询可见，删除又怎样让旧行失效。

继续采用 Spark SQL，沿用[第一篇创建的订单表](/2026/11/09/paimon-table-design/)。主键为 `(dt, id)`，`dt` 保留创建日，按 `id` 固定分桶。先通过写入前后的查询结果，区分“向表提交什么变化”和“文件里怎样处理这些变化”。

## 先观察两次写入的结果

依次提交下面两份完整状态，并在每次写入完成后查询。即使表里已经有订单 `123`，`deduplicate` 也会按后续输入替换它的整行状态。

```sql
INSERT INTO orders (dt, id, status, amount)
VALUES ('2026-10-08', 123, 'open', 10);

SELECT id, status, amount
FROM orders
WHERE dt = '2026-10-08' AND id = 123;

INSERT INTO orders (dt, id, status, amount)
VALUES ('2026-10-08', 123, 'paid', 10);

SELECT id, status, amount
FROM orders
WHERE dt = '2026-10-08' AND id = 123;
```

两次查询分别返回下面的状态，每次都是一行。

| 查询时刻 | id | status | amount |
| --- | --- | --- | --- |
| 第一次写入后 | 123 | open | 10 |
| 第二次写入后 | 123 | paid | 10 |

如果由 SQL 根据条件修改已有订单，付款操作也可以表达为下面的 `UPDATE`，用于替代第二次 `INSERT`。

```sql
UPDATE orders
SET status = 'paid'
WHERE dt = '2026-10-08' AND id = 123;
```

两种表达都可以让查询看到 `paid`：`INSERT` 直接提供同键的新状态，`UPDATE` 先找到匹配记录再产生修改。它们都需要经过写入与提交，SQL 中的更新并不意味着直接修改旧文件里的几个字节。 [Spark SQL 写入与更新](https://paimon.apache.org/docs/2.1/spark/sql-write/)

## 先把输入整理成有序文件

输入可以来自数据库变更或批量计算结果。进入写入链路时，记录带着主键、字段值，以及新增、更新或删除的含义。记录先按分区和桶路由，让同一订单的后续版本进入相同的管理范围。 [Paimon 主键表](https://paimon.apache.org/docs/2.1/primary-key-table/) · [数据分布](https://paimon.apache.org/docs/2.1/primary-key-table/data-distribution/)

<figure>
  <a href="/assets/images/paimon-table-write/write-lifecycle.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-table-write/write-lifecycle.webp" width="1254" height="1254" alt="MOR 写入的手绘流程，记录路由并排序刷成 L0 文件后可以先提交快照，后台 Compaction 合并文件后再通过新快照发布替换关系" loading="lazy" decoding="async" /></a>
  <figcaption>MOR 下，L0 文件可以先提交，Compaction 再通过后续提交发布整理结果。示意图由 AI 生成。</figcaption>
</figure>

**写缓冲把零散更新整理成有序批次。** 记录按主键和版本顺序组织，再刷成 L0 文件。同一批里的同键记录可以先按 merge engine 合并，减少写出量。缓冲能摊薄排序和文件写入的成本，但会占用内存。文件刷出后，还需要提交才能进入可查询的表状态。 [Paimon LSM Tree](https://paimon.apache.org/docs/2.1/primary-key-table/#lsm-trees)

**Compaction 继续处理不同文件之间的重叠。** 多次刷出可能让同一订单分布在多个文件中。合并任务读取选中的 runs，按主键归并并应用同一套 merge engine，产出新的数据文件。第二篇里查询需要处理多少重叠版本，就与这份整理工作完成了多少有关。 [Paimon Compaction](https://paimon.apache.org/docs/2.1/primary-key-table/compaction/)

## 文件怎样进入已提交的表状态

写入任务汇总新增文件、被替换的文件和相关索引变化，再通过快照发布。对图中的 MOR 例子，可以先把 A、B 两个 L0 文件提交到快照 10；后台 Compaction 生成 C 后，再由快照 11 发布用 C 替换 A、B 的关系。 [Paimon Snapshot](https://paimon.apache.org/docs/2.1/concepts/spec/snapshot/)

所以，刷出、合并、提交可以分别发生。刷出解决数据落盘，合并整理文件中的版本，提交决定哪些变化一起对查询可见。需要在写入侧完成版本处理的路径，还要协调新文件与旧行失效信息的发布时机。 [Paimon Table Mode](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/)

普通 Append 表同样需要生成文件并提交，也可能合并小文件，但省去了按主键合并输入状态的环节。下面继续看主键表里，同一组输入在不同规则下怎样变成结果。

## 同一组输入怎样得到四种结果

第一篇按应用场景介绍了四种 merge engine。先新建一张 `partial-update` 表，看怎样用 SQL 声明“只替换这次提供的非空字段”。这张演示表独立于前面的 `orders`，下面的三次写入从空表开始。

```sql
CREATE TABLE orders_merge_demo (
    dt STRING,
    id BIGINT,
    status STRING,
    amount INT
) PARTITIONED BY (dt)
TBLPROPERTIES (
    'primary-key' = 'dt,id',
    'bucket' = '2',
    'bucket-key' = 'id',
    'merge-engine' = 'partial-update'
);

INSERT INTO orders_merge_demo (dt, id, status, amount)
VALUES ('2026-10-08', 123, 'open', 10);

INSERT INTO orders_merge_demo (dt, id, status, amount)
VALUES ('2026-10-08', 123, NULL, 7);

INSERT INTO orders_merge_demo (dt, id, status, amount)
VALUES ('2026-10-08', 123, 'paid', NULL);

SELECT id, status, amount
FROM orders_merge_demo
WHERE dt = '2026-10-08' AND id = 123;
```

结果保留前一次更新的金额，同时得到新的状态。

| id | status | amount |
| --- | --- | --- |
| 123 | paid | 7 |

如果比较其他规则，应分别用新表名建空表，在建表时选择相应的 `merge-engine`，再依次执行同样三次输入。聚合例子还需设置 `'fields.amount.aggregate-function' = 'sum'` 和 `'fields.status.aggregate-function' = 'last_non_null_value'`。这样比较的是同一组输入在不同规则下的结果，不会混入前面演示表的历史数据。 [合并规则](https://paimon.apache.org/docs/2.1/primary-key-table/merge-engine/) · [聚合函数配置](https://paimon.apache.org/docs/2.1/primary-key-table/merge-engine/aggregation/)

图中省略相同的主键，只展示状态和金额。这个例子按三次独立提交的先后确定版本。

<figure>
  <a href="/assets/images/paimon-table-write/engines.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-table-write/engines.webp" width="1536" height="1024" alt="三条同键记录在四种 merge engine 下的合并结果" loading="lazy" decoding="async" /></a>
  <figcaption>同一组输入在四张表里各自留下的结果。示意图由 AI 生成。</figcaption>
</figure>

- **`deduplicate` 得到 `('paid', NULL)`。** 每次输入替换整行，所以第三次写入也把金额变成了空值。它要求输入准确表达新的整行状态；如果只带局部变化，未提供的字段就可能被覆盖。 [Deduplicate](https://paimon.apache.org/docs/2.1/primary-key-table/merge-engine/#deduplicate)

- **`partial-update` 得到 `('paid', 7)`。** 按最新非空值合并时，第二次输入更新金额，第三次输入更新状态。这里的 `NULL` 表示保留已有字段值；业务如果还需要把字段真正清空，就要另外定义这种更新的表达方式。 [Partial Update](https://paimon.apache.org/docs/2.1/primary-key-table/merge-engine/partial-update/)

- **`aggregation` 得到 `('paid', 17)`。** 金额的两次贡献 `10` 和 `7` 相加，状态保留最后一个非空值。同样的 `7` 如果因重试重复输入，结果会继续累加到 `24`。聚合前需要明确去重边界；撤回贡献时，还要考虑所选函数能否处理。 [Aggregation](https://paimon.apache.org/docs/2.1/primary-key-table/merge-engine/aggregation/)

- **`first-row` 得到 `('open', 10)`。** 后续两次输入都不改变首次保留的内容。因此这组输入虽然出现了付款状态，表中的结果仍是最初那一行。 [First Row](https://paimon.apache.org/docs/2.1/primary-key-table/merge-engine/first-row/)

同一个金额 `7`，可以表示金额的新值，也可以表示一笔新增贡献，合并规则要与输入含义匹配。版本顺序同样重要：业务上较新的变化未必较晚到达，需要用业务版本表达的新旧关系，不能只靠到达时间推断。 [记录顺序](https://paimon.apache.org/docs/2.1/primary-key-table/sequence-rowkind/)

## DELETE 怎样找到并处理旧行

回到前面的 `deduplicate` 表 `orders`，删除订单 `123`，再读一次。

```sql
DELETE FROM orders
WHERE dt = '2026-10-08' AND id = 123;

SELECT id, status, amount
FROM orders
WHERE dt = '2026-10-08' AND id = 123;
```

删除提交完成后，查询结果为 **0 行**。这是逻辑记录消失的结果；旧文件中的内容怎样失效、空间何时回收，还需要继续看下面的物理处理过程。

这里有两次不同的定位。执行 SQL 时，先按条件找到需要删除的逻辑记录，再把带主键的删除记录交给写入链路；数据库变更流也可以直接提供这样的删除记录。后续处理旧版本时，Paimon 再用这个主键对应已有数据。 [Paimon 记录与删除](https://paimon.apache.org/docs/2.1/primary-key-table/sequence-rowkind/)

在 MOR 路径里，删除记录可以先进入新文件，查询归并时据此去掉逻辑结果中的订单。删除标记还可能需要继续保留：如果更老的版本仍在其他文件里，过早丢掉标记，后续读取就可能再次看到旧记录。合并必须覆盖相关旧版本，才能安全清理这份删除信息。 [Paimon 文件中的删除记录](https://paimon.apache.org/docs/2.1/learn-paimon/understand-files/)

第一篇介绍了 DV 怎样让查询跳过旧行。生成这些标记时，需要根据旧文件是否参与本次重写，分别处理。

<figure>
  <a href="/assets/images/paimon-table-write/dv.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-table-write/dv.webp" width="1536" height="1024" alt="一条 DELETE 分成重写文件和查找旧文件行号两条路径" loading="lazy" decoding="async" /></a>
  <figcaption>右侧的 42 是文件内行号，从 0 开始计数。示意图由 AI 生成。</figcaption>
</figure>

- **旧文件参与重写。** 归并输入时可以直接处理订单的旧版本，输出文件省略已经删除的行。
- **旧文件继续保留。** 先利用有序文件的主键范围缩小候选，再通过查找索引确认 key 和文件内位置。例如定位到 `F3.parquet` 的第 `42` 号位置，就把 `42` 加入这个文件的 DV。 [Lookup Compaction](https://paimon.apache.org/docs/2.1/primary-key-table/compaction/#lookup-compaction)

这里的 `42` 属于特定文件，文件重写后需要按新布局维护位置关系。这也说明为什么生成 DV 要付出查找成本：逻辑主键必须先对应到旧记录的物理位置，才能准确标记它。

删除后的空间回收还需要后续处理。DV 先让查询跳过旧行，文件重写才有机会去掉记录；被替换的旧文件还要等到历史快照不再需要时才能清理。因此，当前结果不可见、文件内部已整理、存储空间已回收，会发生在不同阶段。

## 持续写入时，合并能否跟上

偶尔完成一次 Compaction，不能说明系统能长期承受当前写入量。持续进入的数据会不断产生新文件；如果合并能力跟不上，积压就会增长。MOR 查询需要处理更多重叠版本，依赖合并结果的读取路径也可能受到可见进度的影响。 [Paimon Compaction](https://paimon.apache.org/docs/2.1/primary-key-table/compaction/) · [Table Mode](https://paimon.apache.org/docs/2.1/primary-key-table/table-mode/)

限制写入速度可以抑制积压，但会增加上游等待；增加或独立分配合并资源，则要承担额外计算成本和文件修改的协调工作。第一篇里的读写取舍，在持续运行时还要满足一个条件：长期的整理能力能跟上数据变化。 [异步合并](https://paimon.apache.org/docs/2.1/primary-key-table/compaction/#asynchronous-compaction)

## 总结

主键表的写入链路把持续到来的变更整理成有序文件，再通过提交发布新的表状态。Merge engine 定义这些变更应形成什么结果，Compaction 和 DV 则帮助处理文件中的旧版本。批量写文件、复用保留数据与后台整理相互配合，让表能够持续承接更新。

这种能力需要长期的整理与维护成本。刷出、提交和完成合并可能发生在不同时刻，逻辑删除与空间回收也有各自的进度。因此，写入设计既要选对输入语义，也要让合并资源跟上变化量，才能同时维持可接受的新鲜度、读取成本和存储占用。

下一篇进一步区分业务主键、文件内位置和 Row ID，解释不同列的数据怎样建立对应关系。 [下一篇：行标识与 Data Evolution](/2026/11/18/paimon-data-evolution/)
