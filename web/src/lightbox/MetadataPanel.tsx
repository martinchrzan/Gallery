import type { PhotoDetail } from '@shared';
import { formatBytes, formatDateTime, formatDimensions } from '../lib/format';

const TAKEN_SOURCE_LABEL: Record<string, string> = {
  exif: 'from EXIF',
  filename: 'from the filename',
  mtime: 'from the file date',
};

interface MetadataPanelProps {
  photo: PhotoDetail | null;
  loading: boolean;
}

export function MetadataPanel({ photo, loading }: MetadataPanelProps): React.ReactElement {
  if (!photo) {
    return (
      <aside className="lightbox-meta">
        <h3>Details</h3>
        <p style={{ color: 'rgba(255,255,255,0.5)' }}>{loading ? 'Loading…' : 'Unavailable'}</p>
      </aside>
    );
  }

  const rows: [string, React.ReactNode][] = [
    ['File', photo.name],
    ['Folder', photo.dir || '/'],
    [
      'Taken',
      <>
        {formatDateTime(photo.takenAt)}
        {photo.takenSource && photo.takenSource !== 'exif' && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
            {TAKEN_SOURCE_LABEL[photo.takenSource]}
          </div>
        )}
      </>,
    ],
    ['Dimensions', formatDimensions(photo.width, photo.height)],
    ['Size', formatBytes(photo.size)],
  ];

  if (photo.camera) rows.push(['Camera', photo.camera]);
  if (photo.lens) rows.push(['Lens', photo.lens]);

  const exposure = [
    photo.focalLength ? `${Math.round(photo.focalLength)}mm` : null,
    photo.aperture ? `ƒ/${Number(photo.aperture.toFixed(1))}` : null,
    photo.exposure,
    photo.iso ? `ISO ${photo.iso}` : null,
  ].filter(Boolean);
  if (exposure.length > 0) rows.push(['Exposure', exposure.join(' · ')]);

  if (photo.gps) {
    rows.push([
      'Location',
      <a
        href={`https://www.openstreetmap.org/?mlat=${photo.gps.lat}&mlon=${photo.gps.lon}#map=15/${photo.gps.lat}/${photo.gps.lon}`}
        target="_blank"
        rel="noreferrer noopener"
      >
        {photo.gps.lat.toFixed(5)}, {photo.gps.lon.toFixed(5)}
      </a>,
    ]);
  }

  return (
    <aside className="lightbox-meta">
      <h3>Details</h3>
      <dl style={{ margin: 0 }}>
        {rows.map(([label, value]) => (
          <div className="meta-row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
