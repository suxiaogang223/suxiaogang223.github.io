---
title: Paimon（六）VARIANT：灵活结构与列式读取
date: 2026-11-19
slug: paimon-variant
summary: 先用 SQL 写入不同结构的对象并提取字段，再解释 VARIANT 的二进制表示、路径读取和 Shredding，以及灵活性、数据保真与查询效率之间的取舍。
tags:
  - bigdata
  - Paimon
draft: false
---

> Paimon 系列。 [表的设计](/2026/11/09/paimon-table-design/) · [上一篇：BLOB：大对象文件的设计](/2026/11/19/paimon-blob/) · [下一篇：VECTOR：向量表示与存储](/2026/11/19/paimon-vector/)

有些数据的结构会不断变化：一条记录多出几个字段，另一条记录缺少同名字段，同一个路径上的值也可能具有不同类型。事件属性、模型输出和嵌套文档经常具有这种特点。

把每个变化都变成表结构调整，会增加字段管理的负担；直接保存为 JSON 字符串，又需要在查询时解释文本中的结构与类型。VARIANT 的设计目的，是在保留这种结构灵活性的同时，让存储和读取能够利用值本身的类型与边界。 [Paimon VARIANT](https://paimon.apache.org/docs/2.1/multimodal-table/variant/)

## 先写入两个结构不同的对象

下面采用 **Spark 4.0 及以上版本的 SQL**，并使用支持 VARIANT 的 Paimon 连接器。假设已配置 Paimon Catalog，选中 `paimon.default`。这里采用 Parquet 文件，VARIANT 本身不要求开启 Data Evolution。 [VARIANT 的 SQL 使用条件](https://paimon.apache.org/docs/2.1/multimodal-table/variant/#overview)

```sql
USE paimon.default;

CREATE TABLE variant_samples (
    id BIGINT,
    payload VARIANT
) USING paimon
TBLPROPERTIES (
    'file.format' = 'parquet'
);

INSERT INTO variant_samples VALUES
    (1, parse_json('{"a":7,"label":"sample-a"}')),
    (2, parse_json('{"a":9,"active":true}'));
```

第一行有 `label`，第二行有 `active`。它们都可以写进同一个 `payload` 列，不必为每种内部结构新增一组表字段。`parse_json` 把 JSON 文本转换为带类型和结构的 VARIANT 值；文件里保存的是相应的二进制表示。

## 用路径提取字段，再看返回结果

```sql
SELECT
    id,
    variant_get(payload, '$.a', 'int') AS a,
    variant_get(payload, '$.label', 'string') AS label
FROM variant_samples
ORDER BY id;
```

| id | a | label |
| --- | --- | --- |
| 1 | 7 | sample-a |
| 2 | 9 | NULL |

`$.a` 表示对象里的 `a` 字段，`int` 指定 SQL 返回类型；第二行没有 `label`，所以该路径提取结果为 SQL `NULL`。路径还可以进入嵌套对象或数组，例如 `$.user.id`、`$.items[0]`。值的类型不能按要求转换时，需要遵循所用函数的转换规则。 [路径查询与类型转换](https://paimon.apache.org/docs/2.1/multimodal-table/variant/#write-and-query-variant)

这个例子展示了两种能力：同一列容纳不同结构，查询按路径得到类型化的结果。但 SQL 只取 `a`，是否就意味着文件也只读取 `a` 的数据？下面从二进制编码和物理布局解释这件事。

## 灵活结构为什么需要专门的表示

VARIANT 可以表达标量、数组和对象。对象包含名字与值的对应关系，数组保留元素顺序，内部还可以继续嵌套。不同记录可以拥有不同结构，表中仍然使用同一个 VARIANT 列。

可以把几种常见存储选择放在一起看。

| 方式 | 适合的需求 | 需要承担的成本 |
| --- | --- | --- |
| 固定列或固定结构 | 字段含义、类型较稳定，频繁用于查询 | 新增和调整结构需要管理 Schema |
| JSON 字符串 | 需要保留文本，或很少访问内部字段 | 提取字段时需要解释文本结构并处理类型 |
| VARIANT | 结构经常变化，同时需要反复访问内部值 | 需要二进制编码、路径访问和类型处理，物理布局仍影响读取成本 |

VARIANT 把结构和类型放进值的表示中，但业务仍要决定字段的含义。相同路径一会儿存数字、一会儿存字符串，虽然能够保留下来，查询时仍需要明确如何解释。

此外，从 JSON 文本转换为 VARIANT，保留的是数据语义。原来的空格、对象字段顺序和数字书写形式，不属于必须原样还原的内容。如果还需要逐字保存源文本，就需要单独保留它。 [VARIANT 与 JSON 文本](https://paimon.apache.org/docs/2.1/multimodal-table/variant/#variant-vs-json-string)

## 二进制表示怎样保留类型和结构

Paimon 使用 Parquet 的 Variant 二进制编码。普通布局中，一个 VARIANT 值由两个二进制部分表示。

- **`metadata`** 保存对象字段名的字典和编码元信息，帮助解释字段标识对应的名字。
- **`value`** 保存类型、结构与实际数据。对象和数组还包含定位内部元素所需的信息。

这里的 `metadata` 属于 VARIANT 值的编码信息，与表级 Schema 各有职责。表结构声明某列为 VARIANT，而值内部的表示描述这条数据实际包含什么。 [Parquet Variant 编码](https://github.com/apache/parquet-format/blob/master/VariantEncoding.md)

<figure>
  <a href="/assets/images/paimon-variant/binary-encoding.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-variant/binary-encoding.webp" width="1254" height="1254" alt="VARIANT 二进制表示的手绘图，简短对象编码为 metadata 字段名字典和 value 中的类型、结构与数据，再通过路径定位整数子值" loading="lazy" decoding="async" /></a>
  <figcaption>图中展示编码职责，字段 ID 用于示意，不代表完整的字节布局。示意图由 AI 生成。</figcaption>
</figure>

字段名可以通过字典中的标识引用，内部值则带有相应类型。整数 `7` 和字符串 `"7"` 因此可以被区分。对象的字段标识与偏移、数组的元素位置与边界，帮助读者找到需要的子值。

这让文本转换时完成的结构解析能够服务后续读取。访问二进制值时，仍要识别结构并解码相关数据，但可以利用已经保存的类型与位置，不必重新解释 JSON 的文本语法。嵌套子值也能结合相应的元信息继续解释。 [值与嵌套结构](https://github.com/apache/parquet-format/blob/master/VariantEncoding.md#value-encoding)

## 按路径读取，是否就能少读文件

开头的 `variant_get(payload, '$.a', 'int')` 描述需要访问哪个字段，以及希望得到的 SQL 类型。读取过程沿着对象与数组的结构找到子值，再按查询需要处理其类型。

但路径访问能力与列裁剪能力有不同的边界。在普通 VARIANT 布局中，内部字段仍编码在同一个二进制 `value` 中。只请求其中一个路径，可以减少对其他子值的解释，却不意味着这个路径已经成为独立的 Parquet 列。读取它仍需要访问相应的二进制值数据。 [普通 VARIANT 布局](https://paimon.apache.org/docs/2.1/multimodal-table/variant/#plain-variant)

因此，二进制编码可以减少文本解释的工作，但宽文档只取少数字段时，I/O 仍可能包含较多无关内容。要让常用路径进一步利用列式存储，就需要改变它们的物理组织方式。

## Shredding 怎样把常用路径拆成列

Shredding 把选定路径按指定类型写入 Parquet 的类型化子列，逻辑上仍保留 VARIANT 列。它把经常访问的那部分结构显式放进列式布局，让这些值有机会使用列编码、压缩、统计信息和列裁剪。 [Parquet Variant Shredding](https://github.com/apache/parquet-format/blob/master/VariantShredding.md)

例如把路径 `a` 按整数拆列。值是整数时，写入相应的 `typed_value`；值是字符串 `"n/a"` 时，整数列无法表达它，就把原值保留在该路径的二进制 `value` 中。没有被选择拆列的字段，则保留在残余的二进制结构里。

<figure>
  <a href="/assets/images/paimon-variant/shredding.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/paimon-variant/shredding.webp" width="1254" height="1254" alt="Shredding 拆列与回退的手绘图，路径 a 的整数值进入 typed_value，字符串值保留在该路径的 value 中，未拆字段保留在残余 value，完整读取时结合这些部分与 metadata 重建 VARIANT" loading="lazy" decoding="async" /></a>
  <figcaption>拆列后的类型化值与回退值共同表达原数据，残余结构继续保存其他字段。示意图由 AI 生成。</figcaption>
</figure>

因此，拆列是一种可恢复完整值的物理布局。类型不匹配的数据可以继续保留，读取完整 VARIANT 时，再按规则组合类型化字段和二进制部分。某个字段的回退 `value` 与顶层保存未拆字段的残余 `value`，也处在不同的结构位置。

如果读取端能够把路径提取下推到扫描阶段，就有机会只读取所需的类型化子列和必要的回退信息，减少无关内容的读取。收益取决于实际布局、类型匹配情况，以及读取端能否使用这些子列；仅仅把列声明为 VARIANT，并不会自动获得全部效果。 [Paimon Shredding 布局](https://paimon.apache.org/docs/2.1/multimodal-table/variant/#shredded-variant)

## 类型变化与空值，为什么必须保真

拆列后的过滤需要同时考虑类型化值与回退值。如果同一路径还存在二进制回退数据，就不能只看整数子列的统计信息，直接判断整批记录都不匹配。值在查询中是否参与类型转换，也会影响判断。文件裁剪必须覆盖查询所定义的全部情况。 [Shredding 的数据跳过规则](https://github.com/apache/parquet-format/blob/master/VariantShredding.md#data-skipping)

字段缺失与字段显式为空也有不同的含义。

| 表示 | 含义 |
| --- | --- |
| `{}` | 对象存在，但没有字段 `a` |
| `{"a": null}` | 字段 `a` 存在，值为 VARIANT 内部的空值 |
| `{"a": "null"}` | 字段 `a` 存在，值为字符串 |

此外，整列值为 SQL `NULL`，又与“对象中某个字段为空”处在不同层次。存储表示需要保留这些区别；具体提取函数可能把某些情况都映射为 SQL `NULL`，也可能提供单独的判断方式。查询需要结合函数的类型转换和空值语义使用这些信息。 [缺失值与空值编码](https://github.com/apache/parquet-format/blob/master/VariantShredding.md#value-shredding)

## 总结

VARIANT 用二进制表示容纳变化的结构，再通过 Shredding 为常用路径提供列式优化。它让数据的灵活性和查询效率可以分开调整，但收益取决于实际的访问方式，需要考虑下面几组取舍。

- **局部读取与完整重建。** 宽文档只反复读取少数路径时，拆列更容易减少无关 I/O；大多数查询都需要完整值时，则要承担组合类型化字段和残余结构的工作。
- **类型化读取与类型回退。** 路径类型越稳定，越多值可以利用类型化子列；保留不同类型的能力，则需要额外的回退表示，以及读取、转换和过滤时的处理。
- **解析收益与编码开销。** 二进制结构减少了重复解释 JSON 文本的工作，但字典、偏移和类型标记都有空间与处理成本，拆列还会增加子列及元数据。最终占用并不保证比 JSON 文本更小。
- **结构灵活性与固定列的效率。** 经常变化的字段适合保留在 VARIANT 中；长期作为关联键、过滤条件或聚合维度的稳定字段，可以直接建成普通类型列，减少路径提取和类型处理的工作。

下一篇介绍 VECTOR，先用 SQL 写入和查询向量，再看固定维度、数值精度与独立存储怎样影响读写。 [下一篇：VECTOR：向量表示与存储](/2026/11/19/paimon-vector/)
