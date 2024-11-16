---
title: 谓词下推(一)：概念和原理
date: 2024-11-16 23:54:22
tags: bigdata
---
> 本文介绍谓词下推的概念和通用实现原理，后续将继续介绍主流列存格式ORC和Paruqet中谓词下推的具体实现。
> 

# 什么是谓词下推

谓词下推（Predicate Pushdown）是一种减少查询数据量的技术。当执行SQL查询时，某些过滤条件可以提前应用到数据读取阶段，从而减少数据的读取和传输量，提高查询性能。比如，当我们执行类似 `SELECT * FROM user WHERE age > 30` 的查询时，理想的情况是只读取满足 `age > 30` 的数据，而不是读取整个表到内存中再进行过滤。

# 如何实现谓词下推

谓词下推一般是通过在数据存储中保存额外的统计信息(如每一列的Min/Max值)，通过这些统计信息来过滤掉文件的部分甚至整个文件。还是以`SELECT * FROM user WHERE age > 30` 为例，假如`user`表中的记录保存在三个文件中，每个文件中age的最大值最小值分别为：

```
people: 
	- file0 metadata: { "age": {"min": 11, "max": 20}}
	- file1 metadata: { "age": {"min": 15, "max": 35}}
	- file2 metadata: { "age": {"min": 31, "max": 40}}
```

查询语句的谓词为`age > 30` 时：

- 对于file0，他的最大age为20，那么一定不存在`age > 30`的记录，因此可以过滤掉file0
- 对于file1，他的最小age为15，最大age为35，因此可能存在满足谓词的记录，要读取该文件
- 对于file2，他的最小age为31，文件中所有的记录都满足条件，也要读取

需要注意的是，对于file1的情况，我们是不知道文件中的哪些记录是符合条件哪些是不符合的，因此在将file1读取到内存后需要进一步进行过滤，才可以得到正确的查询结果。因此谓词下推某种意义上是一种**粗过滤**，他只能过滤掉“一定不满足条件”的文件，对于“可能满足条件”的文件，需要执行器进行进一步的**细过滤**。

在ORC和Parquet格式中，对文件又进行了进一步的划分，I/O的最小单位并不是整个文件，而是文件中的一部分(而是RowGroup)，这样可以进行更加细粒度的过滤，进一步减少不必要的I/O，提高复杂查询的效率。

# 复杂谓词的过滤

上面的例子是一个非常简单的谓词，他只包含一个条件，那么对于多个条件的复杂谓词，谓词下推可以过滤吗？比如这样的查询：

```sql
SELECT * FROM user WHERE city = 'Shijiazhuang' and (age < 30 or last_login > '2024-11-11')
```

他包含3个条件，并且条件之间使用了`and`和`or`进行连接，如何通过这样的谓词来过判断哪些文件可以被过滤掉呢。下面介绍ORC中谓词下推的实现方法的原理，Parquet(Arrow中的实现)也使用了类似的方法实现，但是在逻辑的抽象上面不如ORC简洁易懂:)。

还是以user表举例，假设我们现在的文件元信息如下：

```
people: 
	- file0 metadata: { "age": {"min": 11, "max": 20}, 
						"city": {"min": "Aba", "max": "Luoyang"},
						"last_login": {"min": "2024-06-30", "max": "2024-09-27"}}
	- file1 metadata: { "age": {"min": 15, "max": 35}
						"city": {"min": "Dalian", "max": "Zigong"},
						"last_login": {"min": "2024-08-01", "max": "2024-10-01"}}
	- file2 metadata: { "age": {"min": 31, "max": 40}
						"city": {"min": "Guanzhou", "max": "Shenzhen"},
						"last_login": {"min": "2024-8-30", "max": "2024-11-16"}}
```

对于`city = 'Shijiazhuang' and (age < 30 or last_login > '2024-11-11')` 这样的复杂谓词，我们将其看作一个二叉树：

```
             and
      /                \
city = 'Shijiazhuang'   or
                       /   \
                  age < 30   last_login > '2024-11-11'
```

二叉树的叶子节点是一些简单谓词条件：`city = 'ShiJiaZhuang'` ，`age < 30` ，`last_login > '2024-11-11'` ，按照上一节的方式分别判断文件中是否存在满足简单谓词条件的记录，若存在则为`true`，否则为`false`。

对于file0，`city = 'ShiJiaZhuang'` 的结果为`false`，`age < 30` 的结果为`true` ，`last_login > '2024-11-11'` 的结果为`false` 。将这些结果替换掉二叉树中的叶子节点：

```
    and
  /     \
false    or
        /   \
     true   false
```

最后计算简化后的表达式的值，结果为`false` ，因此我们可以判断出file0中不存在满足谓词条件的记录，可以将文件过滤掉。

同样的，对于file1，二叉树结果为：

```
    and
  /     \
true    or
        /   \
     true   false
```

最终结果为`true`，file1中可能存在满足谓词条件的记录，file1不可被过滤。

对于file2，二叉树结果为：

```
    and
  /     \
false    or
        /   \
     false   true
```

最终结果为`false`，file2也可以被过滤。

# 补充

上面的例子中都是通过Min/Max值信息进行的过滤，这些信息主要针对`>`，`<`以及`=`这样的谓词条件进行过滤。除此以外，还可以通过记录nul值的个数，用来对像`name is null`或者`name is not null` 这样的谓词进行过滤。而对于`name like "%jerry%"`这样的谓词，就无法进行过滤，因此这样的谓词就不可以被下推。

# 总结

以上是对谓词下推的概念和原理的一个简单介绍，后续将结合ORC和Parquet的代码来解析在主流列存格式中谓词下推是怎样被实现的。