import { installSessionRoleStore } from './session-role-store.mjs';
const fail = (code, message) => Object.assign(new Error(message), { code });
const json = value => JSON.stringify(value);

/** BenchGo-owned metadata. Never extend the official Session event format. */
export function installWorkerExecutionStore({ db, tx, api }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_worker_execution_state(
    run_id TEXT PRIMARY KEY REFERENCES sa_runs(id), models TEXT NOT NULL, model_index INTEGER NOT NULL,
    updated_at TEXT NOT NULL, fallback_plan TEXT)`);
  const state = runId => {
    const row = db.prepare('SELECT * FROM sa_worker_execution_state WHERE run_id=?').get(runId);
    return row ? { models: JSON.parse(row.models), index: row.model_index,
      fallbackPlan: row.fallback_plan ? JSON.parse(row.fallback_plan) : null } : null;
  };
  const identity = ({ assignmentId, runId, owner, fence }) => {
    const assignment = api.getAssignment(assignmentId), run = api.runs(assignmentId).find(item => item.id === runId);
    if (!assignment || assignment.state !== 'claimed' || assignment.owner !== owner || assignment.fence !== fence || assignment.leaseUntil <= Date.now()
      || !run || run.owner !== owner || run.fence !== fence || !['prepared', 'submitted', 'running'].includes(run.state)) throw fail('FENCING_CONFLICT', 'Worker execution metadata owner changed');
    return { assignment, run };
  };
  return {
    ...installSessionRoleStore({ db, tx, api }),
    getWorkerExecutionState: state,
    freezeWorkerModelRoute(input) {
      return tx(() => {
        identity(input);
        const prior = state(input.runId);
        if (prior) return prior;
        if (!Array.isArray(input.models) || !input.models.length || input.models.some(model => !model?.providerId || !model?.modelId)
          || !Number.isSafeInteger(input.index) || !input.models[input.index]) throw fail('WORKER_MODEL_ROUTE', 'Invalid frozen Worker model route');
        db.prepare('INSERT INTO sa_worker_execution_state(run_id,models,model_index,updated_at,fallback_plan) VALUES (?,?,?,?,?)').run(input.runId, json(input.models), input.index, new Date().toISOString(), null);
        return state(input.runId);
      });
    },
    selectWorkerModelRoute(input) {
      return tx(() => {
        identity(input);
        const prior = state(input.runId);
        if (!prior || !Number.isSafeInteger(input.index) || !prior.models[input.index]) throw fail('WORKER_MODEL_ROUTE', 'Worker model is outside its frozen queue');
        db.prepare('UPDATE sa_worker_execution_state SET model_index=?,updated_at=? WHERE run_id=?').run(input.index, new Date().toISOString(), input.runId);
        return state(input.runId);
      });
    },
    recordWorkerFallback(input) {
      return tx(() => {
        identity(input);
        if (!state(input.runId)) throw fail('WORKER_MODEL_ROUTE', 'Frozen Worker route is unavailable');
        db.prepare('UPDATE sa_worker_execution_state SET fallback_plan=?,updated_at=? WHERE run_id=?').run(json(input.plan), new Date().toISOString(), input.runId);
        return state(input.runId).fallbackPlan;
      });
    },
  };
}
