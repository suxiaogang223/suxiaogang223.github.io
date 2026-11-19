---
title: Paimon（四）行标识与 Data Evolution
date: 2026-11-18
slug: paimon-data-evolution
summary: 从商品图片的描述补充出发，区分业务 ID、Row ID 和文件内位置，解释按列更新怎样减少重写，以及它给读取和维护带来的成本。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [上一篇：表的写入流程](/2026/11/09/paimon-table-write/) · [下一篇：BLOB：大对象文件的设计](/2026/11/19/paimon-blob/)

第三篇里，删除订单需要先用主键对应旧记录，再找到文件内的位置。继续往后看，如果一行的数据分散在几个文件中，怎样确认它们属于同一行？文件整理之后，这种对应关系又怎样保留？

从这一篇开始，换一张商品素材表。商品图片写入后，后续任务会补充描述、识别属性，再生成向量。描述和向量可能反复更新，而图片本身没有变化。我们希望这些更新尽量复用已有图片，读取时又能把各部分准确拼回同一条记录。本文的商品表采用 Data Evolution 布局，`product_id` 是普通业务列。

## 业务 ID、Row ID 和文件内位置各有什么作用

假设一条商品记录的 `product_id` 是 `P101`。为了说明对应关系，再假定 Paimon 为这行分配了 Row ID `100`，它当前位于文件 A 的第 `0` 号位置。

| 标识 | 例子 | 作用 |
| --- | --- | --- |
| 业务 ID | `product_id = P101` | 由业务定义，关联商品及其属性；是否唯一取决于业务约束与表设计 |
| Row ID | `100` | 由 Paimon 管理，在相应布局中标识表内的一行，让不同列文件能够对齐 |
| 文件内位置 | 文件 A 的位置 `0` | 描述某条物理记录位于哪个文件、哪个位置，例如供该文件的 DV 使用 |

Row Tracking 为 Append 表提供系统管理的行标识。普通文件重写可以改变文件名和行在文件中的位置，同时保留 Row ID。这样，即使一行搬到了文件 C，仍能通过它的 Row ID 关联表内数据。图中的位置从 `0` 变成 `2`，Row ID 仍是 `100`。 [Paimon Row Tracking](https://paimon.apache.org/docs/2.1/append-table/row-tracking/)

<figure>
  <a href="/assets/images/paimon-data-evolution/row-identities.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-data-evolution/row-identities.webp" width="1254" height="1254" alt="同一商品记录的三个标识，业务 ID 为 P101，Row ID 为 100，普通文件重写后从文件 A 的位置 0 移到文件 C 的位置 2，Row ID 保留" loading="lazy" decoding="async" /></a>
  <figcaption>普通文件重写可以改变物理位置，保留表内行标识。这里的 ID 和位置都用于示意。示意图由 AI 生成。</figcaption>
</figure>

业务 ID 与 Row ID 也没有固定的换算关系。同一个 `product_id` 如果被重复追加为两行，会有各自的 Row ID；启用 Row Tracking 本身不会按业务 ID 去重。查询结果里的第几行，同样不能当作 Row ID。示例中后续按商品 ID 更新时，假定业务已经保证每个商品只对应一条目标记录。 [Row Tracking 与行更新](https://paimon.apache.org/docs/2.1/append-table/row-tracking/)

## Data Evolution 为什么需要行标识

Data Evolution 为 Append 表提供按列更新的数据组织方式。一条逻辑行可以由多个文件提供不同列，Row ID 把这些片段对应起来，文件的版本信息决定某列当前使用哪份值。商品的描述更新以后，可以继续从已有文件读取未修改的列和图片内容。 [Paimon Data Evolution](https://paimon.apache.org/docs/2.1/multimodal-table/data-evolution/)

这里也需要区分表结构变化与数据内容变化。给表新增 `caption` 列，定义的是“表里可以有描述”；为已有商品生成描述，再写入这一列，才是在补充已有行的数据。新增列本身不会自动完成回填。

前面主键表的 `partial-update` 按业务主键合并不同输入中的字段；这里则通过系统行标识对齐列文件，并为各列选择当前版本。两种设计都能减少应用重复提供未修改字段的负担，但文件的组织和读取方式不同。

## 只修改一条描述，需要写哪些数据

把商品素材表简化为 `product_id`、`caption` 和图片三部分。假设同一组普通文件覆盖 Row ID `100` 到 `102`，三行描述如下。

| Row ID | product_id | caption |
| --- | --- | --- |
| 100 | P101 | 旧描述 A |
| 101 | P102 | 旧描述 B |
| 102 | P103 | 旧描述 C |

现在只修改商品 `P102` 的描述。下面的 SQL 表达这次更新的含义。

```sql
UPDATE products
SET caption = '新描述 B'
WHERE product_id = 'P102';
```

写入侧先在选定快照中找到匹配行，再确定它所在的文件行范围。对于普通列的部分更新，新描述文件仍覆盖完整的 `[100, 102]` 范围：`101` 写入新值，`100` 和 `102` 写回原来的描述。商品 ID 等未修改列可以继续从已有文件取得，图片文件也可以复用。 [Data Evolution 文件布局](https://paimon.apache.org/docs/2.1/multimodal-table/data-evolution-file-layout/)

<figure>
  <a href="/assets/images/paimon-data-evolution/column-update.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-data-evolution/column-update.webp" width="1254" height="1254" alt="商品描述列的部分更新，基础文件覆盖 Row ID 100 到 102，新描述文件仍覆盖相同行范围，只改变 101 的描述，图片文件继续复用，读取时按 Row ID 组装" loading="lazy" decoding="async" /></a>
  <figcaption>普通列更新保留完整的行范围，节省的是未修改列和内容文件的重写。示意图由 AI 生成。</figcaption>
</figure>

这份收益有明确的边界。只命中一行，也可能需要处理同一文件范围内其他行的描述；大文件里零散的小更新，仍会有写放大。它更容易节省的是宽表中未修改列的 I/O，尤其是图片这类体积较大的内容。文件大小的选择，也要考虑未来更新列时需要处理多大范围。 [部分列更新](https://paimon.apache.org/docs/2.1/multimodal-table/data-evolution/)

## 查询怎样把多个文件拼成一行

新描述文件提交之后，查询需要根据快照中的有效文件重建记录。

- **先确定各文件提供哪些列。** 结合文件对应的 Schema 和列元数据，识别基础文件、描述更新文件和内容文件各自的职责。
- **再为请求的列选择当前版本。** `product_id` 仍由基础文件提供，`caption` 使用新的描述文件。较新的文件只替换它实际写入的列。
- **按 Row ID 对齐各部分。** 把 `101` 对应的商品 ID、新描述和图片组合起来，再一致地处理逻辑删除，得到这行的可见结果。 [文件读取与列版本](https://paimon.apache.org/docs/2.1/multimodal-table/data-evolution-file-layout/)

如果查询只需要商品 ID 和描述，就可以跳过不需要的图片内容。反过来，列版本分散在越多文件里，读取时需要选择和协调的工作也越多。用某列的统计信息做过滤时，同样要认清该列的当前来源，不能用已被覆盖的旧值排除记录。

还有一个与第三篇字段合并例子不同的地方：更新文件没有写入某列，表示这份文件没有提供该列的新值；如果它明确写入了 `NULL`，这一版的值就是空值。前面 `partial-update` 例子里按非空值保留旧字段的规则，不能直接套到这里。 [列缺失与空值](https://paimon.apache.org/docs/2.1/multimodal-table/data-evolution-file-layout/)

## 文件整理与删除怎样影响 Row ID

反复补充描述、标签和向量，会让同一行范围对应越来越多的列文件。普通 Compaction 可以把需要整理的列版本合并起来，减少碎片，同时保留 Row ID。文件边界可以变化，行标识继续承担对齐的作用。 [Data Evolution 维护](https://paimon.apache.org/docs/2.1/multimodal-table/data-evolution-maintenance/)

逻辑删除还要保留位置关系。例如隐藏 Row ID `101` 后，`102` 仍然对应原来的商品，不能因为少了一行就向前挪一个位置。否则，仍在复用的图片文件就会与普通列错位。普通整理也需要维护这份对齐关系。

Row ID 的稳定性有适用范围。部分更新和普通 Compaction 可以保留它；清除已删除位置、重新分配行标识等维护操作，则可能改变相关行的 ID。依赖 Row ID 的索引和跨表引用需要与这些操作一起维护。因此，业务关联仍应由业务 ID 承担，Row ID 的引用则要考虑表的生命周期。 [Row ID 生命周期](https://paimon.apache.org/docs/2.1/multimodal-table/data-evolution-maintenance/)

## 总结

Row ID 为数据提供独立于文件位置的行标识，Data Evolution 利用这份对应关系，让一条逻辑行由不同列文件共同提供。它的价值在于把变化集中到相关列上：反复补充属性或替换特征时，可以继续复用未修改的数据，减少宽表和大对象的重复写入。

节省的写入工作，会转化为读取和维护中的协调工作。更新仍可能覆盖完整文件行范围，查询需要选择当前列版本并对齐数据，维护还要尊重行标识和引用的生命周期。它适合围绕已有数据持续补充少量列的流程，收益取决于能复用多少内容，以及列版本管理要付出多少成本。

下一篇转向 BLOB 文件本身，介绍它怎样组织大对象，以及顺序写入、随机读取和空间回收之间的取舍。 [下一篇：BLOB：大对象文件的设计](/2026/11/19/paimon-blob/)
