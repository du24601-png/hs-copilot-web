# 30 条真实业务商品基线

## 状态

**等待人工真值集。** 本轮不伪造商品、标签或准确率；30 条真实业务商品和 5–15% 拒答率不作为本轮完成门槛。

## 每条必填字段

| 字段 | 说明 |
| --- | --- |
| `caseId` | 稳定、不含业务隐私的编号 |
| `productDescription` | 实际收到的商品描述（必要时脱敏） |
| `knownAttributes` | 材质、结构、用途、参数等已知信息 |
| `truthCode` | 由有资质人员确认的 10 位 HS 编码 |
| `truthBasis` | 真值来源：预归类决定、历史报关单、复核意见等 |
| `reviewer` | 真值确认人或团队 |
| `reviewedAt` | 真值确认日期 |
| `expectedRefusal` | 是否应当拒答，以及原因 |
| `actualTop3` | 系统候选前三 |
| `actualSelected` | P2 最终结论，或拒答 |
| `questionsAndAnswers` | P1 问题、人工回答和自由文本 |
| `unconfirmed` | 未确认属性 |
| `planLatencyMs` | 首轮/第二轮规划耗时 |
| `totalLatencyMs` | P1/P2 端到端耗时 |
| `result` | `top1` / `top3` / `miss` / `correct_refusal` / `wrong_refusal` |
| `notes` | 误差原因、特殊交易条件或待复核项 |

## 统计口径

- 前三命中率仅在 30 条真值均完成双人复核后计算。
- 拒答率 = 拒答条数 / 总条数，同时分别报告正确拒答和错误拒答。
- 任何缺失 `truthCode` 或 `truthBasis` 的条目不进入准确率分母。
