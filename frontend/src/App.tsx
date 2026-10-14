import { useEffect, useState } from 'react';
import { ApiError, getHealth, type HealthResponse } from './api/client';
import { GAME_STAGES } from './data/stages';

type ApiState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly data: HealthResponse }
  | { readonly kind: 'error'; readonly message: string; readonly status?: number };

/**
 * Phase 2 screen.
 *
 * Still not a game UI — that is Phase 4. What this does prove is the full
 * delivery path in one page load: CloudFront → (proxied) API Gateway → Lambda →
 * DynamoDB. If the connectivity card is green, the whole chain is live.
 */
function useApiHealth(): ApiState {
  const [state, setState] = useState<ApiState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    getHealth(controller.signal)
      .then((data) => setState({ kind: 'ok', data }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError) {
          setState({ kind: 'error', message: err.message, status: err.status });
        } else {
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });

    return () => controller.abort();
  }, []);

  return state;
}

function ConnectivityCard() {
  const state = useApiHealth();

  if (state.kind === 'loading') {
    return (
      <section className="card">
        <h2>API 连通性</h2>
        <p className="muted">正在连接 API…</p>
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className="card boundary">
        <h2>API 连通性</h2>
        <div className="status-row">
          <span className="badge badge-err">连接失败</span>
          {state.status !== undefined && <span className="muted">HTTP {state.status}</span>}
        </div>
        <p className="muted">{state.message}</p>
        <p className="muted">
          若本地开发时看到此项失败，请确认已在 <code>frontend/.env.local</code> 中设置
          <code> VITE_API_PROXY_TARGET</code>。
        </p>
      </section>
    );
  }

  const { data } = state;
  return (
    <section className="card">
      <h2>API 连通性</h2>
      <div className="status-row">
        <span className="badge badge-ok">连接正常</span>
        <span className="muted">{data.description}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>阶段</dt>
          <dd>
            Phase {data.phase} · {data.stage}
          </dd>
        </div>
        <div>
          <dt>区域</dt>
          <dd>{data.region}</dd>
        </div>
        <div>
          <dt>DynamoDB 表</dt>
          <dd className="mono">{data.tableName}</dd>
        </div>
        <div>
          <dt>事件池</dt>
          <dd>{data.catalogEvents} 个事件</dd>
        </div>
      </dl>
      <p className="muted small">{data.disclaimer}</p>
    </section>
  );
}

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
          <span className="badge badge-warn">Phase 2</span>
          <span>规则引擎驱动的照护模拟 — 游戏界面待 Phase 4</span>
        </div>
        <p className="muted">
          五阶段照护循环已由规则引擎实现，且<strong>完全不依赖 LLM</strong>。Agent 与长期记忆将在
          Phase 3 引入。
        </p>
      </section>

      <ConnectivityCard />

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
        <span>Phase 2 · v0.3.0</span>
      </footer>
    </div>
  );
}
