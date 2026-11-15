# 来源约定

## 产品交换范围

ASC X12 004010 856 交换范围：ISA/IEA、GS/GE、ST/SE、BSN、HL、PRF、MAN、LIN、SN1、TD1；未知段保留，不要求所有实施指南。ISA 固定 106 字符（含 terminator），元素分隔在 offset 3、component 在 104、segment 在 105，后续按此分隔而非固定 *。HL01 是本交易集节点号，HL02 父号可前向引用，HL03 代码 S/O/P/I 表示 shipment/order/pack/item；指南允许 S-O-P-I 与 S-P-O-I，不能靠固定深度解释。MAN 包装号限定本票，PRF 订单号与商品数量分配按祖先/后代关系保存，不能从缺省的层级臆测分配。控制计数与编号在各自信封层核对，交易级错误不抹掉其他独立交易的原证据。

## 当前来源路由

- `/primary`：application/octet-stream
- `/shipments/multi`：application/octet-stream
- `/shipments/forward`：application/octet-stream
- `/shipments/bad-count`：application/octet-stream

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://x12.org/

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
