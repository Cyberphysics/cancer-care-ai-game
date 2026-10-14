import { GAME_STAGES } from './data/stages';

/**
 * Phase 0 placeholder screen.
 *
 * It exists to prove the delivery path — Vite build → S3 → CloudFront — not to
 * play the game. Everything below is static presentation.
 */
export default function App() {
  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">AWS UG China Challenge · MVP</p>
        <h1>CancerCare AI Game</h1>
        <p className="subtitle">生命守护者 · 由 AI Agent 驱动的肿瘤健康照护模拟游戏</p>
      </header>

      <section className="card status">
        <div className="status-row">
          <span className="badge badge-warn">Phase 0</span>
          <span>项目骨架 — 尚无游戏逻辑，尚无 Agent</span>
        </div>
        <p className="muted">
          当前版本仅打通「前端构建 → S3 → CloudFront」与「API Gateway → Lambda → DynamoDB」两条链路。
          五阶段照护循环、事件引擎与 AgentCore 集成将分别在 Phase 2 / Phase 3 落地。
        </p>
      </section>

      <section className="card">
        <h2>照护生命周期</h2>
        <ol className="stepper">
          {GAME_STAGES.map((stage) => (
            <li key={stage.key}>
              <span className="step-index">{stage.index + 1}</span>
              <span className="step-name">{stage.titleZh}</span>
              <span className="step-en">{stage.titleEn}</span>
            </li>
          ))}
        </ol>
        <p className="muted">
          MVP 聚焦肺癌单一癌种，玩家扮演「家庭健康守护者」，目标是提升患者生活质量（QoL），
          而非癌症治愈率。
        </p>
      </section>

      <section className="card boundary">
        <h2>安全边界</h2>
        <p className="muted">
          本游戏仅用于健康教育。不提供医疗诊断、个体治疗方案、药物推荐或生存预测。
          所有病例均为合成病例，不含真实患者资料。任何健康决策请咨询专业医生。
        </p>
      </section>

      <footer className="footer">
        <span>Phase 0 skeleton · v0.1.0</span>
      </footer>
    </div>
  );
}
