import { useState } from 'react';
import type { FolderNode } from '@shared';
import { formatCount } from '../lib/format';

interface FolderTreeProps {
  node: FolderNode;
  selected: Set<string>;
  onToggle: (path: string) => void;
  depth?: number;
}

/**
 * Checkbox tree of the library's folders. Selecting a folder includes
 * everything beneath it, so a child under a selected parent renders as an
 * indeterminate-but-included checkbox rather than an independent choice.
 */
export function FolderTree({
  node,
  selected,
  onToggle,
  depth = 0,
}: FolderTreeProps): React.ReactElement {
  // The first two levels start open; deeper trees stay collapsed.
  const [expanded, setExpanded] = useState(depth < 1);

  const isRoot = node.path === '';
  const explicitlySelected = selected.has(node.path);
  // Only an explicit root selection means "everything"; an empty selection
  // means an empty gallery.
  const includedByRoot = !isRoot && selected.has('');
  const includedByParent = [...selected].some(
    (path) => path !== '' && path !== node.path && node.path.startsWith(`${path}/`),
  );
  const included = explicitlySelected || includedByRoot || includedByParent;
  const inherited = included && !explicitlySelected;

  return (
    <div>
      <div className={`tree-row${explicitlySelected ? ' selected' : ''}`}>
        <button
          className="tree-toggle"
          onClick={() => setExpanded((value) => !value)}
          style={{ visibility: node.children.length > 0 ? 'visible' : 'hidden' }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▼' : '▶'}
        </button>

        <input
          type="checkbox"
          checked={included}
          // A folder covered by a parent can't be unchecked on its own — show
          // that as indeterminate rather than pretending it's a free choice.
          ref={(element) => {
            if (element) element.indeterminate = inherited;
          }}
          onChange={() => onToggle(node.path)}
          title={
            isRoot
              ? 'Include the whole library'
              : inherited
                ? 'Included via a parent folder'
                : 'Include this folder and everything in it'
          }
        />

        <span className="name" title={node.path || '/'}>
          {isRoot ? 'All photos' : node.name}
        </span>
        <span className="count">{formatCount(node.photoCount)}</span>
      </div>

      {expanded && node.children.length > 0 && (
        <div style={{ marginLeft: 18 }}>
          {node.children.map((child) => (
            <FolderTree
              key={child.path}
              node={child}
              selected={selected}
              onToggle={onToggle}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
