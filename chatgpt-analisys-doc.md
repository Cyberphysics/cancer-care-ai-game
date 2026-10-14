下面文档定位为 **交给 Claude Code + DeepSeek 执行开发的项目设计文档**。

目标不是写一份营销方案，而是作为 AI Coding Agent 的输入规格，帮助 Agent 理解：

- 为什么做这个项目
- MVP 做什么、不做什么
- 游戏循环是什么
- AgentCore 如何使用
- 数据模型如何设计
- AWS 如何部署
- 后续开发任务如何拆解

---

# CancerCare AI Game

## MVP Game Design Document (GDD)

### + Agent Architecture Design

Version: v0.1  
Target Platform: AWS UG CN Challenge  
Target Technology: Amazon Bedrock AgentCore  
Development Agent: Claude Code + DeepSeek V3.2

---

# 1. 项目概述

## 1.1 项目名称

英文：

```
CancerCare AI Game
```

中文：

```
生命守护者
—— 一个由 AI Agent 驱动的肿瘤健康照护模拟游戏
```

---

# 1.2 项目背景

癌症相关知识具有以下特点：

- 信息复杂
- 医学专业门槛高
- 患者和家属容易产生焦虑
- 长期照护需要持续学习和管理

传统健康教育：

- 文章
- 视频
- FAQ

存在问题：

- 被动接受
- 缺少互动
- 缺少情境模拟
- 难以形成行为改变


CancerCare AI Game 希望探索：

> 是否可以通过 AI Agent + 游戏化设计，让普通用户在模拟照护过程中学习正确的健康管理知识？

---

# 1.3 产品定位

不是：

❌ AI 医生  
❌ 癌症预测工具  
❌ 治疗方案推荐系统  
❌ 临床决策辅助系统


而是：

✅ 健康教育游戏  
✅ 家庭照护模拟训练  
✅ 肿瘤生命周期科普体验  
✅ AI Agent 驱动的互动故事


---

# 1.4 AWS Challenge 技术目标

展示：

Amazon Bedrock AgentCore 如何支持：

- 多 Agent 协作
- 长期 Memory
- 工具调用
- 状态管理
- 个性化剧情生成


核心问题：

> 如何利用 AgentCore 创建一个能够理解玩家行为、管理游戏状态、动态生成剧情的 AI 游戏系统？

---

# 2. MVP 游戏目标

## 2.1 MVP 范围

第一版本只实现：

```
肺癌照护模拟
```

原因：

- 肺癌是常见癌症
- 有明确生命周期
- 与真实家庭照护场景高度相关
- 可以覆盖：

预防 → 检查 → 诊断 → 治疗 → 康复 → 长期管理


---

# 2.2 玩家身份

玩家：

```
家庭健康守护者
```

不是医生。

玩家任务：

帮助一个虚拟患者角色：

- 做健康决策
- 管理检查
- 组织资料
- 安排生活
- 提供心理支持


---

# 2.3 游戏目标

最终目标：

提高：

```
Quality Of Life (QoL)
生活质量
```

而不是：

```
Cancer Cure Rate
癌症治愈率
```

避免医疗误导。


---

# 3. 核心游戏循环 (Game Loop)

整体循环：

```
创建患者角色

        ↓

AI生成健康背景

        ↓

每日事件发生

        ↓

玩家做决策

        ↓

Agent评估影响

        ↓

更新患者状态

        ↓

生成下一阶段剧情

        ↓

直到完成整个生命周期模拟
```

---

# 4. 游戏流程设计

## Stage 1: Prevention

## 预防阶段


玩家开始：

虚拟角色：

```
姓名:
王先生

年龄:
55

职业:
办公室员工

风险因素:
- 长期吸烟
- 缺少运动
- 饮食不规律
```


事件：

```
最近持续咳嗽两个月
```

---

玩家选择：

A:

```
认为只是小问题，继续观察
```

B:

```
预约医院检查
```

C:

```
自行购买药物
```

---

Agent反馈：

根据医学常识生成：

- 风险解释
- 后续事件
- 科普内容


---

## Stage 2: Screening

## 检查阶段


事件：

```
体检发现肺部异常影像
```


玩家需要：

- 保存检查资料
- 预约进一步检查
- 理解报告


Agent：

解释：

- CT
- 活检
- 病理


---

## Stage 3: Diagnosis

## 诊断阶段


事件：

```
病理确认肺癌
```


玩家任务：

- 理解疾病信息
- 整理医疗资料
- 与医生沟通


---

## Stage 4: Treatment

## 治疗阶段


模拟：

- 手术
- 放疗
- 靶向治疗
- 化疗


注意：

游戏不模拟：

```
某药提高多少生存率
```

而模拟：

```
治疗过程中的管理挑战
```

例如：

- 药物记录
- 复诊安排
- 营养管理


---

## Stage 5: Recovery

## 康复阶段


玩家管理：

```
睡眠
饮食
运动
心理状态
复查
家庭支持
```


---

# 5. 患者状态模型

核心数据：

PatientState


```json
{
"id":"patient001",

"profile":{

"age":65,

"gender":"male",

"riskFactors":[
"smoking",
"sedentary"
]

},


"health":{

"qualityOfLife":70,

"energy":60,

"stress":30,

"nutrition":70

},


"care":

{

"medicalRecords":[],
"tasks":[],
"appointments":[]

},


"relationship":

{

"familySupport":60

},


"timeline":[]

}
```


---

# 6. 游戏事件系统

## Event Model


```json
{
"id":"event001",

"type":"medical",

"stage":"diagnosis",

"description":

"检查发现异常"


"choices":[

{

"id":"A",

"text":

"继续观察"

},

{

"id":"B",

"text":

"预约进一步检查"

}

]

}
```


---

# 7. Agent 设计

## 7.1 Agent 总体架构


```
                Player

                  |

             Game Frontend

                  |

              API Gateway

                  |

          AgentCore Runtime

                  |

       ----------------------

       |          |          |

 GameMaster  Doctor   Nurse

       |

  Memory

       |

 DynamoDB
```


---

# 8. Agent 角色设计


# Agent 1

## GameMaster Agent

职责：

游戏导演。


能力：

- 创建事件
- 推进剧情
- 判断玩家行为影响
- 生成下一步任务


Tools:

```
get_patient_state()

update_patient_state()

generate_event()

```


---

# Agent 2

## Medical Education Agent


职责：

医学知识解释。


能力：

回答：

- 什么是肺癌筛查？
- 为什么需要病理？
- 什么是靶向治疗？


限制：

不能：

- 诊断
- 推荐治疗方案
- 替代医生


Tools:

```
query_medical_knowledge()
```


---

# Agent 3

## Care Assistant Agent


职责：

家庭照护助手。


能力：

生成：

- 日常任务
- 情绪支持
- 康复建议


Tools:

```
create_task()

get_tasks()

```


---

# 9. AgentCore 使用设计

## 9.1 AgentCore Runtime

用途：

运行：

```
GameMaster Agent
```

负责：

- Agent workflow
- tool calling
- state management


---

## 9.2 AgentCore Memory


用途：

保存：

玩家长期偏好：

例如：

```
玩家喜欢：

详细解释

希望挑战难度高

关注营养管理
```


以及：

```
当前游戏进度
```

注意：

游戏状态主要保存 DynamoDB。

Memory 不作为唯一数据库。

---

## 9.3 AgentCore Gateway


暴露游戏工具。


Example:

### get_player_state


Input:

```json
{
"userId":"001"
}
```


Output:

```json
{
"QoL":80,
"stage":"Treatment"
}
```


---

### update_game_state


Input:

```json
{

"stress":-10,

"nutrition":+5

}
```


---

# 10. AWS 架构设计


```
                 CloudFront

                     |

                    S3

              React Game UI


                     |

              API Gateway


                     |

                 Lambda


                     |

        ----------------------

        |                    |

    DynamoDB              S3


                     |

              AgentCore Runtime


                     |

              Bedrock Models


                     |

             AgentCore Memory

```


---

# 11. AWS 服务职责


|服务|用途|
|-|-|
|S3|游戏资源、图片、配置|
|CloudFront|静态资源加速|
|API Gateway|API入口|
|Lambda|业务逻辑|
|DynamoDB|游戏状态|
|Bedrock|LLM|
|AgentCore Runtime|Agent执行|
|AgentCore Memory|长期记忆|
|AgentCore Gateway|工具调用|
|CloudWatch|监控|

---

# 12. 数据模型


## Player


```json
{
playerId,
nickname,
createdAt
}
```


---

## GameSession


```json
{
sessionId,

playerId,

patientId,

currentStage,

score

}
```


---

## PatientState


```json
{
patientId,

health,

timeline,

tasks

}
```


---

## EventHistory


```json
{
eventId,

choice,

impact,

timestamp
}
```


---

# 13. MVP 功能列表


## P0 必须实现


### 游戏

- 创建患者
- 开始游戏
- 事件展示
- 玩家选择
- 状态变化
- AI生成反馈


### Agent

- GameMaster Agent
- Tool calling
- Memory


### AWS

- IaC部署
- DynamoDB
- Lambda
- Bedrock调用


---

# P1 增强


- 多患者角色
- 随机事件
- 成就系统
- 图形化状态


---

# P2


- 多癌种
- 多Agent社会模拟
- 家庭多人协作


---

# 14. 开发任务拆解


## Phase 1

基础项目


任务：

```
初始化React项目

初始化CDK

创建AWS资源

创建DynamoDB模型

```


---

## Phase 2

游戏核心


实现：

```
PatientState

Event Engine

Choice System

```


---

## Phase 3

Agent


实现：

```
AgentCore Runtime

GameMaster Agent

Tools

Memory
```


---

## Phase 4

前端


页面：

```
首页

患者创建

游戏界面

状态面板

AI聊天窗口

```


---

## Phase 5

部署


完成：

```
cdk bootstrap

cdk deploy

frontend deploy

demo script
```


---

# 15. Demo 演示流程（AWS UG文章）


5分钟 Demo：


## 1

创建角色


```
55岁男性
长期吸烟
```


---

## 2

触发事件


```
持续咳嗽
```


---

## 3

玩家选择


```
主动检查
```


---

## 4

Agent生成反馈


```
解释早筛意义
```


---

## 5

进入治疗阶段


玩家管理：

- 复查
- 饮食
- 心理


---

## 6

最终总结


Agent输出：

```
你的照护策略：

优势:
- 及时检查
- 资料整理

不足:
- 心理支持不足

健康教育建议:
...
```


---

# 16. 安全边界


必须明确：

游戏：

✅ 健康教育

不提供：

❌ 医疗诊断  
❌ 个体治疗方案  
❌ 药物推荐  
❌ 生存预测  


所有医学内容：

- 使用公开医学资料
- 标注来源
- 引导咨询专业医生


---

# 17. 给 Claude Code 的开发原则


请遵循：

1. 优先实现 MVP，不提前设计复杂系统。

2. 所有 AWS 资源使用 IaC。

3. 所有 Agent Tool 必须：
   - 明确定义输入输出
   - 最小权限
   - 可测试

4. 游戏状态必须由 DynamoDB 管理。

5. Agent 不能直接修改关键状态，必须经过后端校验。

6. 使用合成病例，不上传真实患者资料。

7. README 必须包含：
   - 架构图
   - 部署步骤
   - Demo流程
   - AWS服务说明


---

# 项目最终目标

构建：

> 一个基于 Amazon Bedrock AgentCore 的 AI 健康教育模拟游戏，通过多 Agent 协作和长期记忆，让玩家在互动剧情中学习癌症预防、诊断、治疗支持和家庭照护知识。


这个项目的核心不是“让 AI 看病”，而是展示：

> **Agent 如何成为一个有状态、有记忆、有工具、有规则约束的智能游戏角色系统。**

---

以上文档可以直接作为 Claude Code 的第一份项目输入。建议下一步让 Claude Code 先生成：

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `infra/cdk` 基础设施
4. MVP Git roadmap

不要一开始让它写全部代码，否则 DeepSeek 类模型容易在没有项目骨架的情况下过度实现。