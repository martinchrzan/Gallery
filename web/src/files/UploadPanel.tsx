import { IconClose } from '../components/icons';
import { formatBytes, formatCount } from '../lib/format';
import type { Uploader } from './uploads';

/**
 * The transfer panel: one row per file, an overall bar, and a way out of both.
 *
 * It stays on screen after the queue drains rather than vanishing, because a
 * failed file is the one thing here worth reading, and a panel that disappears
 * on completion would take the failure with it.
 */
export function UploadPanel({ uploader }: { uploader: Uploader }): React.ReactElement | null {
  const { tasks, active, progress } = uploader;
  if (tasks.length === 0) return null;

  const percent = progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 100;
  const inFlight = tasks.filter((t) => t.state === 'queued' || t.state === 'uploading').length;

  return (
    <section className="upload-panel" aria-label="Uploads">
      <header className="upload-head">
        <span className="upload-title">
          {active
            ? `Uploading ${formatCount(progress.done + 1)} of ${formatCount(progress.done + inFlight)}`
            : progress.failed > 0
              ? `${formatCount(progress.failed)} upload${progress.failed === 1 ? '' : 's'} failed`
              : `Uploaded ${formatCount(progress.done)} file${progress.done === 1 ? '' : 's'}`}
        </span>

        {active ? (
          <button className="btn btn-ghost" onClick={uploader.cancelAll}>
            Cancel
          </button>
        ) : (
          <button
            className="btn btn-ghost btn-icon"
            onClick={uploader.clearFinished}
            title="Dismiss"
            aria-label="Dismiss"
          >
            <IconClose size={15} />
          </button>
        )}
      </header>

      {active && (
        <div className="upload-bar" role="progressbar" aria-valuenow={percent}>
          <div className="upload-bar-fill" style={{ width: `${percent}%` }} />
        </div>
      )}

      <ul className="upload-list">
        {tasks.map((task) => {
          const filePercent =
            task.state === 'done' ? 100 : task.size > 0 ? Math.floor((task.sent / task.size) * 100) : 0;

          return (
            <li className={`upload-row ${task.state}`} key={task.key}>
              <span className="name" title={`${task.dir ? `${task.dir}/` : ''}${task.name}`}>
                {task.name}
              </span>

              <span className="state" title={task.error ?? undefined}>
                {task.state === 'done'
                  ? formatBytes(task.size)
                  : task.state === 'error'
                    ? task.error
                    : task.state === 'canceled'
                      ? 'Canceled'
                      : task.state === 'queued'
                        ? 'Waiting'
                        : `${filePercent}%`}
              </span>

              {(task.state === 'queued' || task.state === 'uploading') && (
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => uploader.cancel(task.key)}
                  title="Cancel this file"
                  aria-label={`Cancel ${task.name}`}
                >
                  <IconClose size={13} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
