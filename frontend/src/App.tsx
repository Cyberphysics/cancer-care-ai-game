import { useEffect, useState } from 'react';
import { ApiError, getHealth } from './api/client';
import type { HealthResponse } from './api/types';
import GameApp from './game/GameApp';

type ApiState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly data: HealthResponse }
  | { readonly kind: 'error'; readonly message: string; readonly status?: number };

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

/**
 * Connection card — kept, but demoted to the footer.
 *
 * It is the one thing on the page that proves the whole delivery path in a single
 * request: CloudFront → (proxied) API Gateway → Lambda → DynamoDB. If this is
 * green, every other call on the page has a working chain behind it. It is no
 * longer the main event now that there is an actual game to play.
 */
function ConnectivityCard() {
  const state = useApiHealth();

  if (state.kind === 'loading') {
    return (
      <section className="card">
        <h2>链路自检</h2>
        <p className="muted">正在连接 API…</p>
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className="card boundary">
        <h2>链路自检</h2>
        <div className="status-row">
          <span className="badge badge-err">连接失败</span>
          {state.status !== undefined && <span className="muted">HTTP {state.status}</span>}
        </div>
        <p className="muted">{state.message}</p>
        <p className="muted small">
          本地开发时若此项失败，请确认 <code>frontend/.env.local</code> 里的{' '}
          <code>VITE_API_PROXY_TARGET</code> 指向已部署的 API。
        </p>
      </section>
    );
  }

  const { data } = state;
  return (
    <section className="card">
      <h2>链路自检</h2>
      <div className="status-row">
        <span className="badge badge-ok">CloudFront → API → Lambda → DynamoDB 全通</span>
      </div>
      <dl className="facts">
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

      <GameApp />

      <ConnectivityCard />

      <section className="card boundary">
        <h2>安全边界</h2>
        <p className="muted">
          本游戏仅用于健康教育。不提供医疗诊断、个体治疗方案、药物推荐或生存预测。
          所有病例均为合成病例，不含真实患者资料。任何健康决策请咨询专业医生。
        </p>
      </section>

      <footer className="footer">
        <span>Phase 3 · 游戏由规则引擎驱动，AI 仅作叙事叠加层</span>
      </footer>
    </div>
  );
}
