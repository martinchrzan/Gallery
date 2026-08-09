import { useCallback, useEffect, useState } from 'react';
import { api, type FolderNode, type User, type UserWithCode } from '../api/client';
import { IconCopy } from '../components/icons';
import { formatDateTime } from '../lib/format';
import { describeFolders, toggleFolder } from './folders';
import { FolderTree } from './FolderTree';

interface UsersPanelProps {
  tree: FolderNode | null;
  currentUserId: number;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export function UsersPanel({
  tree,
  currentUserId,
  onError,
  onNotice,
}: UsersPanelProps): React.ReactElement {
  const [users, setUsers] = useState<User[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  /**
   * A freshly issued code, held only in this component's state. The server
   * stores nothing but its hash, so once this is dismissed it is gone.
   */
  const [issued, setIssued] = useState<UserWithCode | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftFolders, setDraftFolders] = useState<string[]>([]);

  const reload = useCallback(
    (signal?: AbortSignal) => {
      api
        .users(signal)
        .then((next) => !signal?.aborted && setUsers(next))
        .catch((err: Error) => !signal?.aborted && onError(err.message));
    },
    [onError],
  );

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const create = async (): Promise<void> => {
    try {
      const result = await api.createUser({ label: draftLabel.trim(), folders: draftFolders });
      setIssued(result);
      setDrafting(false);
      setDraftLabel('');
      setDraftFolders([]);
      reload();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const setFolders = async (user: User, folders: string[]): Promise<void> => {
    // Optimistic: the folder tree should not lag a click behind.
    setUsers((prev) => prev?.map((u) => (u.id === user.id ? { ...u, folders } : u)) ?? prev);
    try {
      await api.updateUser(user.id, { folders });
    } catch (err) {
      onError((err as Error).message);
      reload();
    }
  };

  const rotate = async (user: User): Promise<void> => {
    try {
      setIssued(await api.rotateUserCode(user.id));
      onNotice(`${user.label} has been signed out everywhere`);
      reload();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const remove = async (user: User): Promise<void> => {
    if (!window.confirm(`Remove ${user.label}? Their access code stops working immediately.`)) {
      return;
    }
    try {
      await api.deleteUser(user.id);
      reload();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <section className="card">
      <h2>People</h2>
      <p className="hint">
        Everyone signs in with an access code — there is no username. Give someone a code and they
        see the gallery for the folders you pick here, with no Files tab and no settings.
      </p>

      {issued && <CodeReveal issued={issued} onDismiss={() => setIssued(null)} />}

      <div className="user-list">
        {users === null && (
          <div className="pill">
            <div className="spinner" />
            Loading people…
          </div>
        )}

        {users?.map((user) => {
          const isSelf = user.id === currentUserId;
          const isAdmin = user.role === 'admin';
          return (
            <div key={user.id} className="user-row">
              <div className="user-main">
                <div className="user-name">
                  {user.label}
                  {isAdmin && <span className="chip">Admin</span>}
                  {isSelf && <span className="chip chip-quiet">You</span>}
                </div>
                <div className="user-meta">
                  {isAdmin ? 'Full access' : describeFolders(user.folders)}
                  {' · '}
                  {user.lastSeenAt ? `last seen ${formatDateTime(user.lastSeenAt)}` : 'never signed in'}
                </div>
              </div>

              <div className="user-actions">
                {!isAdmin && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => setExpanded(expanded === user.id ? null : user.id)}
                  >
                    {expanded === user.id ? 'Done' : 'Folders'}
                  </button>
                )}
                <button className="btn btn-ghost" onClick={() => void rotate(user)}>
                  New code
                </button>
                <button
                  className="btn btn-ghost btn-danger-ghost"
                  disabled={isSelf}
                  title={isSelf ? 'You cannot remove your own account' : undefined}
                  onClick={() => void remove(user)}
                >
                  Remove
                </button>
              </div>

              {expanded === user.id && (
                <div className="folder-tree user-folders">
                  {tree ? (
                    <FolderTree
                      node={tree}
                      selected={new Set(user.folders)}
                      onToggle={(path) => void setFolders(user, toggleFolder(user.folders, path))}
                    />
                  ) : (
                    <div className="pill">
                      <div className="spinner" />
                      Reading folders…
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {drafting ? (
        <div className="user-draft">
          <div className="field">
            <div>
              <label htmlFor="new-user-label">Name</label>
              <div className="desc">Just a label so you can tell codes apart.</div>
            </div>
            <div className="field-control">
              <input
                id="new-user-label"
                type="text"
                value={draftLabel}
                placeholder="Anna"
                autoFocus
                onChange={(event) => setDraftLabel(event.target.value)}
              />
            </div>
          </div>

          <div className="folder-tree user-folders">
            {tree ? (
              <FolderTree
                node={tree}
                selected={new Set(draftFolders)}
                onToggle={(path) => setDraftFolders(toggleFolder(draftFolders, path))}
              />
            ) : (
              <div className="pill">
                <div className="spinner" />
                Reading folders…
              </div>
            )}
          </div>

          <div className="user-draft-actions">
            <span className="desc">{describeFolders(draftFolders)}</span>
            <div className="topbar-spacer" />
            <button className="btn btn-ghost" onClick={() => setDrafting(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={draftLabel.trim() === ''}
              onClick={() => void create()}
            >
              Create code
            </button>
          </div>
        </div>
      ) : (
        <button className="btn" style={{ marginTop: 14 }} onClick={() => setDrafting(true)}>
          Add someone
        </button>
      )}
    </section>
  );
}

/**
 * The one moment an access code is readable. It exists only in this render — the
 * server kept a hash — so the copy button and the warning both matter.
 */
function CodeReveal({
  issued,
  onDismiss,
}: {
  issued: UserWithCode;
  onDismiss: () => void;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard
      .writeText(issued.code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div className="code-reveal">
      <div className="code-reveal-head">
        Access code for <strong>{issued.user.label}</strong>
      </div>
      <div className="code-reveal-value">
        <code>{issued.code}</code>
        <button className="btn btn-ghost btn-icon" onClick={copy} title="Copy" aria-label="Copy">
          <IconCopy size={16} />
        </button>
      </div>
      <div className="code-reveal-note">
        {copied ? 'Copied.' : 'Copy it now — it cannot be shown again, only replaced.'}
      </div>
      <button className="btn btn-ghost" onClick={onDismiss}>
        Done
      </button>
    </div>
  );
}
