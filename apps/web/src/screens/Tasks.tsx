import type { ApprovalDto, ProjectDto, ReminderDto, RunDto, TodoDto } from '@aminchat/shared';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { ApprovalCard } from '../components/ApprovalCard';
import { Icon } from '../components/Icon';
import { RunPanel, StatusChip } from '../components/RunPanel';
import { AgentPicker } from '../components/pickers';
import { Button, ConfirmDialog, EmptyState, ErrorBanner, IconButton, Segmented, Spinner } from '../components/ui';
import { Ai } from '../lib/endpoints';
import { fmtDateTime } from '../lib/format';
import { useErrorText, useLocale, useT } from '../lib/i18n';
import { realtime } from '../lib/realtime';
import { navigate } from '../lib/router';
import { isActiveRun, mergeApproval, mergeStep, newerRun } from '../lib/runs';
import { useAgents } from '../state/ai';
import { useAiConversation } from '../state/conversations';
import { toast } from '../state/toast';

type View = 'tasks' | 'todos' | 'reminders' | 'projects';

type RunMap = Record<string, RunDto>;
type RunAction = { type: 'set'; runs: RunDto[] } | { type: 'run'; run: RunDto } | { type: 'step'; runId: string; step: RunDto['steps'][number] } | { type: 'approval'; approval: ApprovalDto };
function runsReducer(s: RunMap, a: RunAction): RunMap {
  switch (a.type) {
    case 'set': {
      const next: RunMap = { ...s };
      for (const r of a.runs) next[r.id] = newerRun(next[r.id], r);
      return next;
    }
    case 'run':
      return { ...s, [a.run.id]: newerRun(s[a.run.id], a.run) };
    case 'step':
      return s[a.runId] ? { ...s, [a.runId]: mergeStep(s[a.runId]!, a.step) } : s;
    case 'approval':
      return s[a.approval.runId] ? { ...s, [a.approval.runId]: mergeApproval(s[a.approval.runId]!, a.approval) } : s;
  }
}

function TasksView() {
  const t = useT();
  const errText = useErrorText();
  const { data: agents } = useAgents();
  const aiConv = useAiConversation();
  const [runs, dispatch] = useReducer(runsReducer, {});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [goal, setGoal] = useState('');
  const [agentId, setAgentId] = useState('auto');
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, f] = await Promise.all([Ai.runs('active', 50), Ai.runs('finished', 20)]);
      dispatch({ type: 'set', runs: [...a.runs, ...f.runs] });
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const off = realtime.on((ev) => {
      if (ev.type === 'run.updated') dispatch({ type: 'run', run: ev.run });
      else if (ev.type === 'run.step') dispatch({ type: 'step', runId: ev.runId, step: ev.step });
      else if (ev.type === 'run.approval') dispatch({ type: 'approval', approval: ev.approval });
    });
    const offResync = realtime.onResync(() => void load());
    return () => {
      off();
      offResync();
    };
  }, [load]);

  const all = useMemo(() => Object.values(runs).sort((a, b) => b.createdAt - a.createdAt), [runs]);
  const active = all.filter((r) => isActiveRun(r));
  const finished = all.filter((r) => !isActiveRun(r));
  const waiting = active.flatMap((r) => r.approvals.filter((a) => a.status === 'pending'));

  async function start() {
    if (!goal.trim()) return;
    setStarting(true);
    try {
      const res = await Ai.createTask({ goal: goal.trim(), agentId });
      dispatch({ type: 'run', run: res.run });
      setGoal('');
      toast(t('tasks.started'), 'success');
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="stack">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <h3>
          <Icon name="plus" size={18} /> {t('tasks.new')}
        </h3>
        <label htmlFor="task-goal" className="sr-only">
          {t('tasks.goal')}
        </label>
        <textarea id="task-goal" dir="auto" rows={3} value={goal} placeholder={t('tasks.goalPlaceholder')} onChange={(e) => setGoal(e.target.value)} />
        <div className="row">
          <AgentPicker agents={agents ?? []} value={agentId} onChange={setAgentId} />
          <Button type="submit" variant="primary" icon="send" busy={starting} disabled={!goal.trim()}>
            {t('tasks.start')}
          </Button>
        </div>
      </form>

      {error != null && <ErrorBanner text={errText(error)} onRetry={() => void load()} />}
      {loading && <Spinner label={t('common.loading')} />}

      {waiting.length > 0 && (
        <section aria-label={t('approval.pending')}>
          <h3>{t('approval.pending')}</h3>
          {waiting.map((a) => (
            <ApprovalCard key={a.id} approval={a} onDecided={() => void load()} />
          ))}
        </section>
      )}

      <section aria-label={t('tasks.active')}>
        <h3>{t('tasks.active')}</h3>
        {active.length === 0 && !loading && <p className="muted">{t('tasks.noneActive')}</p>}
        {active.map((r) => (
          <RunCard key={r.id} run={r} aiConversationId={aiConv?.id} onChanged={() => void load()} />
        ))}
      </section>

      <section aria-label={t('tasks.recent')}>
        <h3>{t('tasks.recent')}</h3>
        {finished.length === 0 && !loading && <p className="muted">{t('tasks.noneRecent')}</p>}
        {finished.map((r) => (
          <RunCard key={r.id} run={r} aiConversationId={aiConv?.id} onChanged={() => void load()} />
        ))}
      </section>
    </div>
  );
}

function RunCard({ run, onChanged }: { run: RunDto; aiConversationId?: string; onChanged: () => void }) {
  const t = useT();
  const locale = useLocale();
  const errText = useErrorText();
  const [busy, setBusy] = useState(false);
  const retryable = run.kind !== 'assist' && !!run.threadId && (run.status === 'failed' || run.status === 'cancelled');
  return (
    <article className="task-card" data-testid="task-card" data-status={run.status}>
      <header className="task-card-head">
        <div className="task-goal" dir="auto">
          {run.goal}
        </div>
        <StatusChip status={run.status} />
      </header>
      <div className="muted small">
        {fmtDateTime(run.createdAt, locale)}
        {run.resolvedAgentId && run.resolvedAgentId !== run.agentId ? ` · ${run.resolvedAgentId}` : ` · ${run.agentId}`}
      </div>
      <RunPanel run={run} compact={false} onChanged={onChanged} />
      <div className="row">
        {run.threadId && (
          <Button variant="ghost" icon="chat" onClick={() => navigate(`/ai/${run.threadId}`)}>
            {t('tasks.open')}
          </Button>
        )}
        {retryable && (
          <Button
            variant="ghost"
            icon="refresh"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await Ai.retryRun(run.id);
                onChanged();
              } catch (err) {
                toast(errText(err), 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('tasks.retry')}
          </Button>
        )}
      </div>
    </article>
  );
}

function TodosView() {
  const t = useT();
  const locale = useLocale();
  const errText = useErrorText();
  const [status, setStatus] = useState<'open' | 'done'>('open');
  const [todos, setTodos] = useState<TodoDto[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => Ai.todos(status).then((r) => (setTodos(r.todos), setError(null))).catch(setError), [status]);
  useEffect(() => {
    setTodos(null);
    void load();
  }, [load]);
  return (
    <div className="stack">
      <Segmented label={t('todos.title')} value={status} onChange={setStatus} options={[{ value: 'open', label: t('todos.open') }, { value: 'done', label: t('todos.done') }]} />
      {error != null && <ErrorBanner text={errText(error)} onRetry={() => void load()} />}
      {!todos && !error && <Spinner />}
      {todos && todos.length === 0 && <EmptyState icon="tasks" title={status === 'open' ? t('todos.emptyOpen') : t('todos.emptyDone')} text={t('todos.hint')} />}
      <ul className="list">
        {(todos ?? []).map((td) => (
          <li key={td.id} className="list-row">
            <label className="todo">
              <input
                type="checkbox"
                checked={td.status === 'done'}
                onChange={async (e) => {
                  try {
                    await Ai.setTodo(td.id, e.target.checked ? 'done' : 'open');
                    void load();
                  } catch (err) {
                    toast(errText(err), 'error');
                  }
                }}
              />
              <span className="list-main">
                <strong dir="auto" className={td.status === 'done' ? 'struck' : ''}>
                  {td.title}
                </strong>
                <span className="muted small">
                  {td.priority !== 'normal' ? `${t(`todos.priority.${td.priority}` as never)} · ` : ''}
                  {td.dueAt ? t('todos.due', { time: fmtDateTime(td.dueAt, locale) }) : ''}
                  {td.project ? ` · ${td.project}` : ''}
                </span>
                {td.notes && (
                  <span className="muted small" dir="auto">
                    {td.notes}
                  </span>
                )}
              </span>
            </label>
            <IconButton
              icon="trash"
              size={16}
              label={t('common.delete')}
              onClick={async () => {
                try {
                  await Ai.deleteTodo(td.id);
                  void load();
                } catch (err) {
                  toast(errText(err), 'error');
                }
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RemindersView() {
  const t = useT();
  const locale = useLocale();
  const errText = useErrorText();
  const [items, setItems] = useState<ReminderDto[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => Ai.reminders('all').then((r) => (setItems(r.reminders), setError(null))).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="stack">
      {error != null && <ErrorBanner text={errText(error)} onRetry={() => void load()} />}
      {!items && !error && <Spinner />}
      {items && items.length === 0 && <EmptyState icon="bell" title={t('reminders.empty')} text={t('reminders.hint')} />}
      <ul className="list">
        {(items ?? []).map((r) => (
          <li key={r.id} className="list-row">
            <div className="list-item static">
              <Icon name="bell" size={20} />
              <span className="list-main">
                <strong dir="auto">{r.text}</strong>
                <span className="muted small">
                  {fmtDateTime(r.remindAt, locale)} · {t(`reminders.status.${r.status}` as never)}
                </span>
              </span>
            </div>
            {r.status === 'scheduled' && (
              <IconButton
                icon="x"
                size={16}
                label={t('reminders.cancel')}
                onClick={async () => {
                  try {
                    await Ai.deleteReminder(r.id);
                    void load();
                  } catch (err) {
                    toast(errText(err), 'error');
                  }
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectsView() {
  const t = useT();
  const errText = useErrorText();
  const [items, setItems] = useState<ProjectDto[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [del, setDel] = useState<ProjectDto | null>(null);
  const load = useCallback(() => Ai.projects().then((r) => (setItems(r.projects), setError(null))).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="stack">
      {error != null && <ErrorBanner text={errText(error)} onRetry={() => void load()} />}
      {!items && !error && <Spinner />}
      {items && items.length === 0 && <EmptyState icon="list" title={t('projects.empty')} text={t('projects.hint')} />}
      {(items ?? []).map((p) => (
        <article key={p.id} className="panel">
          <header className="row between">
            <h3 dir="auto">{p.name}</h3>
            <span className="chip">{t(`projects.status.${p.status}` as never)}</span>
          </header>
          {p.goal && (
            <p dir="auto" className="muted">
              {p.goal}
            </p>
          )}
          <ul className="milestones">
            {p.milestones.map((m, i) => (
              <li key={i} className={m.done ? 'done' : ''}>
                <Icon name={m.done ? 'check' : 'clock'} size={14} /> <span dir="auto">{m.title}</span>
                {m.due && <span className="muted small"> · {m.due}</span>}
              </li>
            ))}
          </ul>
          <Button variant="ghost" icon="trash" onClick={() => setDel(p)}>
            {t('common.delete')}
          </Button>
        </article>
      ))}
      <ConfirmDialog
        open={del !== null}
        danger
        title={t('projects.delete')}
        text={t('projects.deleteConfirm', { name: del?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onClose={() => setDel(null)}
        onConfirm={async () => {
          const p = del;
          setDel(null);
          if (!p) return;
          try {
            await Ai.deleteProject(p.id);
            void load();
          } catch (err) {
            toast(errText(err), 'error');
          }
        }}
      />
    </div>
  );
}

export function TasksScreen() {
  const t = useT();
  const [view, setView] = useState<View>('tasks');
  return (
    <section className="page" aria-label={t('nav.tasks')}>
      <header className="page-head">
        <h1>{t('nav.tasks')}</h1>
      </header>
      <div className="page-body">
        <Segmented
          label={t('nav.tasks')}
          value={view}
          onChange={setView}
          options={[
            { value: 'tasks', label: t('tasks.tab.tasks') },
            { value: 'todos', label: t('tasks.tab.todos') },
            { value: 'reminders', label: t('tasks.tab.reminders') },
            { value: 'projects', label: t('tasks.tab.projects') },
          ]}
        />
        {view === 'tasks' && <TasksView />}
        {view === 'todos' && <TodosView />}
        {view === 'reminders' && <RemindersView />}
        {view === 'projects' && <ProjectsView />}
      </div>
    </section>
  );
}
