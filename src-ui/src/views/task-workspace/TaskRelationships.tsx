import type {
  TaskChildCreateInput,
  TaskRecord,
  TaskWorkChatMutationInput,
} from '@kontourai/station-contracts/task-graph';
import { taskStatusLabel } from '@kontourai/station-contracts/task-graph';
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
import { useState } from 'react';
import { Button } from '../../components/Button';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { openChatsStore } from '../../contexts/open-chats-store';

export function TaskRelationships({
  task,
  kind,
}: {
  task: TaskRecord;
  kind: 'children' | 'work-chats';
}) {
  const scope = useHostRequestAuthorityScope();
  if (!scope) return <p>Task relationships unavailable.</p>;
  const key = JSON.stringify([
    scope.apiBase,
    scope.authorityKey,
    task.id,
    task.createdAt,
  ]);
  return kind === 'children' ? (
    <Subtasks key={key} task={task} scope={scope} />
  ) : (
    <WorkChats key={key} task={task} scope={scope} />
  );
}
const identity = (task: TaskRecord) => ({
  taskId: task.id,
  taskCreatedAt: task.createdAt,
});

function Subtasks({
  task,
  scope,
}: {
  task: TaskRecord;
  scope: TaskRelationshipScope;
}) {
  const { navigate } = useNavigation();
  const children = useTaskChildrenQuery(identity(task), scope);
  const create = useCreateTaskChildMutation(scope);
  const [title, setTitle] = useState('');
  const [request, setRequest] = useState<TaskChildCreateInput>();
  function submit(input: TaskChildCreateInput) {
    if (!scope.isCurrent()) return;
    setRequest(input);
    create.mutate(input, {
      onSuccess: (result) => {
        if (!scope.isCurrent()) return;
        setRequest(undefined);
        setTitle('');
        navigate(`/tasks/${encodeURIComponent(result.task.id)}`);
      },
    });
  }
  return (
    <section className="task-relationships" aria-label="Subtasks">
      <h2>Subtasks</h2>
      {children.isLoading && <p>Loading subtasks…</p>}
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
      {children.data?.children.length === 0 && <p>No subtasks yet.</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || request) return;
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
            maxLength={512}
            value={title}
            disabled={!!request}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={!title.trim() || !!request}>
          Add subtask
        </Button>
      </form>
      {create.error && request && (
        <p role="alert">
          Subtask creation could not be confirmed.
          <Button disabled={create.isPending} onClick={() => submit(request)}>
            Retry creation
          </Button>
          <Button
            onClick={() => {
              setRequest(undefined);
              create.reset();
            }}
          >
            Dismiss
          </Button>
        </p>
      )}
    </section>
  );
}

function WorkChats({
  task,
  scope,
}: {
  task: TaskRecord;
  scope: TaskRelationshipScope;
}) {
  const chats = useTaskWorkChatsQuery(identity(task), scope);
  const mutation = useSetTaskWorkChatMutation(scope);
  const [selected, setSelected] = useState('');
  const [request, setRequest] = useState<TaskWorkChatMutationInput>();
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
    if (!scope.isCurrent()) return;
    setRequest(input);
    mutation.mutate(input, {
      onSuccess: () => {
        if (scope.isCurrent()) {
          setRequest(undefined);
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
      if (!scope.isCurrent()) return;
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
      {chats.isLoading && <p>Loading work chats…</p>}
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
      {chats.data?.chats.length === 0 && <p>No linked work chats.</p>}
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
      {mutation.error && request && (
        <p role="alert">
          Chat update could not be confirmed.
          <Button disabled={mutation.isPending} onClick={() => send(request)}>
            Retry update
          </Button>
          <Button
            onClick={() => {
              setRequest(undefined);
              mutation.reset();
            }}
          >
            Dismiss
          </Button>
        </p>
      )}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}
