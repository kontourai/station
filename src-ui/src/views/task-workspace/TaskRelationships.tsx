import type {
  TaskChildCreateInput,
  TaskRecord,
  TaskWorkChatMutationInput,
} from '@kontourai/station-contracts/task-graph';
import {
  MAX_TASK_TITLE_LENGTH,
  taskStatusLabel,
} from '@kontourai/station-contracts/task-graph';
import { fetchConversationInventory } from '@kontourai/station-sdk';
import { fetchTaskWorkChat } from '@kontourai/station-sdk/client/task-relationships';
import {
  type TaskRelationshipScope,
  useCreateTaskChildMutation,
  useSetTaskWorkChatMutation,
  useTaskChildrenQuery,
  useTaskWorkChatsQuery,
} from '@kontourai/station-sdk/task-relationships';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, SkeletonList } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { openChatsStore } from '../../contexts/open-chats-store';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import {
  chatIntent,
  childIntent,
  useRetainedRelationship,
} from './useRetainedRelationship';

export function TaskRelationships({
  task,
  kind,
}: {
  task: TaskRecord;
  kind: 'children' | 'work-chats';
}) {
  const scope = useHostRequestAuthorityScope();
  const recoveryKey = JSON.stringify([
    scope?.apiBase,
    scope?.draftRecoveryKey ?? scope?.authorityKey,
    task.id,
    task.createdAt,
    task.projectId,
  ]);
  // Live activation changes still retire mounted work, but not saved retry intent.
  const key = JSON.stringify([recoveryKey, scope?.authorityKey]);
  useLayoutEffect(() => {
    try {
      if (
        sessionStorage.getItem('station-task-relationship:scope') ===
        recoveryKey
      )
        return;
      for (const panel of ['children', 'work-chats']) {
        try {
          sessionStorage.removeItem(`station-task-relationship:${panel}`);
        } catch {
          /* New scope cannot restore the old envelope. */
        }
      }
      sessionStorage.setItem('station-task-relationship:scope', recoveryKey);
    } catch {
      /* Sending still requires successful storage. */
    }
  }, [recoveryKey]);
  if (!scope) return <p>Task relationships unavailable.</p>;
  return kind === 'children' ? (
    <Subtasks key={key} task={task} scope={scope} scopeKey={recoveryKey} />
  ) : (
    <WorkChats key={key} task={task} scope={scope} scopeKey={recoveryKey} />
  );
}
const identity = (task: TaskRecord) => ({
  taskId: task.id,
  taskCreatedAt: task.createdAt,
});

function Subtasks({
  task,
  scope,
  scopeKey,
}: {
  task: TaskRecord;
  scope: TaskRelationshipScope;
  scopeKey: string;
}) {
  const { navigate } = useNavigation();
  const children = useTaskChildrenQuery(identity(task), scope);
  const create = useCreateTaskChildMutation(scope);
  const [title, setTitle] = useState('');
  const retained = useRetainedRelationship(
    'children',
    scopeKey,
    childIntent.refine(
      (input) =>
        input.parent.taskId === task.id &&
        input.parent.taskCreatedAt === task.createdAt &&
        input.task.projectId === task.projectId,
    ),
  );
  const { request } = retained;
  const [destination, setDestination] = useState('');
  const { DiscardModal } = useUnsavedGuard(!!title || !!request, () => {
    if (!retained.clear()) return false;
    setTitle('');
    return true;
  });
  useEffect(() => {
    if (destination) navigate(destination);
  }, [destination, navigate]);
  function submit(input: TaskChildCreateInput) {
    if (!scope.isCurrent() || !retained.isActive()) return;
    if (!retained.retain(input) || retained.blocked) return;
    create.mutate(input, {
      onSuccess: (result) => {
        if (!scope.isCurrent() || !retained.isActive()) return;
        if (!retained.clear()) return;
        setTitle('');
        setDestination(`/tasks/${encodeURIComponent(result.task.id)}`);
      },
    });
  }
  return (
    <section className="task-relationships" aria-label="Subtasks">
      <h2>Subtasks</h2>
      {children.isLoading && (
        <SkeletonList count={2} label="Loading subtasks" />
      )}
      {children.error ? (
        <p role="alert">
          Subtasks unavailable.{' '}
          <Button onClick={() => void children.refetch()}>Retry</Button>
        </p>
      ) : (
        <ul>
          {children.data?.children.map((child) => (
            <li key={child.id}>
              <Button
                onClick={() =>
                  navigate(`/tasks/${encodeURIComponent(child.id)}`)
                }
              >
                {child.title}
              </Button>
              <span>{taskStatusLabel(child.status)}</span>
            </li>
          ))}
        </ul>
      )}
      {children.data?.children.length === 0 && (
        <Empty label="Nothing added yet" />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !title.trim() ||
            title.trim().length > MAX_TASK_TITLE_LENGTH ||
            request
          )
            return;
          submit({
            operationId: randomCorrelationId(),
            parent: identity(task),
            task: { projectId: task.projectId, title: title.trim() },
          });
        }}
      >
        <label>
          Subtask title{' '}
          <input
            maxLength={MAX_TASK_TITLE_LENGTH}
            value={title}
            disabled={!!request}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={!title.trim() || !!request}>
          Add subtask
        </Button>
      </form>
      <DiscardModal />
      {retained.notice && <p role="alert">{retained.notice}</p>}
      {request && !create.isPending && (
        <p role="alert">
          Subtask creation could not be confirmed. It may already have been
          added.
          <Button
            disabled={create.isPending || retained.blocked}
            onClick={() => submit(request)}
          >
            Retry creation
          </Button>
          <Button
            onClick={() => {
              if (!retained.clear()) return;
              setTitle('');
              create.reset();
            }}
          >
            Stop retrying
          </Button>
        </p>
      )}
    </section>
  );
}

function WorkChats({
  task,
  scope,
  scopeKey,
}: {
  task: TaskRecord;
  scope: TaskRelationshipScope;
  scopeKey: string;
}) {
  const chats = useTaskWorkChatsQuery(identity(task), scope);
  const mutation = useSetTaskWorkChatMutation(scope);
  const [selected, setSelected] = useState('');
  const retained = useRetainedRelationship(
    'work-chats',
    scopeKey,
    chatIntent.refine(
      (input) =>
        input.task.taskId === task.id &&
        input.task.taskCreatedAt === task.createdAt,
    ),
  );
  const { request } = retained;
  const { DiscardModal } = useUnsavedGuard(!!selected || !!request, () => {
    if (!retained.clear()) return false;
    setSelected('');
    return true;
  });
  const [notice, setNotice] = useState('');
  const [preparing, setPreparing] = useState(false);
  const inventory = useQuery({
    queryKey: ['task-work-chat-candidates', scope.apiBase, scope.authorityKey],
    retry: false,
    queryFn: async ({ signal }) => {
      if (!scope.isCurrent()) throw new Error('Connection changed');
      const page = await fetchConversationInventory(scope.apiBase, {
        requestScope: scope,
        signal,
        limit: 100,
      });
      if (!scope.isCurrent()) throw new Error('Connection changed');
      return page;
    },
  });
  function send(input: TaskWorkChatMutationInput) {
    if (!scope.isCurrent() || !retained.isActive()) return;
    if (!retained.retain(input) || retained.blocked) return;
    mutation.mutate(input, {
      onSuccess: () => {
        if (scope.isCurrent() && retained.isActive()) {
          if (!retained.clear()) return;
          setSelected('');
        }
      },
    });
  }
  async function link() {
    if (!selected || preparing || request || !scope.isCurrent()) return;
    const operationId = randomCorrelationId();
    const conversationId = selected;
    setPreparing(true);
    setNotice('');
    try {
      const candidate = await fetchTaskWorkChat(
        scope.apiBase,
        identity(task),
        conversationId,
        { requestScope: scope },
      );
      if (!scope.isCurrent() || !retained.isActive()) return;
      send({
        operationId,
        task: identity(task),
        conversationId,
        expectedRevision: candidate.revision,
        linked: true,
      });
    } catch {
      if (scope.isCurrent())
        setNotice('Chat link unavailable. Select a chat and try again.');
    } finally {
      setPreparing(false);
    }
  }
  async function open(conversationId: string) {
    setNotice('');
    if (
      !(await openChatsStore.openConversation(conversationId, scope.isCurrent, {
        revealDock: true,
      })) &&
      scope.isCurrent()
    )
      setNotice('Chat could not be opened.');
  }
  return (
    <section className="task-relationships" aria-label="Work chats">
      <h2>Work chats</h2>
      {chats.isLoading && <SkeletonList count={2} label="Loading work chats" />}
      {chats.error && (
        <p role="alert">
          Work chats unavailable.{' '}
          <Button onClick={() => void chats.refetch()}>Retry</Button>
        </p>
      )}
      <ul>
        {chats.data?.chats.map((chat) => (
          <li key={chat.conversationId}>
            <Button onClick={() => void open(chat.conversationId)}>
              {inventory.data?.items.find(
                (item) => item.id === chat.conversationId,
              )?.title || 'Open chat'}
            </Button>
            <Button
              disabled={!!request || preparing}
              onClick={() =>
                send({
                  operationId: randomCorrelationId(),
                  task: identity(task),
                  conversationId: chat.conversationId,
                  expectedRevision: chat.revision,
                  linked: false,
                })
              }
            >
              Unlink
            </Button>
          </li>
        ))}
      </ul>
      {chats.data?.chats.length === 0 && <Empty label="Nothing linked yet" />}
      <label>
        Link a chat{' '}
        <select
          value={selected}
          disabled={!!request || preparing}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Choose a chat</option>
          {inventory.data?.items
            .filter(
              (item) =>
                !chats.data?.chats.some(
                  (chat) => chat.conversationId === item.id,
                ),
            )
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.title || 'Untitled chat'}
              </option>
            ))}
        </select>
      </label>
      <Button
        disabled={!selected || !!request || preparing}
        onClick={() => void link()}
      >
        Link chat
      </Button>
      {inventory.error && (
        <p role="alert">
          Chat selection unavailable.{' '}
          <Button onClick={() => void inventory.refetch()}>
            Retry selection
          </Button>
        </p>
      )}
      {inventory.data?.hasMore && <p>Showing recent chats.</p>}
      <DiscardModal />
      {retained.notice && <p role="alert">{retained.notice}</p>}
      {request && !mutation.isPending && (
        <p role="alert">
          Chat update could not be confirmed. The change may already have been
          applied.
          <Button
            disabled={mutation.isPending || retained.blocked}
            onClick={() => send(request)}
          >
            Retry update
          </Button>
          <Button
            onClick={() => {
              if (!retained.clear()) return;
              setSelected('');
              mutation.reset();
            }}
          >
            Stop retrying
          </Button>
        </p>
      )}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}
